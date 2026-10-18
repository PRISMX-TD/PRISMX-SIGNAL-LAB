"""客服台路由（设计 docs/superpowers/specs/2026-10-17-support-desk-design.md）。

两组：
- `router`（/support，require_staff）：客服与管理员共用的工作台——查找用户、客户卡片、查看完整电话、
  受限操作（重发验证 / 解绑 / 重置试用 / 补偿天数）、我的跟进、跟进记录、站内来信、申请、模板。
- `admin_router`（/admin/support，require_admin）：客服管理——成员 / tier / 查看上限、跟进分配 /
  收回 / 改派 / 延期、跟进进度与完整记录、待审批、转化审核与补录、业绩看板、模板维护、客服台设置。

权限全部在后端：客户信息只经 services/support_view.serialize_customer 输出；可见范围见
_visible_user。所有查看敏感信息与写操作都进操作日志（actor_type=support，admin 记 admin）。
客服接口不提供导出、批量浏览，列表单页最多 50。

Support-desk routes. `router` (/support, require_staff) is the shared workbench;
`admin_router` (/admin/support, require_admin) manages staff, assignments,
follow-up progress and records, approvals, stats, templates and settings.
Every permission is enforced here:
customer data only leaves through support_view.serialize_customer, visibility is
_visible_user, and every sensitive view or write is logged. No exports, no bulk
browsing, pages capped at 50.
"""
from __future__ import annotations

import json
import logging
from datetime import date, datetime, timedelta, timezone
from typing import Literal

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.models import (
    FOLLOW_UP_ACTIVE_STATUSES,
    ActivityEvent,
    Conversion,
    EmailOptOut,
    FollowUp,
    FollowUpNote,
    MT5Account,
    SupportAction,
    SupportReplyTemplate,
    SupportRequest,
    Ticket,
    TicketReply,
    User,
)
from app.services import activity_log, conversions
from app.services import support_desk as desk
from app.services.audit import log_change
from app.services.deps import StaffCtx, is_account_online, require_admin, require_staff, staff_ctx_for
from app.services.notification_feed import (
    KIND_SUPPORT_ALERT,
    KIND_SUPPORT_REMINDER,
    KIND_TICKET_REPLY,
    create_notification,
    notify_ws,
)
from app.services.settings_store import (
    SUPPORT_DEFAULTS,
    get_support_settings,
    invalidate_support_cache,
    save_support_settings,
)
from app.services.support_view import serialize_customer

logger = logging.getLogger("prismx.support")

router = APIRouter(prefix="/support", tags=["support"])
admin_router = APIRouter(prefix="/admin/support", tags=["admin-support"], dependencies=[Depends(require_admin)])

# 客服接口列表单页上限（设计 §8）/ page cap for support lists (design §8)
PAGE_MAX = 50
# admin 批量分配一次最多多少人 / max users per bulk assignment
ASSIGN_MAX = 500

_PRIORITY_RANK = {"high": 0, "normal": 1, "low": 2}
# 进行中的跟进多少天没有新记录（没有记录则从分配起算）算「停滞」；已结束的跟进不算。
# An active follow-up is stale after this many days without a note (counted from
# assignment when there is none); closed follow-ups are never stale.
STALE_DAYS = 3
# admin 列表里「最近一条记录」摘要的长度 / length of the latest-note excerpt in admin lists
NOTE_EXCERPT = 160

# 代号沿用上线时的，界面文案 2026-10-18 改为：open_mt5 引导连接实盘、open_signallab 引导开通 PRO、activate_trial
# 激活休眠用户、revisit 联系解答问题、other 其他；renew（续费）不再提供，只留给旧记录。
# Codes kept from launch; labels renamed 2026-10-18 (see above). renew is no longer offered, kept for old rows.
GoalT = Literal["open_mt5", "open_signallab", "activate_trial", "revisit", "other"]
PriorityT = Literal["low", "normal", "high"]
ChannelT = Literal["phone", "email", "in_app", "other"]
StaffStatusT = Literal["pending", "contacted", "interested", "converted", "no_interest", "unreachable"]


# ─────────────────────────────────────────────────────────────────────────────
# 请求体 / request bodies
# ─────────────────────────────────────────────────────────────────────────────
class UnbindIn(BaseModel):
    reason: str = Field(min_length=1, max_length=500)


class ReasonIn(BaseModel):
    reason: str | None = Field(default=None, max_length=500)


class CompDaysIn(BaseModel):
    days: int = Field(ge=1, le=365)
    reason: str = Field(min_length=1, max_length=500)


class MessageIn(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    body: str = Field(min_length=1, max_length=5000)


class FollowUpRequestIn(BaseModel):
    goal: GoalT
    note: str | None = Field(default=None, max_length=1000)


class ConversionRequestIn(BaseModel):
    server: str = Field(min_length=1, max_length=100)
    login: str = Field(min_length=1, max_length=32)
    note: str | None = Field(default=None, max_length=1000)


class FollowUpPatchIn(BaseModel):
    status: StaffStatusT | None = None
    # 显式 null = 清除下次跟进时间 / explicit null clears it
    nextContactAt: datetime | None = None


class FollowUpNoteIn(BaseModel):
    channel: ChannelT = "other"
    content: str = Field(min_length=1, max_length=5000)
    outcome: str | None = Field(default=None, max_length=200)


class MemberPatchIn(BaseModel):
    tier: Literal["internal", "outsourced"] | None = None
    # 显式 null = 用全局默认 / explicit null = use the global default
    revealLimit: int | None = Field(default=None, ge=0, le=10000)


class AssignIn(BaseModel):
    userIds: list[str] = Field(min_length=1, max_length=ASSIGN_MAX)
    assigneeId: str
    goal: GoalT
    priority: PriorityT = "normal"
    expiresAt: datetime | None = None
    nextContactAt: datetime | None = None
    note: str | None = Field(default=None, max_length=2000)
    # 退订了推广邮件的用户默认跳过；明确勾选才分配（设计 §5.2「排除/警告」）
    # Users who unsubscribed from marketing mail are skipped unless explicitly included.
    includeOptedOut: bool = False


class CheckIn(BaseModel):
    userIds: list[str] = Field(min_length=1, max_length=ASSIGN_MAX)


class IdsIn(BaseModel):
    ids: list[str] = Field(min_length=1, max_length=ASSIGN_MAX)


class ReassignIn(IdsIn):
    assigneeId: str


class ExtendIn(IdsIn):
    expiresAt: datetime | None = None
    days: int | None = Field(default=None, ge=1, le=365)


class ReviewIn(BaseModel):
    note: str | None = Field(default=None, max_length=1000)


class ConversionReviewIn(BaseModel):
    approve: bool
    note: str | None = Field(default=None, max_length=1000)


class ManualConversionIn(BaseModel):
    userId: str
    kind: Literal["mt5_real", "signallab_paid"]
    creditedTo: str | None = None
    server: str | None = Field(default=None, max_length=100)
    login: str | None = Field(default=None, max_length=32)
    note: str | None = Field(default=None, max_length=1000)


class TemplateIn(BaseModel):
    title: str = Field(min_length=1, max_length=100)
    body: str = Field(min_length=1, max_length=5000)
    lang: str | None = Field(default=None, max_length=8)


class TemplatePatchIn(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=100)
    body: str | None = Field(default=None, min_length=1, max_length=5000)
    lang: str | None = Field(default=None, max_length=8)


class SupportSettingsIn(BaseModel):
    support_comp_days_max: int | None = Field(default=None, ge=0, le=365)
    support_follow_up_days: int | None = Field(default=None, ge=1, le=365)
    support_outsourced_reveal_daily: int | None = Field(default=None, ge=0, le=10000)
    support_alert_reveal_per_hour: int | None = Field(default=None, ge=0, le=10000)
    support_alert_views_per_hour: int | None = Field(default=None, ge=0, le=100000)


# ─────────────────────────────────────────────────────────────────────────────
# 视图 / views
# ─────────────────────────────────────────────────────────────────────────────
def _now() -> datetime:
    return desk.utcnow()


def _loads(text: str | None) -> dict:
    if not text:
        return {}
    try:
        v = json.loads(text)
    except ValueError:
        return {}
    return v if isinstance(v, dict) else {}


def _follow_up_view(fu: FollowUp, user: User | None = None, names: dict | None = None) -> dict:
    now = _now()
    nxt = desk.naive(fu.next_contact_at)
    out = {
        "id": fu.id,
        "userId": fu.user_id,
        "nickname": user.nickname if user is not None else None,
        "assigneeId": fu.assignee_id,
        "assignedBy": fu.assigned_by,
        "goal": fu.goal,
        "priority": fu.priority,
        "note": fu.note,
        "status": fu.status,
        "nextContactAt": fu.next_contact_at,
        "expiresAt": fu.expires_at,
        "createdAt": fu.created_at,
        "closedAt": fu.closed_at,
        "firstContactAt": fu.first_contact_at,
        "active": fu.status in FOLLOW_UP_ACTIVE_STATUSES,
        "overdue": bool(nxt is not None and nxt <= now and fu.status in FOLLOW_UP_ACTIVE_STATUSES),
    }
    if names is not None:
        out["assigneeName"] = names.get(fu.assignee_id)
    return out


def _note_view(n: FollowUpNote, names: dict) -> dict:
    return {
        "id": n.id,
        "followUpId": n.follow_up_id,
        "authorId": n.author_id,
        "authorName": names.get(n.author_id),
        "channel": n.channel,
        "content": n.content,
        "outcome": n.outcome,
        "createdAt": n.created_at,
    }


def _conversion_view(c: Conversion, ctx: StaffCtx | None) -> dict:
    out = {
        "id": c.id,
        "userId": c.user_id,
        "kind": c.kind,
        "source": c.source,
        "status": c.status,
        "followUpId": c.follow_up_id,
        "createdAt": c.created_at,
        "creditedToMe": bool(ctx is not None and c.credited_to == ctx.user.id),
    }
    if ctx is None or ctx.is_admin:
        out["creditedTo"] = c.credited_to
        out["detail"] = _loads(c.detail)
    return out


def _request_view(r: SupportRequest, names: dict | None = None) -> dict:
    return {
        "id": r.id,
        "kind": r.kind,
        "requesterId": r.requester_id,
        "requesterName": (names or {}).get(r.requester_id),
        "targetUserId": r.target_user_id,
        "payload": _loads(r.payload),
        "status": r.status,
        "reviewerId": r.reviewer_id,
        "reviewedAt": r.reviewed_at,
        "note": r.note,
        "createdAt": r.created_at,
    }


def _template_view(t: SupportReplyTemplate) -> dict:
    return {"id": t.id, "title": t.title, "body": t.body, "lang": t.lang, "updatedAt": t.updated_at}


def _names(db: Session, ids) -> dict:
    ids = {i for i in ids if i}
    if not ids:
        return {}
    return {u.id: (u.nickname or u.email) for u in db.query(User).filter(User.id.in_(ids)).all()}


def _reveal_limit(db: Session, user: User) -> int:
    if user.support_reveal_limit is not None:
        return user.support_reveal_limit
    return get_support_settings(db)["support_outsourced_reveal_daily"]


# ─────────────────────────────────────────────────────────────────────────────
# 可见范围（设计 §2.4）/ visibility (design §2.4)
# ─────────────────────────────────────────────────────────────────────────────
def _my_active_follow_up(db: Session, ctx: StaffCtx, user_id: str) -> FollowUp | None:
    q = db.query(FollowUp).filter(FollowUp.user_id == user_id, FollowUp.status.in_(FOLLOW_UP_ACTIVE_STATUSES))
    if not ctx.is_admin:
        q = q.filter(FollowUp.assignee_id == ctx.user.id)
    return q.first()


def _has_ticket(db: Session, user_id: str) -> bool:
    """「工单相关」：这个人提交过工单（客服处理工单时可看提交人卡片）。客服发起的「客服来信」
    （category=follow_up）不算——否则给任何人发一封信就能永久看到他。
    Ticket-related: the user has submitted a ticket. Staff-initiated follow_up
    letters don't count, or messaging anyone would grant permanent visibility."""
    return (
        db.query(Ticket.id)
        .filter(Ticket.user_id == user_id, Ticket.category != "follow_up")
        .first()
        is not None
    )


def _visible_user(db: Session, ctx: StaffCtx, user_id: str) -> tuple[User, FollowUp | None]:
    """取一个调用者有权看的用户，否则 404（不区分「不存在」与「看不到」）。
    admin：任何人。客服：① 分配给自己且进行中的跟进用户；② 提交过工单的用户。
    Fetch a user the caller may see, else 404 (not-found and not-visible look the
    same). Admins see anyone; agents see their active follow-ups and ticket submitters."""
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="用户不存在 / User not found")
    fu = _my_active_follow_up(db, ctx, user.id)
    if ctx.is_admin or fu is not None or _has_ticket(db, user.id):
        return user, fu
    raise HTTPException(status_code=404, detail="用户不存在 / User not found")


