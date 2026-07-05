"""按订阅等级过滤的信号广播。

新信号只推给享有实时权益的在线用户；FREE 等级要等这条信号过期
（SIGNAL_EXPIRE_MINUTES 分钟后，已无法再下单）才会第一次看到它，
连同其最终状态一起推送——效果等同于"延迟到不能用了才给看"。

Plan-aware signal broadcast.

A new signal is pushed only to online users on a real-time-eligible plan.
FREE-tier users see the same signal for the first time only after it has
expired (SIGNAL_EXPIRE_MINUTES later, already untradeable), delivered
together with its final state — effectively "delayed until it's unusable".
"""
from app.core.database import SessionLocal
from app.models import User
from app.services.connection_manager import manager


async def _broadcast_to_plan_group(message: dict, *, free_only: bool) -> None:
    """向当前在线用户中匹配 FREE / 非 FREE 的一组推送消息。
    Push a message to the subset of currently-online users matching FREE / non-FREE."""
    connected = manager.connected_user_ids()
    if not connected:
        return
    db = SessionLocal()
    try:
        q = db.query(User.id).filter(User.id.in_(connected))
        q = q.filter(User.plan == "FREE") if free_only else q.filter(User.plan != "FREE")
        target_ids = [uid for (uid,) in q.all()]
    finally:
        db.close()
    for uid in target_ids:
        await manager.push_to_client(uid, message)


async def broadcast_signal_new_realtime(payload: dict) -> None:
    """新信号生成：只推给实时等级的在线用户 / a new signal: push only to real-time-tier users."""
    await _broadcast_to_plan_group({"type": "SIGNAL_NEW", "data": payload}, free_only=False)


async def broadcast_signal_new_free_tier(payload: dict) -> None:
    """信号已过期：FREE 等级第一次看到它，连同最终状态一起推送。
    A signal has expired: FREE tier's first reveal, delivered with its final state."""
    await _broadcast_to_plan_group({"type": "SIGNAL_NEW", "data": payload}, free_only=True)
