"""工单路由：用户提交工单、查看自己的工单、追加回复；管理员查看/回复/修改全部工单。

站内通知走两个方向：新工单落地时给每位管理员写一条（不发系统推送，见
_notify_admins_new_ticket），管理员回复时给提交者写一条并另发系统推送。两种通知都
与产生它的那次写入同一个事务——系统推送可能因为没订阅、被墙、密钥没配而根本发不
出去，铃铛里那一条是唯一保证留得下的痕迹。

Ticket router: users submit, view and reply to their own tickets; admins view,
reply to and modify all tickets. In-app notifications flow both ways: a new
ticket notifies every admin (no tray push — see _notify_admins_new_ticket), an
admin reply notifies the submitter and also pushes. Both rows ride the same
transaction as the write that produced them: a tray push can simply not happen
(no subscription, blocked network, no keys), which leaves the bell entry as the
one trace guaranteed to survive.
"""
import json
import logging
import re
from datetime import datetime, timezone

from fastapi import APIRouter, BackgroundTasks, Depends, File, HTTPException, Query, Request, UploadFile, status
from sqlalchemy.orm import Session, selectinload
from starlette.concurrency import run_in_threadpool

from app.core.config import settings
from app.core.database import get_db
from app.core.strategy_limits import user_limiter
from app.models import LuckyDraw, Ticket, TicketReply, User, UserNotification
from app.schemas import (
    AdminTicketAssign,
    AdminTicketReplyCreate,
    AdminTicketUpdate,
    TicketCreate,
    TicketListItem,
    TicketOut,
    TicketReplyCreate,
    TicketReplyOut,
)
from app.services.audit import log_change
from app.services.deps import STAFF_ROLES, StaffCtx, get_current_user, get_current_user_id_light, require_admin, require_staff
from app.services.image_upload import (
    UploadError,
    delete_private_images,
    is_private_configured,
    read_upload_capped,
    signed_image_urls,
    upload_private_image,
)
from app.services.notification_feed import (
    KIND_TICKET_NEW,
    KIND_TICKET_REPLY,
    create_notification,
    notify_ws,
)

logger = logging.getLogger("prismx.tickets")

router = APIRouter(prefix="/tickets", tags=["tickets"])

# 列表端点的预加载：两个列表都要为每一行取最新一条回复（_latest_reply）及其作者，
# 懒加载下这就是每行 2 条查询，管理端一页 200 条 = 400+ 条查询，全是 by-id 的小
# 查询，看不出慢但把一次列表变成一轮扫射。selectinload 把它压成"每种关系一条
# IN 查询"，与这个文件里其余批量取数的写法一致。
# 管理端还要 Ticket.user（列表要显示提交者邮箱），那一条在用到的地方单独加——
# 用户端列表用的是自己的 user.email，不需要。
# Eager loads for the list endpoints: both need the newest reply and its author
# per row (_latest_reply), which lazily is two queries per row — 400+ on a
# 200-row admin page. All tiny by-id lookups, individually invisible, together a
# burst. selectinload collapses them to one IN query per relationship. The admin
# list additionally needs Ticket.user for the submitter's email; the user-facing
# list already has that user in hand.
_LIST_EAGER_LOADS = selectinload(Ticket.replies).selectinload(TicketReply.author)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _reply_role(r: TicketReply) -> str:
    """回复作者的角色：优先用写入时的快照（rev 41 author_role），旧行回落作者当前角色。
    The reply author's role: the rev 41 snapshot, else the author's current role."""
    return r.author_role or (r.author.role if r.author is not None else "user")


def _author_email(author: User, viewer_is_admin: bool, role: str | None = None) -> str:
    """回复作者在当前查看者眼里的邮箱：工作人员（客服 / 管理员）的邮箱不给普通用户看，
    回空串，前端据此显示「Signal Lab 客服」。工作人员查看时照常给全。
    The reply author's email as the viewer may see it: staff (support / admin)
    emails are never shown to regular users (empty string; the UI shows "Support")."""
    role = role or author.role
    if role in STAFF_ROLES and not viewer_is_admin:
        return ""
    return author.email


def _is_staff(user: User) -> bool:
    return user.role in STAFF_ROLES


# 附图对象键只认 upload_private_image 产出的形状：<作者 id>/<32 位 hex>.<扩展名>，可带尺寸片段。
# 于是消息里塞不进外链（追踪像素会把看工单的管理员的 IP 送出去），也引用不了别人目录下的图——
# 目录名必须等于这条消息的作者。
# Image keys must have exactly the shape upload_private_image produces: <author id>/<32 hex>.<ext>,
# optional size fragment. So no external URL can be smuggled in (a tracking pixel would leak the
# viewing admin's IP), and no one else's upload can be referenced — the folder must be the author.
_IMAGE_KEY_RE = re.compile(r"^(?P<owner>[^/#]{1,64})/[0-9a-f]{32}\.(?:png|jpg|gif|webp)(?:#w=\d{1,5}&h=\d{1,5})?$")