def _ctx(ctx) -> StaffCtx:
    return ctx if isinstance(ctx, StaffCtx) else staff_ctx_for(ctx)


# ─────────────────────────────────────────────────────────────────────────────
# 客服工作台 / staff workbench
# ─────────────────────────────────────────────────────────────────────────────
@router.get("/me", response_model=dict)
def support_me(db: Session = Depends(get_db), staff: StaffCtx = Depends(require_staff)):
    """当前工作人员的身份、tier、今日查看完整电话的用量（外包），以及水印文字。
    The caller's identity, tier, today's phone-reveal usage (outsourced) and watermark text."""
    ctx = _ctx(staff)
    u = ctx.user
    limit = _reveal_limit(db, u) if ctx.is_outsourced else None
    used = desk.count_actions(db, u.id, desk.ACT_REVEAL, desk.day_start()) if ctx.is_outsourced else None
    return {
        "id": u.id,
        "nickname": u.nickname,
        "email": u.email,
        "role": u.role,
        "isAdmin": ctx.is_admin,
        "tier": ctx.tier,
        "revealLimit": limit,
        "revealsToday": used,
        # 外包页面的半透明水印：昵称（没有则邮箱前缀）+ 日期 / watermark for outsourced pages
        "watermark": f"{u.nickname or u.email.split('@')[0]} · {date.today().isoformat()}" if ctx.is_outsourced else None,
        "settings": {"compDaysMax": get_support_settings(db)["support_comp_days_max"]},
    }


@router.get("/search", response_model=dict)
def support_search(
    q: str = Query(min_length=1, max_length=200),
    db: Session = Depends(get_db),
    staff: StaffCtx = Depends(require_staff),
):
    """按「精确邮箱 / 用户 ID / 工单号」找人（设计 §2.4），只回调用者有权看的人；不支持模糊、不支持
    翻页浏览。每次搜索都记日志。
    Exact lookup by email / user id / ticket id, returning only users the caller
    may see. No fuzzy matching, no browsing; every search is logged."""
    ctx = _ctx(staff)
    term = q.strip()
    found: list[User] = []
    by_email = db.query(User).filter(func.lower(User.email) == term.lower()).first()
    if by_email:
        found.append(by_email)
    by_id = db.get(User, term)
    if by_id and by_id not in found:
        found.append(by_id)
    t = db.get(Ticket, term)
    if t is not None:
        owner = db.get(User, t.user_id)
        if owner and owner not in found:
            found.append(owner)
    results = []
    for u in found:
        try:
            _visible_user(db, ctx, u.id)
        except HTTPException:
            continue
        results.append(serialize_customer(db, u, ctx))
    desk.record_action(db, ctx.user.id, desk.ACT_SEARCH, None, {"hits": len(results)})
    # 搜索词可能是邮箱（个人信息），日志只留长度与是否命中 / log the term's length, not the term
    desk.log(db, ctx, activity_log.SUPPORT_SEARCH, data={"len": len(term), "hits": len(results)})
    db.commit()
    return {"results": results}


@router.get("/users/{user_id}", response_model=dict)
def support_customer(user_id: str, db: Session = Depends(get_db), staff: StaffCtx = Depends(require_staff)):
    """客户卡片：按权限表脱敏的用户信息 + 我的跟进 + 跟进记录 + 转化时间线 + 工单 + 开户链接。
    每次查看记日志、计数（1 小时超过阈值通知 admin）。
    The customer card, permission-filtered, plus my follow-up, its notes, the
    conversion timeline and tickets. Every view is logged and counted."""
    ctx = _ctx(staff)
    user, fu = _visible_user(db, ctx, user_id)
    card = serialize_customer(db, user, ctx)
    notes = []
    if fu is not None:
        rows = (
            db.query(FollowUpNote)
            .filter(FollowUpNote.follow_up_id == fu.id)
            .order_by(FollowUpNote.created_at.asc())
            .all()
        )
        names = _names(db, {n.author_id for n in rows})
        notes = [_note_view(n, names) for n in rows]
    convs = (
        db.query(Conversion)
        .filter(Conversion.user_id == user.id)
        .order_by(Conversion.created_at.asc())
        .all()
    )
    tickets = (
        db.query(Ticket)
        .filter(Ticket.user_id == user.id)
        .order_by(Ticket.updated_at.desc())
        .limit(PAGE_MAX)
        .all()
    )
    desk.record_action(db, ctx.user.id, desk.ACT_VIEW, user.id)
    desk.log(db, ctx, activity_log.SUPPORT_VIEW_CUSTOMER, user_id=user.id)
    alerted = desk.check_anomaly(db, ctx, desk.ACT_VIEW)
    db.commit()
    desk.flush_ws(alerted)
    return {
        "customer": card,
        "followUp": _follow_up_view(fu, user) if fu is not None else None,
        "notes": notes,
        "conversions": [_conversion_view(c, ctx) for c in convs],
        "tickets": [
            {"id": t.id, "title": t.title, "category": t.category, "status": t.status,
             "priority": t.priority, "updatedAt": t.updated_at, "assigneeId": t.assignee_id}
            for t in tickets
        ],
    }


@router.post("/users/{user_id}/reveal-phone", response_model=dict)
def support_reveal_phone(user_id: str, db: Session = Depends(get_db), staff: StaffCtx = Depends(require_staff)):
    """查看完整电话：返回完整号码并记日志。外包计入每日上限，超限 429（设计 §2.3 / §8）。
    Reveal the full phone number (logged). Outsourced agents count against a daily
    cap and get 429 once it is used up."""
    from app.services.support_view import format_phone

    ctx = _ctx(staff)
    user, _fu = _visible_user(db, ctx, user_id)
    if not user.phone:
        raise HTTPException(status_code=404, detail="该用户没有填写电话 / No phone on file")
    limit = None
    used = None
    if ctx.is_outsourced:
        limit = _reveal_limit(db, ctx.user)
        used = desk.count_actions(db, ctx.user.id, desk.ACT_REVEAL, desk.day_start())
        if used >= limit:
            raise HTTPException(
                status_code=429,
                detail="今日查看完整电话次数已用完 / Daily phone-reveal limit reached",
            )
        used += 1
    desk.record_action(db, ctx.user.id, desk.ACT_REVEAL, user.id)
    desk.log(db, ctx, activity_log.SUPPORT_REVEAL_PHONE, user_id=user.id)
    alerted = desk.check_anomaly(db, ctx, desk.ACT_REVEAL)
    db.commit()
    desk.flush_ws(alerted)
    return {"phone": format_phone(user.phone), "revealsToday": used, "revealLimit": limit}


@router.post("/users/{user_id}/resend-verification", response_model=dict)
def support_resend_verification(
    user_id: str,
    background: BackgroundTasks,
    db: Session = Depends(get_db),
    staff: StaffCtx = Depends(require_staff),
):
    """替用户重发验证邮件：复用 auth 的发信逻辑与每小时频控（超限 429）。
    Resend the verification mail for the user, reusing auth's sender and hourly cap."""
    from app.services import email_verification

    ctx = _ctx(staff)
    user, _fu = _visible_user(db, ctx, user_id)
    if user.email_verified_at is not None:
        return {"ok": True, "alreadyVerified": True}
    if email_verification.too_many_recent_sends(user.id):
        raise HTTPException(
            status_code=429,
            detail="发送太频繁了，请稍后再试 / Too many emails sent — try again later",
        )
    raw = email_verification.issue_token(db, user)
    desk.record_action(db, ctx.user.id, desk.ACT_RESEND, user.id)
    desk.log(db, ctx, activity_log.SUPPORT_ACTION, user_id=user.id, data={"action": "resend_verification"})
    db.commit()
    background.add_task(email_verification.send_verification_email, user.email, raw)
    return {"ok": True, "alreadyVerified": False}


