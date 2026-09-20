"""比赛计分（设计 §1.7/§1.8）：按参赛条目过滤 + scoring_from 下限 + metric 门槛，
快照写入 leaderboard_snapshots（board=comp.metric, period_key=comp:<id>）。

复用 boards.py 的 `_resolved_in_period`/`reconcile_deposits`——两者都新增了可选
`bounds` 参数（默认 None 时行为与 Phase 2 完全一致），比赛这边显式传
(comp.starts_at, comp.ends_at)，因为比赛 key（`comp:<id>`）不是 `period_bounds`
能解析的自然周/月格式。
"""
from collections import defaultdict
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException
from sqlalchemy.exc import IntegrityError

from app.models import (
    Competition, CompetitionParticipant, LeaderboardSnapshot, MT5Account, PeriodBaseline, User,
)
from .badges import award_badge
from .badge_judges import campaigner_tier, finished_competition_count
from app.services.account_type import CONTEST, DEMO
from .boards import REAL, _aware, _resolved_in_period, board_gates, reconcile_deposits, return_score


TRACKS = ("real", "demo")
# 赛道 → 允许参赛的 trade_mode 集合。demo 赛道收模拟与赛区账户（都不是真金白银）；
# trade_mode 为 NULL（尚未判定）的账户两个赛道都不收——宁可不让报名，也不能把
# 一个还没判出类型的账户放进以本金论英雄的榜里。
# Track → the trade_mode values it accepts. The demo track takes both demo and
# contest accounts (neither is real money). Accounts with a NULL trade_mode (not yet
# classified) are accepted by neither: better to refuse entry than to admit an
# unclassified account to a board scored on capital.
_TRACK_MODES = {"real": (REAL,), "demo": (DEMO, CONTEST)}

# 每人每场最多能报几个条目（设计 §1.7 的反刷榜闸）。
#
# 为什么必须有这道闸：名次是按「条目」（login）出行的，不是按人。同一个人报进
# N 个账户、两两反向对冲下单，总有一个账户跑出漂亮的收益率——期望为零的操作
# 却能稳定拿到榜首，奖金场就是被这么套的。
#
# 两个赛道给不同的值，因为成本不同：模拟账户可以零成本无限开，所以 demo 赛道
# 只认一个条目，对冲刷榜在这一侧直接不成立；实盘每开一个账户都要真金白银入金，
# 对冲的代价是真实的点差与手续费，所以留 3 个——足够覆盖「一个人确实同时在
# 几家/几个账户上跑不同策略」这类正当用法，又把批量对冲的成本抬到不划算。
#
# How many entries one user may have in one competition (the anti-gaming gate
# from §1.7). Ranks are per entry (login), not per person, so one user entering N
# accounts and hedging them against each other is guaranteed to leave one account
# at the top of the board — a zero-expectation trick that reliably wins prizes.
# The two tracks get different caps because their cost differs: demo accounts are
# free and unlimited, so the demo track allows exactly one entry and the hedge
# stops being possible at all; a real account costs real money to fund and the
# hedge pays real spread and commission, so three entries are allowed — enough
# for the legitimate "I really do run a few accounts" case while keeping bulk
# hedging uneconomical.
MAX_ENTRIES_DEMO = 1
MAX_ENTRIES_REAL = 3
_TRACK_MAX_ENTRIES = {"real": MAX_ENTRIES_REAL, "demo": MAX_ENTRIES_DEMO}


def track_modes(track: str) -> tuple[int, ...]:
    return _TRACK_MODES.get(track or "real", _TRACK_MODES["real"])


def max_entries_per_user(track: str) -> int:
    return _TRACK_MAX_ENTRIES.get(track or "real", MAX_ENTRIES_REAL)


def comp_gates(comp: Competition, gset: dict) -> dict:
    """这场比赛实际生效的门槛：比赛自己配了就用自己的，没配回落全局。

    形状与 `board_gates()` 完全一致，因为下游（`compute_comp_rows` 与比赛详情
    页的 gates 回显）就是照那份形状读的——"页面上写的门槛"与"计算时用的门槛"
    必须永远是同一个来源，这条约定见 `board_gates` 的说明。

    The gates actually in force for this competition: its own values when set,
    otherwise the global ones. Shape is identical to `board_gates()` because
    that's what the consumers read — the number shown on the page and the number
    used to compute rows must come from one source (see `board_gates`).
    """
    gates = dict(board_gates(gset))
    if comp.min_baseline_usd is not None:
        gates["min_baseline_usd"] = float(comp.min_baseline_usd)
    if comp.min_trades is not None:
        n = max(1, int(comp.min_trades))
        gates["min_trades_return"] = n
        gates["min_trades_winrate"] = n
    return gates


