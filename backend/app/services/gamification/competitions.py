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
from app.services.account_type import CONTEST, DEMO
from .boards import REAL, _aware, _resolved_in_period, board_gates, reconcile_deposits


TRACKS = ("real", "demo")
# 赛道 → 允许参赛的 trade_mode 集合。demo 赛道收模拟与赛区账户（都不是真金白银）；
# trade_mode 为 NULL（尚未判定）的账户两个赛道都不收——宁可不让报名，也不能把
# 一个还没判出类型的账户放进以本金论英雄的榜里。
# Track → the trade_mode values it accepts. The demo track takes both demo and
# contest accounts (neither is real money). Accounts with a NULL trade_mode (not yet
# classified) are accepted by neither: better to refuse entry than to admit an
# unclassified account to a board scored on capital.
_TRACK_MODES = {"real": (REAL,), "demo": (DEMO, CONTEST)}


def track_modes(track: str) -> tuple[int, ...]:
    return _TRACK_MODES.get(track or "real", _TRACK_MODES["real"])


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
        profits_by_login = _resolved_in_period(db, uid, logins, period_key, taken,
                                                bounds=(starts_at, ends_at))
        for lg in logins:
            b = baseline_by_login[lg]
            profits = profits_by_login.get(lg, [])
            sample = len(profits)
            total = sum(profits)
            denom = b.baseline + b.adjust
            if comp.metric == "return_pct":
                if sample >= min_trades_return and denom >= min_baseline and denom > 0:
                    rows.append({"userId": uid, "login": lg,
                                "score": total / denom, "sample": sample})
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

    acct = (db.query(MT5Account)
              .filter(MT5Account.user_id == user.id, MT5Account.login == mt5_login).first())
    if acct is None or acct.trade_mode not in track_modes(comp.track):
        detail = ("仅实盘账户可参赛 / Only real accounts may enter" if comp.track == "real"
                  else "仅模拟账户可参赛 / Only demo accounts may enter")
        raise HTTPException(status_code=400, detail=detail)
    if acct.balance is None:
        raise HTTPException(status_code=400,
                            detail="账户余额未同步，请先连接账户 / Account balance not synced yet")

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
    accounts = (db.query(MT5Account)
                  .filter(MT5Account.trade_mode.in_(track_modes(comp.track)),
                          MT5Account.balance.isnot(None)).all())
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
    """终审（设计 §1.7/§1.9，Phase 3 Task 4；§5.3 宽限期，Task F）：结算不可重跑，
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
    if comp.status != "ended":
        raise HTTPException(
            status_code=400,
            detail="仅可终审已结束的比赛 / Only ended competitions can be settled")

    now = _aware(now) or datetime.now(timezone.utc)
    grace_until = _aware(comp.ends_at) + timedelta(hours=24)
    if now < grace_until:
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

    # 审计：照 admin.py 的 _log_change 先例（本函数内 import，不在模块顶层，
    # 避免给 admin 路由模块和 gamification 服务层之间引入任何加载顺序耦合）。
    # old/new 特意给出两个不同的值——_log_change 在两者相等时直接静默跳过写入。
    from app.routers.admin import _log_change
    _log_change(db, admin_id, admin_id, f"competition:settle:{comp.id}", "ended", "settled")

    db.commit()   # 名次 + status + 审计：终局状态到此为止，下面发奖失败不会回退到这里

    badges: list[dict] = []
    badge_errors: list[dict] = []

    def _award(user_id: str, badge_id: str) -> None:
        try:
            if award_badge(db, user_id, badge_id):
                badges.append({"userId": user_id, "badgeId": badge_id})
        except Exception as exc:
            # award_badge 自己只兜住 IntegrityError；任何其它异常（推送逻辑之外，
            # 比如 commit 中途的连接错误）会把 session 撂在一个"脏"事务里——
            # Postgres 下这类 session 后续任何语句都会被级联拒绝（当前语句失败后
            # 事务已 abort），必须先 rollback 清空，才能继续发下一枚勋章或做别的
            # 查询。失败本身不重新抛出，收进 badge_errors 供人工补发。
            db.rollback()
            badge_errors.append({"userId": user_id, "badgeId": badge_id, "error": str(exc)})

    for uid in finisher_users:
        _award(uid, "comp_finisher")
    for uid in podium_users:
        _award(uid, "comp_podium")
    if winner_user is not None:
        _award(winner_user, "comp_winner")

    # 卫冕王：按 starts_at 升序取全部已 settled 的比赛（含本场——本场的 status
    # 与 final_rank 已经在上面那次 commit 里落盘），相邻两届冠军是同一人才发奖。
    settled_comps = (db.query(Competition)
                        .filter(Competition.status == "settled")
                        .order_by(Competition.starts_at.asc()).all())
    winner_by_comp: dict[str, str | None] = {}
    for c in settled_comps:
        row = (db.query(CompetitionParticipant.user_id)
                 .filter(CompetitionParticipant.competition_id == c.id,
                         CompetitionParticipant.final_rank == 1).first())
        winner_by_comp[c.id] = row[0] if row else None
    for prev, cur in zip(settled_comps, settled_comps[1:]):
        w_prev, w_cur = winner_by_comp[prev.id], winner_by_comp[cur.id]
        if w_prev is not None and w_prev == w_cur:
            _award(w_cur, "comp_back_to_back")

    return {"ranked": ranked, "badges": badges, "badgeErrors": badge_errors}