@router.post("/users/{user_id}/mt5/{account_id}/unbind", response_model=dict)
def support_unbind_mt5(
    user_id: str,
    account_id: str,
    body: UnbindIn,
    db: Session = Depends(get_db),
    staff: StaffCtx = Depends(require_staff),
):
    """替用户解绑一个 MT5 账号（软删，同用户自己解绑）。必须填原因；桥接账号在线时 409。
    复用 log_unbind，另记一条客服操作日志（带原因）。
    Unbind one of the user's MT5 accounts (soft delete, as the user's own unbind).
    A reason is required; an online bridge account answers 409. Reuses log_unbind
    and adds a support activity row carrying the reason."""
    from app.services.gateway_binding import log_unbind, mark_removed, not_removed
    from app.services.trade_performance import invalidate_trade_caches

    ctx = _ctx(staff)
    user, _fu = _visible_user(db, ctx, user_id)
    row = (
        db.query(MT5Account)
        .filter(MT5Account.id == account_id, MT5Account.user_id == user.id, not_removed())
        .with_for_update()
        .first()
    )
    if row is None:
        raise HTTPException(status_code=404, detail="账号不存在 / Account not found")
    if row.source != "gateway" and is_account_online(row):
        raise HTTPException(
            status_code=409,
            detail="账号仍在线，请用户先断开桥接程序 / Account is online; the bridge must disconnect first",
        )
    reason = body.reason.strip()
    log_unbind(db, row, user.id)
    desk.record_action(db, ctx.user.id, desk.ACT_UNBIND, user.id, {"account": row.id})
    desk.log(db, ctx, activity_log.SUPPORT_ACTION, user_id=user.id, ref_id=row.id,
             data={"action": "unbind", "reason": reason, "ch": row.source or "bridge"})
    login = row.login
    mark_removed(db, row)  # 提交 / commits
    invalidate_trade_caches(user.id, [login])
    try:
        from app.routers.bridge import invalidate_status_cache

        invalidate_status_cache(user.id)
    except Exception:
        logger.debug("invalidate_status_cache failed", exc_info=True)
    return {"ok": True}


def _support_reset_count(db: Session, user_id: str) -> int:
    return (
        db.query(func.count(SupportAction.id))
        .filter(SupportAction.target_user_id == user_id, SupportAction.kind == desk.ACT_RESET_TRIAL)
        .scalar()
        or 0
    )


@router.post("/users/{user_id}/reset-trial", response_model=dict)
def support_reset_trial(
    user_id: str,
    body: ReasonIn,
    db: Session = Depends(get_db),
    staff: StaffCtx = Depends(require_staff),
):
    """重置试用资格（清 trial_used_at，用户可再领一次）。客服对每个用户终身 1 次（support_actions
    查重，不论哪位客服做的）；admin 不限，且 admin 的重置不占客服那一次。
    Reset the trial credential (clears trial_used_at). Support agents get one reset
    per user, ever, across all agents; admins are unlimited and don't use it up."""
    ctx = _ctx(staff)
    user, _fu = _visible_user(db, ctx, user_id)
    if user.trial_used_at is None:
        raise HTTPException(status_code=400, detail="该用户还没用过试用 / Trial has not been used yet")
    if not ctx.is_admin and _support_reset_count(db, user.id) >= 1:
        raise HTTPException(
            status_code=409,
            detail="该用户的试用已被客服重置过一次 / This user's trial was already reset once by support",
        )
    log_change(db, ctx.user.id, user.id, "trial_used_at", user.trial_used_at, None)
    user.trial_used_at = None
    desk.record_action(
        db, ctx.user.id, desk.ACT_RESET_TRIAL if not ctx.is_admin else "reset_trial_admin", user.id,
        {"reason": body.reason} if body.reason else None,
    )
    desk.log(db, ctx, activity_log.SUPPORT_ACTION, user_id=user.id,
             data={"action": "reset_trial", "reason": body.reason})
    db.commit()
    return {"ok": True}


def apply_comp_days(db: Session, actor_id: str, user: User, days: int) -> datetime | None:
    """补偿天数落到用户上：PRO 有到期 → 从 max(到期, 现在) 往后加；FREE → 升 PRO、从现在起算；
    永久 PRO → 400。审计写 plan / plan_expires_at（admin_user_id = 操作者）。不提交。
    Apply compensation days: extend a PRO expiry from max(expiry, now); upgrade FREE
    to PRO from now; permanent PRO -> 400. Audited as plan / plan_expires_at."""
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    if user.plan == "PRO" and user.plan_expires_at is None:
        raise HTTPException(status_code=400, detail="该用户已是永久会员 / User already has permanent PRO")
    base = now
    if user.plan == "PRO":
        cur = desk.naive(user.plan_expires_at)
        if cur is not None and cur > base:
            base = cur
    new_exp = base + timedelta(days=days)
    if user.plan != "PRO":
        log_change(db, actor_id, user.id, "plan", user.plan, "PRO")
        user.plan = "PRO"
        user.plan_is_trial = False
    log_change(db, actor_id, user.id, "plan_expires_at", user.plan_expires_at, new_exp)
    user.plan_expires_at = new_exp
    return new_exp


@router.post("/users/{user_id}/comp-days", response_model=dict)
def support_comp_days(
    user_id: str,
    body: CompDaysIn,
    db: Session = Depends(get_db),
    staff: StaffCtx = Depends(require_staff),
):
    """补偿天数。单次 ≤ support_comp_days_max（默认 7）直接生效；超过 → 生成审批单等 admin 处理。
    admin 不受上限约束。
    Compensation days: up to support_comp_days_max (default 7) applies at once;
    above it a request goes to the admin approval queue. Admins are uncapped."""
    ctx = _ctx(staff)
    user, _fu = _visible_user(db, ctx, user_id)
    cap = get_support_settings(db)["support_comp_days_max"]
    if not ctx.is_admin and body.days > cap:
        req = SupportRequest(
            kind="comp_days", requester_id=ctx.user.id, target_user_id=user.id,
            payload=json.dumps({"days": body.days, "reason": body.reason}, ensure_ascii=False),
        )
        db.add(req)
        db.flush()
        desk.log(db, ctx, activity_log.SUPPORT_ACTION, user_id=user.id, ref_id=req.id,
                 data={"action": "comp_days_requested", "days": body.days, "reason": body.reason})
        alerted = desk.notify(db, desk.admin_ids(db), KIND_SUPPORT_ALERT,
                              f"待审批：补偿 {body.days} 天 / approval needed", "/admin?tab=support", req.id)
        db.commit()
        desk.flush_ws(alerted)
        return {"applied": False, "request": _request_view(req), "planExpiresAt": user.plan_expires_at}
    new_exp = apply_comp_days(db, ctx.user.id, user, body.days)
    desk.record_action(db, ctx.user.id, desk.ACT_COMP_DAYS, user.id, {"days": body.days})
    desk.log(db, ctx, activity_log.SUPPORT_ACTION, user_id=user.id,
             data={"action": "comp_days", "days": body.days, "reason": body.reason})
    db.commit()
    return {"applied": True, "request": None, "planExpiresAt": new_exp}


@router.post("/users/{user_id}/do-not-contact", response_model=dict)
def support_do_not_contact(user_id: str, db: Session = Depends(get_db), staff: StaffCtx = Depends(require_staff)):
    """用户要求不再联系：置 users.do_not_contact_at，当前跟进转 no_interest，以后拦截分配。
    The user asked not to be contacted: set do_not_contact_at, close the active
    follow-up as no_interest, and block future assignments."""
    ctx = _ctx(staff)
    user, _fu = _visible_user(db, ctx, user_id)
    now = _now()
    if user.do_not_contact_at is None:
        user.do_not_contact_at = now
    active = (
        db.query(FollowUp)
        .filter(FollowUp.user_id == user.id, FollowUp.status.in_(FOLLOW_UP_ACTIVE_STATUSES))
        .all()
    )
    # 状态都是标签了，结束跟进统一用 revoked / statuses are labels now, so closing uses revoked
    for fu in active:
        fu.status = "revoked"
        fu.closed_at = now
    # 记下关掉了哪几条跟进，后台的跟进记录按它归属，不靠时间猜
    # record which follow-ups this closed, so the admin record attributes it exactly instead of by time
    desk.log(db, ctx, activity_log.SUPPORT_ACTION, user_id=user.id,
             data={"action": "do_not_contact", "fu": [fu.id for fu in active]})
    db.commit()
    return {"ok": True, "doNotContactAt": user.do_not_contact_at}


@router.post("/users/{user_id}/message", response_model=dict)
def support_message(
    user_id: str,
    body: MessageIn,
    db: Session = Depends(get_db),
    staff: StaffCtx = Depends(require_staff),
):
    """站内联系：以客服身份给用户新开一张工单（category=follow_up，用户侧显示为「Signal Lab 客服」
    来信），指派给发信人，用户收到站内通知与推送。只能发给自己正在跟进的用户（admin 不限）。
    In-app contact: open a new ticket for the user as staff (category follow_up,
    shown as a letter from Signal Lab Support), assigned to the sender; the user
    gets an in-app notification and a push. Only for the caller's active
    follow-ups (admins: anyone)."""
    from app.routers.tickets import _ticket_out

    ctx = _ctx(staff)
    user, fu = _visible_user(db, ctx, user_id)
    if not ctx.is_admin and fu is None:
        raise HTTPException(status_code=403, detail="只能联系自己正在跟进的用户 / Only your active follow-ups")
    if user.do_not_contact_at is not None:
        raise HTTPException(status_code=409, detail="用户已要求不再联系 / The user asked not to be contacted")
    ticket = Ticket(
        user_id=user.id, title=body.title.strip(), category="follow_up", priority="normal",
        status="open", assignee_id=ctx.user.id,
    )
    db.add(ticket)
    db.flush()
    reply = TicketReply(
        ticket_id=ticket.id, author_id=ctx.user.id, body=body.body.strip(),
        author_role=ctx.user.role,
    )
    db.add(reply)
    create_notification(db, user.id, KIND_TICKET_REPLY, text=ticket.title,
                        link=f"/support?ticket={ticket.id}", ref_id=ticket.id)
    desk.record_action(db, ctx.user.id, desk.ACT_MESSAGE, user.id, {"ticket": ticket.id})
    desk.log(db, ctx, activity_log.SUPPORT_FOLLOW_UP if fu else activity_log.SUPPORT_ACTION,
             user_id=user.id, ref_id=ticket.id, data={"action": "message", "fu": fu.id if fu else None})
    db.commit()
    db.refresh(ticket)
    notify_ws(user.id)
    try:
        from app.services.push_dispatch import dispatch_ticket_reply

        dispatch_ticket_reply(ticket.id, user.id)
    except Exception:
        logger.warning("客服来信推送失败: ticket=%s user=%s", ticket.id, user.id, exc_info=True)
    return {"ticket": _ticket_out(ticket, [reply], True, db).model_dump()}