def _checked_images(keys: list[str], author_id: str) -> str | None:
    """校验附图键并序列化成写库的 JSON；不合规回 400，没有图回 None。
    Validate image keys and serialise them for storage; 400 when invalid, None when empty."""
    for key in keys:
        m = _IMAGE_KEY_RE.match(key)
        if not m or m.group("owner") != author_id:
            raise HTTPException(status_code=400, detail="图片无效，请重新上传 / Invalid image, please upload it again")
    return json.dumps(keys) if keys else None


def _image_keys(r: TicketReply) -> list[str]:
    if not r.images:
        return []
    try:
        keys = json.loads(r.images)
    except ValueError:
        return []
    return [k for k in keys if isinstance(k, str)] if isinstance(keys, list) else []


def _reply_out(r: TicketReply, viewer_is_admin: bool, urls: dict[str, str] | None = None) -> TicketReplyOut:
    """urls 为 None 时不给图（列表预览），只给张数；签不出来的图同样只计数，前端显示占位。
    With urls None (list previews) only the count is given; images that couldn't be signed
    are likewise only counted and the UI shows a placeholder."""
    keys = _image_keys(r)
    role = _reply_role(r)
    return TicketReplyOut(
        id=r.id,
        authorId=r.author_id,
        authorEmail=_author_email(r.author, viewer_is_admin, role),
        authorRole=role,
        authorName=r.author.nickname if role in STAFF_ROLES else None,
        internal=bool(r.internal),
        body=r.body,
        images=[urls[k] for k in keys if k in urls] if urls else [],
        imageCount=len(keys),
        createdAt=r.created_at,
    )


def _visible(replies: list[TicketReply], viewer_is_admin: bool) -> list[TicketReply]:
    """内部备注只给工作人员看 / internal notes are staff-only."""
    return replies if viewer_is_admin else [r for r in replies if not r.internal]


def _assignee_name(db: Session | None, ticket: Ticket) -> str | None:
    if not ticket.assignee_id or db is None:
        return None
    u = db.get(User, ticket.assignee_id)
    return (u.nickname or u.email) if u else None


def _ticket_out(ticket: Ticket, replies: list[TicketReply], viewer_is_admin: bool, db: Session | None = None) -> TicketOut:
    """把 ORM 对象转成 TicketOut；整条工单的附图一次签完。非工作人员视角下内部备注整行剔除。
    viewer_is_admin 的意思是「查看者是工作人员（客服或管理员）」。
    Convert ORM objects to TicketOut, signing the whole thread's images in one call.
    Internal notes are dropped for non-staff viewers. viewer_is_admin means "the
    viewer is staff (support or admin)"."""
    user: User = ticket.user  # relationship backref
    replies = _visible(replies, viewer_is_admin)
    urls = signed_image_urls([k for r in replies for k in _image_keys(r)])
    return TicketOut(
        id=ticket.id,
        userId=ticket.user_id,
        userEmail=user.email,
        title=ticket.title,
        category=ticket.category,
        priority=ticket.priority,
        status=ticket.status,
        createdAt=ticket.created_at,
        updatedAt=ticket.updated_at,
        replies=[_reply_out(r, viewer_is_admin, urls) for r in replies],
        assigneeId=ticket.assignee_id if viewer_is_admin else None,
        assigneeName=_assignee_name(db, ticket) if viewer_is_admin else None,
    )


def _staff_targets(db: Session, ticket: Ticket, exclude: str) -> list[tuple[str, str]]:
    """工单通知的工作人员收件人 (id, role)：已指派 → 指派人 + 全体 admin；未指派 → admin + 全部
    在岗客服（未停用）。
    Staff recipients for ticket notifications: assignee + admins when assigned,
    otherwise admins plus every on-duty (enabled) support agent."""
    q = db.query(User.id, User.role).filter(User.disabled_at.is_(None))
    if ticket.assignee_id:
        rows = q.filter((User.role == "admin") | (User.id == ticket.assignee_id)).all()
    else:
        rows = q.filter(User.role.in_(STAFF_ROLES)).all()
    return [(r[0], r[1]) for r in rows if r[0] != exclude]


def _staff_link(role: str, ticket_id: str) -> str:
    if role == "admin":
        return f"/admin?tab=tickets&ticket={ticket_id}"
    return f"/support-desk?ticket={ticket_id}"


def _notify_admins_new_ticket(db: Session, ticket: Ticket, submitter: User) -> list[str]:
    """新工单落地时给每位管理员写一条站内通知，返回收到通知的管理员 id。

    不发系统推送：管理员是少数几个人，工单也不是分秒必争的事，往每个管理员的
    每台设备推一条只会把后台的日常变成噪音。铃铛里留一条就够——他们本来就常开
    着后台。提交者自己是管理员时不通知自己。

    Write one in-app notification per admin when a ticket lands, returning the
    ids notified. No tray push: admins are a handful of people and a ticket isn't
    time-critical, so fanning out to every device of every admin would only turn
    routine work into noise — a bell entry is enough for people who keep the
    console open anyway. A submitter who is themselves an admin isn't notified.
    """
    # rev 41：收件人从「全体管理员」扩成「管理员 + 在岗客服」（已指派的只通知指派人 + 管理员）。
    # rev 41: recipients widen from admins to admins + on-duty support (assignee + admins once assigned).
    targets = _staff_targets(db, ticket, submitter.id)
    for staff_id, role in targets:
        create_notification(
            db,
            staff_id,
            KIND_TICKET_NEW,
            text=ticket.title,
            link=_staff_link(role, ticket.id),
            ref_id=ticket.id,
        )
    return [t[0] for t in targets]


