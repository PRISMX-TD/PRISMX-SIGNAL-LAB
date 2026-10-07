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

from fastapi import APIRouter, Depends, File, HTTPException, Query, Request, UploadFile, status
from sqlalchemy.orm import Session, selectinload
from starlette.concurrency import run_in_threadpool

from app.core.config import settings
from app.core.database import get_db
from app.core.strategy_limits import user_limiter
from app.models import Ticket, TicketReply, User
from app.schemas import (
    AdminTicketReplyCreate,
    AdminTicketUpdate,
    TicketCreate,
    TicketListItem,
    TicketOut,
    TicketReplyCreate,
    TicketReplyOut,
)
from app.services.deps import get_current_user, get_current_user_id_light, require_admin
from app.services.image_upload import (
    UploadError,
    is_private_configured,
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


def _author_email(author: User, viewer_is_admin: bool) -> str:
    """回复作者在当前查看者眼里的邮箱：管理员的邮箱不给普通用户看，回空串，
    前端据此显示「客服」。管理员查看时照常给全。
    The reply author's email as the viewer may see it: staff emails are never
    shown to regular users (empty string; the UI shows "Support" instead)."""
    if author.role == "admin" and not viewer_is_admin:
        return ""
    return author.email


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
    return TicketReplyOut(
        id=r.id,
        authorId=r.author_id,
        authorEmail=_author_email(r.author, viewer_is_admin),
        authorRole=r.author.role,
        body=r.body,
        images=[urls[k] for k in keys if k in urls] if urls else [],
        imageCount=len(keys),
        createdAt=r.created_at,
    )


def _ticket_out(ticket: Ticket, replies: list[TicketReply], viewer_is_admin: bool) -> TicketOut:
    """把 ORM 对象转成 TicketOut；整条工单的附图一次签完。
    Convert ORM objects to TicketOut, signing the whole thread's images in one call."""
    user: User = ticket.user  # relationship backref
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
    )


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
    admin_ids = [
        r[0] for r in db.query(User.id).filter(User.role == "admin").all()
        if r[0] != submitter.id
    ]
    for admin_id in admin_ids:
        create_notification(
            db,
            admin_id,
            KIND_TICKET_NEW,
            text=ticket.title,
            link=f"/admin?tab=tickets&ticket={ticket.id}",
            ref_id=ticket.id,
        )
    return admin_ids


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
    admin_ids = [
        r[0] for r in db.query(User.id).filter(User.role == "admin").all()
        if r[0] != author.id
    ]
    for admin_id in admin_ids:
        create_notification(
            db,
            admin_id,
            KIND_TICKET_REPLY,
            text=ticket.title,
            link=f"/admin?tab=tickets&ticket={ticket.id}",
            ref_id=ticket.id,
        )
    return admin_ids


def _latest_reply(ticket: Ticket, viewer_is_admin: bool) -> TicketReplyOut | None:
    """最新的那条回复（可能有也可能没有）/ the most recent reply, if any."""
    # relationship 上配了 order_by="TicketReply.created_at"（见 models），所以
    # ticket.replies 已经按时间升序，取最后一个就是最新的那条。
    # 别按"默认按 id 排序"去理解这一段——那是这条注释以前的说法，早就不成立了。
    # The relationship carries order_by="TicketReply.created_at" (see models), so
    # replies is already oldest-first and the last element is the newest. (This
    # comment used to claim "ordered by id by default"; that stopped being true.)
    if ticket.replies:
        r = ticket.replies[-1] if ticket.replies else None
        if not r:
            return None
        return _reply_out(r, viewer_is_admin)
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
    declared = file.size
    if declared is None:
        try:
            declared = int(request.headers.get("content-length") or 0) or None
        except ValueError:
            declared = None
    if declared is not None and declared > settings.UPLOAD_MAX_BYTES:
        mb = settings.UPLOAD_MAX_BYTES / (1024 * 1024)
        raise HTTPException(status_code=413, detail=f"图片超过 {mb:.0f}MB 上限 / the image exceeds the {mb:.0f}MB limit")
    data = await file.read()
    try:
        # 同步 httpx 挪进线程池，别卡事件循环（见 admin.upload_admin_image 的说明）
        # The sync httpx call goes to the threadpool, off the event loop (see admin.upload_admin_image)
        key = await run_in_threadpool(upload_private_image, data, user_id)
    except UploadError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"key": key}


@router.post("", response_model=TicketOut, status_code=status.HTTP_201_CREATED)
def create_ticket(
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
    )
    db.add(reply)
    admin_ids = _notify_admins_new_ticket(db, ticket, user)
    db.commit()
    db.refresh(ticket)
    for admin_id in admin_ids:
        notify_ws(admin_id)
    return _ticket_out(ticket, [reply], user.role == "admin")


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
            latestReply=_latest_reply(t, user.role == "admin"),
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
    if not ticket or (ticket.user_id != user.id and user.role != "admin"):
        raise HTTPException(status_code=404, detail="工单不存在 / Ticket not found")
    replies = (
        db.query(TicketReply)
        .filter(TicketReply.ticket_id == ticket_id)
        .order_by(TicketReply.created_at.asc())
        .all()
    )
    return _ticket_out(ticket, replies, user.role == "admin")


