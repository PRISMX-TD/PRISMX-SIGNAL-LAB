"""客服台的服务层（设计 2026-10-17）：日志、计数、通知、客服降级后的回收、提醒 / 过期扫描。

路由在 routers/support.py；用户卡片序列化在 services/support_view.py；转化在 services/conversions.py。

Support-desk service layer: activity logging, counters, notifications, cleanup when
an agent is demoted / disabled, and the reminder / expiry sweep. Routes live in
routers/support.py, the customer card in services/support_view.py, conversions in
services/conversions.py.
"""
from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy import func
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from app.core.database import SessionLocal
from app.models import FOLLOW_UP_ACTIVE_STATUSES, FollowUp, SupportAction, Ticket, User
from app.services import activity_log
from app.services.deps import StaffCtx
from app.services.notification_feed import (
    KIND_SUPPORT_ALERT,
    KIND_SUPPORT_REMINDER,
    create_notification,
    notify_ws,
)

logger = logging.getLogger("prismx.support_desk")

# 提醒 / 过期扫描间隔（设计 §5.3：每 5 分钟）/ sweep interval (design §5.3: every 5 minutes)
SWEEP_INTERVAL_SECONDS = 5 * 60
# 即将过期提前多久提醒 / how early the "expiring soon" reminder goes out
EXPIRING_NOTICE = timedelta(days=3)

FOLLOW_UP_GOALS = ("open_mt5", "open_signallab", "renew", "activate_trial", "revisit")
FOLLOW_UP_PRIORITIES = ("low", "normal", "high")
FOLLOW_UP_STATUSES = (
    "pending", "contacted", "interested", "converted", "no_interest", "unreachable", "revoked", "expired",
)
# 客服可以自己切的状态（revoked / expired 只有 admin / 系统能写）
# Statuses an agent may set themselves (revoked / expired are admin / system only)
STAFF_SETTABLE_STATUSES = ("pending", "contacted", "interested", "converted", "no_interest", "unreachable")

# SupportAction.kind
ACT_VIEW = "view_customer"
ACT_REVEAL = "reveal_phone"
ACT_SEARCH = "search"
ACT_RESET_TRIAL = "reset_trial"
ACT_COMP_DAYS = "comp_days"
ACT_UNBIND = "unbind"
ACT_RESEND = "resend_verification"
ACT_MESSAGE = "message"


def utcnow() -> datetime:
    """不带时区的 UTC（库里的时间列都是这个口径）/ naive UTC, like every column here."""
    return datetime.now(timezone.utc).replace(tzinfo=None)


def naive(dt: datetime | None) -> datetime | None:
    if dt is None:
        return None
    if dt.tzinfo is not None:
        return dt.astimezone(timezone.utc).replace(tzinfo=None)
    return dt


def actor_type(ctx: StaffCtx) -> str:
    return activity_log.ACTOR_ADMIN if ctx.is_admin else activity_log.ACTOR_SUPPORT


def log(db: Session, ctx: StaffCtx, kind: str, *, user_id: str | None = None,
        ref_id: str | None = None, data: dict | None = None) -> None:
    """记一条客服台操作日志（随调用方的 commit）/ one desk activity row, riding the caller's commit."""
    activity_log.log_event(
        db, kind, user_id=user_id, actor_type=actor_type(ctx), actor_id=ctx.user.id,
        ref_id=ref_id, data=data or {},
    )


def record_action(db: Session, actor_id: str, kind: str, target_user_id: str | None = None,
                  data: dict | None = None) -> None:
    db.add(SupportAction(
        actor_id=actor_id, target_user_id=target_user_id, kind=kind,
        data=json.dumps(data, ensure_ascii=False) if data else None,
    ))


def count_actions(db: Session, actor_id: str, kind: str, since: datetime) -> int:
    return (
        db.query(func.count(SupportAction.id))
        .filter(SupportAction.actor_id == actor_id, SupportAction.kind == kind,
                SupportAction.created_at >= since)
        .scalar()
        or 0
    )


def day_start() -> datetime:
    """「每日」按 STATS_TZ 自然日切（与看板一致），返回该日零点的 naive UTC。
    The daily cap resets at the STATS_TZ day boundary (same as the dashboard)."""
    from app.services.stats_time import day_start_utc, today

    return naive(day_start_utc(today()))