def _notify_admins_ticket_reply(db: Session, ticket: Ticket, author: User) -> list[str]:
    """用户追加回复时给每位管理员写一条站内通知，返回收到通知的管理员 id。

    为什么必须有：新工单会通知全体管理员（_notify_admins_new_ticket），但用户在
    已有工单里追问就完全静默。管理端列表按 updated_at 倒序，而追加一条 reply
    **不会**触发 Ticket 行的 onupdate（那个 onupdate 只在 Ticket 自己被 UPDATE 时
    生效），所以那条工单连往上冒都不会——用户回了话，管理员这边没有任何变化。
    这两件事要一起修，只修一件仍然看不见（排序修了但没人知道要去看，通知修了
    但点进列表还是在第二页）。

    复用 KIND_TICKET_REPLY：这条通知对管理员的意思就是"工单有新回复"，与管理员
    回复时发给用户的那条同一件事、方向相反。link 指向后台的工单详情。
    不发系统推送，理由同 _notify_admins_new_ticket。

    Notify every admin when a user adds a reply. New tickets already fan out, but
    a follow-up on an existing ticket was silent — and since the admin list is
    ordered by updated_at while appending a reply does not touch the Ticket row
    (its onupdate only fires on an UPDATE of Ticket itself), the ticket did not
    even float to the top. Both halves have to be fixed together or the user's
    reply stays invisible either way. Reuses KIND_TICKET_REPLY: to an admin this
    means exactly "the ticket has a new reply", same event, other direction.
    """
    targets = _staff_targets(db, ticket, author.id)
    for staff_id, role in targets:
        create_notification(
            db,
            staff_id,
            KIND_TICKET_REPLY,
            text=ticket.title,
            link=_staff_link(role, ticket.id),
            ref_id=ticket.id,
        )
    return [t[0] for t in targets]


def _latest_reply(ticket: Ticket, viewer_is_admin: bool) -> TicketReplyOut | None:
    """最新的那条回复（可能有也可能没有）/ the most recent reply, if any."""
    # relationship 上配了 order_by="TicketReply.created_at"（见 models），所以
    # ticket.replies 已经按时间升序，取最后一个就是最新的那条。
    # 别按"默认按 id 排序"去理解这一段——那是这条注释以前的说法，早就不成立了。
    # The relationship carries order_by="TicketReply.created_at" (see models), so
    # replies is already oldest-first and the last element is the newest. (This
    # comment used to claim "ordered by id by default"; that stopped being true.)
    replies = _visible(list(ticket.replies or []), viewer_is_admin)
    if replies:
        return _reply_out(replies[-1], viewer_is_admin)
    return None


# ---- 用户端 / user endpoints ----

@router.post("/upload-image", response_model=dict)
@user_limiter.limit(settings.RATE_LIMIT_TICKET_UPLOAD)
async def upload_ticket_image(
    request: Request,
    file: UploadFile = File(...),
    user_id: str = Depends(get_current_user_id_light),
):
    """上传一张工单截图，返回对象键（发消息时放进 images）。用户与管理员共用。

    鉴权走只读缓存的轻量依赖：get_current_user 会拿一个数据库连接并一直占到响应结束，
    而上传要等文件推到 Supabase，慢网下几十秒——为一张截图占住连接池里的一个连接不值得。
    两道大小判断的道理同 admin.upload_admin_image（声明值只配快速拒绝，读到的字节数才算数）。

    Upload one ticket screenshot and return its object key (sent back in `images`). Shared by
    users and admins. Auth uses the cache-only dependency: get_current_user checks out a DB
    connection and holds it until the response, and an upload waits on Supabase for up to tens
    of seconds on a slow link — not worth a pooled connection per screenshot. The two size
    checks follow admin.upload_admin_image (declared size for fast rejection only).
    """
    if not is_private_configured():
        raise HTTPException(status_code=503, detail="后台未配置图片存储 / Image storage isn't configured")
    # 声明大小快速拒绝 + 有界读取（最多读上限+1 字节），见 read_upload_capped
    # Declared-size fast rejection + a bounded read (cap+1 bytes), see read_upload_capped
    data = await read_upload_capped(file, request)
    try:
        # 同步 httpx 挪进线程池，别卡事件循环（见 admin.upload_admin_image 的说明）
        # The sync httpx call goes to the threadpool, off the event loop (see admin.upload_admin_image)
        key = await run_in_threadpool(upload_private_image, data, user_id)
    except UploadError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"key": key}