def comp_period_key(comp_id: str) -> str:
    return f"comp:{comp_id}"


def compute_comp_rows(db, comp: Competition) -> list[dict]:
    """比赛未取消资格的参赛条目 + `period_baselines(comp:<id>)`：按 `boards.
    _resolved_in_period` 的语义计算——有效下界 = max(比赛开赛, 基线 taken_at,
    条目 scoring_from)、上界 = 比赛结束。按 comp.metric 应用门槛（含
    min_baseline_usd），返回 `{userId, login, score, sample}` 未排名行。

    只有参赛条目登记的账户（login）计分——同一用户名下未登记进这场比赛的其它
    账户不得混入（哪怕它恰好也在 period_baselines 里留了同 key 的脏行）。
    """
    from app.services.settings_store import get_gamification_settings
    gset = get_gamification_settings(db)
    # 比赛用的是所选 metric 的完整周期榜规则，默认与 boards.py 同步（同一个
    # board_gates()，两处不会分叉）；本场比赛单独配了门槛时由 comp_gates 覆盖。
    # A competition uses its metric's full board rules, by default in lockstep with
    # boards.py (same board_gates(), so the two can't diverge); comp_gates applies
    # this competition's own overrides on top when it has any.
    gates = comp_gates(comp, gset)
    min_baseline = gates["min_baseline_usd"]
    min_trades_return = gates["min_trades_return"]
    min_trades_winrate = gates["min_trades_winrate"]
    wr_require_profit = gates["winrate_require_profit"]
    period_key = comp_period_key(comp.id)
    starts_at = _aware(comp.starts_at)
    ends_at = _aware(comp.ends_at)

    participants = (db.query(CompetitionParticipant)
                       .filter(CompetitionParticipant.competition_id == comp.id,
                               CompetitionParticipant.disqualified.is_(False)).all())
    if not participants:
        return []

    baselines = {(b.user_id, b.mt5_login): b for b in
                 db.query(PeriodBaseline).filter(PeriodBaseline.period_key == period_key)}

    by_user = defaultdict(list)
    for p in participants:
        by_user[p.user_id].append(p)

    rows = []
    for uid, plist in by_user.items():
        logins = set()
        taken = {}
        baseline_by_login = {}
        for p in plist:
            b = baselines.get((uid, p.mt5_login))
            if b is None:
                continue                            # 未拍基线：不出行
            lower = max(starts_at, _aware(b.taken_at),
                        *([_aware(p.scoring_from)] if p.scoring_from is not None else []))
            taken[p.mt5_login] = lower
            baseline_by_login[p.mt5_login] = b
            logins.add(p.mt5_login)
        if not logins:
            continue
        # modes：按本场赛道取（real 赛只算实盘单、demo 赛只算模拟单）。不传的话
        # _resolved_in_period 默认只认实盘，模拟赛的成交会被整个滤掉。
        # modes: taken from this competition's track (a real competition scores only
        # live fills, a demo one only demo fills). Without it _resolved_in_period
        # defaults to real-only and a demo competition's fills all get filtered out.
        profits_by_login = _resolved_in_period(db, uid, logins, period_key, taken,
                                                bounds=(starts_at, ends_at),
                                                modes=track_modes(comp.track))
        for lg in logins:
            b = baseline_by_login[lg]
            resolved = profits_by_login.get(lg, [])
            profits = [pr for _o, _c, pr in resolved]
            sample = len(profits)
            total = sum(profits)
            if comp.metric == "return_pct":
                # 逐仓按当时本金计分，与周期榜同一个 return_score（出入金口径不分叉）。
                # Per-position capital, same return_score as the standing board.
                scored = return_score(b, resolved, min_baseline)
                if sample >= min_trades_return and scored is not None:
                    rows.append({"userId": uid, "login": lg,
                                "score": scored[0], "sample": sample})
            elif comp.metric == "win_rate":
                # 盈亏正闸同 boards.py：现在是可配开关 winrate_require_profit（默认关）。
                # Same as boards.py: a principled profit-positive gate,
                # deliberately not a setting.
                if sample >= min_trades_winrate and (total > 0 or not wr_require_profit):
                    wins = sum(1 for pr in profits if pr > 0)
                    rows.append({"userId": uid, "login": lg,
                                "score": wins / sample, "sample": sample})
    return rows