@router.post("/{ticket_id}/reply", response_model=TicketOut)
def reply_to_ticket(
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
    return _ticket_out(ticket, replies, user.role == "admin")


# ---- 管理员端 / admin endpoints ----

admin_router = APIRouter(prefix="/admin/tickets", tags=["admin-tickets"])


@admin_router.get("", response_model=list[TicketListItem])
def list_all_tickets(
    status_filter: str | None = Query(default=None, alias="status"),
    category: str | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_db),
    _admin: User = Depends(require_admin),
):
    """全部工单列表，支持按 status / category 筛选，分页。
    All tickets, filterable by status/category, paginated."""
    query = db.query(Ticket)
    if status_filter:
        query = query.filter(Ticket.status == status_filter)
    if category:
        query = query.filter(Ticket.category == category)
    tickets = (
        query.options(selectinload(Ticket.user), _LIST_EAGER_LOADS)
        .order_by(Ticket.updated_at.desc())
        .offset(offset)
        .limit(limit)
        .all()
    )
    return [
        TicketListItem(
            id=t.id,
            userEmail=t.user.email,
            title=t.title,
            category=t.category,
            priority=t.priority,
            status=t.status,
            updatedAt=t.updated_at,
            latestReply=_latest_reply(t, True),
        )
        for t in tickets
    ]


@admin_router.get("/{ticket_id}", response_model=TicketOut)
def admin_get_ticket(
    ticket_id: str,
    db: Session = Depends(get_db),
    _admin: User = Depends(require_admin),
):
    """管理员查看任意工单详情。/ Admin views any ticket detail."""
    ticket = db.query(Ticket).filter(Ticket.id == ticket_id).first()
    if not ticket:
        raise HTTPException(status_code=404, detail="工单不存在 / Ticket not found")
    replies = (
        db.query(TicketReply)
        .filter(TicketReply.ticket_id == ticket_id)
        .order_by(TicketReply.created_at.asc())
        .all()
    )
    return _ticket_out(ticket, replies, True)


@admin_router.post("/{ticket_id}/reply", response_model=TicketOut)
def admin_reply_to_ticket(
    ticket_id: str,
    body: AdminTicketReplyCreate,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    """管理员回复，可选同时修改 status / priority。
    Admin reply; optionally change status/priority at the same time."""
    ticket = db.query(Ticket).filter(Ticket.id == ticket_id).first()
    if not ticket:
        raise HTTPException(status_code=404, detail="工单不存在 / Ticket not found")
    images = _checked_images(body.images, admin.id)
    if body.status:
        ticket.status = body.status
    if body.priority:
        ticket.priority = body.priority
    ticket.updated_at = _now()
    reply = TicketReply(
        ticket_id=ticket.id,
        author_id=admin.id,
        body=body.body.strip(),
        images=images,
    )
    db.add(reply)
    # 站内通知与这次回复同一个事务：系统通知栏那条（下面的 dispatch_ticket_reply）
    # 可能因为没订阅、被墙、密钥没配而根本发不出去，铃铛里这一条是用户唯一一定
    # 看得到的痕迹，不能跟着推送一起失败。管理员回自己提的工单不通知自己。
    # The in-app row shares this transaction: the tray notification below can
    # simply not happen (no subscription, blocked network, no VAPID keys), which
    # makes the bell entry the one trace the user is guaranteed to see — it must
    # not fail along with the push. An admin replying to their own ticket isn't
    # notified.
    notify_user_id = ticket.user_id if ticket.user_id != admin.id else None
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
        # 推送文案里不带管理员邮箱，与接口对用户隐藏邮箱一致（见 _author_email）。
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

    replies = (
        db.query(TicketReply)
        .filter(TicketReply.ticket_id == ticket_id)
        .order_by(TicketReply.created_at.asc())
        .all()
    )
    return _ticket_out(ticket, replies, True)


@admin_router.patch("/{ticket_id}", response_model=TicketOut)
def admin_update_ticket(
    ticket_id: str,
    body: AdminTicketUpdate,
    db: Session = Depends(get_db),
    _admin: User = Depends(require_admin),
):
    """仅修改 status / priority（不回复）。/ Change status/priority only, no reply."""
    ticket = db.query(Ticket).filter(Ticket.id == ticket_id).first()
    if not ticket:
        raise HTTPException(status_code=404, detail="工单不存在 / Ticket not found")
    if body.status:
        ticket.status = body.status
    if body.priority:
        ticket.priority = body.priority
    db.commit()
    db.refresh(ticket)
    replies = (
        db.query(TicketReply)
        .filter(TicketReply.ticket_id == ticket_id)
        .order_by(TicketReply.created_at.asc())
        .all()
    )
    return _ticket_out(ticket, replies, True)
