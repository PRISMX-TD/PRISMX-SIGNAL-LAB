"""领奖：自定义奖项的两种领取方式 + 管理员发放 / 取消 + 后台列表。
form：用户在轮盘页填（发放前可改）；ticket：服务端替用户建一张「申领」工单并回写工单号，
同一条记录只建一张。领取期限系统不管，由管理员在「待发奖」里决定（设计 §6）。
claim_info 可能含收货地址：只有本人（用户端只查自己的记录）与管理员看得到。

Claims for custom prizes: form (user types it, editable until handled) or ticket (the server
opens one `claim` ticket and links it; one per draw). No system deadline — the admin decides.
claim_info may hold a postal address, so only the owner and admins ever see it.
"""
import json

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models import LuckyDraw, Ticket, TicketReply, User
from app.services.lucky.common import (
    CLAIM_FORM, CLAIM_TICKET, F_CANCELLED, F_DELIVERED, F_OPEN, F_SUBMITTED, utcnow,
)
from app.services.notification_feed import KIND_LUCKY_CANCELLED, KIND_LUCKY_DELIVERED, create_notification

LINK = "/lucky"


def _snap(d: LuckyDraw) -> dict:
    return json.loads(d.prize_snapshot or "{}")


def _locked(db: Session, draw_id: str) -> LuckyDraw | None:
    """行锁读取：双击 / 两台设备同时提交，或两位管理员同时处理，第二个请求会等第一个提交后重读状态。
    Row-locked read so a double submit or two admins handling at once serialise (a no-op on SQLite)."""
    return db.query(LuckyDraw).filter(LuckyDraw.id == draw_id).with_for_update().first()


def _own_open(db: Session, user: User, draw_id: str, mode: str) -> LuckyDraw:
    d = _locked(db, draw_id)
    if d is None or d.user_id != user.id:
        raise HTTPException(404, "记录不存在 / Not found")
    if _snap(d).get("claimMode") != mode:
        raise HTTPException(400, "这个奖品不是这种领取方式 / Wrong claim method for this prize")
    if d.fulfillment_status not in F_OPEN:
        raise HTTPException(400, "已处理，不能再改 / Already handled")
    return d


def submit_info(db: Session, user: User, draw_id: str, text: str) -> LuckyDraw:
    text = text.strip()
    if not text:
        raise HTTPException(400, "内容不能为空 / Text cannot be empty")
    d = _own_open(db, user, draw_id, CLAIM_FORM)
    d.claim_info = text
    d.fulfillment_status = F_SUBMITTED
    return d


def open_ticket(db: Session, user: User, draw_id: str) -> tuple[LuckyDraw, list[str]]:
    """第二项是需要 WS 提醒的管理员 id；已建过工单就原样返回、不再通知。
    Second item = admins to nudge over WS; an existing claim ticket is returned as-is, no re-notify."""
    d = _locked(db, draw_id)
    if d is not None and d.user_id == user.id and d.support_ticket_id:
        return d, []
    d = _own_open(db, user, draw_id, CLAIM_TICKET)
    name = _snap(d).get("name") or ""
    t = Ticket(user_id=user.id, title=f"幸运轮盘奖品领取：{name}"[:200], category="claim",
               priority="normal", status="open")
    db.add(t)
    db.flush()
    db.add(TicketReply(ticket_id=t.id, author_id=user.id, author_role="user",
                       body=f"奖品：{name}\n中奖时间：{d.created_at:%Y-%m-%d %H:%M} UTC\n记录号：{d.id}"))
    from app.routers.tickets import _notify_admins_new_ticket
    admin_ids = _notify_admins_new_ticket(db, t, user)
    d.support_ticket_id = t.id
    d.fulfillment_status = F_SUBMITTED
    return d, admin_ids


