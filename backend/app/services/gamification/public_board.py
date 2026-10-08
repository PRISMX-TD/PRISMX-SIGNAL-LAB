"""公开比赛页（设计 §1.3/§1.7/§1.8/§3.1/§3.2）：未登录访客看到的载荷、可见性判定、
主推比赛挑选、推广漏斗打点与统计。

这里的载荷会进 shared_cache 全员共享（routers/public_competitions.py），所以**不能有
任何按观众个性化的字段**，也不能有 login / userId / profileId / email——字段白名单见
设计 §1.8。名字只在本人报名时同意公开（public_name is True）且管理员没隐藏、没退榜、
设了昵称时才给，否则 null（前端显示「匿名选手」），徽章随名字一起隐去。

Public competition pages: the anonymous visitor's payload, visibility rules,
featured-competition pick and promo funnel counters. The payload is cached and
shared by everyone, so it must carry nothing viewer-specific and no login /
userId / profileId / email (whitelist in design §1.8). A name is shown only
when the entrant opted in, wasn't hidden by an admin, hasn't opted out of
boards and has a nickname; otherwise null, with the badge hidden too.
"""
from __future__ import annotations

import re
from collections import defaultdict
from datetime import datetime, timezone

from sqlalchemy import func
from sqlalchemy.exc import IntegrityError

from app.models import (
    Competition, CompetitionParticipant, InviteLink, LeaderboardSnapshot, MT5Account,
    PromoFunnelDaily, User)
from app.services.settings_store import get_gamification_settings
from app.utils.timeutil import aware as _aware

from .badges import equipped_badge_tiers
from .competitions import comp_gates, comp_period_key, track_modes

# 大小写都认；调用方先 normalize_comp_id() 转小写再查库 / 拼缓存键（库里存小写）。
# Case-insensitive; callers lowercase via normalize_comp_id() before lookups.
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)
FUNNEL_STEPS = ("view", "cta", "open_account")
PUBLIC_ROWS = 50


def normalize_comp_id(comp_id: str | None) -> str:
    """手改的 /c/<ID> 链接可能是大写 UUID；库里与缓存键一律小写。
    Hand-edited links may carry an uppercase UUID; ids are stored lowercase."""
    return (comp_id or "").strip().lower()


def public_cache_key(comp_id: str) -> str:
    """公开详情的共享缓存键；管理端改比赛 / 参赛者改名字公开时按它失效。
    Shared-cache key of the public detail; admin edits and name toggles delete it."""
    return f"comp-public:{comp_id}"


def _iso(dt) -> str | None:
    return dt.isoformat() if dt else None


def public_switches_on(gset: dict) -> bool:
    """两个全局开关都开：比赛内测开关（站内可见）+ 公开页总开关。
    Both global switches: competitions visible in-app, and the public master switch."""
    return bool(gset.get("competitions_visible")) and bool(gset.get("competitions_public_enabled"))


def comp_public_eligible(comp: Competition) -> bool:
    """单场比赛自身的公开条件（§1.7）：非草稿、开了 public_view、模拟赛、报名制、
    填了 https 开户链接。与全局开关分开，是因为公开详情把全局开关放在缓存外面判。
    The competition's own conditions (§1.7), separate from the global switches,
    which the public detail checks outside its cache."""
    url = comp.open_account_url or ""
    return (comp.status != "draft" and bool(comp.public_view) and comp.track == "demo"
            and comp.enrollment == "signup" and url.startswith("https://"))


def is_publicly_viewable(db, comp: Competition | None) -> bool:
    if comp is None:
        return False
    return public_switches_on(get_gamification_settings(db)) and comp_public_eligible(comp)


def initial_public_name(db, comp: Competition) -> bool | None:
    """报名时 public_name 的初值：公开比赛的报名弹窗已写明「榜单会公开展示昵称与成绩」，
    报名即同意（True）；其余比赛不表态（None = 公开页匿名）。§1.8。
    Initial public_name at signup: True for a public competition (the dialog says
    the board is public), None otherwise (anonymous on the public page)."""
    return True if is_publicly_viewable(db, comp) else None


def featured_competition_id(db) -> str | None:
    """主推比赛（§1.3）：设置里钉的那场可公开就用它；否则在可公开且 running/upcoming
    的比赛里取开赛时间离现在最近的——running 优先（最近开赛的），再 upcoming（最快开赛的）。
    Featured competition (§1.3): the pinned one when publicly viewable; otherwise
    the publicly viewable running/upcoming competition whose start is nearest —
    running first (latest start), then upcoming (soonest start)."""
    gset = get_gamification_settings(db)
    if not public_switches_on(gset):
        return None
    pinned = gset.get("featured_competition_id")
    if pinned:
        comp = db.get(Competition, pinned)
        if comp is not None and comp_public_eligible(comp):
            return comp.id
    comps = [c for c in (db.query(Competition)
                           .filter(Competition.status.in_(("running", "upcoming")),
                                   Competition.public_view.is_(True)).all())
             if comp_public_eligible(c)]
    running = sorted((c for c in comps if c.status == "running"),
                     key=lambda c: _aware(c.starts_at), reverse=True)
    upcoming = sorted((c for c in comps if c.status == "upcoming"),
                      key=lambda c: _aware(c.starts_at))
    pick = (running + upcoming)[:1]
    return pick[0].id if pick else None