def _snapshot_one_comp(db, comp: Competition) -> list[dict]:
    """单场比赛的算行 + 排名 + 快照原子替换（delete-then-insert），不 commit——
    commit 时机由调用方决定：`snapshot_competitions` 每场比赛提交一次；
    `settle_competition` 把这一步并入终审第一段事务，不单独提交。

    返回排好名次的行（在 `compute_comp_rows` 的行基础上原地加了 `rank`），供
    调用方直接使用，不必再回查一遍 `leaderboard_snapshots`。
    """
    key = comp_period_key(comp.id)
    rows = compute_comp_rows(db, comp)
    # 排序键与周期榜完全一致，并列名次同样不存在——理由见 boards.snapshot_boards
    # 同一处的说明（名次必须唯一，下面 settle_competition 才能按 rank == 1 发出
    # 恰好一枚冠军金牌）。
    # Same sort key as the standing board, and likewise no ties — see the note at
    # the same spot in boards.snapshot_boards (ranks must be unique so
    # settle_competition awards exactly one champion on rank == 1).
    rows.sort(key=lambda r: (-r["score"], -r["sample"], r["login"]))
    db.query(LeaderboardSnapshot).filter(
        LeaderboardSnapshot.board == comp.metric,
        LeaderboardSnapshot.period_key == key).delete()
    for i, r in enumerate(rows, start=1):
        r["rank"] = i
        db.add(LeaderboardSnapshot(board=comp.metric, period_key=key,
                                   user_id=r["userId"], mt5_login=r["login"],
                                   rank=i, score=r["score"], sample=r["sample"]))
    return rows


# 按需刷新的节流：榜单页会被多个用户同时轮询，每次都重算一遍聚合查询没有
# 意义——同一场比赛 REFRESH_MIN_INTERVAL 秒内只真正算一次，其余请求直接读刚
# 落盘的快照。
#
# 节流状态走 shared_state（配了 REDIS_URL 就跨进程，没配退回进程内内存，行为与
# 原来的模块级 dict 一致）。原来是进程内 dict，多 worker 下每个 worker 各算各
# 的：N 个 worker = N 倍重算，而且两个 worker 可以同时进到下面的
# delete-then-insert，一方 commit 就会撞 leaderboard_snapshots 的唯一约束
# (board, period_key, user_id, mt5_login)，把用户端的 GET /competitions/{id}
# 打成 500。
#
# 用 incr_with_ttl 而不是「读一次再写一次」：自增在两种后端上都是原子的，先到
# 的那个请求拿到 1、真的去算，同一窗口内的其余请求拿到 >1 直接读快照——这正是
# 单靠 get+set 会在并发下漏掉的那一格。
#
# Throttle for on-demand refreshes, kept in shared_state (cross-process when
# REDIS_URL is set, in-process memory otherwise — identical to the module-level
# dict this replaces). As a per-process dict each worker throttled on its own: N
# workers meant N recomputes, and two of them could enter the delete-then-insert
# below at once, so one commit would hit the leaderboard_snapshots unique
# constraint and turn a user's GET /competitions/{id} into a 500.
# incr_with_ttl rather than get-then-set: the increment is atomic on both
# backends, so the first request in a window gets 1 and does the work while the
# rest get >1 and read the snapshot — exactly the race a get+set pair loses.
REFRESH_MIN_INTERVAL = 20.0
_REFRESH_KEY_PREFIX = "comp-refresh:"


def _refresh_throttle_key(comp_id: str) -> str:
    return f"{_REFRESH_KEY_PREFIX}{comp_id}"