def staff_recipients(db: Session, exclude: str | None = None) -> list[str]:
    """在岗的工作人员：admin + 未停用的客服 / on-duty staff: admins plus enabled support agents."""
    rows = (
        db.query(User.id)
        .filter(User.role.in_(("admin", "support")), User.disabled_at.is_(None))
        .all()
    )
    return [r[0] for r in rows if r[0] != exclude]


def admin_ids(db: Session) -> list[str]:
    return [r[0] for r in db.query(User.id).filter(User.role == "admin", User.disabled_at.is_(None)).all()]


def notify(db: Session, user_ids, kind: str, text: str, link: str, ref_id: str | None = None) -> list[str]:
    ids = list(dict.fromkeys(i for i in user_ids if i))
    for uid in ids:
        create_notification(db, uid, kind, text=text, link=link, ref_id=ref_id)
    return ids


def flush_ws(user_ids) -> None:
    for uid in user_ids:
        try:
            notify_ws(uid)
        except Exception:
            logger.debug("notify_ws failed", exc_info=True)


def user_label(user: User | None) -> str:
    if user is None:
        return ""
    return user.nickname or f"#{user.id[:8]}"


def check_anomaly(db: Session, ctx: StaffCtx, kind: str) -> list[str]:
    """单个客服 1 小时内查看完整电话 / 卡片超过阈值 → 通知 admin（只在**刚越线**那一次发，
    不每次都发）。admin 自己不算。返回收到通知的 admin id（调用方 commit 后 flush_ws）。
    Alert admins when one agent crosses the hourly reveal / view threshold — once,
    on the crossing, not on every call. Admins themselves are exempt."""
    if ctx.is_admin:
        return []
    from app.services.settings_store import get_support_settings

    s = get_support_settings(db)
    threshold = s["support_alert_reveal_per_hour"] if kind == ACT_REVEAL else s["support_alert_views_per_hour"]
    if threshold <= 0:
        return []
    db.flush()
    n = count_actions(db, ctx.user.id, kind, utcnow() - timedelta(hours=1))
    if n != threshold + 1:
        return []
    what = "查看完整电话 / phone reveals" if kind == ACT_REVEAL else "查看客户卡片 / card views"
    return notify(
        db, admin_ids(db), KIND_SUPPORT_ALERT,
        text=f"{user_label(ctx.user)} · {what} > {threshold}/h",
        link="/admin?tab=support", ref_id=ctx.user.id,
    )


def release_staff_assignments(db: Session, staff: User, actor_id: str) -> dict:
    """客服被降为普通用户或被停用：名下进行中的跟进全部收回（status=revoked，用户回到待分配池），
    工单的指派清空。不提交，随调用方的 commit。
    When an agent is demoted or disabled: revoke their active follow-ups (the users
    return to the unassigned pool) and clear their ticket assignments. No commit."""
    now = utcnow()
    fus = (
        db.query(FollowUp)
        .filter(FollowUp.assignee_id == staff.id, FollowUp.status.in_(FOLLOW_UP_ACTIVE_STATUSES))
        .all()
    )
    for fu in fus:
        fu.status = "revoked"
        fu.closed_at = now
        activity_log.log_event(
            db, activity_log.SUPPORT_FOLLOW_UP, user_id=fu.user_id,
            actor_type=activity_log.ACTOR_ADMIN, actor_id=actor_id, ref_id=fu.id,
            data={"action": "revoke", "reason": "staff_removed", "from": staff.id},
        )
    tickets = (
        db.query(Ticket)
        .filter(Ticket.assignee_id == staff.id)
        .update({"assignee_id": None}, synchronize_session=False)
    )
    return {"followUps": len(fus), "tickets": tickets or 0}


# ─────────────────────────────────────────────────────────────────────────────
# 提醒 / 过期扫描 / reminder and expiry sweep
# ─────────────────────────────────────────────────────────────────────────────
def _push(user_id: str, title: str, body: str) -> None:
    try:
        from app.services.push_dispatch import EVENT_SUPPORT_REMINDER, dispatch_event_push

        dispatch_event_push(user_id, EVENT_SUPPORT_REMINDER, title, body)
    except Exception:
        logger.warning("客服提醒推送失败 / support reminder push failed: user=%s", user_id, exc_info=True)