def _shown_name(p: CompetitionParticipant | None, u: User | None) -> str | None:
    if p is None or u is None:
        return None
    if p.public_name is not True or p.name_hidden is True or u.leaderboard_opt_out:
        return None
    return u.nickname or None


def build_public_payload(db, comp: Competition) -> dict:
    """§3.1 公开载荷。只读快照（公开 GET 不触发 refresh_comp_board），前 50 行。
    The §3.1 public payload: reads the snapshot only (no refresh), top 50 rows."""
    gset = get_gamification_settings(db)
    gates = comp_gates(comp, gset)
    key = comp_period_key(comp.id)
    snaps = (db.query(LeaderboardSnapshot)
               .filter(LeaderboardSnapshot.board == comp.metric,
                       LeaderboardSnapshot.period_key == key)
               .order_by(LeaderboardSnapshot.rank)
               .limit(PUBLIC_ROWS)
               .all())
    parts: dict[str, CompetitionParticipant] = {}
    users: dict[str, User] = {}
    if snaps:
        parts = {p.mt5_login: p for p in (db.query(CompetitionParticipant)
                   .filter(CompetitionParticipant.competition_id == comp.id,
                           CompetitionParticipant.mt5_login.in_({r.mt5_login for r in snaps})))}
        users = {u.id: u for u in db.query(User).filter(User.id.in_({r.user_id for r in snaps}))}
    tiers = equipped_badge_tiers(db, users.values())
    rows = []
    for r in snaps:
        p = parts.get(r.mt5_login)
        # 刚被取消资格的人在下一轮快照前还留在快照里；公开页不等，直接跳过。
        # A just-disqualified entrant stays in the snapshot until the next tick.
        if p is not None and p.disqualified is True:
            continue
        u = users.get(r.user_id)
        name = _shown_name(p, u)
        rows.append({
            "rank": r.rank,
            "displayName": name,
            "score": r.score,
            "sample": r.sample,
            # 匿名行连徽章也不给：徽章组合本身就能认出人。
            # Anonymous rows drop the badge too: a badge set can identify someone.
            "equippedBadge": u.equipped_badge if (name and u) else None,
            "equippedBadgeTier": tiers.get(r.user_id, 0) if name else 0,
        })
    snapshot_at = (db.query(func.max(LeaderboardSnapshot.computed_at))
                     .filter(LeaderboardSnapshot.board == comp.metric,
                             LeaderboardSnapshot.period_key == key).scalar())
    participants = (db.query(func.count(func.distinct(CompetitionParticipant.user_id)))
                      .filter(CompetitionParticipant.competition_id == comp.id,
                              CompetitionParticipant.disqualified.isnot(True)).scalar()) or 0
    next_id = None
    if comp.status in ("ended", "settled"):
        fid = featured_competition_id(db)
        next_id = fid if fid and fid != comp.id else None
    min_trades = (gates["min_trades_winrate"] if comp.metric == "win_rate"
                  else gates["min_trades_return"])
    return {
        "id": comp.id,
        "name": comp.name,
        "description": comp.description,
        "prizeNote": comp.prize_note,
        "metric": comp.metric,
        "track": comp.track,
        "enrollment": comp.enrollment,
        "status": comp.status,
        "regOpensAt": _iso(comp.reg_opens_at),
        "regClosesAt": _iso(comp.reg_closes_at),
        "startsAt": _iso(comp.starts_at),
        "endsAt": _iso(comp.ends_at),
        "participants": int(participants),
        "gates": {
            "minBaselineUsd": gates["min_baseline_usd"],
            "maxBaselineUsd": gates["max_baseline_usd"],
            "minTrades": min_trades,
        },
        "openAccountUrl": comp.open_account_url,
        "snapshotAt": _iso(_aware(snapshot_at)) if snapshot_at else None,
        "rows": rows,
        "nextCompetitionId": next_id,
    }