def refresh_comp_board(db, comp: Competition, force: bool = False) -> bool:
    """把这场比赛的榜单快照重算一遍并落盘，返回是否真的算了。

    进行中的比赛才有必要刷（未开始没有行、已结束/已终审的行不该再动）；
    `force=True` 由管理端「立即刷新」按钮使用，跳过节流但仍守状态这一关。

    Recomputes and persists this competition's board snapshot; returns whether it
    actually ran. Only a running competition is worth refreshing (an upcoming one
    has no rows, and an ended/settled one's rows must not move). `force=True` comes
    from the admin "refresh now" button: it skips the throttle but still respects
    the status guard.
    """
    from app.services import shared_state

    if comp.status != "running":
        return False
    if not force:
        n = shared_state.incr_with_ttl(_refresh_throttle_key(comp.id),
                                        int(REFRESH_MIN_INTERVAL))
        if n > 1:
            return False
    try:
        _snapshot_one_comp(db, comp)
        db.commit()
    except IntegrityError:
        # delete-then-insert 撞唯一约束 (board, period_key, user_id, mt5_login)：
        # 节流已经把常态挡掉，剩下的是「节流键刚过期 + 两个 worker 同时进来」这
        # 类窄窗口。这条路径挂在用户端的 GET 上，别人已经写好的快照就是我们要写
        # 的那一份，回滚、报告「这次没算」即可——绝不能让读榜变成 500。
        # The delete-then-insert hit the unique constraint: the throttle covers
        # the common case, leaving only the narrow window where it just expired
        # and two workers entered together. This runs on a user-facing GET and the
        # snapshot the other worker wrote is the one we were about to write, so
        # roll back and report "did not run" — reading a board must never 500.
        db.rollback()
        return False
    return True


def advance_competition_statuses(db, now: datetime) -> dict:
    """按 `starts_at` / `ends_at` 自动推进比赛状态：upcoming→running、running→ended。

    **为什么必须自动推进**：`snapshot_competitions` 只处理 running/ended，所以一场
    过了 `starts_at` 却还挂在 upcoming 的比赛**一行快照都不产生**——用户打开比赛页
    看到的是一张永远空的榜，而报名窗口照常开着。同理 running 不推到 ended 就永远
    进不了终审。这两件事此前完全依赖管理员记得手动点一下状态，忘一次就是一场
    比赛静默失效。

    **哪些状态不碰**：
      · draft：草稿对用户端根本不存在，什么时候发布是运营决定，不是时间决定；
      · settled：终局状态，只能由管理员终审（`settle_competition`）写入。
        自动推进绝不越过 ended→settled 这条线——终审要发勋章、定永久名次，
        还要守 §5.3 的 24 小时宽限期，那必须是人按下去的。

    推进到 running 时对 `enrollment == "auto"` 的比赛顺带自动入场，与管理端
    PATCH 推进状态时的行为一致（auto_enroll 幂等，重复调用安全）。

    Advances competition status by the clock: upcoming→running once `starts_at`
    has passed, running→ended once `ends_at` has. Without this a competition left
    in upcoming produces no snapshot rows at all (snapshot_competitions only
    handles running/ended), so entrants stare at a permanently empty board, and a
    competition left in running can never be settled — both previously depended on
    an admin remembering to click. draft and settled are never touched: publishing
    a draft is an operational decision, and settling is a permanent, badge-awarding
    action that must stay in human hands (see settle_competition and its §5.3
    grace period). Advancing to running also auto-enrolls, matching what the admin
    PATCH does; auto_enroll is idempotent.
    """
    now = _aware(now)
    started = ended = 0
    just_started = []
    comps = (db.query(Competition)
               .filter(Competition.status.in_(("upcoming", "running"))).all())
    for comp in comps:
        if comp.status == "upcoming" and _aware(comp.starts_at) is not None \
                and now >= _aware(comp.starts_at):
            comp.status = "running"
            started += 1
            just_started.append(comp)
        # 不用 elif：一场已经结束的比赛可能整段都没被扫到（循环停过、比赛很短），
        # 这一趟要能把它从 upcoming 一路推到 ended，而不是每趟只走一格。
        # Not elif: a short competition, or one whose window elapsed while the loop
        # was down, must go all the way from upcoming to ended in a single pass.
        if comp.status == "running" and _aware(comp.ends_at) is not None \
                and now >= _aware(comp.ends_at):
            comp.status = "ended"
            ended += 1
    if started or ended:
        db.commit()
    # 自动入场只对「这一趟刚推成 running」的比赛做，不对全部 running 的比赛做：
    # auto_enroll 要全表扫一遍 MT5Account，而这条循环 60 秒一趟——对每场进行中
    # 的比赛每分钟扫一次全账户表不划算。入场时机与管理端 PATCH 推进状态时一致
    # （都是「刚开赛那一下」）。放在 commit 之后：auto_enroll 内部逐账户 commit，
    # 状态先落盘，入场中途失败不会把状态推进一起回滚掉。
    # Auto-enrollment runs only for competitions advanced in *this* pass, not for
    # every running one: auto_enroll scans the whole MT5Account table and this loop
    # ticks every 60s. That matches when the admin PATCH path enrolls (the moment
    # it starts). It runs after the commit because auto_enroll commits per account,
    # so the status change is already persisted and a mid-enrollment failure can't
    # roll the advance back with it.
    enrolled = 0
    for comp in just_started:
        if comp.enrollment == "auto":
            enrolled += auto_enroll(db, comp, now)
    return {"started": started, "ended": ended, "autoEnrolled": enrolled}