def _handle(db: Session, admin: User, draw_id: str, status: str, note: str) -> LuckyDraw:
    d = _locked(db, draw_id)
    if d is None:
        raise HTTPException(404, "记录不存在 / Not found")
    if d.fulfillment_status not in F_OPEN:
        raise HTTPException(400, "已处理 / Already handled")
    d.fulfillment_status = status
    d.admin_note = note.strip() or None
    d.handled_by, d.handled_at = admin.id, utcnow()
    kind = KIND_LUCKY_DELIVERED if status == F_DELIVERED else KIND_LUCKY_CANCELLED
    text = _snap(d).get("name") or ""
    if d.admin_note:
        text = f"{text} · {d.admin_note}"
    create_notification(db, d.user_id, kind, text=text, link=LINK, ref_id=d.id)
    return d


def prize_name(d: LuckyDraw) -> str:
    return _snap(d).get("name") or ""


def push_handled(user_id: str, delivered: bool, name: str, note: str | None) -> None:
    """发放 / 取消后的系统推送（设计 §6：站内通知 + 推送）。同步阻塞，从 BackgroundTasks 调；
    参数都是提交前取好的纯值，后台任务里不再碰会话。取消原因用户在站内本来就看得到，所以带上；
    发放备注（快递单号之类）只在站内通知里，不进系统通知栏。
    Push after a delivery / cancellation (spec 6: in-app + push). Blocking; call from BackgroundTasks
    with plain values read before the commit so the task never touches the session. The cancel reason
    is already visible to the user in-app, so it rides along; a delivery note (tracking numbers) stays
    in the in-app row and out of the notification tray."""
    from app.services.push_dispatch import EVENT_LUCKY_WHEEL, dispatch_users_push
    if delivered:
        title, body = "奖品已发放", f"「{name}」已发放，点开查看"
    else:
        title, body = "奖品已取消", f"「{name}」已取消：{note}" if note else f"「{name}」已取消"
    dispatch_users_push([user_id], EVENT_LUCKY_WHEEL, title, body, url=LINK, tag="prismx-lucky")


def deliver(db: Session, admin: User, draw_id: str, note: str) -> LuckyDraw:
    return _handle(db, admin, draw_id, F_DELIVERED, note)


def cancel(db: Session, admin: User, draw_id: str, reason: str) -> LuckyDraw:
    if not reason.strip():
        raise HTTPException(400, "取消要写原因（用户看得到）/ A reason is required")
    return _handle(db, admin, draw_id, F_CANCELLED, reason)


def admin_query(db: Session, *, status: str | None = None, round_id: str | None = None,
                user_id: str | None = None, prize_id: str | None = None):
    q = db.query(LuckyDraw, User).join(User, User.id == LuckyDraw.user_id)
    if status == "open":
        q = q.filter(LuckyDraw.fulfillment_status.in_(F_OPEN))
    elif status:
        q = q.filter(LuckyDraw.fulfillment_status == status)
    if round_id:
        q = q.filter(LuckyDraw.round_id == round_id)
    if user_id:
        q = q.filter(LuckyDraw.user_id == user_id)
    if prize_id:
        q = q.filter(LuckyDraw.prize_id == prize_id)
    # id 作并列时的次序，翻页不重不漏 / id breaks created_at ties so paging is stable
    return q.order_by(LuckyDraw.created_at.desc(), LuckyDraw.id.desc())


def admin_row(d: LuckyDraw, u: User) -> dict:
    s = _snap(d)
    return {"id": d.id, "createdAt": d.created_at, "roundId": d.round_id,
            "user": {"id": u.id, "email": u.email, "nickname": u.nickname},
            "prize": {"id": d.prize_id, "name": s.get("name"), "kind": s.get("kind"),
                      "proDays": s.get("proDays"), "claimMode": s.get("claimMode"), "probBp": s.get("probBp")},
            "fulfillmentStatus": d.fulfillment_status, "claimInfo": d.claim_info,
            "supportTicketId": d.support_ticket_id, "adminNote": d.admin_note, "handledAt": d.handled_at}