# 发工单 / 回复的按用户限流：两者都会写库、给全体管理员发通知（站内 + WS），没有上限
# 就是一个登录用户能刷满管理员收件箱与 tickets 表的口子。数值远高于正常使用
# （真人一小时提不了十个工单），只拦脚本。
# Per-user limits on creating and replying: both write rows and notify every admin
# (feed + WS), so without a cap one account could flood the admins' inbox and the
# tickets table. Well above real use — only scripts hit these.
RATE_LIMIT_TICKET_CREATE = "3/minute;10/hour"
RATE_LIMIT_TICKET_REPLY = "6/minute;30/hour"


@router.post("", response_model=TicketOut, status_code=status.HTTP_201_CREATED)
@user_limiter.limit(RATE_LIMIT_TICKET_CREATE)
def create_ticket(
    request: Request,
    body: TicketCreate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """提交新工单。同时写入 tickets 和第一条 ticket_replies。
    Submit a new ticket; writes the ticket and its first reply in one step."""
    # 标题先去空白再判空：schema 的 min_length 在 strip 之前校验，纯空格标题会漏过去，
    # 落库成空标题。strip 只会变短，max_length 那条不受影响。
    # Strip first, then require non-empty: the schema's min_length runs before the
    # strip, so a whitespace-only title would slip through and be stored empty.
    # Stripping only shortens, so max_length still holds.
    title = body.title.strip()
    if not title:
        raise HTTPException(status_code=422, detail="请填写标题 / Title is required")
    images = _checked_images(body.images, user.id)
    ticket = Ticket(
        user_id=user.id,
        title=title,
        category=body.category,
        priority=body.priority,
        status="open",
    )
    db.add(ticket)
    db.flush()
    reply = TicketReply(
        ticket_id=ticket.id,
        author_id=user.id,
        body=body.body.strip(),
        images=images,
        author_role="user",
    )
    db.add(reply)
    admin_ids = _notify_admins_new_ticket(db, ticket, user)
    db.commit()
    db.refresh(ticket)
    for admin_id in admin_ids:
        notify_ws(admin_id)
    # 用户侧接口一律按用户视角返回（内部备注不出现）/ user endpoints always return the user view
    return _ticket_out(ticket, [reply], False)


@router.get("", response_model=list[TicketListItem])
def list_my_tickets(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """当前用户的工单列表，按 updated_at 倒序，每条带最新回复预览。
    Current user's tickets, newest first, each with a latest-reply preview."""
    tickets = (
        db.query(Ticket)
        .options(_LIST_EAGER_LOADS)
        .filter(Ticket.user_id == user.id)
        .order_by(Ticket.updated_at.desc())
        .all()
    )
    return [
        TicketListItem(
            id=t.id,
            userEmail=user.email,
            title=t.title,
            category=t.category,
            priority=t.priority,
            status=t.status,
            updatedAt=t.updated_at,
            # 用户侧列表恒按用户视角：自己工单里的内部备注不给
            # The user-side list is always the user view: no internal notes
            latestReply=_latest_reply(t, False),
        )
        for t in tickets
    ]


@router.get("/{ticket_id}", response_model=TicketOut)
def get_ticket(
    ticket_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """工单详情 + 全部回复。仅工单所有者或管理员可访问。

    「不存在」与「不是你的」回同一个 404：403 等于确认这个 id 真的存在，而
    /agent 那边（invite._owned_link）已经是统一 404 的做法，同一个产品里不该有
    两种口径。id 是 UUID、实际可猜性低，所以这是对齐而不是补漏洞。

    Not-found and not-yours share one 404: a 403 confirms the id exists, and the
    agent endpoints already answer 404 for both. Ids are UUIDs so this is
    consistency work, not a hole being closed.
    """
    ticket = db.query(Ticket).filter(Ticket.id == ticket_id).first()
    if not ticket or (ticket.user_id != user.id and not _is_staff(user)):
        raise HTTPException(status_code=404, detail="工单不存在 / Ticket not found")
    replies = (
        db.query(TicketReply)
        .filter(TicketReply.ticket_id == ticket_id)
        .order_by(TicketReply.created_at.asc())
        .all()
    )
    # 自己的工单按用户视角（内部备注不出现）；工作人员看别人的工单按工作人员视角。
    # Own ticket -> user view (no internal notes); staff viewing someone else's -> staff view.
    return _ticket_out(ticket, replies, ticket.user_id != user.id and _is_staff(user), db)


@router.post("/{ticket_id}/reply", response_model=TicketOut)
@user_limiter.limit(RATE_LIMIT_TICKET_REPLY)
def reply_to_ticket(
    request: Request,
    ticket_id: str,
    body: TicketReplyCreate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """追加回复。closed 工单拒绝，除非传 reopen: true。
    Add a reply. Closed tickets are rejected unless reopen is true."""
    ticket = db.query(Ticket).filter(Ticket.id == ticket_id).first()
    # 与 get_ticket 同一口径：不存在与不是你的都是 404。留一个 403 在这里等于
    # 把详情那边刚统一掉的存在性信号从另一个端点原样漏出去。
    # Same verdict as get_ticket: a lingering 403 here would leak from one
    # endpoint exactly what the other just stopped leaking.
    if not ticket or ticket.user_id != user.id:
        raise HTTPException(status_code=404, detail="工单不存在 / Ticket not found")
    images = _checked_images(body.images, user.id)
    if ticket.status == "closed" and not body.reopen:
        raise HTTPException(
            status_code=400,
            detail="工单已关闭，可重开后回复 / Ticket is closed, reopen it to reply",
        )
    if body.reopen:
        ticket.status = "open"
    reply = TicketReply(
        ticket_id=ticket.id,
        author_id=user.id,
        body=body.body.strip(),
        images=images,
        # 在自己的工单里回复，身份就是「用户」——哪怕他本人是客服。
        # Replying on one's own ticket is a user reply, even for a staff member.
        author_role="user",
    )
    db.add(reply)
    # updated_at 无条件更新，不再只在 reopen 时更新：两端的列表都按它倒序排，
    # 不动它的话用户的追问会一直沉在"最后一次有人改过工单状态"的位置。
    # onupdate 指望不上——追加一行 reply 不是对 Ticket 行的 UPDATE。
    # updated_at is bumped unconditionally now, not only on reopen: both lists
    # sort by it, so a follow-up would otherwise stay buried at whenever the
    # ticket itself was last touched. The column's onupdate can't help — adding
    # a reply is not an UPDATE of the Ticket row.
    ticket.updated_at = _now()
    admin_ids = _notify_admins_ticket_reply(db, ticket, user)
    db.commit()
    db.refresh(ticket)
    for admin_id in admin_ids:
        notify_ws(admin_id)
    replies = (
        db.query(TicketReply)
        .filter(TicketReply.ticket_id == ticket_id)
        .order_by(TicketReply.created_at.asc())
        .all()
    )
    return _ticket_out(ticket, replies, False)


# ---- 管理员端 / admin endpoints ----

admin_router = APIRouter(prefix="/admin/tickets", tags=["admin-tickets"])

# 审计行里管理员回复只留开头这么多字：操作日志一句话说清「回了什么」就够，全文在
# ticket_replies 里，不必在审计表再存一份。
# How much of an admin reply the audit row keeps: enough for the activity log to
# say what was answered; the full text already lives in ticket_replies.
_AUDIT_REPLY_CHARS = 60


def _reply_excerpt(reply: TicketReply) -> str:
    text = (reply.body or "").strip()
    if text:
        return text if len(text) <= _AUDIT_REPLY_CHARS else text[:_AUDIT_REPLY_CHARS] + "…"
    # 只发了截图的回复也是一条回复，不能因为正文为空被 log_change 当成「没变」跳过。
    # An image-only reply is still a reply; an empty value would make log_change
    # treat it as "unchanged" and skip it.
    n = len(_image_keys(reply))
    return f"[图片 ×{n} / {n} image(s)]"


def _audit_ticket_change(
    db: Session,
    admin_id: str,
    ticket: Ticket,
    old_status: str | None,
    old_priority: str | None,
    reply: TicketReply | None = None,
) -> None:
    """管理员动工单的审计（以前只有回复正文留在 ticket_replies，状态 / 优先级怎么变的
    无从查起）：`ticket:<id>:status`、`ticket:<id>:priority` 各一行（没变的 log_change
    自己跳过），有回复再加 `ticket:<id>:reply`（只存开头 60 字）。目标用户记工单提交者，
    操作日志按用户筛选时能看到「管理员处理了他的工单」。随调用方的 commit 提交；同一请求
    的几行共用一个 op_id，页面上合成一行。

    Audit for admin ticket handling — previously only reply bodies survived (in
    ticket_replies) and status / priority history was lost. One row each for
    `ticket:<id>:status` and `ticket:<id>:priority` (log_change skips unchanged
    ones), plus `ticket:<id>:reply` holding the first 60 characters. The target is
    the ticket's submitter, so filtering the activity log by user shows staff
    handling their ticket. Rides the caller's commit; rows from one request share
    an op_id and fold into one line on the page.
    """
    log_change(db, admin_id, ticket.user_id, f"ticket:{ticket.id}:status", old_status, ticket.status)
    log_change(db, admin_id, ticket.user_id, f"ticket:{ticket.id}:priority", old_priority, ticket.priority)
    if reply is not None:
        log_change(db, admin_id, ticket.user_id, f"ticket:{ticket.id}:reply", None, _reply_excerpt(reply))


def _staff(ctx) -> StaffCtx:
    """依赖注入给的是 StaffCtx；老测试直接调函数时传的是 User，这里统一成 StaffCtx。
    The dependency yields a StaffCtx; direct calls (older tests) pass a User."""
    if isinstance(ctx, StaffCtx):
        return ctx
    from app.services.deps import staff_ctx_for

    return staff_ctx_for(ctx)


# 客服的列表分页上限（设计 §8：客服接口不提供批量浏览，单页最多 50）；admin 仍可到 200。
# Page cap for support agents (design §8: no bulk browsing, 50 per page); admins keep 200.
SUPPORT_PAGE_MAX = 50


@admin_router.get("", response_model=list[TicketListItem])
def list_all_tickets(
    status_filter: str | None = Query(default=None, alias="status"),
    category: str | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_db),
    _admin: StaffCtx = Depends(require_staff),
    assignee: str | None = Query(default=None),
):
    """全部工单列表，支持按 status / category / assignee（me / none / <用户 id>）筛选，分页。
    客服与管理员都能看全部工单（处理工单需要，设计 §2.4）；客服单页最多 50。
    All tickets, filterable by status / category / assignee (me / none / <user id>),
    paginated. Support agents see every ticket too (design §2.4), 50 per page max."""
    ctx = _staff(_admin)
    if not ctx.is_admin:
        limit = min(limit, SUPPORT_PAGE_MAX)
    query = db.query(Ticket)
    # status=active = 未关闭（open + in_progress），客服台「待回复」用 / not closed, for the desk's awaiting-reply tab
    if status_filter == "active":
        query = query.filter(Ticket.status != "closed")
    elif status_filter:
        query = query.filter(Ticket.status == status_filter)
    if category:
        query = query.filter(Ticket.category == category)
    # 直接调函数时没传 assignee 会拿到 Query(...) 对象本身，只认字符串。
    # A direct call that omits assignee receives the Query(...) default itself; only strings count.
    if isinstance(assignee, str) and assignee:
        if assignee == "me":
            query = query.filter(Ticket.assignee_id == ctx.user.id)
        elif assignee == "none":
            query = query.filter(Ticket.assignee_id.is_(None))
        else:
            query = query.filter(Ticket.assignee_id == assignee)
    tickets = (
        query.options(selectinload(Ticket.user), _LIST_EAGER_LOADS)
        .order_by(Ticket.updated_at.desc())
        .offset(offset)
        .limit(limit)
        .all()
    )
    assignee_ids = {t.assignee_id for t in tickets if t.assignee_id}
    names = {
        u.id: (u.nickname or u.email)
        for u in (db.query(User).filter(User.id.in_(assignee_ids)).all() if assignee_ids else [])
    }
    return [
        TicketListItem(
            id=t.id,
            userId=t.user_id,
            userEmail=_customer_email(t.user, ctx),
            title=t.title,
            category=t.category,
            priority=t.priority,
            status=t.status,
            updatedAt=t.updated_at,
            latestReply=_latest_reply(t, True),
            assigneeId=t.assignee_id,
            assigneeName=names.get(t.assignee_id) if t.assignee_id else None,
        )
        for t in tickets
    ]


def _customer_email(user: User, ctx: StaffCtx) -> str:
    """工单提交人的邮箱：外包客服看脱敏值（设计 §2.3），其余完整。
    The submitter's email: masked for outsourced agents (design §2.3), full otherwise."""
    if ctx.is_outsourced:
        from app.services.support_view import mask_email

        return mask_email(user.email) or ""
    return user.email


def _staff_ticket_out(db: Session, ticket: Ticket, ctx: StaffCtx) -> TicketOut:
    replies = (
        db.query(TicketReply)
        .filter(TicketReply.ticket_id == ticket.id)
        .order_by(TicketReply.created_at.asc())
        .all()
    )
    out = _ticket_out(ticket, replies, True, db)
    if ctx.is_outsourced:
        from app.services.support_view import mask_email

        out.userEmail = mask_email(out.userEmail) or ""
        for r in out.replies:
            if r.authorId == ticket.user_id:
                r.authorEmail = mask_email(r.authorEmail) or ""
    return out


@admin_router.get("/{ticket_id}", response_model=TicketOut)
def admin_get_ticket(
    ticket_id: str,
    db: Session = Depends(get_db),
    _admin: StaffCtx = Depends(require_staff),
):
    """工作人员查看任意工单详情（含内部备注）。/ Staff view any ticket detail, internal notes included."""
    ticket = db.query(Ticket).filter(Ticket.id == ticket_id).first()
    if not ticket:
        raise HTTPException(status_code=404, detail="工单不存在 / Ticket not found")
    return _staff_ticket_out(db, ticket, _staff(_admin))


@admin_router.post("/{ticket_id}/reply", response_model=TicketOut)
def admin_reply_to_ticket(
    ticket_id: str,
    body: AdminTicketReplyCreate,
    db: Session = Depends(get_db),
    admin: StaffCtx = Depends(require_staff),
):
    """工作人员回复，可选同时修改 status / priority。internal=true 为内部备注：不通知用户、
    不推送、用户侧接口永不返回。
    Staff reply; optionally change status/priority at the same time. internal=true
    makes it an internal note: no user notification, no push, never user-visible."""
    ctx = _staff(admin)
    staff = ctx.user
    ticket = db.query(Ticket).filter(Ticket.id == ticket_id).first()
    if not ticket:
        raise HTTPException(status_code=404, detail="工单不存在 / Ticket not found")
    images = _checked_images(body.images, staff.id)
    old_status, old_priority = ticket.status, ticket.priority
    if body.status:
        ticket.status = body.status
    if body.priority:
        ticket.priority = body.priority
    ticket.updated_at = _now()
    reply = TicketReply(
        ticket_id=ticket.id,
        author_id=staff.id,
        body=body.body.strip(),
        images=images,
        internal=bool(body.internal),
        author_role=staff.role,
    )
    db.add(reply)
    # 谁先回复用户，工单就归谁：未分配的工单在首次（非内部）回复时自动认领给回复人，
    # 其他客服在队列里就能看到「某某跟进中」，不必先手动认领。已有跟进人的不改。
    # Whoever replies first owns it: an unassigned ticket is claimed by the replier on the
    # first non-internal reply, so other agents see who is on it. Existing assignees are kept.
    if not body.internal and ticket.assignee_id is None and ticket.user_id != staff.id:
        ticket.assignee_id = staff.id
    if body.internal:
        # 内部备注单独记一个字段，免得日志里看成「回复了用户」。
        # Internal notes get their own field so the log never reads as "replied to the user".
        _audit_ticket_change(db, staff.id, ticket, old_status, old_priority)
        log_change(db, staff.id, ticket.user_id, f"ticket:{ticket.id}:note", None, _reply_excerpt(reply))
    else:
        _audit_ticket_change(db, staff.id, ticket, old_status, old_priority, reply)
    # 站内通知与这次回复同一个事务：系统通知栏那条（下面的 dispatch_ticket_reply）
    # 可能因为没订阅、被墙、密钥没配而根本发不出去，铃铛里这一条是用户唯一一定
    # 看得到的痕迹，不能跟着推送一起失败。工作人员回自己提的工单不通知自己；内部备注不通知用户。
    # The in-app row shares this transaction: the tray notification below can
    # simply not happen (no subscription, blocked network, no VAPID keys), which
    # makes the bell entry the one trace the user is guaranteed to see — it must
    # not fail along with the push. Staff replying to their own ticket aren't
    # notified, and internal notes never notify the user.
    notify_user_id = ticket.user_id if ticket.user_id != staff.id and not body.internal else None
    if notify_user_id:
        create_notification(
            db,
            notify_user_id,
            KIND_TICKET_REPLY,
            text=ticket.title,
            link=f"/support?ticket={ticket.id}",
            ref_id=ticket.id,
        )
    db.commit()
    db.refresh(ticket)
    if notify_user_id:
        notify_ws(notify_user_id)

        # 推送通知给工单提交者 / notify the ticket submitter
        try:
            from app.services.push_dispatch import dispatch_ticket_reply
            # 推送文案里不带工作人员邮箱，与接口对用户隐藏邮箱一致（见 _author_email）。
            # No staff email in the push text either, matching _author_email.
            dispatch_ticket_reply(ticket.id, ticket.user_id)
        except Exception:
            # 行为不变（通知失败不影响回复成功），但要留痕：这个 except 连 import 失败
            # 都一起吞，推送链路整体坏掉时表现为「用户再也收不到工单回复通知」，而服务端
            # 完全没有迹象——静默失败的那种，只能靠用户来投诉才会发现。
            # Behaviour unchanged (a failed notification must not fail the reply) but
            # no longer traceless: this except swallows even an ImportError, so a
            # broken push path shows up only as "users stopped getting ticket-reply
            # notifications", with nothing server-side to notice it by.
            logger.warning(
                "工单回复推送失败: ticket=%s user=%s", ticket.id, ticket.user_id, exc_info=True
            )

    return _staff_ticket_out(db, ticket, ctx)


@admin_router.patch("/{ticket_id}", response_model=TicketOut)
def admin_update_ticket(
    ticket_id: str,
    body: AdminTicketUpdate,
    db: Session = Depends(get_db),
    admin: StaffCtx = Depends(require_staff),
):
    """仅修改 status / priority（不回复）。/ Change status/priority only, no reply."""
    ctx = _staff(admin)
    ticket = db.query(Ticket).filter(Ticket.id == ticket_id).first()
    if not ticket:
        raise HTTPException(status_code=404, detail="工单不存在 / Ticket not found")
    old_status, old_priority = ticket.status, ticket.priority
    if body.status:
        ticket.status = body.status
    if body.priority:
        ticket.priority = body.priority
    _audit_ticket_change(db, ctx.user.id, ticket, old_status, old_priority)
    db.commit()
    db.refresh(ticket)
    return _staff_ticket_out(db, ticket, ctx)


@admin_router.post("/{ticket_id}/assign", response_model=TicketOut)
def admin_assign_ticket(
    ticket_id: str,
    body: AdminTicketAssign,
    db: Session = Depends(get_db),
    admin: StaffCtx = Depends(require_staff),
):
    """指派工单（rev 41）。admin：指派给任一在岗工作人员，或传 null 清空；客服：只能认领给自己，
    或放弃自己名下的（传 null）。被指派人收到一条站内通知。
    Assign a ticket. Admins assign to any on-duty staff member or clear it (null);
    support agents may only claim it for themselves or release their own. The new
    assignee gets an in-app notification."""
    ctx = _staff(admin)
    ticket = db.query(Ticket).filter(Ticket.id == ticket_id).first()
    if not ticket:
        raise HTTPException(status_code=404, detail="工单不存在 / Ticket not found")
    target_id = body.assigneeId or None
    if not ctx.is_admin:
        if target_id is not None and target_id != ctx.user.id:
            raise HTTPException(status_code=403, detail="客服只能认领给自己 / Support can only claim tickets for themselves")
        if target_id is None and ticket.assignee_id not in (None, ctx.user.id):
            raise HTTPException(status_code=403, detail="只能放弃自己名下的工单 / You can only release your own tickets")
    target = None
    if target_id is not None:
        target = db.get(User, target_id)
        if target is None or target.role not in STAFF_ROLES or target.disabled_at is not None:
            raise HTTPException(status_code=400, detail="只能指派给在岗的客服或管理员 / Assignee must be active staff")
    old = ticket.assignee_id
    if old != target_id:
        ticket.assignee_id = target_id
        log_change(db, ctx.user.id, ticket.user_id, f"ticket:{ticket.id}:assignee", old, target_id)
        notify_ids = []
        if target is not None and target.id != ctx.user.id:
            create_notification(
                db, target.id, KIND_TICKET_NEW, text=ticket.title,
                link=_staff_link(target.role, ticket.id), ref_id=ticket.id,
            )
            notify_ids.append(target.id)
        db.commit()
        for uid in notify_ids:
            notify_ws(uid)
    db.refresh(ticket)
    return _staff_ticket_out(db, ticket, ctx)


# require_staff 跟这组其它路由一样挂在路由自己身上（单独挂载也有守卫），require_admin 再把客服挡掉
# require_staff sits on the route like the rest of this router (guarded even if mounted alone); require_admin then shuts support out
@admin_router.delete("/{ticket_id}", response_model=dict, dependencies=[Depends(require_staff)])
def admin_delete_ticket(
    ticket_id: str,
    background: BackgroundTasks,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    """删除工单（只有管理员；客服不能删）：连同全部回复（含内部备注）和指向它的站内通知一起删，
    附图在后台从私有桶里删掉（别的工单也引用的图留着）。审计记一行 `ticket:<id>:delete`，
    值是工单标题，目标用户是提交者——工单没了，操作日志里还查得到谁删了哪张。
    Delete a ticket (admins only; support cannot): every reply (internal notes included) and
    the in-app notifications pointing at it go too, and its images are removed from the
    private bucket in the background (images another ticket also references stay). One audit
    row `ticket:<id>:delete` holds the title with the submitter as target, so the activity
    log still shows who deleted what after the ticket is gone."""
    ticket = db.query(Ticket).filter(Ticket.id == ticket_id).first()
    if not ticket:
        raise HTTPException(status_code=404, detail="工单不存在 / Ticket not found")
    replies = db.query(TicketReply).filter(TicketReply.ticket_id == ticket.id).all()
    keys = list(dict.fromkeys(k for r in replies for k in _image_keys(r)))
    # 同一张图理论上能被别的工单再引用（键只校验作者），那种图不删
    # an image key can in principle be reused by another ticket (keys only check the author); keep those
    orphan = [
        k for k in keys
        if not db.query(TicketReply.id)
        .filter(TicketReply.ticket_id != ticket.id, TicketReply.images.contains(k.partition("#")[0]))
        .first()
    ]
    notes = db.query(UserNotification).filter(
        UserNotification.ref_id == ticket.id,
        UserNotification.kind.in_((KIND_TICKET_NEW, KIND_TICKET_REPLY)),
    )
    notified = {row[0] for row in notes.with_entities(UserNotification.user_id).distinct()}
    # 标题为空时 log_change 会当成「没变」不写，用工单号顶上，保证删除一定留痕
    # log_change skips an empty value as "unchanged"; fall back to the ticket number so a delete is always logged
    title = (ticket.title or "").strip() or f"#{ticket.id[:8]}"
    log_change(db, admin.id, ticket.user_id, f"ticket:{ticket.id}:delete", None, title)
    notes.delete(synchronize_session=False)
    # 幸运轮盘的领奖记录可能指向这张申领工单：先断开引用，否则 Postgres 外键拦住删除；
    # 断开后用户可以为该奖品重新开一张。
    # A lucky-wheel draw may point at this claim ticket: clear the link first or the Postgres FK
    # blocks the delete; the user can then open a fresh one for that prize.
    db.query(LuckyDraw).filter(LuckyDraw.support_ticket_id == ticket.id).update(
        {LuckyDraw.support_ticket_id: None}, synchronize_session=False)
    for r in replies:
        db.delete(r)
    db.delete(ticket)
    db.commit()
    if orphan:
        background.add_task(delete_private_images, orphan)
    # 铃铛里那几条通知没了，让在线页面重拉一次 / their bell entries are gone; let open pages refetch
    for uid in notified:
        notify_ws(uid)
    return {"deleted": True}