def snapshot_competitions(db, now: datetime) -> dict:
    """对 status in ("running", "ended")（未 settled）的比赛算行、排名、快照。

    running：先 `reconcile_deposits(db, comp_key, now=now, bounds=(starts_at,
    ends_at))`（基线拍照在报名/自动入场时完成，快照不补拍），再算行。
    ended（未 settled）：只重算计分，不再对账（与周期榜「结束周期不对账」的
    语义一致）。settled/draft/upcoming 绝不触碰。

    单场比赛的算行/排名/快照替换逻辑复用 `_snapshot_one_comp`——`settle_competition`
    终审前刷新快照走的是同一份实现，不重复维护两套。
    """
    comps = (db.query(Competition)
               .filter(Competition.status.in_(("running", "ended"))).all())
    total_rows = 0
    for comp in comps:
        key = comp_period_key(comp.id)
        starts_at = _aware(comp.starts_at)
        ends_at = _aware(comp.ends_at)
        if comp.status == "running":
            reconcile_deposits(db, key, now=now, bounds=(starts_at, ends_at))
        rows = _snapshot_one_comp(db, comp)
        total_rows += len(rows)
        db.commit()
    return {"comps": len(comps), "rows": total_rows}


def register_participant(db, comp: Competition, user: User, mt5_login: str,
                          now: datetime) -> CompetitionParticipant:
    """报名参赛（设计 §1.7/§1.8）：仅 `enrollment=="signup"` 的比赛可报名，报名窗口内
    （`reg_opens_at <= now < reg_closes_at`；任一边未配置视为窗口未开放），账户须是
    本人名下、类型与比赛赛道相符（real 收实盘 / demo 收模拟）且余额已同步。参赛行 + `period_baselines
    (comp:<id>)` 基线在同一事务内一并插入、一次 commit——中途崩溃不会留下有参赛行
    却没基线的半截状态。撞唯一约束（并发重复报名）→ 回滚、原样返回已有条目（幂等）。
    """
    if comp.enrollment != "signup":
        raise HTTPException(status_code=400, detail="本比赛为自动参赛 / This competition auto-enrolls")
    if comp.status not in ("upcoming", "running"):
        raise HTTPException(status_code=400,
                            detail="比赛已结束，无法报名 / Competition already finished")

    now = _aware(now)
    opens, closes = _aware(comp.reg_opens_at), _aware(comp.reg_closes_at)
    if opens is None or closes is None or not (opens <= now < closes):
        raise HTTPException(status_code=400, detail="不在报名窗口内 / Registration window closed")

    from app.services.gateway_binding import not_removed
    acct = (db.query(MT5Account)
              .filter(MT5Account.user_id == user.id, MT5Account.login == mt5_login,
                      not_removed()).first())
    if acct is None or acct.trade_mode not in track_modes(comp.track):
        detail = ("仅实盘账户可参赛 / Only real accounts may enter" if comp.track == "real"
                  else "仅模拟账户可参赛 / Only demo accounts may enter")
        raise HTTPException(status_code=400, detail=detail)
    if acct.balance is None:
        raise HTTPException(status_code=400,
                            detail="账户余额未同步，请先连接账户 / Account balance not synced yet")

    # 每人每场的条目上限（见 _TRACK_MAX_ENTRIES 的说明）。只数「别的 login」——
    # 重复报同一个账户是幂等路径（下面撞唯一约束后原样返回已有条目），不该被
    # 上限误伤。被取消资格的条目照数：取消资格不退还名额，否则「报满 → 故意
    # 违规 → 腾出名额再报」就成了绕过这道闸的后门。
    # Per-user entry cap (see _TRACK_MAX_ENTRIES). Only *other* logins are
    # counted: re-registering the same account is the idempotent path below and
    # must not trip the cap. Disqualified entries still count — a disqualification
    # does not return a slot, or "fill up, get disqualified on purpose, re-enter"
    # would walk straight around this gate.
    cap = max_entries_per_user(comp.track)
    existing_entries = (db.query(CompetitionParticipant)
                          .filter(CompetitionParticipant.competition_id == comp.id,
                                  CompetitionParticipant.user_id == user.id,
                                  CompetitionParticipant.mt5_login != mt5_login).count())
    if existing_entries >= cap:
        raise HTTPException(
            status_code=400,
            detail=(f"每人每场最多报名 {cap} 个账户 / "
                    f"At most {cap} account(s) per person per competition"))

    key = comp_period_key(comp.id)
    scoring_from = max(_aware(comp.starts_at), now)
    db.add(CompetitionParticipant(competition_id=comp.id, user_id=user.id, mt5_login=mt5_login,
                                  scoring_from=scoring_from))
    db.add(PeriodBaseline(user_id=user.id, mt5_login=mt5_login, period_key=key,
                          baseline=acct.balance, taken_at=now))
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        existing = (db.query(CompetitionParticipant)
                      .filter(CompetitionParticipant.competition_id == comp.id,
                              CompetitionParticipant.mt5_login == mt5_login).first())
        if existing is not None:
            return existing
        # 撞的不是参赛行的唯一约束，而是 period_baselines 的——孤儿基线（此前
        # 某次写入只落了基线没落参赛行，成因不追究，防御性兜底）：基线已在，
        # 复用它（不重拍 taken_at），只补插参赛行。
        db.add(CompetitionParticipant(competition_id=comp.id, user_id=user.id,
                                      mt5_login=mt5_login, scoring_from=scoring_from))
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            raise HTTPException(
                status_code=400,
                detail="报名状态异常，请联系管理员 / Registration state error, contact admin")

    return (db.query(CompetitionParticipant)
              .filter(CompetitionParticipant.competition_id == comp.id,
                      CompetitionParticipant.mt5_login == mt5_login).first())


