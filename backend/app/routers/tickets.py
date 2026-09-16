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
import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.core.database import get_db
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
from app.services.deps import get_current_user, require_admin
from app.services.notification_feed import (
    KIND_TICKET_NEW,
    KIND_TICKET_REPLY,
    create_notification,
    notify_ws,
)

logger = logging.getLogger("prismx.tickets")

router = APIRouter(prefix="/tickets", tags=["tickets"])


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _ticket_out(ticket: Ticket, replies: list[TicketReply]) -> TicketOut:
    """把 ORM 对象转成 TicketOut / convert ORM objects to TicketOut."""
    user: User = ticket.user  # relationship backref
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
        replies=[
            TicketReplyOut(
                id=r.id,
                authorId=r.author_id,
                authorEmail=r.author.email,
                authorRole=r.author.role,
                body=r.body,
                createdAt=r.created_at,
            )
            for r in replies
        ],
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


def _latest_reply(ticket: Ticket) -> TicketReplyOut | None:
    """最新的那条回复（可能有也可能没有）/ the most recent reply, if any."""
    # 按 replies relationship 查询——ORM relationship 默认按 id 排序，
    # 所以这里单独查 created_at desc 取最新一条
    if ticket.replies:
        r = ticket.replies[-1] if ticket.replies else None
        if not r:
            return None
        return TicketReplyOut(
            id=r.id,
            authorId=r.author_id,
            authorEmail=r.author.email,
            authorRole=r.author.role,
            body=r.body,
            createdAt=r.created_at,
        )
    return None


# ---- 用户端 / user endpoints ----

@router.post("", response_model=TicketOut, status_code=status.HTTP_201_CREATED)
def create_ticket(
    body: TicketCreate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """提交新工单。同时写入 tickets 和第一条 ticket_replies。
    Submit a new ticket; writes the ticket and its first reply in one step."""
    ticket = Ticket(
        user_id=user.id,
        title=body.title.strip(),
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
    )
    db.add(reply)
    admin_ids = _notify_admins_new_ticket(db, ticket, user)
    db.commit()
    db.refresh(ticket)
    for admin_id in admin_ids:
        notify_ws(admin_id)
    return _ticket_out(ticket, [reply])


@router.get("", response_model=list[TicketListItem])
def list_my_tickets(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """当前用户的工单列表，按 updated_at 倒序，每条带最新回复预览。
    Current user's tickets, newest first, each with a latest-reply preview."""
    tickets = (
        db.query(Ticket)
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
            latestReply=_latest_reply(t),
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
    Ticket detail with all replies. Only the owner or an admin may access."""
    ticket = db.query(Ticket).filter(Ticket.id == ticket_id).first()
    if not ticket:
        raise HTTPException(status_code=404, detail="工单不存在 / Ticket not found")
    if ticket.user_id != user.id and user.role != "admin":
        raise HTTPException(status_code=403, detail="无权访问该工单 / Access denied")
    replies = (
        db.query(TicketReply)
        .filter(TicketReply.ticket_id == ticket_id)
        .order_by(TicketReply.created_at.asc())
        .all()
    )
    return _ticket_out(ticket, replies)


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
    if not ticket:
        raise HTTPException(status_code=404, detail="工单不存在 / Ticket not found")
    if ticket.user_id != user.id:
        raise HTTPException(status_code=403, detail="无权回复该工单 / Access denied")
    if ticket.status == "closed" and not body.reopen:
        raise HTTPException(
            status_code=400,
            detail="工单已关闭，可重开后回复 / Ticket is closed, reopen it to reply",
        )
    if body.reopen:
        ticket.status = "open"
        ticket.updated_at = _now()
    reply = TicketReply(
        ticket_id=ticket.id,
        author_id=user.id,
        body=body.body.strip(),
    )
    db.add(reply)
    db.commit()
    db.refresh(ticket)
    replies = (
        db.query(TicketReply)
        .filter(TicketReply.ticket_id == ticket_id)
        .order_by(TicketReply.created_at.asc())
        .all()
    )
    return _ticket_out(ticket, replies)


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
    tickets = query.order_by(Ticket.updated_at.desc()).offset(offset).limit(limit).all()
    return [
        TicketListItem(
            id=t.id,
            userEmail=t.user.email,
            title=t.title,
            category=t.category,
            priority=t.priority,
            status=t.status,
            updatedAt=t.updated_at,
            latestReply=_latest_reply(t),
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
    return _ticket_out(ticket, replies)


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
    if body.status:
        ticket.status = body.status
    if body.priority:
        ticket.priority = body.priority
    ticket.updated_at = _now()
    reply = TicketReply(
        ticket_id=ticket.id,
        author_id=admin.id,
        body=body.body.strip(),
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
        dispatch_ticket_reply(ticket.id, ticket.user_id, admin.email)
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
    return _ticket_out(ticket, replies)


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
    return _ticket_out(ticket, replies)
