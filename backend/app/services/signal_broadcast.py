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
from datetime import datetime, timezone

from app.core.database import SessionLocal
from app.models import User
from app.services.connection_manager import manager
from app.services.plans import is_plan_expired, is_realtime_plan


async def _broadcast_to_plan_group(message: dict, *, free_only: bool) -> None:
    """向当前在线用户中匹配 FREE / 非 FREE 的一组推送消息。

    "有效实时资格" = 等级本身实时 且 未过期。到期时间一到就立即按 FREE 处理，
    不必等后台 plan_expiry_sweep_loop 把 plan 落库降级——否则一个刚过期、又
    挂着网页不动（不发任何带凭证请求，不会触发 get_current_user 的即时降级）的
    PRO 会在被扫到之前继续收到实时信号。判定与 REST 侧的 is_realtime_plan +
    is_plan_expired 完全一致。

    Push a message to the subset of currently-online users matching FREE /
    non-FREE. "Effectively real-time" = a real-time plan AND not expired. Expiry
    takes effect immediately here rather than waiting for the background
    plan_expiry_sweep_loop to persist the FREE downgrade — otherwise a
    just-expired PRO sitting idle on the page (making no authenticated request,
    so get_current_user's read-time downgrade never fires) would keep receiving
    real-time signals until the sweep catches it. Uses the same is_realtime_plan
    + is_plan_expired predicate as the REST path.
    """
    connected = manager.connected_user_ids()
    if not connected:
        return
    now = datetime.now(timezone.utc)
    db = SessionLocal()
    try:
        rows = (
            db.query(User.id, User.plan, User.plan_expires_at)
            .filter(User.id.in_(connected))
            .all()
        )
    finally:
        db.close()
    want_realtime = not free_only
    target_ids = [
        uid
        for (uid, plan, expires_at) in rows
        if (is_realtime_plan(plan) and not is_plan_expired(plan, expires_at, now)) == want_realtime
    ]
    for uid in target_ids:
        await manager.push_to_client(uid, message)


async def broadcast_signal_new_realtime(payload: dict) -> None:
    """新信号生成：只推给实时等级的在线用户 / a new signal: push only to real-time-tier users."""
    await _broadcast_to_plan_group({"type": "SIGNAL_NEW", "data": payload}, free_only=False)


async def broadcast_signal_new_free_tier(payload: dict) -> None:
    """信号已过期：FREE 等级第一次看到它，连同最终状态一起推送。
    A signal has expired: FREE tier's first reveal, delivered with its final state."""
    await _broadcast_to_plan_group({"type": "SIGNAL_NEW", "data": payload}, free_only=True)
