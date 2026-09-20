"""桥接指令唤醒：订单落库的那一刻，叫醒正在长轮询 /bridge/poll 的桥接。

以前桥接每 1.5 秒来问一次"有指令吗"，一笔单平均要在库里躺 0.75 秒才被取走，快市里
这就是止损滑出目标区间的那一段。现在桥接（v1.4 起）带 waitSeconds 挂在 /bridge/poll
上；这里在订单 commit 之后置一个 per-user 的 asyncio.Event，把它当场叫醒——指令从落库
到桥接拿到，从"最多 1.5 秒"变成"一个 HTTP 往返"。

跨 worker：配了 Redis 时经 shared_state 的 pub/sub 广播，每个 worker 跑一条订阅协程，
把别的 worker 发来的唤醒落到本进程的事件上；没配 Redis 时后端本来就必须是单 worker
（main.py 启动时会提示），进程内置事件即可。事件按用户懒建：旧版桥接从不长轮询，字典里
就没有它的条目，notify 只是一次字典查找。

Wakes a bridge that is long-polling /bridge/poll the moment an order is committed,
instead of letting it sit for up to one 1.5s poll interval. Per-user asyncio.Event,
broadcast across workers via shared_state pub/sub when Redis is configured.

Bridge long-poll wake-up. Per-user asyncio.Event set right after an order commits;
fanned out to other workers over shared_state pub/sub when Redis is on.
"""
import asyncio
import json
import logging

from app.services import shared_state

logger = logging.getLogger("prismx.bridge_wake")

CHANNEL = "bridge_wake"

_loop: asyncio.AbstractEventLoop | None = None
_events: dict[str, asyncio.Event] = {}


def bind_loop(loop: asyncio.AbstractEventLoop) -> None:
    """lifespan 启动时捕获主事件循环：notify 可能从线程池线程调用，置事件要跨线程投递。
    Capture the main loop at startup; notify() may run on a worker thread."""
    global _loop
    _loop = loop


def _event(user_id: str) -> asyncio.Event:
    ev = _events.get(user_id)
    if ev is None:
        ev = asyncio.Event()
        _events[user_id] = ev
    return ev


def arm(user_id: str) -> None:
    """一轮长轮询开始前（查库之前）调用：清掉上一轮遗留的唤醒。

    顺序必须是「清 → 查库 → 等」：查库期间落库的订单会把事件重新置起，等待立即返回并
    再查一次；若在查库之后才清，那笔订单的唤醒就被清掉了，要等到超时。
    Call before the DB read: clear → read → wait. An order committed during the read
    re-sets the event so the wait returns at once; clearing after the read would lose it.
    """
    _event(user_id).clear()


async def wait(user_id: str, timeout: float) -> bool:
    """等这个用户的唤醒，最多 timeout 秒。True = 被叫醒，False = 超时。"""
    try:
        await asyncio.wait_for(_event(user_id).wait(), timeout)
        return True
    except asyncio.TimeoutError:
        return False


def _wake_local(user_id: str) -> None:
    ev = _events.get(user_id)
    if ev is None:
        # 没有桥接在等（旧版桥接、或桥接离线）：它下一次来 poll 自然会取到指令。
        # Nobody waiting: the next regular poll picks the command up as before.
        return
    loop = _loop
    if loop is None or loop.is_closed():
        ev.set()
        return
    loop.call_soon_threadsafe(ev.set)


def notify(user_id: str | None) -> None:
    """订单落库（commit 之后）调用，任何线程都可以。

    先置本进程的事件（下单请求和长轮询多半就在同一个进程里），配了 Redis 再广播给
    其它 worker。广播失败只记日志：唤醒是加速，不是正确性依赖，桥接超时后照常再问。
    Set the local event first, then broadcast to other workers when Redis is on. A
    failed broadcast is only logged: waking is an optimisation, the poll still times
    out and asks again.
    """
    if not user_id:
        return
    _wake_local(str(user_id))
    if shared_state.enabled():
        try:
            shared_state.publish(CHANNEL, {"user": str(user_id)})
        except Exception as e:  # noqa: BLE001
            logger.warning("bridge_wake 广播失败 / publish failed: %s", e)


async def run_subscriber() -> None:
    """多 worker：把别的 worker 发来的唤醒落到本进程的事件上。断线 3 秒后重连。
    Multi-worker only: apply wakes published by other workers; reconnect on drop."""
    while True:
        pubsub = client = None
        try:
            sub = shared_state.new_async_pubsub(CHANNEL, with_client=True)
            if sub is None:
                return
            pubsub, channel, client = sub
            await pubsub.subscribe(channel)
            async for msg in pubsub.listen():
                if msg.get("type") != "message":
                    continue
                try:
                    data = json.loads(msg.get("data") or "")
                except (ValueError, TypeError):
                    continue
                # 自己发的已经在 notify 里就地置过事件了，不必再来一次。
                # Our own publishes were applied locally in notify() already.
                if data.get("from") == shared_state.WORKER_ID:
                    continue
                uid = data.get("user")
                if uid:
                    _wake_local(str(uid))
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001
            logger.warning("bridge_wake 订阅中断，3 秒后重连 / subscriber dropped, reconnecting in 3s: %s", e)
            await asyncio.sleep(3)
        finally:
            # 每绕一圈 new_async_pubsub 都新建一个客户端（连同它自己的连接池）。
            # 不关掉的话，Redis 每抖动一次这条循环就重来一轮、多留一组连接——一段
            # 不稳定期下来连接数线性堆高，最后撞 maxclients，而这条链路上挂着的是
            # 「下单立刻叫醒桥接」，堵住就退回 1.5 秒轮询。异常路径也要走到，所以
            # 放 finally 而不是循环末尾。与 connection_manager.run_fanout_subscriber
            # 同源同解（审计 F-09）。
            # Every pass creates a fresh client (with its own pool); leaving it
            # open leaks one set of connections per Redis wobble until maxclients
            # is hit. Must run on the error path too, hence finally. Same fix as
            # connection_manager.run_fanout_subscriber.
            await _close_pubsub(pubsub, client)


async def _close_pubsub(pubsub, client) -> None:
    """关闭订阅与客户端；关闭失败只记日志，绝不把订阅循环带下去。
    Close pubsub + client; a cleanup failure must never kill the loop."""
    for obj in (pubsub, client):
        if obj is None:
            continue
        try:
            await obj.aclose()
        except Exception as e:  # noqa: BLE001
            logger.debug("关闭 Redis 订阅连接失败 / closing pubsub connection failed: %s", e)


def start_tasks() -> list[asyncio.Task]:
    """配了 Redis 时每个 worker 都要跑的订阅协程；单 worker 返回空列表。"""
    if not shared_state.enabled():
        return []
    return [asyncio.create_task(run_subscriber(), name="bridge:wake")]
