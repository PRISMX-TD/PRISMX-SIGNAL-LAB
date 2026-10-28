"""用户「最近动态」时间线（2026-10-28）：管理后台的用户档案抽屉、客服台的客户卡片共用。

把散在几张表里、跟「这个人最近在干什么」有关的事合成一条按时间倒序的列表：
注册、比赛报名与名次、幸运转盘中奖、付款、会员变更、工单、登录 / 绑定等账号事件。
每类只取最近几条，整条列表再截到 limit——这是给人扫一眼的，不是审计报表（审计看操作日志）。

权限沿用 support_view 的权限表：付款金额只给 admin；MT5 账号对内部客服只露后 4 位，
对外包整个不给；会员变更的操作人姓名外包看不到。

The user's "recent activity" timeline (2026-10-28), shared by the admin user drawer and the
support desk's customer card. Merges the "what has this person been up to" facts spread over
several tables into one newest-first list: sign-up, competition entries and ranks, lucky-wheel
wins, payments, plan changes, tickets, and account events (login / bind …). Each source is
capped and the merged list trimmed to `limit` — this is for a glance, not an audit (the
activity log is the audit). Permissions follow support_view's table: payment amounts are
admin-only; MT5 logins are last-4 for internal agents and absent for outsourced; plan-change
actor names are hidden from outsourced agents.
"""
from __future__ import annotations

import json
from datetime import datetime

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models import (
    ActivityEvent,
    AdminAuditLog,
    Competition,
    CompetitionParticipant,
    LeaderboardSnapshot,
    LuckyDraw,
    Payment,
    Ticket,
    User,
)
from app.services.deps import StaffCtx

# 每类最多取几条 / per-source cap
PER_SOURCE = 10
DEFAULT_LIMIT = 40

# 时间线里展示的账号事件（其余如自动仓管设置、结果更正留在操作日志里看）
# Account events shown on the timeline; the rest stay in the activity log
EVENT_KINDS = (
    "user.login",
    "user.email_verified",
    "user.password_changed",
    "user.password_reset",
    "user.nickname",
    "user.phone_set",
    "mt5.bind",
    "mt5.unbind",
    "mt5.revoked",
)

# 会员相关的审计字段 / plan-related audit fields
PLAN_FIELDS = ("plan", "plan_expires_at", "role")


def _login_for(login: str | None, ctx: StaffCtx) -> str | None:
    if not login:
        return None
    if ctx.is_admin:
        return str(login)
    if ctx.is_outsourced:
        return None
    return "****" + str(login)[-4:]


def _comp_items(db: Session, user_id: str, ctx: StaffCtx) -> list[dict]:
    rows = (
        db.query(CompetitionParticipant, Competition)
        .join(Competition, Competition.id == CompetitionParticipant.competition_id)
        .filter(CompetitionParticipant.user_id == user_id)
        .order_by(CompetitionParticipant.registered_at.desc())
        .limit(PER_SOURCE)
        .all()
    )
    if not rows:
        return []
    # 进行中 / 已结束未终审的比赛读榜单快照里的名次与成绩；已终审用写死的 final_rank。
    # Live / unsettled contests read rank + score from the snapshot; settled ones use final_rank.
    keys = {f"comp:{c.id}" for _, c in rows}
    snaps = {
        (s.period_key, s.mt5_login): s
        for s in db.query(LeaderboardSnapshot)
        .filter(LeaderboardSnapshot.period_key.in_(keys), LeaderboardSnapshot.user_id == user_id)
        .all()
    }
    totals = dict(
        db.query(LeaderboardSnapshot.period_key, func.count(LeaderboardSnapshot.id))
        .filter(LeaderboardSnapshot.period_key.in_(keys))
        .group_by(LeaderboardSnapshot.period_key)
        .all()
    )
    out = []
    for p, c in rows:
        key = f"comp:{c.id}"
        snap = snaps.get((key, str(p.mt5_login)))
        settled = c.status == "settled"
        rank = p.final_rank if settled else (snap.rank if snap else None)
        score = p.final_score if settled and p.final_score is not None else (snap.score if snap else None)
        out.append({
            "kind": "comp",
            "at": p.registered_at,
            "compId": c.id,
            "name": c.name,
            "status": c.status,
            "metric": c.metric,
            "login": _login_for(p.mt5_login, ctx),
            "rank": rank,
            "total": totals.get(key),
            "score": score,
            "disqualified": bool(p.disqualified),
        })
    return out