def record_funnel_event(db, comp_id: str, step: str, ref: str | None,
                        day: str | None = None) -> bool:
    """公开页漏斗打点（view / cta / open_account）。只给可公开的比赛计数；ref 只认真实
    存在且启用的邀请码，否则记 ''（无码）——任意字符串不能在表里造行。返回是否计入。

    并发两个请求同时插同一 (day, comp, code, step) 时，后插的撞唯一键：在 SAVEPOINT 里
    插，撞了回滚 SAVEPOINT 再走一次原子 +1。

    Funnel counter for the public page. Only publicly viewable competitions count;
    ref must be a real active invite code, otherwise it is recorded as '' so
    arbitrary strings can't mint rows. A concurrent insert of the same key hits
    the unique constraint inside a SAVEPOINT and falls back to the atomic +1.
    """
    comp_id = normalize_comp_id(comp_id)
    if step not in FUNNEL_STEPS or not UUID_RE.match(comp_id):
        return False
    comp = db.get(Competition, comp_id)
    if not is_publicly_viewable(db, comp):
        return False
    code = ""
    norm = (ref or "").strip().lower()
    if norm and db.query(InviteLink.id).filter(InviteLink.code == norm,
                                               InviteLink.is_active.is_(True)).first():
        code = norm
    day = day or datetime.now(timezone.utc).strftime("%Y-%m-%d")
    match = (PromoFunnelDaily.day == day, PromoFunnelDaily.competition_id == comp.id,
             PromoFunnelDaily.code == code, PromoFunnelDaily.step == step)

    def bump() -> int:
        return (db.query(PromoFunnelDaily).filter(*match)
                  .update({PromoFunnelDaily.count: PromoFunnelDaily.count + 1},
                          synchronize_session=False))

    if not bump():
        try:
            with db.begin_nested():
                db.add(PromoFunnelDaily(day=day, competition_id=comp.id, code=code,
                                        step=step, count=1))
        except IntegrityError:
            bump()
    db.commit()
    return True


def build_funnel(db, comp: Competition) -> dict:
    """§3.2 本场推广漏斗：每条本场推广链接（invite_links.competition_id == comp.id）一行。
    clicks 来自链接自身计数；views/ctas/openAccounts 来自 promo_funnel_daily 求和；
    registrations/verified/bound 按 users.invite_code == code；entries = 本场未取消资格的
    参赛条目数。noRef 是没带码进公开页的访客（code = ''）。
    Per-link promo funnel for one competition (§3.2); noRef = visitors without a code."""
    from app.services.gateway_binding import not_removed

    links = (db.query(InviteLink).filter(InviteLink.competition_id == comp.id)
               .order_by(InviteLink.created_at.asc()).all())
    codes = [lk.code for lk in links]
    steps: dict[str, dict[str, int]] = defaultdict(lambda: {s: 0 for s in FUNNEL_STEPS})
    for code, step, n in (db.query(PromoFunnelDaily.code, PromoFunnelDaily.step,
                                   func.sum(PromoFunnelDaily.count))
                            .filter(PromoFunnelDaily.competition_id == comp.id)
                            .group_by(PromoFunnelDaily.code, PromoFunnelDaily.step).all()):
        if step in FUNNEL_STEPS:
            steps[code][step] = int(n or 0)

    def per_code(q) -> dict[str, int]:
        return {c: int(n) for c, n in q.group_by(User.invite_code).all()}

    regs: dict[str, int] = {}
    verified: dict[str, int] = {}
    bound: dict[str, int] = {}
    entries: dict[str, int] = {}
    if codes:
        users_q = (db.query(User.invite_code, func.count(func.distinct(User.id)))
                     .filter(User.invite_code.in_(codes)))
        regs = per_code(users_q)
        verified = per_code(users_q.filter(User.email_verified_at.isnot(None)))
        bound = per_code(users_q.join(MT5Account, MT5Account.user_id == User.id)
                                .filter(MT5Account.source == "gateway",
                                        MT5Account.revoked_at.is_(None), not_removed(),
                                        MT5Account.trade_mode.in_(track_modes(comp.track))))
        entries = per_code(db.query(User.invite_code, func.count(CompetitionParticipant.id))
                             .join(CompetitionParticipant, CompetitionParticipant.user_id == User.id)
                             .filter(User.invite_code.in_(codes),
                                     CompetitionParticipant.competition_id == comp.id,
                                     CompetitionParticipant.disqualified.isnot(True)))
    return {
        "links": [{
            "code": lk.code,
            "label": lk.label,
            "channel": lk.channel,
            "clicks": int(lk.clicks or 0),
            "views": steps[lk.code]["view"],
            "ctas": steps[lk.code]["cta"],
            "openAccounts": steps[lk.code]["open_account"],
            "registrations": regs.get(lk.code, 0),
            "verified": verified.get(lk.code, 0),
            "bound": bound.get(lk.code, 0),
            "entries": entries.get(lk.code, 0),
        } for lk in links],
        "noRef": {"views": steps[""]["view"], "ctas": steps[""]["cta"],
                  "openAccounts": steps[""]["open_account"]},
    }
