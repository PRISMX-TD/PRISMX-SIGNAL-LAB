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

from starlette.concurrency import run_in_threadpool

from app.core.database import SessionLocal
from app.models import Signal, User
from app.schemas import SignalOut
from app.services.connection_manager import manager
from app.services.plans import is_plan_expired, is_realtime_plan


def serialize_signal(sig: Signal) -> dict:
    """把 Signal 行转成推送用的 JSON 载荷。

    放在这里而不是各推送点各写一份：这个映射此前在 engine/signal_engine.py 与
    routers/webhook.py 里各有一份逐字节相同的 `_serialize`，而两处推的是同一种
    消息、被同一批前端代码消费。字段对不齐的后果不会报错，只会让某条通道推出去的
    信号少一个字段——前端拿到 undefined，界面上表现为某个数字空着。信号载荷加字段
    是常事，一份定义才不会漏掉其中一条通道。

    Serialize a Signal row into the push payload.

    Kept here rather than duplicated at each push site: a byte-identical
    `_serialize` previously lived in both engine/signal_engine.py and
    routers/webhook.py, feeding the same message type to the same frontend code.
    A drift between them raises nothing — one channel simply pushes a signal
    missing a field, the frontend reads undefined, and a number renders blank.
    Fields get added to this payload routinely; one definition is what keeps a
    channel from being forgotten.
    """
    return SignalOut(
        id=sig.id,
        symbol=sig.symbol,
        side=sig.side,
        entry=sig.entry,
        stopLoss=sig.stop_loss,
        takeProfit=sig.take_profit,
        indicator=sig.indicator,
        status=sig.status,
        createdAt=sig.created_at,
        expireAt=sig.expire_at,
        result=sig.result or "PENDING",
        resolvedAt=sig.resolved_at,
    ).model_dump(mode="json")


# 按 id 批量查等级时每次取多少个：SQLite 的 IN 参数个数有编译期上限（老版本 999），
# Postgres 超长 IN 同样会让计划变差。与 push_dispatch._BATCH_CHUNK 同值。
# Chunk size for the plan lookup by id (SQLite's IN limit; long INs hurt Postgres
# plans too). Same value as push_dispatch._BATCH_CHUNK.
_PLAN_LOOKUP_CHUNK = 500


def _plan_group_user_ids(connected: list[str], free_only: bool, now: datetime) -> list[str]:
    """在线名单里匹配 FREE / 非 FREE 的那一组（**同步查库**，经线程池调用）。
    The FREE / non-FREE subset of the online roster (blocking DB query)."""
    want_realtime = not free_only
    targets: list[str] = []
    db = SessionLocal()
    try:
        for i in range(0, len(connected), _PLAN_LOOKUP_CHUNK):
            rows = (
                db.query(User.id, User.plan, User.plan_expires_at)
                .filter(User.id.in_(connected[i:i + _PLAN_LOOKUP_CHUNK]))
                .all()
            )
            targets.extend(
                uid
                for (uid, plan, expires_at) in rows
                if (is_realtime_plan(plan) and not is_plan_expired(plan, expires_at, now)) == want_realtime
            )
    finally:
        db.close()
    return targets


async def plan_group_targets(*, free_only: bool) -> list[str]:
    """当前在线用户中匹配 FREE / 非 FREE 的一组 id。

    "有效实时资格" = 等级本身实时 且 未过期。到期时间一到就立即按 FREE 处理，
    不必等后台 plan_expiry_sweep_loop 把 plan 落库降级——否则一个刚过期、又
    挂着网页不动（不发任何带凭证请求，不会触发 get_current_user 的即时降级）的
    PRO 会在被扫到之前继续收到实时信号。判定与 REST 侧的 is_realtime_plan +
    is_plan_expired 完全一致。

    在线名单（配了 Redis 是一次网络往返）与查库都不在事件循环上做：以前两者都是
    直接同步调用，每条新信号、每 5 秒的到期广播都会把事件循环卡住一次查库的时间。

    Ids of currently-online users matching FREE / non-FREE. "Effectively
    real-time" = a real-time plan AND not expired. Expiry takes effect
    immediately here rather than waiting for the background
    plan_expiry_sweep_loop to persist the FREE downgrade — otherwise a
    just-expired PRO sitting idle on the page (making no authenticated request,
    so get_current_user's read-time downgrade never fires) would keep receiving
    real-time signals until the sweep catches it. Uses the same is_realtime_plan
    + is_plan_expired predicate as the REST path. Neither the roster read nor
    the DB query runs on the event loop any more.
    """
    connected = await manager.connected_user_ids_async()
    if not connected:
        return []
    now = datetime.now(timezone.utc)
    return await run_in_threadpool(_plan_group_user_ids, list(connected), free_only, now)


async def _broadcast_to_plan_group(message: dict, *, free_only: bool) -> None:
    """向当前在线用户中匹配 FREE / 非 FREE 的一组推送消息（判定见 plan_group_targets）。

    整组一次 push_to_users：多 worker 时是**一次** publish 带上目标名单，由各 worker
    投给连在自己这里的人；以前是逐人 await push_to_client，在线的实时用户有几百个，
    一条信号就要排几百次 Redis 往返，排在后面的人晚好几秒才看到。
    Push a message to the FREE / non-FREE subset (see plan_group_targets) with a
    single push_to_users — one publish carrying the target list — instead of one
    awaited push_to_client per user, which queued hundreds of round-trips.
    """
    targets = await plan_group_targets(free_only=free_only)
    if targets:
        await manager.push_to_users(targets, message)


async def broadcast_signal_new_realtime(payload: dict) -> None:
    """新信号生成：只推给实时等级的在线用户 / a new signal: push only to real-time-tier users."""
    await _broadcast_to_plan_group({"type": "SIGNAL_NEW", "data": payload}, free_only=False)


async def broadcast_signal_new_free_tier(payload: dict) -> None:
    """信号已过期：FREE 等级第一次看到它，连同最终状态一起推送。
    A signal has expired: FREE tier's first reveal, delivered with its final state."""
    await _broadcast_to_plan_group({"type": "SIGNAL_NEW", "data": payload}, free_only=True)


async def broadcast_signals_new_free_tier(payloads: list[dict]) -> None:
    """同一轮过期的多条信号一起揭晓给 FREE 等级：名单与等级只查一次，而不是每条
    信号各查一遍（到期扫描每 5 秒一轮，一轮可能同时过期好几条）。
    Reveal several just-expired signals to the FREE tier with one roster/plan
    lookup instead of one per signal (the expiry sweep can expire several at once)."""
    if not payloads:
        return
    targets = await plan_group_targets(free_only=True)
    if not targets:
        return
    for payload in payloads:
        await manager.push_to_users(targets, {"type": "SIGNAL_NEW", "data": payload})