def _lucky_items(db: Session, user_id: str) -> list[dict]:
    rows = (
        db.query(LuckyDraw)
        .filter(LuckyDraw.user_id == user_id)
        .order_by(LuckyDraw.created_at.desc())
        .limit(PER_SOURCE)
        .all()
    )
    out = []
    for d in rows:
        try:
            snap = json.loads(d.prize_snapshot or "{}")
        except ValueError:
            snap = {}
        out.append({
            "kind": "lucky",
            "at": d.created_at,
            "prize": snap.get("name"),
            "prizeKind": snap.get("kind"),
            "status": d.fulfillment_status,
            "soldOut": bool(d.sold_out_miss),
            "ticketId": d.support_ticket_id,
        })
    return out


def _payment_items(db: Session, user_id: str) -> list[dict]:
    rows = (
        db.query(Payment)
        .filter(Payment.user_id == user_id, Payment.status == "FINISHED")
        .order_by(Payment.created_at.desc())
        .limit(PER_SOURCE)
        .all()
    )
    return [
        {"kind": "payment", "at": p.finished_at or p.created_at, "plan": p.plan, "amountUsd": p.amount_usd}
        for p in rows
    ]


def _plan_items(db: Session, user_id: str, ctx: StaffCtx) -> list[dict]:
    rows = (
        db.query(AdminAuditLog)
        .filter(AdminAuditLog.target_user_id == user_id, AdminAuditLog.field.in_(PLAN_FIELDS))
        .order_by(AdminAuditLog.created_at.desc())
        .limit(PER_SOURCE)
        .all()
    )
    names: dict[str, str] = {}
    if rows and not ctx.is_outsourced:
        ids = {r.admin_user_id for r in rows if r.admin_user_id != user_id}
        if ids:
            names = {u.id: (u.nickname or u.email) for u in db.query(User).filter(User.id.in_(ids)).all()}
    return [
        {
            "kind": "plan",
            "at": r.created_at,
            "field": r.field,
            "old": r.old_value,
            "new": r.new_value,
            "by": names.get(r.admin_user_id),
        }
        for r in rows
    ]


def _ticket_items(db: Session, user_id: str) -> list[dict]:
    rows = (
        db.query(Ticket)
        .filter(Ticket.user_id == user_id)
        .order_by(Ticket.created_at.desc())
        .limit(PER_SOURCE)
        .all()
    )
    return [
        {"kind": "ticket", "at": t.created_at, "ticketId": t.id, "title": t.title,
         "category": t.category, "status": t.status}
        for t in rows
    ]


def _event_items(db: Session, user_id: str, ctx: StaffCtx) -> list[dict]:
    rows = (
        db.query(ActivityEvent)
        .filter(ActivityEvent.user_id == user_id, ActivityEvent.kind.in_(EVENT_KINDS))
        .order_by(ActivityEvent.created_at.desc())
        .limit(PER_SOURCE)
        .all()
    )
    return [
        {"kind": "event", "at": e.created_at, "event": e.kind, "login": _login_for(e.mt5_login, ctx)}
        for e in rows
    ]


def recent_activity(db: Session, user: User, ctx: StaffCtx, limit: int = DEFAULT_LIMIT) -> list[dict]:
    """合并后的时间线，新的在前。/ The merged timeline, newest first."""
    items: list[dict] = [{"kind": "signup", "at": user.created_at}]
    items += _comp_items(db, user.id, ctx)
    items += _lucky_items(db, user.id)
    if ctx.is_admin:
        items += _payment_items(db, user.id)
    items += _plan_items(db, user.id, ctx)
    items += _ticket_items(db, user.id)
    items += _event_items(db, user.id, ctx)
    items = [i for i in items if i.get("at") is not None]
    items.sort(key=lambda i: i["at"] or datetime.min, reverse=True)
    return items[:limit]
