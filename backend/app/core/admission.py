"""入口排队：过载时让请求在门口等，而不是挤进线程池与连接池里一起卡死。
Front-door admission: under overload, requests wait at the door instead of piling into
the thread pool and the DB pool and wedging the worker together.

为什么（2026-10-10 压测）：几百个请求同时进来时，它们全部进了线程池（256 条），一起去抢
每个 worker 只有 12 条的数据库连接；排在后面的等满 DB_POOL_TIMEOUT（8 秒）一片 503，而
已经被客户端放弃的请求还在排队、还在照样执行，负载撤掉后后端又卡了一分多钟，最后是看门狗
重启才恢复。下单那条路上更糟：成交回来后写库那一步也在抢连接，抢不到就把已成交的单记成了
失败。

做法：纯 ASGI 中间件，按路径分三类——
  · 交易指令（POST /api/orders 及其子路径）：单独一条道，同时最多 ORDER_MAX_INFLIGHT 笔，
    排不上的最多等 ORDER_QUEUE_TIMEOUT 秒，到点回 503「指令未发出」（什么都没执行，可以重下）；
  · 不排队：看门狗探活、运维面板的管理员校验、桥接轮询与回执、支付回调与 EA/TradingView 的
    数据入口（见 _EXEMPT_EXACT 上的说明）；
  · 其余普通请求：同时最多 HTTP_MAX_INFLIGHT 个，排队超过 HTTP_QUEUE_TIMEOUT 回 503。
在门口等用的是 asyncio 信号量：不占线程、不占连接、不占 CPU。正常负载下名额永远用不满，
请求直接通过，和没有这个中间件时一样。

Why (2026-10-10 load test): with hundreds of requests arriving at once, all of them
entered the 256-thread pool and fought over the worker's 12 DB connections; the tail
timed out at DB_POOL_TIMEOUT in a wave of 503s, requests their clients had already
abandoned kept queueing and executing, and after the load stopped the backend stayed
wedged for over a minute until the watchdog restarted it. On the order path it was
worse: the post-fill write also fought for a connection, and losing that race recorded
filled orders as failed.

How: a pure ASGI middleware with three classes of path — trading commands get their own
lane (ORDER_MAX_INFLIGHT, 503 "not sent" after ORDER_QUEUE_TIMEOUT: nothing ran, safe to
retry); the watchdog probe, the ops panel's admin check, bridge polls and results, the
payment callback and the EA / TradingView inputs are never queued (see _EXEMPT_EXACT);
everything else shares HTTP_MAX_INFLIGHT with a 503 after HTTP_QUEUE_TIMEOUT. Waiting is
an asyncio semaphore: no thread, no connection, no CPU. At normal load the slots are never
exhausted and every request passes straight through.
"""
import asyncio
import json
import logging
import time

from app.core.config import settings

logger = logging.getLogger("prismx.admission")

_ORDER_BUSY = (
    "当前下单的人太多，本次指令未发出，可以放心重试 / "
    "Too many orders right now; this one was NOT sent and is safe to retry"
)
_HTTP_BUSY = "服务繁忙，请稍后重试 / Service busy, please retry shortly"
# 拒绝日志限频：过载时每秒可能拒掉几百个，日志一行就够。
# Rate-limit the rejection log: an overload can shed hundreds a second.
_LOG_EVERY = 30.0