@router.post("/users/{user_id}/follow-up-request", response_model=dict)
def support_follow_up_request(
    user_id: str,
    body: FollowUpRequestIn,
    db: Session = Depends(get_db),
    staff: StaffCtx = Depends(require_staff),
):
    """申请跟进（工单里遇到潜在客户）：生成审批单，admin 批准即生成跟进并分配给申请人。
    Request a follow-up (a lead met in a ticket); approval creates it for the requester."""
    ctx = _ctx(staff)
    user, _fu = _visible_user(db, ctx, user_id)
    req = SupportRequest(
        kind="follow_up", requester_id=ctx.user.id, target_user_id=user.id,
        payload=json.dumps({"goal": body.goal, "note": body.note}, ensure_ascii=False),
    )
    db.add(req)
    db.flush()
    desk.log(db, ctx, activity_log.SUPPORT_FOLLOW_UP, user_id=user.id, ref_id=req.id,
             data={"action": "request", "goal": body.goal})
    db.commit()
    return {"request": _request_view(req)}


@router.post("/users/{user_id}/conversion-request", response_model=dict)
def support_conversion_request(
    user_id: str,
    body: ConversionRequestIn,
    db: Session = Depends(get_db),
    staff: StaffCtx = Depends(require_staff),
):
    """手动开户标记：客服填服务器 + 账号 → 审批单（pending），admin 审核通过才记 mt5_real 转化。
    Manual open-account claim: server + login -> a pending request; only admin
    approval records the mt5_real conversion."""
    ctx = _ctx(staff)
    user, _fu = _visible_user(db, ctx, user_id)
    req = SupportRequest(
        kind="conversion_manual", requester_id=ctx.user.id, target_user_id=user.id,
        payload=json.dumps({"server": body.server.strip(), "login": body.login.strip(), "note": body.note},
                           ensure_ascii=False),
    )
    db.add(req)
    db.flush()
    desk.log(db, ctx, activity_log.SUPPORT_ACTION, user_id=user.id, ref_id=req.id,
             data={"action": "conversion_manual_requested"})
    db.commit()
    return {"request": _request_view(req)}


@router.get("/requests", response_model=dict)
def support_my_requests(
    limit: int = Query(default=PAGE_MAX, ge=1, le=PAGE_MAX),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_db),
    staff: StaffCtx = Depends(require_staff),
):
    """我提交的申请（最新在前）/ my own requests, newest first."""
    ctx = _ctx(staff)
    rows = (
        db.query(SupportRequest)
        .filter(SupportRequest.requester_id == ctx.user.id)
        .order_by(SupportRequest.created_at.desc())
        .offset(offset).limit(limit).all()
    )
    return {"items": [_request_view(r) for r in rows]}


@router.get("/follow-ups", response_model=dict)
def support_my_follow_ups(
    limit: int = Query(default=PAGE_MAX, ge=1, le=PAGE_MAX),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_db),
    staff: StaffCtx = Depends(require_staff),
):
    """我的跟进：只含分配给我、进行中的；按下次跟进时间（逾期在前、没设的在后）+ 优先级排序。
    My follow-ups: only active ones assigned to me, ordered by next contact time
    (overdue first, unset last) then priority."""
    ctx = _ctx(staff)
    rows = (
        db.query(FollowUp)
        .filter(FollowUp.assignee_id == ctx.user.id, FollowUp.status.in_(FOLLOW_UP_ACTIVE_STATUSES))
        .all()
    )
    far = datetime.max
    rows.sort(key=lambda f: (desk.naive(f.next_contact_at) or far, _PRIORITY_RANK.get(f.priority, 1),
                             desk.naive(f.created_at) or far))
    total = len(rows)
    page = rows[offset:offset + limit]
    users = {u.id: u for u in db.query(User).filter(User.id.in_({f.user_id for f in page}))} if page else {}
    return {"total": total, "items": [_follow_up_view(f, users.get(f.user_id)) for f in page]}


def _my_follow_up(db: Session, ctx: StaffCtx, fu_id: str) -> FollowUp:
    fu = db.get(FollowUp, fu_id)
    if fu is None or (not ctx.is_admin and (fu.assignee_id != ctx.user.id or fu.status not in FOLLOW_UP_ACTIVE_STATUSES)):
        raise HTTPException(status_code=404, detail="跟进不存在 / Follow-up not found")
    return fu


@router.get("/follow-ups/{fu_id}", response_model=dict)
def support_follow_up_detail(fu_id: str, db: Session = Depends(get_db), staff: StaffCtx = Depends(require_staff)):
    """一条跟进 + 跟进记录（客户卡片走 GET /support/users/{id}）。收回 / 改派后原客服立即 404。
    One follow-up with its notes (the customer card is GET /support/users/{id}).
    Revoked or reassigned follow-ups are a 404 for the previous agent at once."""
    ctx = _ctx(staff)
    fu = _my_follow_up(db, ctx, fu_id)
    rows = db.query(FollowUpNote).filter(FollowUpNote.follow_up_id == fu.id).order_by(FollowUpNote.created_at.asc()).all()
    names = _names(db, {n.author_id for n in rows})
    return {"followUp": _follow_up_view(fu, db.get(User, fu.user_id)), "notes": [_note_view(n, names) for n in rows]}


@router.patch("/follow-ups/{fu_id}", response_model=dict)
def support_follow_up_patch(
    fu_id: str,
    body: FollowUpPatchIn,
    db: Session = Depends(get_db),
    staff: StaffCtx = Depends(require_staff),
):
    """切换跟进状态（纯标签，不结束跟进）/ 设置下次跟进时间。
    Change the status (a label; never closes the follow-up) or the next contact time."""
    ctx = _ctx(staff)
    fu = _my_follow_up(db, ctx, fu_id)
    fields = body.model_dump(exclude_unset=True)
    changes = {}
    if "nextContactAt" in fields:
        new = desk.naive(fields["nextContactAt"])
        changes["next"] = new.isoformat() if new else None
        fu.next_contact_at = new
    if fields.get("status") and fields["status"] != fu.status:
        if fu.status not in FOLLOW_UP_ACTIVE_STATUSES:
            raise HTTPException(status_code=409, detail="跟进已结束 / Follow-up is closed")
        changes["status"] = fields["status"]
        changes["from"] = fu.status
        fu.status = fields["status"]
        if fu.status not in FOLLOW_UP_ACTIVE_STATUSES:
            fu.closed_at = _now()
        if fu.first_contact_at is None and fu.status != "pending":
            fu.first_contact_at = _now()
    if changes:
        desk.log(db, ctx, activity_log.SUPPORT_FOLLOW_UP, user_id=fu.user_id, ref_id=fu.id,
                 data={"action": "update", **changes})
    db.commit()
    return {"followUp": _follow_up_view(fu, db.get(User, fu.user_id))}


@router.post("/follow-ups/{fu_id}/notes", response_model=dict)
def support_follow_up_note(
    fu_id: str,
    body: FollowUpNoteIn,
    db: Session = Depends(get_db),
    staff: StaffCtx = Depends(require_staff),
):
    """追加一条跟进记录（只追加、不可删改）。第一条记录的时间计入「首次联系时长」。
    Append a follow-up note (append-only); the first one sets first_contact_at."""
    ctx = _ctx(staff)
    fu = _my_follow_up(db, ctx, fu_id)
    note = FollowUpNote(follow_up_id=fu.id, author_id=ctx.user.id, channel=body.channel,
                        content=body.content.strip(), outcome=body.outcome)
    db.add(note)
    if fu.first_contact_at is None:
        fu.first_contact_at = _now()
    if fu.status == "pending":
        fu.status = "contacted"
    db.flush()
    desk.log(db, ctx, activity_log.SUPPORT_FOLLOW_UP, user_id=fu.user_id, ref_id=fu.id,
             data={"action": "note", "channel": body.channel})
    db.commit()
    return {"note": _note_view(note, _names(db, {ctx.user.id})), "followUp": _follow_up_view(fu)}


@router.get("/templates", response_model=dict)
def support_templates(
    lang: str | None = Query(default=None, max_length=8),
    db: Session = Depends(get_db),
    _staff: StaffCtx = Depends(require_staff),
):
    """快捷回复模板（只读）/ canned replies, read-only for staff."""
    q = db.query(SupportReplyTemplate)
    if lang:
        q = q.filter(or_(SupportReplyTemplate.lang == lang, SupportReplyTemplate.lang.is_(None)))
    return {"items": [_template_view(t) for t in q.order_by(SupportReplyTemplate.title).all()]}


# ─────────────────────────────────────────────────────────────────────────────
# admin：客服管理 / admin: support management
# ─────────────────────────────────────────────────────────────────────────────
def _admin_ctx(admin: User) -> StaffCtx:
    return staff_ctx_for(admin)


def _active_staff(db: Session, user_id: str) -> User:
    u = db.get(User, user_id)
    if u is None or u.role not in ("support", "admin") or u.disabled_at is not None:
        raise HTTPException(status_code=400, detail="只能分配给在岗的客服或管理员 / Assignee must be active staff")
    return u