def auto_enroll(db, comp: Competition, now: datetime) -> int:
    """自动入场（设计 §1.7/§1.8）：类型与赛道相符（real 收实盘 / demo 收模拟）、余额非 NULL、属主
    未退榜的账户逐个写参赛行 + 拍基线，`scoring_from = comp.starts_at`（自动参赛的
    比赛没有报名，起点即开赛）。已入场（撞唯一约束）静默跳过——幂等，可反复调用
    （由状态推进到 running 的 admin 端点触发，Task 5）。返回新入场数。
    """
    if comp.enrollment != "auto":
        return 0    # 防误用：signup 比赛不该被批量拉入参赛（无声吞掉，不抛错）

    now = _aware(now)
    key = comp_period_key(comp.id)
    scoring_from = _aware(comp.starts_at)
    opted_out = {r[0] for r in db.query(User.id).filter(User.leaderboard_opt_out.is_(True))}
    already = {p.mt5_login for p in
               db.query(CompetitionParticipant).filter(
                   CompetitionParticipant.competition_id == comp.id)}
    from app.services.gateway_binding import not_removed
    accounts = (db.query(MT5Account)
                  .filter(MT5Account.trade_mode.in_(track_modes(comp.track)),
                          MT5Account.balance.isnot(None), not_removed()).all())
    # 逐账户 commit 与 `boards.ensure_baselines` 同一个取舍：下面的 IntegrityError
    # 就是幂等手段（已入场的静默跳过），批量提交会让一行撞约束毁掉整批，需要
    # 另设幂等设计——理由详见 ensure_baselines 里的那段说明。
    # Per-account commit, same trade-off as boards.ensure_baselines: the
    # IntegrityError below is the idempotency mechanism, and batching would let
    # one colliding row take out the whole batch. See the note there.
    enrolled = 0
    for acct in accounts:
        if acct.user_id in opted_out or acct.login in already:
            continue
        db.add(CompetitionParticipant(competition_id=comp.id, user_id=acct.user_id,
                                      mt5_login=acct.login, scoring_from=scoring_from))
        db.add(PeriodBaseline(user_id=acct.user_id, mt5_login=acct.login, period_key=key,
                              baseline=acct.balance, taken_at=now))
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            continue
        already.add(acct.login)
        enrolled += 1
    return enrolled


