"""站内通知（铃铛面板里的「消息」）：写一行 + 通知在线设备刷新。

与 push_dispatch 的分工：push_dispatch 负责把消息送到**系统通知栏**（Web Push /
FCM），这里负责把同一件事留在**站内**——用户没开推送、推送被墙、或者事后回来翻
的时候，铃铛里还找得到。两条路互不依赖：推送失败不该让站内也少一条，站内写失败
也不该让工单回复本身失败。

Division of labour with push_dispatch: that module delivers to the *system*
notification tray (Web Push / FCM); this one keeps the same event *in the app*,
for users who never enabled push, whose push is blocked, or who simply come back
later. The two paths are independent — a failed push must not cost the in-app
row, and a failed row must not fail the action that produced it.
"""
import logging

from sqlalchemy.orm import Session

from app.models import UserNotification

logger = logging.getLogger("prismx.notification_feed")

# 通知类别。前端按这个值取标题文案（i18n key notifFeed.<kind>），所以新增一类
# 必须同时在前端补文案，否则会渲染出裸 key。
# Notification kinds. The frontend maps each to a title string (i18n key
# notifFeed.<kind>), so adding one here means adding the copy there too —
# otherwise the panel renders a bare key.
KIND_TICKET_REPLY = "ticket_reply"
KIND_TICKET_NEW = "ticket_new"
# 代理改了某个客户的会员（/agent 下唯一的写端点，见 routers/invite.agent_set_plan）。
# 收件人只有管理员：这条通知的用途是让"代理动了别人的付费权益"这件事有人看见，
# 而不是通知被改的那个人。
# 标题文案在前端 i18n 的 `notifFeed.agent_plan_change`；text 里带「谁改了谁、改了什么」。
# An agent changed a customer's plan; admins only. The title lives in the frontend's
# `notifFeed.agent_plan_change`; the text body carries who/whom/what.
KIND_AGENT_PLAN_CHANGE = "agent_plan_change"

# 单条文本的入库上限：text 来自用户自己填的工单标题（后端已限 200 字），这里再
# 兜一道，避免将来别的来源塞进超长字符串。
# Cap on the stored text: it comes from a user-authored ticket title (already
# capped at 200 by the ticket schema); this is a second guard for future callers.
_TEXT_MAX = 200

_WS_TIMEOUT = 2.0


def create_notification(
    db: Session,
    user_id: str,
    kind: str,
    text: str = "",
    link: str = "",
    ref_id: str | None = None,
) -> UserNotification:
    """写一条站内通知。只 add + flush，不 commit——由调用方的事务一起落盘，
    这样"工单回复成功但通知没写进去"这种半截状态不会出现。
    Insert one notification. Adds and flushes but does not commit: it rides the
    caller's transaction, so "reply saved, notification lost" can't happen."""
    row = UserNotification(
        user_id=user_id,
        kind=kind,
        ref_id=ref_id,
        text=(text or "")[:_TEXT_MAX],
        link=link or "",
    )
    db.add(row)
    db.flush()
    return row


def notify_ws(user_id: str) -> None:
    """告诉这个用户此刻在线的页面「有新通知了」，让铃铛立刻重拉。

    只发一个信号、不带内容：面板拿到信号后自己去 /notifications/feed 取，省得
    WS 帧与接口两处各维护一份渲染字段。失败只记日志——实时刷新是锦上添花，
    用户下次打开面板照样看得到。

    Tell whichever of this user's pages are online that something arrived, so the
    bell refetches. Signal only, no payload: the panel re-reads
    /notifications/feed rather than having the WS frame and the endpoint each
    carry their own copy of the render fields. Failures are logged and swallowed
    — live refresh is a bonus; the row is there next time the panel opens.
    """
    try:
        from app.services.connection_manager import manager
        from app.services.gateway_client import run_on_main_loop

        run_on_main_loop(
            manager.push_to_client(user_id, {"type": "NOTIFICATION_NEW", "data": {}}),
            timeout=_WS_TIMEOUT,
        )
    except Exception:  # noqa: BLE001
        logger.warning("站内通知 WS 下发失败 / in-app notification WS signal failed", exc_info=True)