@admin_router.get("/members", response_model=dict)
def admin_support_members(db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    """客服成员：tier、每日查看上限（含生效值）、在岗 / 停用、名下进行中工单与跟进数、今日查看电话次数。
    Support members with tier, reveal limit (and effective value), status, open
    tickets, active follow-ups and today's reveals."""
    members = db.query(User).filter(User.role == "support").order_by(User.created_at).all()
    ids = [m.id for m in members]
    tickets = dict(
        db.query(Ticket.assignee_id, func.count(Ticket.id))
        .filter(Ticket.assignee_id.in_(ids), Ticket.status != "closed")
        .group_by(Ticket.assignee_id).all()
    ) if ids else {}
    fus = dict(
        db.query(FollowUp.assignee_id, func.count(FollowUp.id))
        .filter(FollowUp.assignee_id.in_(ids), FollowUp.status.in_(FOLLOW_UP_ACTIVE_STATUSES))
        .group_by(FollowUp.assignee_id).all()
    ) if ids else {}
    start = desk.day_start()
    reveals = dict(
        db.query(SupportAction.actor_id, func.count(SupportAction.id))
        .filter(SupportAction.actor_id.in_(ids), SupportAction.kind == desk.ACT_REVEAL,
                SupportAction.created_at >= start)
        .group_by(SupportAction.actor_id).all()
    ) if ids else {}
    default_limit = get_support_settings(db)["support_outsourced_reveal_daily"]
    return {"items": [
        {
            "id": m.id, "email": m.email, "nickname": m.nickname,
            "tier": m.support_tier, "effectiveTier": staff_ctx_for(m).tier,
            "revealLimit": m.support_reveal_limit,
            "effectiveRevealLimit": m.support_reveal_limit if m.support_reveal_limit is not None else default_limit,
            "disabled": m.disabled_at is not None,
            "openTickets": tickets.get(m.id, 0),
            "activeFollowUps": fus.get(m.id, 0),
            "revealsToday": reveals.get(m.id, 0),
            "lastActiveAt": m.last_active_at,
        }
        for m in members
    ]}


@admin_router.patch("/members/{user_id}", response_model=dict)
def admin_support_member_patch(
    user_id: str,
    body: MemberPatchIn,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    """改客服 tier / 每日查看上限（null = 用全局默认），各写一条审计。设为客服本身走
    PATCH /admin/users/{id}（role=support）。
    Change a member's tier / daily reveal limit (null = global default), audited.
    Making someone support goes through PATCH /admin/users/{id}."""
    m = db.get(User, user_id)
    if m is None or m.role != "support":
        raise HTTPException(status_code=404, detail="客服不存在 / Support member not found")
    fields = body.model_dump(exclude_unset=True)
    if "tier" in fields:
        log_change(db, admin.id, m.id, "support_tier", m.support_tier, fields["tier"])
        m.support_tier = fields["tier"]
    if "revealLimit" in fields:
        log_change(db, admin.id, m.id, "support_reveal_limit", m.support_reveal_limit, fields["revealLimit"])
        m.support_reveal_limit = fields["revealLimit"]
    db.commit()
    return {"id": m.id, "tier": m.support_tier, "revealLimit": m.support_reveal_limit}


@admin_router.get("/settings", response_model=dict)
def admin_support_settings(db: Session = Depends(get_db)):
    """客服台设置 / support-desk settings."""
    return get_support_settings(db)


@admin_router.put("/settings", response_model=dict)
def admin_support_settings_put(
    body: SupportSettingsIn,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    """改客服台设置，逐键审计（setting:support:<key>）/ update settings, audited per key."""
    old = get_support_settings(db)
    new = {k: v for k, v in body.model_dump(exclude_unset=True).items() if v is not None and k in SUPPORT_DEFAULTS}
    for k, v in new.items():
        if old.get(k) != v:
            log_change(db, admin.id, admin.id, f"setting:support:{k}", json.dumps(old.get(k)), json.dumps(v))
    save_support_settings(db, new)
    db.commit()
    invalidate_support_cache()
    return get_support_settings(db)


def _assign_blockers(db: Session, user_ids: list[str]) -> dict[str, dict]:
    """每个用户的分配阻碍：doNotContact / activeFollowUp（硬拦截）、optedOut（警告）、missing。
    Per-user assignment blockers: doNotContact / activeFollowUp (hard), optedOut (warning)."""
    users = {u.id: u for u in db.query(User).filter(User.id.in_(user_ids)).all()}
    opted = {r[0] for r in db.query(EmailOptOut.user_id).filter(EmailOptOut.user_id.in_(user_ids)).all()}
    active = {
        r[0]: r[1] for r in db.query(FollowUp.user_id, FollowUp.assignee_id)
        .filter(FollowUp.user_id.in_(user_ids), FollowUp.status.in_(FOLLOW_UP_ACTIVE_STATUSES)).all()
    }
    out = {}
    for uid in user_ids:
        u = users.get(uid)
        out[uid] = {
            "userId": uid,
            "missing": u is None,
            "doNotContact": bool(u is not None and u.do_not_contact_at is not None),
            "optedOut": uid in opted,
            "activeFollowUp": uid in active,
            "activeAssigneeId": active.get(uid),
            "staff": bool(u is not None and u.role in ("support", "admin")),
        }
    return out


@admin_router.post("/follow-ups/check", response_model=dict)
def admin_follow_up_check(body: CheckIn, db: Session = Depends(get_db)):
    """分配前预检：哪些人会被排除 / 需要警告（设计 §5.2）。
    Pre-flight for assignment: who is excluded or warned (design §5.2)."""
    ids = list(dict.fromkeys(body.userIds))
    return {"items": list(_assign_blockers(db, ids).values())}


@admin_router.post("/follow-ups", response_model=dict)
def admin_follow_up_assign(body: AssignIn, db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    """批量分配跟进。排除：用户不存在、工作人员本人、已要求勿扰、已有进行中跟进；退订推广邮件的
    默认排除，includeOptedOut=true 才分配。截止默认 = 现在 + support_follow_up_days。
    Bulk-assign follow-ups. Excluded: missing users, staff, do-not-contact, an
    existing active follow-up; email opt-outs unless includeOptedOut. The default
    deadline is now + support_follow_up_days."""
    ctx = _admin_ctx(admin)
    assignee = _active_staff(db, body.assigneeId)
    ids = list(dict.fromkeys(body.userIds))
    blockers = _assign_blockers(db, ids)
    # 默认不设期限（用户 2026-10-17：不需要标记时间）；传了 expiresAt 才有。
    # No deadline by default (owner, 2026-10-17); only set when expiresAt is given.
    expires = desk.naive(body.expiresAt)
    created, skipped = [], []
    for uid in ids:
        b = blockers[uid]
        reason = (
            "missing" if b["missing"] else
            "staff" if b["staff"] else
            "do_not_contact" if b["doNotContact"] else
            "active_follow_up" if b["activeFollowUp"] else
            "opted_out" if (b["optedOut"] and not body.includeOptedOut) else None
        )
        if reason:
            skipped.append({"userId": uid, "reason": reason})
            continue
        fu = FollowUp(
            user_id=uid, assignee_id=assignee.id, assigned_by=admin.id, goal=body.goal,
            priority=body.priority, note=body.note, status="pending",
            next_contact_at=desk.naive(body.nextContactAt), expires_at=expires,
        )
        db.add(fu)
        db.flush()
        desk.log(db, ctx, activity_log.SUPPORT_FOLLOW_UP, user_id=uid, ref_id=fu.id,
                 data={"action": "assign", "to": assignee.id, "goal": body.goal})
        created.append(fu)
    db.commit()
    return {"created": [_follow_up_view(f) for f in created], "skipped": skipped}


def _like_escape(value: str) -> str:
    """把 LIKE 的元字符转义掉，供 `ilike(..., escape="\\\\")` 使用（同 admin 用户搜索）。
    Escape LIKE metacharacters for `ilike(..., escape="\\\\")`, as the admin user search does."""
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _last_note_sq():
    """每条跟进最近一条记录的时间（子查询：fu_id, last_at）。排序「按最近动态」与统计停滞共用。
    Per follow-up latest note time (subquery fu_id, last_at), shared by the
    activity sort and the stale counts."""
    return (
        select(FollowUpNote.follow_up_id.label("fu_id"), func.max(FollowUpNote.created_at).label("last_at"))
        .group_by(FollowUpNote.follow_up_id)
        .subquery()
    )


def _note_stats(db: Session, fu_ids) -> dict[str, dict]:
    """一批跟进的记录统计：{fu_id: {"count", "lastAt", "note"(最近一条 FollowUpNote)}}。两条集合查询
    （分组计数 / 取最新），不逐行查；同一时刻多条取 id 最大的那条，结果稳定。
    Note stats for a batch of follow-ups, {fu_id: {count, lastAt, note}}, in two
    set-based queries (grouped count, latest rows) — never per row. Ties on the
    same timestamp keep the largest id so the pick is stable."""
    ids = list({i for i in fu_ids if i})
    if not ids:
        return {}
    out = {
        fid: {"count": n or 0, "lastAt": last, "note": None}
        for fid, n, last in (
            db.query(FollowUpNote.follow_up_id, func.count(FollowUpNote.id), func.max(FollowUpNote.created_at))
            .filter(FollowUpNote.follow_up_id.in_(ids))
            .group_by(FollowUpNote.follow_up_id)
            .all()
        )
    }
    if not out:
        return {}
    latest = (
        db.query(FollowUpNote.follow_up_id.label("fu_id"), func.max(FollowUpNote.created_at).label("last_at"))
        .filter(FollowUpNote.follow_up_id.in_(list(out)))
        .group_by(FollowUpNote.follow_up_id)
        .subquery()
    )
    rows = (
        db.query(FollowUpNote)
        .join(latest, and_(FollowUpNote.follow_up_id == latest.c.fu_id, FollowUpNote.created_at == latest.c.last_at))
        .all()
    )
    for n in rows:
        slot = out.get(n.follow_up_id)
        if slot is not None and (slot["note"] is None or n.id > slot["note"].id):
            slot["note"] = n
    return out


def _is_stale(fu: FollowUp, last_note_at, cutoff: datetime) -> bool:
    """进行中且「最近记录时间（没有则分配时间）」早于 cutoff / active and last touched before cutoff."""
    if fu.status not in FOLLOW_UP_ACTIVE_STATUSES:
        return False
    ref = desk.naive(last_note_at) or desk.naive(fu.created_at)
    return ref is not None and ref < cutoff


def _note_excerpt(n: FollowUpNote | None, names: dict) -> dict | None:
    if n is None:
        return None
    return {"content": (n.content or "")[:NOTE_EXCERPT], "channel": n.channel, "authorName": names.get(n.author_id)}


@admin_router.get("/follow-ups", response_model=dict)
def admin_follow_up_list(
    assigneeId: str | None = Query(default=None),
    status: str | None = Query(default=None, description="active | closed | <具体状态>"),
    userId: str | None = Query(default=None),
    q: str | None = Query(default=None, max_length=200, description="客户邮箱 / 昵称包含 / email or nickname contains"),
    sort: Literal["created", "activity"] = Query(default="created"),
    stale: bool = Query(default=False, description="只看停滞的 / stale ones only"),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_db),
):
    """跟进列表（admin）：按客服 / 状态（active、closed 或具体状态）/ 用户 / 客户邮箱或昵称（q，不分
    大小写）筛选；stale=true 只留停滞的（进行中且 STALE_DAYS 天没有新记录）；sort=created（默认，
    分配时间新→旧）或 activity（最近记录时间，没有记录用分配时间）。附按状态的分布计数（受客服 /
    用户 / q 约束，不受 status / stale 约束）。每条另带记录数、最近一条记录（摘要）、是否停滞。
    Follow-up list for admins, filterable by assignee / status / user / customer
    email-or-nickname (q, case-insensitive); stale=true keeps only stale ones
    (active, no note for STALE_DAYS days); sort=created (default, newest
    assignment first) or activity (latest note, else assignment time). The
    per-status distribution honours assignee / user / q but not status / stale.
    Each item also carries its note count, latest note excerpt and a stale flag."""
    qry = db.query(FollowUp)
    if assigneeId:
        qry = qry.filter(FollowUp.assignee_id == assigneeId)
    if userId:
        qry = qry.filter(FollowUp.user_id == userId)
    term = (q or "").strip()
    if term:
        like = f"%{_like_escape(term)}%"
        qry = qry.join(User, User.id == FollowUp.user_id).filter(
            or_(User.email.ilike(like, escape="\\"), User.nickname.ilike(like, escape="\\"))
        )
    dist_q = qry
    if status == "active":
        qry = qry.filter(FollowUp.status.in_(FOLLOW_UP_ACTIVE_STATUSES))
    elif status == "closed":
        qry = qry.filter(FollowUp.status.notin_(FOLLOW_UP_ACTIVE_STATUSES))
    elif status:
        qry = qry.filter(FollowUp.status == status)
    cutoff = _now() - timedelta(days=STALE_DAYS)
    # 停滞筛选与「按最近动态」共用一次外连接（子查询按跟进分组，一对一，不改变行数）
    # The stale filter and the activity sort share one outer join (grouped per follow-up: 1:1, no extra rows)
    touched = None
    if stale or sort == "activity":
        last = _last_note_sq()
        qry = qry.outerjoin(last, last.c.fu_id == FollowUp.id)
        touched = func.coalesce(last.c.last_at, FollowUp.created_at)
    if stale:
        qry = qry.filter(FollowUp.status.in_(FOLLOW_UP_ACTIVE_STATUSES), touched < cutoff)
    total = qry.count()
    if sort == "activity":
        qry = qry.order_by(touched.desc(), FollowUp.id.desc())
    else:
        qry = qry.order_by(FollowUp.created_at.desc())
    rows = qry.offset(offset).limit(limit).all()
    users = {u.id: u for u in db.query(User).filter(User.id.in_({f.user_id for f in rows}))} if rows else {}
    stats = _note_stats(db, [f.id for f in rows])
    names = _names(db, {f.assignee_id for f in rows}
                   | {s["note"].author_id for s in stats.values() if s["note"] is not None})
    dist = dict(dist_q.with_entities(FollowUp.status, func.count(FollowUp.id)).group_by(FollowUp.status).all())
    items = []
    for f in rows:
        v = _follow_up_view(f, users.get(f.user_id), names)
        u = users.get(f.user_id)
        v["email"] = u.email if u else None
        s = stats.get(f.id) or {"count": 0, "lastAt": None, "note": None}
        v["notesCount"] = s["count"]
        v["lastNoteAt"] = s["lastAt"]
        v["lastNote"] = _note_excerpt(s["note"], names)
        v["stale"] = _is_stale(f, s["lastAt"], cutoff)
        items.append(v)
    return {"total": total, "items": items, "distribution": dist}


@admin_router.get("/follow-ups/{fu_id}", response_model=dict)
def admin_follow_up_detail(fu_id: str, db: Session = Depends(get_db)):
    """一条跟进的完整记录（admin 抽屉）：跟进本身、客户概要、全部跟进记录（新→旧）、操作时间线
    （分配 / 改状态 / 改派 / 延期 / 收回 / 过期 / 站内来信 / 勿扰，新→旧，不含「写记录」——记录单列）、
    相关转化。时间线只扫这个用户自跟进创建前 1 分钟起的日志。
    One follow-up's full record for the admin drawer: the follow-up, a customer
    summary, every note (newest first), the event timeline (assign / status /
    reassign / extend / revoke / expiry / in-app letter / do-not-contact, newest
    first, note events left out since notes are listed) and its conversions. The
    timeline only scans this user's rows from a minute before the follow-up began."""
    fu = db.get(FollowUp, fu_id)
    if fu is None:
        raise HTTPException(status_code=404, detail="跟进不存在 / Follow-up not found")
    user = db.get(User, fu.user_id)
    notes = (
        db.query(FollowUpNote)
        .filter(FollowUpNote.follow_up_id == fu.id)
        .order_by(FollowUpNote.created_at.desc(), FollowUpNote.id.desc())
        .all()
    )
    convs = (
        db.query(Conversion)
        .filter(Conversion.follow_up_id == fu.id)
        .order_by(Conversion.created_at.desc(), Conversion.id.desc())
        .all()
    )
    slack = timedelta(minutes=1)
    started = desk.naive(fu.created_at)
    closed = desk.naive(fu.closed_at)
    ev_q = db.query(ActivityEvent).filter(
        ActivityEvent.user_id == fu.user_id,
        ActivityEvent.kind.in_((activity_log.SUPPORT_FOLLOW_UP, activity_log.SUPPORT_ACTION)),
    )
    if started is not None:
        ev_q = ev_q.filter(ActivityEvent.created_at >= started - slack)
    events = []
    for e in ev_q.order_by(ActivityEvent.created_at.desc(), ActivityEvent.id.desc()).all():
        data = _loads(e.data)
        action = data.get("action")
        if e.kind == activity_log.SUPPORT_FOLLOW_UP:
            # 站内来信的 ref_id 是工单号，跟进号在 data.fu / a letter's ref_id is the ticket, data.fu the follow-up
            if (e.ref_id != fu.id and data.get("fu") != fu.id) or action == "note":
                continue
        else:
            # 「勿扰」带 data.fu（关掉的跟进号列表）；老记录没有，只认紧贴结束时间（±1 分钟）的那条
            # do-not-contact carries data.fu (the follow-ups it closed); old rows lack it, so they
            # only count when they sit right at this follow-up's close (within a minute either way)
            if action != "do_not_contact":
                continue
            closed_ids = data.get("fu")
            if isinstance(closed_ids, list):
                if fu.id not in closed_ids:
                    continue
            else:
                e_at = desk.naive(e.created_at)
                if closed is None or e_at is None or abs(e_at - closed) > slack:
                    continue
        events.append({
            "id": e.id, "at": e.created_at, "action": action, "actorId": e.actor_id,
            "actorType": e.actor_type, "actorName": None, "data": data,
        })
    # update 的 data.from 是旧状态，不是人；只有 assign / reassign / revoke 的 to / from 是用户 id
    # update's data.from is the previous status; only assign / reassign / revoke carry user ids
    people = {e["actorId"] for e in events}
    for e in events:
        if e["action"] in ("assign", "reassign", "revoke"):
            people |= {e["data"].get("to"), e["data"].get("from")}
    people |= {fu.assignee_id, fu.assigned_by} | {n.author_id for n in notes} | {c.credited_to for c in convs}
    names = _names(db, {p for p in people if isinstance(p, str)})
    for e in events:
        e["actorName"] = names.get(e["actorId"])
    last_at = notes[0].created_at if notes else None  # 已按新→旧排好 / already newest first
    view = _follow_up_view(fu, user, names)
    view["email"] = user.email if user else None
    view["assignedByName"] = names.get(fu.assigned_by)
    view["notesCount"] = len(notes)
    view["lastNoteAt"] = last_at
    view["stale"] = _is_stale(fu, last_at, _now() - timedelta(days=STALE_DAYS))
    return {
        "followUp": view,
        "user": {
            "id": user.id, "email": user.email, "nickname": user.nickname, "plan": user.plan,
            "createdAt": user.created_at, "lastActiveAt": user.last_active_at,
            "doNotContact": user.do_not_contact_at is not None,
        } if user is not None else None,
        "notes": [_note_view(n, names) for n in notes],
        "events": events,
        "names": names,
        "conversions": [_conversion_view(c, None) for c in convs],
    }


def _active_follow_ups(db: Session, ids: list[str]) -> list[FollowUp]:
    return (
        db.query(FollowUp)
        .filter(FollowUp.id.in_(ids), FollowUp.status.in_(FOLLOW_UP_ACTIVE_STATUSES))
        .all()
    )


@admin_router.post("/follow-ups/revoke", response_model=dict)
def admin_follow_up_revoke(body: IdsIn, db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    """收回跟进（status=revoked），原客服立即失去跟进视图 / revoke; the agent loses the view at once."""
    ctx = _admin_ctx(admin)
    now = _now()
    rows = _active_follow_ups(db, body.ids)
    for fu in rows:
        fu.status = "revoked"
        fu.closed_at = now
        desk.log(db, ctx, activity_log.SUPPORT_FOLLOW_UP, user_id=fu.user_id, ref_id=fu.id,
                 data={"action": "revoke", "from": fu.assignee_id})
    db.commit()
    return {"updated": len(rows)}


@admin_router.post("/follow-ups/reassign", response_model=dict)
def admin_follow_up_reassign(body: ReassignIn, db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    """改派给另一位客服。已记录的转化归属不变（归属在转化发生时定死）。
    Reassign to another agent; conversions already credited keep their credit."""
    ctx = _admin_ctx(admin)
    assignee = _active_staff(db, body.assigneeId)
    rows = _active_follow_ups(db, body.ids)
    for fu in rows:
        if fu.assignee_id == assignee.id:
            continue
        old = fu.assignee_id
        fu.assignee_id = assignee.id
        fu.assigned_notified = False
        desk.log(db, ctx, activity_log.SUPPORT_FOLLOW_UP, user_id=fu.user_id, ref_id=fu.id,
                 data={"action": "reassign", "from": old, "to": assignee.id})
    db.commit()
    return {"updated": len(rows)}


@admin_router.post("/follow-ups/extend", response_model=dict)
def admin_follow_up_extend(body: ExtendIn, db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    """延期：给定新截止时间，或在 max(原截止, 现在) 上加 days 天。按天数延期时跳过没有截止
    时间的跟进——它们本来就不限期，加天数反而会让它们到期自动结束。
    Extend: set a new deadline, or add days to max(current deadline, now). Extending by days
    skips follow-ups without a deadline: they never expire, and adding days would make them."""
    if body.expiresAt is None and body.days is None:
        raise HTTPException(status_code=422, detail="请给出 expiresAt 或 days / expiresAt or days is required")
    ctx = _admin_ctx(admin)
    now = _now()
    rows = _active_follow_ups(db, body.ids)
    if body.expiresAt is None:
        rows = [fu for fu in rows if fu.expires_at is not None]
    for fu in rows:
        if body.expiresAt is not None:
            new = desk.naive(body.expiresAt)
        else:
            base = max(desk.naive(fu.expires_at) or now, now)
            new = base + timedelta(days=body.days)
        fu.expires_at = new
        fu.expiring_notified = False
        desk.log(db, ctx, activity_log.SUPPORT_FOLLOW_UP, user_id=fu.user_id, ref_id=fu.id,
                 data={"action": "extend", "to": new.isoformat()})
    db.commit()
    return {"updated": len(rows)}


@admin_router.get("/requests", response_model=dict)
def admin_support_requests(
    status: str | None = Query(default="pending"),
    kind: str | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_db),
):
    """待审批（默认 pending）：comp_days / follow_up / conversion_manual。
    The approval queue (pending by default)."""
    q = db.query(SupportRequest)
    if status and status != "all":
        q = q.filter(SupportRequest.status == status)
    if kind:
        q = q.filter(SupportRequest.kind == kind)
    rows = q.order_by(SupportRequest.created_at.desc()).offset(offset).limit(limit).all()
    names = _names(db, {r.requester_id for r in rows} | {r.target_user_id for r in rows})
    items = []
    for r in rows:
        v = _request_view(r, names)
        v["targetName"] = names.get(r.target_user_id)
        items.append(v)
    return {"items": items}


def _pending_request(db: Session, req_id: str) -> SupportRequest:
    req = db.get(SupportRequest, req_id)
    if req is None:
        raise HTTPException(status_code=404, detail="申请不存在 / Request not found")
    if req.status != "pending":
        raise HTTPException(status_code=409, detail="申请已处理 / Request already reviewed")
    return req


@admin_router.post("/requests/{req_id}/approve", response_model=dict)
def admin_support_request_approve(
    req_id: str,
    body: ReviewIn,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    """批准申请并执行：comp_days → 按天数补偿；follow_up → 生成跟进给申请人；conversion_manual →
    记一条手动 mt5_real（confirmed，归属申请人）。
    Approve and execute: comp_days applies the days; follow_up creates the
    follow-up for the requester; conversion_manual records a confirmed manual
    mt5_real credited to the requester."""
    ctx = _admin_ctx(admin)
    req = _pending_request(db, req_id)
    payload = _loads(req.payload)
    target = db.get(User, req.target_user_id)
    if target is None:
        raise HTTPException(status_code=404, detail="用户不存在 / User not found")
    result: dict = {}
    if req.kind == "comp_days":
        days = int(payload.get("days") or 0)
        if days <= 0:
            raise HTTPException(status_code=400, detail="天数无效 / Invalid days")
        # 审计记在申请人名下还是审批人名下？记审批人：是他拍板生效的。
        # Audited under the approver: their decision is what made it take effect.
        result["planExpiresAt"] = apply_comp_days(db, admin.id, target, days)
    elif req.kind == "follow_up":
        if target.do_not_contact_at is not None:
            raise HTTPException(status_code=409, detail="用户已要求不再联系 / The user asked not to be contacted")
        if conversions.active_follow_up(db, target.id) is not None:
            raise HTTPException(status_code=409, detail="该用户已有进行中的跟进 / User already has an active follow-up")
        assignee = _active_staff(db, req.requester_id)
        fu = FollowUp(
            user_id=target.id, assignee_id=assignee.id, assigned_by=admin.id,
            goal=payload.get("goal") if payload.get("goal") in desk.FOLLOW_UP_GOALS else "revisit",
            priority="normal", note=payload.get("note"), status="pending",
            expires_at=None,
        )
        db.add(fu)
        db.flush()
        result["followUpId"] = fu.id
        desk.log(db, ctx, activity_log.SUPPORT_FOLLOW_UP, user_id=target.id, ref_id=fu.id,
                 data={"action": "assign", "to": assignee.id, "goal": fu.goal, "request": req.id})
    elif req.kind == "conversion_manual":
        fu = db.query(FollowUp).filter(
            FollowUp.user_id == target.id, FollowUp.assignee_id == req.requester_id,
            FollowUp.status.in_(FOLLOW_UP_ACTIVE_STATUSES),
        ).first()
        conv = conversions.record(
            db, target.id, conversions.KIND_MT5_REAL,
            dedupe_key=conversions.mt5_key(payload.get("login"), payload.get("server")),
            detail={"login": payload.get("login"), "server": payload.get("server"), "request": req.id},
            source=conversions.SOURCE_MANUAL, status=conversions.STATUS_CONFIRMED,
            credited_to=req.requester_id, follow_up_id=fu.id if fu else None,
        )
        if conv is not None:
            conversions.apply_follow_up_conversion(fu, conversions.KIND_MT5_REAL, conversions.STATUS_CONFIRMED)
        result["conversionId"] = conv.id if conv else None
    else:
        raise HTTPException(status_code=400, detail="未知申请类型 / Unknown request kind")
    req.status = "approved"
    req.reviewer_id = admin.id
    req.reviewed_at = _now()
    req.note = body.note
    desk.log(db, ctx, activity_log.SUPPORT_ACTION, user_id=target.id, ref_id=req.id,
             data={"action": "approve", "kind": req.kind})
    ids = desk.notify(db, [req.requester_id], KIND_SUPPORT_REMINDER,
                      f"申请已批准 / approved · {req.kind}", "/support-desk", req.id)
    db.commit()
    desk.flush_ws(ids)
    return {"request": _request_view(req), "result": result}


@admin_router.post("/requests/{req_id}/reject", response_model=dict)
def admin_support_request_reject(
    req_id: str,
    body: ReviewIn,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    """驳回申请 / reject a request."""
    ctx = _admin_ctx(admin)
    req = _pending_request(db, req_id)
    req.status = "rejected"
    req.reviewer_id = admin.id
    req.reviewed_at = _now()
    req.note = body.note
    desk.log(db, ctx, activity_log.SUPPORT_ACTION, user_id=req.target_user_id, ref_id=req.id,
             data={"action": "reject", "kind": req.kind})
    ids = desk.notify(db, [req.requester_id], KIND_SUPPORT_REMINDER,
                      f"申请被驳回 / rejected · {req.kind}", "/support-desk", req.id)
    db.commit()
    desk.flush_ws(ids)
    return {"request": _request_view(req)}


@admin_router.get("/conversions", response_model=dict)
def admin_support_conversions(
    status: str | None = Query(default=None),
    kind: str | None = Query(default=None),
    creditedTo: str | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_db),
):
    """转化列表（如 status=pending_review 是待审核的自报实盘）/ conversions, e.g. pending_review."""
    q = db.query(Conversion)
    if status:
        q = q.filter(Conversion.status == status)
    if kind:
        q = q.filter(Conversion.kind == kind)
    if creditedTo:
        q = q.filter(Conversion.credited_to == creditedTo)
    rows = q.order_by(Conversion.created_at.desc()).offset(offset).limit(limit).all()
    names = _names(db, {c.user_id for c in rows} | {c.credited_to for c in rows})
    items = []
    for c in rows:
        v = _conversion_view(c, None)
        v["userName"] = names.get(c.user_id)
        v["creditedName"] = names.get(c.credited_to)
        items.append(v)
    return {"items": items}


@admin_router.post("/conversions/{conv_id}/review", response_model=dict)
def admin_support_conversion_review(
    conv_id: str,
    body: ConversionReviewIn,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    """审核一条 pending_review 的转化：通过 → confirmed（关联跟进目标匹配则转 converted）；驳回 → rejected。
    Review a pending conversion: approve -> confirmed (a matching follow-up converts); reject -> rejected."""
    ctx = _admin_ctx(admin)
    c = db.get(Conversion, conv_id)
    if c is None:
        raise HTTPException(status_code=404, detail="转化不存在 / Conversion not found")
    if c.status != conversions.STATUS_PENDING:
        raise HTTPException(status_code=409, detail="该转化不在待审核状态 / Not pending review")
    c.status = conversions.STATUS_CONFIRMED if body.approve else conversions.STATUS_REJECTED
    c.reviewed_by = admin.id
    if body.approve and c.follow_up_id:
        conversions.apply_follow_up_conversion(db.get(FollowUp, c.follow_up_id), c.kind, c.status)
    desk.log(db, ctx, activity_log.SUPPORT_ACTION, user_id=c.user_id, ref_id=c.id,
             data={"action": "conversion_review", "approve": body.approve, "note": body.note})
    db.commit()
    return {"conversion": _conversion_view(c, None)}


@admin_router.post("/conversions", response_model=dict)
def admin_support_conversion_create(
    body: ManualConversionIn,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    """admin 补录转化（mt5_real 需服务器 + 账号；signallab_paid 每人一次）。已存在同键 → 409。
    Admin back-fills a conversion (mt5_real needs server + login; paid is once per user)."""
    ctx = _admin_ctx(admin)
    target = db.get(User, body.userId)
    if target is None:
        raise HTTPException(status_code=404, detail="用户不存在 / User not found")
    if body.creditedTo:
        _active_staff(db, body.creditedTo)
    key = ""
    if body.kind == conversions.KIND_MT5_REAL:
        if not body.server or not body.login:
            raise HTTPException(status_code=422, detail="请填写服务器和账号 / server and login are required")
        key = conversions.mt5_key(body.login.strip(), body.server.strip())
    fu = None
    if body.creditedTo:
        fu = db.query(FollowUp).filter(
            FollowUp.user_id == target.id, FollowUp.assignee_id == body.creditedTo,
            FollowUp.status.in_(FOLLOW_UP_ACTIVE_STATUSES),
        ).first()
    # 不指定归属时 record 自己按「当前进行中的跟进」归属 / no creditedTo -> record's own attribution
    conv = conversions.record(
        db, target.id, body.kind, dedupe_key=key,
        detail={"server": body.server, "login": body.login, "note": body.note, "by": admin.id},
        source=conversions.SOURCE_MANUAL, status=conversions.STATUS_CONFIRMED,
        credited_to=body.creditedTo, follow_up_id=fu.id if fu else None,
    )
    if conv is None:
        raise HTTPException(status_code=409, detail="该转化已存在 / Conversion already recorded")
    if fu is not None:
        conversions.apply_follow_up_conversion(fu, body.kind, conversions.STATUS_CONFIRMED)
    desk.log(db, ctx, activity_log.SUPPORT_ACTION, user_id=target.id, ref_id=conv.id,
             data={"action": "conversion_manual", "kind": body.kind})
    db.commit()
    return {"conversion": _conversion_view(conv, None)}


@admin_router.get("/stats", response_model=dict)
def admin_support_stats(
    start: date | None = Query(default=None),
    end: date | None = Query(default=None),
    db: Session = Depends(get_db),
):
    """业绩看板：按客服 × 时间段（按分配时间 / 转化时间落在 [start, end] 的 STATS_TZ 自然日）。
    只给数量：分配数、已联系、有意向、已转化跟进、转化数（分 kind，只算 confirmed）、转化率、
    平均首次联系时长（小时）。不含任何金额。
    Performance per agent over [start, end] (STATS_TZ days, by assignment time /
    conversion time). Counts only — never amounts."""
    from app.services.stats_time import day_start_utc, today

    end = end or today()
    start = start or (end - timedelta(days=29))
    if start > end:
        raise HTTPException(status_code=422, detail="开始日期晚于结束日期 / start is after end")
    lo = desk.naive(day_start_utc(start))
    hi = desk.naive(day_start_utc(end + timedelta(days=1)))
    staff = db.query(User).filter(User.role.in_(("support", "admin"))).all()
    fus = db.query(FollowUp).filter(FollowUp.created_at >= lo, FollowUp.created_at < hi).all()
    convs = (
        db.query(Conversion)
        .filter(Conversion.credited_to.isnot(None), Conversion.status == conversions.STATUS_CONFIRMED,
                Conversion.created_at >= lo, Conversion.created_at < hi)
        .all()
    )
    contacted_states = {"contacted", "interested", "converted", "no_interest", "unreachable"}
    rows = {}
    for u in staff:
        rows[u.id] = {
            "staffId": u.id, "nickname": u.nickname, "email": u.email, "role": u.role,
            "tier": staff_ctx_for(u).tier,
            "assigned": 0, "contacted": 0, "interested": 0, "convertedFollowUps": 0,
            "conversions": {k: 0 for k in conversions.KINDS},
            "conversionRate": None, "avgFirstContactHours": None, "_fc": [],
        }
    for f in fus:
        r = rows.get(f.assignee_id)
        if r is None:
            continue
        r["assigned"] += 1
        if f.first_contact_at is not None or f.status in contacted_states:
            r["contacted"] += 1
        if f.status in ("interested", "converted"):
            r["interested"] += 1
        if f.status == "converted":
            r["convertedFollowUps"] += 1
        if f.first_contact_at is not None and f.created_at is not None:
            r["_fc"].append((desk.naive(f.first_contact_at) - desk.naive(f.created_at)).total_seconds() / 3600)
    for c in convs:
        r = rows.get(c.credited_to)
        if r is not None and c.kind in r["conversions"]:
            r["conversions"][c.kind] += 1
    out = []
    for r in rows.values():
        fc = r.pop("_fc")
        if r["assigned"]:
            r["conversionRate"] = round(r["convertedFollowUps"] / r["assigned"], 4)
        if fc:
            r["avgFirstContactHours"] = round(sum(fc) / len(fc), 2)
        if r["role"] == "admin" and not r["assigned"] and not any(r["conversions"].values()):
            continue  # 没参与跟进的管理员不占行 / admins with no desk work are omitted
        out.append(r)
    out.sort(key=lambda r: (-sum(r["conversions"].values()), -r["assigned"]))
    return {"start": start.isoformat(), "end": end.isoformat(), "items": out}


@admin_router.get("/progress", response_model=dict)
def admin_support_progress(db: Session = Depends(get_db)):
    """跟进进度（按人）：每位客服（以及名下有进行中跟进的其他人，如管理员）当前进行中的跟进数与
    状态分布、停滞数（STALE_DAYS 天没有新记录）、近 7 天自己写的记录数、最近一次写记录的时间；
    外加全站合计。停用的客服只在仍有进行中跟进或近 7 天有记录时列出。全部是分组查询，不逐人查。
    Follow-up progress per person: every support agent (plus anyone else, e.g. an
    admin, holding active follow-ups) with active count and status distribution,
    stale count (no note for STALE_DAYS days), notes they wrote in the last 7 days
    and their latest note time, plus site-wide totals. Disabled agents appear only
    while they still hold active follow-ups or wrote notes in 7 days. Grouped
    queries only — no per-agent query loops."""
    now = _now()
    cutoff = now - timedelta(days=STALE_DAYS)
    week_ago = now - timedelta(days=7)
    is_active = FollowUp.status.in_(FOLLOW_UP_ACTIVE_STATUSES)
    dist: dict[str, dict[str, int]] = {}
    for assignee, st, n in (
        db.query(FollowUp.assignee_id, FollowUp.status, func.count(FollowUp.id))
        .filter(is_active)
        .group_by(FollowUp.assignee_id, FollowUp.status)
        .all()
    ):
        if n:
            dist.setdefault(assignee, {})[st] = n
    last = _last_note_sq()
    stale = dict(
        db.query(FollowUp.assignee_id, func.count(FollowUp.id))
        .outerjoin(last, last.c.fu_id == FollowUp.id)
        .filter(is_active, func.coalesce(last.c.last_at, FollowUp.created_at) < cutoff)
        .group_by(FollowUp.assignee_id)
        .all()
    )
    notes7 = dict(
        db.query(FollowUpNote.author_id, func.count(FollowUpNote.id))
        .filter(FollowUpNote.created_at >= week_ago)
        .group_by(FollowUpNote.author_id)
        .all()
    )
    # 行：全部客服 + 名下有进行中跟进的其他人 / rows: every agent plus other active assignees
    people = {u.id: u for u in db.query(User).filter(User.role == "support").all()}
    extra = set(dist) - set(people)
    if extra:
        people.update({u.id: u for u in db.query(User).filter(User.id.in_(extra)).all()})
    last_note = dict(
        db.query(FollowUpNote.author_id, func.max(FollowUpNote.created_at))
        .filter(FollowUpNote.author_id.in_(list(people)))
        .group_by(FollowUpNote.author_id)
        .all()
    ) if people else {}
    items = []
    for u in people.values():
        d = dist.get(u.id, {})
        active = sum(d.values())
        disabled = u.disabled_at is not None
        if u.role == "support" and disabled and not active and not notes7.get(u.id):
            continue  # 停用且已无工作的客服不占行 / disabled agents with no work left are omitted
        items.append({
            "staffId": u.id, "nickname": u.nickname, "email": u.email, "role": u.role,
            "tier": staff_ctx_for(u).tier, "disabled": disabled,
            "active": active, "distribution": d, "stale": stale.get(u.id, 0),
            "notes7d": notes7.get(u.id, 0), "lastNoteAt": last_note.get(u.id),
        })
    items.sort(key=lambda r: (r["disabled"], -r["active"], -r["notes7d"],
                              (r["nickname"] or r["email"] or "").lower()))
    return {
        "staleDays": STALE_DAYS,
        "totals": {
            "active": sum(sum(d.values()) for d in dist.values()),
            "stale": sum(stale.values()),
            "notes7d": sum(notes7.values()),
            "pending": sum(d.get("pending", 0) for d in dist.values()),
        },
        "items": items,
    }


@admin_router.get("/templates", response_model=dict)
def admin_support_templates(db: Session = Depends(get_db)):
    return {"items": [_template_view(t) for t in db.query(SupportReplyTemplate).order_by(SupportReplyTemplate.title).all()]}


@admin_router.post("/templates", response_model=dict)
def admin_support_template_create(body: TemplateIn, db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    t = SupportReplyTemplate(title=body.title.strip(), body=body.body, lang=body.lang, created_by=admin.id)
    db.add(t)
    db.commit()
    return {"template": _template_view(t)}


@admin_router.patch("/templates/{tpl_id}", response_model=dict)
def admin_support_template_patch(tpl_id: str, body: TemplatePatchIn, db: Session = Depends(get_db)):
    t = db.get(SupportReplyTemplate, tpl_id)
    if t is None:
        raise HTTPException(status_code=404, detail="模板不存在 / Template not found")
    fields = body.model_dump(exclude_unset=True)
    if fields.get("title"):
        t.title = fields["title"].strip()
    if fields.get("body"):
        t.body = fields["body"]
    if "lang" in fields:
        t.lang = fields["lang"]
    t.updated_at = _now()
    db.commit()
    return {"template": _template_view(t)}


@admin_router.delete("/templates/{tpl_id}", response_model=dict)
def admin_support_template_delete(tpl_id: str, db: Session = Depends(get_db)):
    t = db.get(SupportReplyTemplate, tpl_id)
    if t is None:
        raise HTTPException(status_code=404, detail="模板不存在 / Template not found")
    db.delete(t)
    db.commit()
    return {"ok": True}
