"""工单的工作人员站内通知：新工单、用户追问时通知谁、链接指向哪。

原来写在 routers/tickets.py，幸运轮盘申领（services/lucky/claims）开工单时要复用，只能反过来 import
路由层（2026-11-18 审计）。搬到这里，路由和申领都调这一份。

Staff in-app notifications for tickets: who hears about a new ticket or a user reply, and
where the link points. Moved out of routers/tickets.py so lucky-wheel claims can reuse them
without importing the router layer (2026-11-18 audit).
"""
from sqlalchemy.orm import Session

from app.models import Ticket, User
from app.services.deps import STAFF_ROLES
from app.services.notification_feed import KIND_TICKET_NEW, KIND_TICKET_REPLY, create_notification


def staff_targets(db: Session, ticket: Ticket, exclude: str) -> list[tuple[str, str]]:
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


def staff_link(role: str, ticket_id: str) -> str:
    if role == "admin":
        return f"/admin?tab=tickets&ticket={ticket_id}"
    return f"/support-desk?ticket={ticket_id}"


def notify_staff_new_ticket(db: Session, ticket: Ticket, submitter: User) -> list[str]:
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
    targets = staff_targets(db, ticket, submitter.id)
    for staff_id, role in targets:
        create_notification(
            db,
            staff_id,
            KIND_TICKET_NEW,
            text=ticket.title,
            link=staff_link(role, ticket.id),
            ref_id=ticket.id,
        )
    return [t[0] for t in targets]


def notify_staff_ticket_reply(db: Session, ticket: Ticket, author: User) -> list[str]:
    """用户追加回复时给每位管理员写一条站内通知，返回收到通知的管理员 id。

    为什么必须有：新工单会通知全体管理员（_notify_admins_new_ticket），但用户在
    已有工单里追问就完全静默。管理端列表按 updated_at 倒序，而追加一条 reply
    **不会**触发 Ticket 行的 onupdate（那个 onupdate 只在 Ticket 自己被 UPDATE 时
    生效），所以那条工单连往上冒都不会——用户回了话，管理员这边没有任何变化。
    这两件事要一起修，只修一件仍然看不见（排序修了但没人知道要去看，通知修了
    但点进列表还是在第二页）。

    复用 KIND_TICKET_REPLY：这条通知对管理员的意思就是"工单有新回复"，与管理员
    回复时发给用户的那条同一件事、方向相反。link 指向后台的工单详情。
    不发系统推送，理由同 notify_staff_new_ticket。

    Notify every admin when a user adds a reply. New tickets already fan out, but
    a follow-up on an existing ticket was silent — and since the admin list is
    ordered by updated_at while appending a reply does not touch the Ticket row
    (its onupdate only fires on an UPDATE of Ticket itself), the ticket did not
    even float to the top. Both halves have to be fixed together or the user's
    reply stays invisible either way. Reuses KIND_TICKET_REPLY: to an admin this
    means exactly "the ticket has a new reply", same event, other direction.
    """
    targets = staff_targets(db, ticket, author.id)
    for staff_id, role in targets:
        create_notification(
            db,
            staff_id,
            KIND_TICKET_REPLY,
            text=ticket.title,
            link=staff_link(role, ticket.id),
            ref_id=ticket.id,
        )
    return [t[0] for t in targets]