class _Lane:
    """一条道：并发上限 + 排队时限。信号量按事件循环各建一个（测试里会有多个循环）。
    One lane: a concurrency cap plus a queueing deadline. One semaphore per event loop
    (tests run several loops)."""

    def __init__(self, name: str, limit: int, timeout: float, busy: str):
        self.name = name
        self.limit = max(1, int(limit))
        self.timeout = float(timeout)
        self.busy = busy
        self._sems: dict[int, asyncio.Semaphore] = {}
        self.inflight = 0
        self.waiting = 0
        self.rejected = 0
        self._logged_at = 0.0

    def _sem(self) -> asyncio.Semaphore:
        loop_id = id(asyncio.get_running_loop())
        sem = self._sems.get(loop_id)
        if sem is None:
            sem = self._sems[loop_id] = asyncio.Semaphore(self.limit)
        return sem

    async def acquire(self) -> asyncio.Semaphore | None:
        sem = self._sem()
        if not sem.locked():
            await sem.acquire()  # 有空位：不挂起、不建任务 / free slot: no suspension, no task
        else:
            self.waiting += 1
            try:
                await asyncio.wait_for(sem.acquire(), self.timeout)
            except asyncio.TimeoutError:
                self.rejected += 1
                now = time.monotonic()
                if now - self._logged_at >= _LOG_EVERY:
                    self._logged_at = now
                    logger.warning(
                        "入口排队超时，已回 503 / admission timeout on lane %s: inflight=%d waiting=%d "
                        "rejected_total=%d (limit %d, timeout %.0fs)",
                        self.name, self.inflight, self.waiting, self.rejected, self.limit, self.timeout,
                    )
                return None
            finally:
                self.waiting -= 1
        self.inflight += 1
        return sem

    def release(self, sem: asyncio.Semaphore) -> None:
        self.inflight -= 1
        sem.release()


_order_lane = _Lane("orders", settings.ORDER_MAX_INFLIGHT, settings.ORDER_QUEUE_TIMEOUT, _ORDER_BUSY)
_http_lane = _Lane("http", settings.HTTP_MAX_INFLIGHT, settings.HTTP_QUEUE_TIMEOUT, _HTTP_BUSY)

_P = settings.API_PREFIX
# 不排队的路径：
#   · 看门狗探活（根路径）、运维面板确认管理员身份的 /admin/trial——过载时正是要按重启按钮的时候；
#   · 桥接轮询与回执：报到要是在门口等过 10 秒，账号就被判离线、用户收到「桥接断开」的误报；
#     报到大多走快路径不碰数据库，领指令的长轮询大半时间只是在等；回执是成交结果，必须落库；
#   · 支付回调（到账通知）、EA 行情/K 线、TradingView 等信号入口。量都很小，丢了的代价却大。
# Never queued: the watchdog probe and the ops panel's /admin/trial admin check (overload is
# exactly when the restart button is needed); bridge polls and results (a check-in held at
# the door past 10s marks the account offline and fires a false "bridge offline" alert; most
# check-ins take the DB-free fast path and the command long poll mostly waits; results are
# fills and must be recorded); the payment callback, the EA market feed and the
# TradingView-style webhooks — all low volume, all costly to lose.
_EXEMPT_EXACT = frozenset({
    "/", f"{_P}/admin/trial",
    f"{_P}/bridge/poll", f"{_P}/bridge/result",
    f"{_P}/payments/webhook",
})
_EXEMPT_PREFIXES = (f"{_P}/feed/", f"{_P}/webhook/")
_ORDER_PATH = f"{_P}/orders"


def _lane_for(scope) -> _Lane | None:
    method = scope.get("method", "GET")
    if method == "OPTIONS":
        return None
    path = scope.get("path", "")
    if path in _EXEMPT_EXACT or path.startswith(_EXEMPT_PREFIXES):
        return None
    if method == "POST" and (path == _ORDER_PATH or path.startswith(_ORDER_PATH + "/")):
        return _order_lane
    return _http_lane


def snapshot() -> dict:
    """当前状态，给系统状态页 / 排查用。/ Current state for the status page and debugging."""
    return {
        lane.name: {"inflight": lane.inflight, "waiting": lane.waiting, "rejected": lane.rejected,
                    "limit": lane.limit}
        for lane in (_http_lane, _order_lane)
    }


async def _reject(send, lane: _Lane) -> None:
    body = json.dumps({"detail": lane.busy}, ensure_ascii=False).encode("utf-8")
    await send({
        "type": "http.response.start",
        "status": 503,
        "headers": [
            (b"content-type", b"application/json"),
            (b"content-length", str(len(body)).encode()),
            (b"retry-after", b"2"),
        ],
    })
    await send({"type": "http.response.body", "body": body})


class AdmissionMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or not settings.ADMISSION_ENABLED:
            await self.app(scope, receive, send)
            return
        lane = _lane_for(scope)
        if lane is None:
            await self.app(scope, receive, send)
            return
        sem = await lane.acquire()
        if sem is None:
            await _reject(send, lane)
            return
        try:
            await self.app(scope, receive, send)
        finally:
            lane.release(sem)