def sweep_follow_ups(now: datetime | None = None, db: Session | None = None) -> dict:
    """一轮扫描：① 过期的进行中跟进置 expired（通知客服 + admin 汇总）；② 新分配、到点、
    即将过期（提前 3 天）提醒客服（站内 + 推送）。每种提醒都有去重标记，不会每 5 分钟重复。
    同步、自己开 session（测试可传 db）；由 support_desk_loop 放进线程池调用。
    One sweep: expire overdue active follow-ups (notify the agent, plus one summary
    to admins), then remind agents of new assignments, due contacts and follow-ups
    expiring within 3 days (in-app + push). Every reminder has a dedupe marker, so
    nothing repeats every 5 minutes. Synchronous with its own session (tests may
    pass one); the loop runs it in the thread pool."""
    now = naive(now) or utcnow()
    own = db is None
    db = db or SessionLocal()
    pushes: list[tuple[str, str, str]] = []
    touched: list[str] = []
    counts = {"expired": 0, "assigned": 0, "due": 0, "expiring": 0}
    try:
        active = db.query(FollowUp).filter(FollowUp.status.in_(FOLLOW_UP_ACTIVE_STATUSES)).all()
        users = {u.id: u for u in db.query(User).filter(User.id.in_({f.user_id for f in active}))} if active else {}
        expired_by_admin = 0
        for fu in active:
            label = user_label(users.get(fu.user_id))
            link = f"/support-desk?followUp={fu.id}"
            exp = naive(fu.expires_at)
            if exp is not None and exp < now:
                fu.status = "expired"
                fu.closed_at = now
                activity_log.log_event(
                    db, activity_log.SUPPORT_FOLLOW_UP, user_id=fu.user_id,
                    actor_type=activity_log.ACTOR_SYSTEM, ref_id=fu.id, data={"action": "expired"},
                )
                touched += notify(db, [fu.assignee_id], KIND_SUPPORT_REMINDER, f"已过期 / expired · {label}", link, fu.id)
                counts["expired"] += 1
                expired_by_admin += 1
                continue
            if not fu.assigned_notified:
                fu.assigned_notified = True
                touched += notify(db, [fu.assignee_id], KIND_SUPPORT_REMINDER, f"新分配 / new · {label}", link, fu.id)
                pushes.append((fu.assignee_id, "新的跟进 / New follow-up", label))
                counts["assigned"] += 1
            nxt = naive(fu.next_contact_at)
            if nxt is not None and nxt <= now and naive(fu.reminded_next_at) != nxt:
                fu.reminded_next_at = nxt
                touched += notify(db, [fu.assignee_id], KIND_SUPPORT_REMINDER, f"到点跟进 / due · {label}", link, fu.id)
                pushes.append((fu.assignee_id, "该跟进了 / Follow-up due", label))
                counts["due"] += 1
            if exp is not None and not fu.expiring_notified and exp - now <= EXPIRING_NOTICE:
                fu.expiring_notified = True
                touched += notify(db, [fu.assignee_id], KIND_SUPPORT_REMINDER, f"即将过期 / expiring · {label}", link, fu.id)
                pushes.append((fu.assignee_id, "跟进即将过期 / Follow-up expiring", label))
                counts["expiring"] += 1
        if expired_by_admin:
            touched += notify(
                db, admin_ids(db), KIND_SUPPORT_ALERT,
                f"{expired_by_admin} 条跟进已过期 / follow-ups expired", "/admin?tab=support",
            )
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        if own:
            db.close()
    flush_ws(set(touched))
    for uid, title, body in pushes:
        _push(uid, title, body)
    return counts


async def support_desk_loop() -> None:
    """每 5 分钟跑一次 sweep_follow_ups（线程池里，别卡事件循环）。
    Run sweep_follow_ups every 5 minutes in the thread pool."""
    from app.services import loop_health

    while True:
        loop_health.beat("support_desk")
        try:
            await run_in_threadpool(sweep_follow_ups)
        except Exception:
            logger.exception("support_desk_loop error")
        await asyncio.sleep(SWEEP_INTERVAL_SECONDS)
