"""比赛计分（设计 §1.7/§1.8）：按参赛条目过滤 + scoring_from 下限 + metric 门槛，
快照写入 leaderboard_snapshots（board=comp.metric, period_key=comp:<id>）。

复用 boards.py 的 `_resolved_in_period`/`reconcile_deposits`——两者都新增了可选
`bounds` 参数（默认 None 时行为与 Phase 2 完全一致），比赛这边显式传
(comp.starts_at, comp.ends_at)，因为比赛 key（`comp:<id>`）不是 `period_bounds`
能解析的自然周/月格式。
"""
from collections import defaultdict
from datetime import datetime

from fastapi import HTTPException
from sqlalchemy.exc import IntegrityError

from app.models import (
    Competition, CompetitionParticipant, LeaderboardSnapshot, MT5Account, PeriodBaseline, User,
)
from .badges import award_badge
from .boards import REAL, _aware, _resolved_in_period, reconcile_deposits


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
    min_baseline = float(get_gamification_settings(db).get("min_baseline_usd", 500.0))
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
                if sample >= 5 and denom >= min_baseline and denom > 0:
                    rows.append({"userId": uid, "login": lg,
                                "score": total / denom, "sample": sample})
            elif comp.metric == "win_rate":
                if sample >= 20 and total > 0:
                    wins = sum(1 for pr in profits if pr > 0)
                    rows.append({"userId": uid, "login": lg,
                                "score": wins / sample, "sample": sample})
    return rows


def snapshot_competitions(db, now: datetime) -> dict:
    """对 status in ("running", "ended")（未 settled）的比赛算行、排名、快照。

    running：先 `reconcile_deposits(db, comp_key, now=now, bounds=(starts_at,
    ends_at))`（基线拍照在报名/自动入场时完成，快照不补拍），再算行。
    ended（未 settled）：只重算计分，不再对账（与周期榜「结束周期不对账」的
    语义一致）。settled/draft/upcoming 绝不触碰。
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
        rows = compute_comp_rows(db, comp)
        rows.sort(key=lambda r: (-r["score"], -r["sample"], r["login"]))
        db.query(LeaderboardSnapshot).filter(
            LeaderboardSnapshot.board == comp.metric,
            LeaderboardSnapshot.period_key == key).delete()
        for i, r in enumerate(rows, start=1):
            db.add(LeaderboardSnapshot(board=comp.metric, period_key=key,
                                       user_id=r["userId"], mt5_login=r["login"],
                                       rank=i, score=r["score"], sample=r["sample"]))
        total_rows += len(rows)
        db.commit()
    return {"comps": len(comps), "rows": total_rows}


def register_participant(db, comp: Competition, user: User, mt5_login: str,
                          now: datetime) -> CompetitionParticipant:
    """报名参赛（设计 §1.7/§1.8）：仅 `enrollment=="signup"` 的比赛可报名，报名窗口内
    （`reg_opens_at <= now < reg_closes_at`；任一边未配置视为窗口未开放），账户须是
    本人名下、`trade_mode==2`（实盘）且余额已同步。参赛行 + `period_baselines
    (comp:<id>)` 基线在同一事务内一并插入、一次 commit——中途崩溃不会留下有参赛行
    却没基线的半截状态。撞唯一约束（并发重复报名）→ 回滚、原样返回已有条目（幂等）。
    """
    if comp.enrollment != "signup":
        raise HTTPException(status_code=400, detail="本比赛为自动参赛 / This competition auto-enrolls")

    now = _aware(now)
    opens, closes = _aware(comp.reg_opens_at), _aware(comp.reg_closes_at)
    if opens is None or closes is None or not (opens <= now < closes):
        raise HTTPException(status_code=400, detail="不在报名窗口内 / Registration window closed")

    acct = (db.query(MT5Account)
              .filter(MT5Account.user_id == user.id, MT5Account.login == mt5_login).first())
    if acct is None or acct.trade_mode != REAL:
        raise HTTPException(status_code=400, detail="仅实盘账户可参赛 / Only real accounts may enter")
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
    """自动入场（设计 §1.7/§1.8）：全部实盘（`trade_mode==2`）、余额非 NULL、属主
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
                  .filter(MT5Account.trade_mode == REAL, MT5Account.balance.isnot(None)).all())
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


def settle_competition(db, comp: Competition, admin_id: str) -> dict:
    """终审（设计 §1.7/§1.9，Phase 3 Task 4）：结算不可重跑，一切以 status 为闸。

    两段式、中间夹一次 commit，且顺序不可换：第一段把名次和 status="settled"
    连同审计行一起落盘并 commit——这一段完成后，比赛就已经终局，`comp.status
    != "ended"` 的前置校验会挡住任何重复调用。第二段才发奖：award_badge 内部
    自行 commit（沿用既有 house pattern），单枚失败只会漏发一枚勋章（可人工
    补发，幂等），绝不会传导回去把已经写死的名次或 status 撤回——所以失败被
    捕获进返回值的 badgeErrors，而不是抛出让调用方以为终审本身失败了。
    """
    if comp.status != "ended":
        raise HTTPException(
            status_code=400,
            detail="仅可终审已结束的比赛 / Only ended competitions can be settled")

    key = comp_period_key(comp.id)
    snapshots = (db.query(LeaderboardSnapshot)
                   .filter(LeaderboardSnapshot.board == comp.metric,
                           LeaderboardSnapshot.period_key == key)
                   .order_by(LeaderboardSnapshot.rank.asc()).all())
    by_login = {p.mt5_login: p for p in
                db.query(CompetitionParticipant).filter(
                    CompetitionParticipant.competition_id == comp.id)}

    ranked = 0
    finisher_users: set[str] = set()
    podium_users: set[str] = set()
    winner_user = None
    for snap in snapshots:
        participant = by_login.get(snap.mt5_login)
        # 双保险：disqualified 的参赛者理论上根本不会有快照行（compute_comp_rows
        # 已经把他们排除在计分之外），但终审是终局动作，宁可多判一次也不让一条
        # 意外留下的快照行把取消资格的人写进名次或发出奖。
        if participant is None or participant.disqualified:
            continue
        participant.final_score = snap.score
        participant.final_rank = snap.rank
        ranked += 1
        finisher_users.add(participant.user_id)
        if snap.rank <= 3:
            podium_users.add(participant.user_id)
        if snap.rank == 1:
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