def settle_competition(db, comp: Competition, admin_id: str,
                        now: datetime | None = None) -> dict:
    """终审（设计 §1.7/§1.9，Phase 3 Task 4；§5.3 宽限期，Task F）：不可重跑，
    一切以 status 为闸。

    §5.3：比赛结束（`ends_at`，计分上界）后 24 小时内不可终审——留出宽限期让
    迟到的平仓（比如比赛结束时仍持仓、随后才平的单）能被 `_resolved_in_period`
    收进最后一次快照。宽限期从 `ends_at` 起算，不是从 status 被人工推到
    "ended" 那一刻起算：管理端状态推进是人工操作，可能早于/晚于 ends_at，
    只有 ends_at 才是 §5.3 里定义的计分截止点。
    Grace period counts from `ends_at` (the scoring upper bound per §5.3), not
    from whenever an admin manually advances status to "ended" — the two can
    diverge, and only `ends_at` is the cutoff the spec defines.

    终审前先刷新一遍本场比赛的快照（`_snapshot_one_comp`，与每小时循环
    `snapshot_competitions` 共用同一份实现）：最近一次落盘的快照最长可能有一小
    时陈旧——「取消资格 → 立刻终审」这个自然的管理流程会踩到这个陈旧窗口：
    被取消资格的人还占着上一次快照里的名次（compute_comp_rows 已经把 disqualified
    参赛者排除在计分之外，但那是下一次快照才生效），若终审直接读旧快照，永久
    名次表会把他钉在榜上、幸存者拿不到该有的名次（比如没有 rank 1）、
    comp_winner 也会因此静默漏发。这里的刷新和后面「名次 + status + 审计」的
    落盘算在同一段事务里，一起 commit。

    两段式、中间夹一次 commit，且顺序不可换：第一段把（刷新后的）名次和
    status="settled" 连同审计行一起落盘并 commit——这一段完成后，比赛就已经
    终局，`comp.status != "ended"` 的前置校验会挡住任何重复调用。第二段才发
    奖：award_badge 内部自行 commit（沿用既有 house pattern），单枚失败只会
    漏发一枚勋章（可人工补发，幂等），绝不会传导回去把已经写死的名次或 status
    撤回——所以失败被捕获进返回值的 badgeErrors，而不是抛出让调用方以为终审
    本身失败了。
    """
    # 内测期这里有过 force=True 跳过全部前置条件的分支（2026-09-04 为测试放开），
    # 上线前移除（2026-09-05）：早于实际结束时间终审会漏掉尚未平仓和迟到的单，
    # 而名次一旦定格就是永久的。要在测试库里快速终审，改 ends_at 或改时钟，不要
    # 给生产代码留后门。
    # A force=True bypass lived here during the closed beta (2026-09-04) and was
    # removed before launch (2026-09-05): settling early drops still-open and
    # late closes, and ranks are permanent once locked. To settle quickly in a test
    # database, move ends_at or the clock — don't leave a backdoor in production code.
    now = _aware(now) or datetime.now(timezone.utc)
    if comp.status != "ended":
        raise HTTPException(
            status_code=400,
            detail="仅可终审已结束的比赛 / Only ended competitions can be settled")
    if now < _aware(comp.ends_at) + timedelta(hours=24):
        raise HTTPException(
            status_code=400,
            detail="比赛结束后需等待 24 小时方可终审，以收齐迟到的平仓 / "
                    "Settlement opens 24 hours after the competition ends, "
                    "so late closes are counted")

    rows = _snapshot_one_comp(db, comp)   # 先落定最新名次，再读——见上方 docstring
    by_login = {p.mt5_login: p for p in
                db.query(CompetitionParticipant).filter(
                    CompetitionParticipant.competition_id == comp.id)}

    ranked = 0
    finisher_users: set[str] = set()
    podium_users: set[str] = set()
    winner_user = None
    for r in rows:
        participant = by_login.get(r["login"])
        # 双保险：disqualified 的参赛者理论上根本不会出现在刚刷新的 rows 里
        # （compute_comp_rows 已经把他们排除在计分之外），但终审是终局动作，
        # 宁可多判一次也不让意外情况把取消资格的人写进名次或发出奖。
        if participant is None or participant.disqualified:
            continue
        participant.final_score = r["score"]
        participant.final_rank = r["rank"]
        ranked += 1
        finisher_users.add(participant.user_id)
        if r["rank"] <= 3:
            podium_users.add(participant.user_id)
        if r["rank"] == 1:
            winner_user = participant.user_id

    comp.status = "settled"

    # 审计走 services/audit.log_change（admin 路由的 _log_change 就是它的别名）——
    # 服务层不 import 路由模块。old/new 特意给出两个不同的值——两者相等时直接静默跳过写入。
    # Audit via services/audit.log_change (the admin router's _log_change is an
    # alias of it); the service layer never imports a router.
    from app.services.audit import log_change as _log_change
    _log_change(db, admin_id, admin_id, f"competition:settle:{comp.id}", "ended", "settled")

    db.commit()   # 名次 + status + 审计：终局状态到此为止，下面发奖失败不会回退到这里

    badges: list[dict] = []
    badge_errors: list[dict] = []

    def _award(user_id: str, badge_id: str, tier: int = 0) -> None:
        try:
            if award_badge(db, user_id, badge_id, tier):
                badges.append({"userId": user_id, "badgeId": badge_id, "tier": tier})
        except Exception as exc:
            # award_badge 自己只兜住 IntegrityError；任何其它异常（推送逻辑之外，
            # 比如 commit 中途的连接错误）会把 session 撂在一个"脏"事务里——
            # Postgres 下这类 session 后续任何语句都会被级联拒绝（当前语句失败后
            # 事务已 abort），必须先 rollback 清空，才能继续发下一枚勋章或做别的
            # 查询。失败本身不重新抛出，收进 badge_errors 供人工补发。
            db.rollback()
            badge_errors.append({"userId": user_id, "badgeId": badge_id, "error": str(exc)})

    # 赛场勋章一枚三档：完赛铜 / 前三银 / 冠军金。每人只发其最高档一次——
    # award_badge 只升不降，之前的比赛拿过银的这次夺冠会升成金。
    # One arena badge, three tiers: finisher bronze / podium silver / champion gold.
    # Each user gets their highest tier once; award_badge only moves up, so a
    # silver from an earlier competition becomes gold on winning this one.
    arena_tier: dict[str, int] = {}
    for uid in finisher_users:
        arena_tier[uid] = max(arena_tier.get(uid, 0), 1)
    for uid in podium_users:
        arena_tier[uid] = max(arena_tier.get(uid, 0), 2)
    if winner_user is not None:
        arena_tier[winner_user] = 3
    for uid, tier in arena_tier.items():
        _award(uid, "arena", tier)

    # 老将：完赛场次到档就发，和赛场勋章同一场到手。本场的 final_rank 与 status
    # 已在上面那次 commit 落盘，所以这里数到的场次已含本场。每小时循环也会判
    # 这枚（badge_judges._j_campaigner），这里只是让"第三场完赛"当场就有反馈。
    # Campaigner: awarded here so the third finish shows up at settlement, not an
    # hour later. This competition is already committed, so the count includes it.
    for uid in finisher_users:
        tier = campaigner_tier(finished_competition_count(db, uid))
        if tier:
            _award(uid, "campaigner", tier)

    # 卫冕王：按 starts_at 升序取全部已 settled 的比赛（含本场——本场的 status
    # 与 final_rank 已经在上面那次 commit 里落盘），相邻两届冠军是同一人才发奖。
    settled_comps = (db.query(Competition)
                        .filter(Competition.status == "settled")
                        .order_by(Competition.starts_at.asc()).all())
    # 冠军一次查完：以前是对每场比赛单独发一次 .first()，比赛场次只增不减，
    # 结算耗时随历史线性变长。final_rank == 1 每场至多一人（final_rank 唯一），
    # 所以按 competition_id 建字典不会互相覆盖；没有冠军的场次在字典里缺席，
    # 下面 .get() 读出 None，与原先的语义一致。
    # Fetch every champion in one query: this used to issue one .first() per
    # settled competition, and the count only grows, so settlement got slower
    # with every season. final_rank == 1 holds at most one row per competition,
    # so keying by competition_id cannot collide; competitions without a
    # champion are simply absent and .get() below yields None as before.
    winner_by_comp: dict[str, str | None] = {}
    if settled_comps:
        rows = (db.query(CompetitionParticipant.competition_id, CompetitionParticipant.user_id)
                  .filter(CompetitionParticipant.competition_id.in_([c.id for c in settled_comps]),
                          CompetitionParticipant.final_rank == 1).all())
        winner_by_comp = {comp_id: uid for comp_id, uid in rows}
    for prev, cur in zip(settled_comps, settled_comps[1:]):
        w_prev, w_cur = winner_by_comp.get(prev.id), winner_by_comp.get(cur.id)
        if w_prev is not None and w_prev == w_cur:
            _award(w_cur, "comp_back_to_back")

    return {"ranked": ranked, "badges": badges, "badgeErrors": badge_errors}
