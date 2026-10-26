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
  · 不排队：看门狗探活、运维面板的管理员校验、已鉴权桥接的轮询与回执、支付回调与
    EA/TradingView 的数据入口（见 _EXEMPT_EXACT 上的说明）；
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
retry); the watchdog probe, the ops panel's admin check, cached-token bridge polls and results, the
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
                # 系统状态页「容量」灯用：只动内存，至多 30 秒在线程里刷一次（services/capacity.py）
                # For the status page's capacity light: memory only, flushed off-loop (services/capacity.py)
                from app.services import capacity
                capacity.note_overload("admission:" + self.name)
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
    f"{_P}/payments/webhook",
})
_EXEMPT_PREFIXES = (f"{_P}/feed/", f"{_P}/webhook/")
_ORDER_PATH = f"{_P}/orders"
# 桥接轮询与回执的免排队只给「已经鉴权过的 token」：带的 X-API-Token 在桥接鉴权缓存里
# （routers/bridge._auth_cache，最近 10 秒内成功鉴权过、不碰数据库的那条快路径）才直通。
# 以前只看路径，任何人带一个随便编的 token 就能绕过排队，每个请求都去连接池查一次库
# （审计 2026-10-26）。不认识的 token 走普通请求的道：平时有空位照样立刻通过（正常桥接
# 缓存过期后的第一拍也一样），过载时和别的请求一起排队、到点 503，不再挤占线程与连接。
# Bridge poll/result skip the queue only for a token that is in the bridge auth cache
# (routers/bridge._auth_cache: authenticated in the last ~10s, the DB-free fast path).
# Exempting on the path alone let any made-up token bypass admission and spend a pooled
# DB lookup per request (audit 2026-10-26). An unknown token takes the http lane: it
# passes at once when there is room (as does a genuine bridge whose entry just lapsed),
# and is queued / shed with everything else under overload.
_BRIDGE_CACHED_EXACT = frozenset({f"{_P}/bridge/poll", f"{_P}/bridge/result"})


def _header(scope, name: bytes) -> bytes | None:
    for k, v in scope.get("headers") or ():
        if k.lower() == name:
            return v
    return None


def _bridge_token_cached(scope) -> bool:
    """X-API-Token 是否命中桥接鉴权缓存（只读、不碰数据库；任何意外都当未命中）。
    Whether X-API-Token is in the bridge auth cache (read-only, no DB; any surprise = miss)."""
    raw = _header(scope, b"x-api-token")
    if not raw:
        return False
    try:
        from app.core.security import hash_api_token
        from app.routers import bridge

        hit = bridge._auth_cache.get(hash_api_token(raw.decode("latin-1")))
        return hit is not None and hit[0] > time.monotonic()
    except Exception:  # noqa: BLE001 —— 判不出来就排队，安全的那一边 / unsure -> queue
        return False


def _lane_for(scope) -> _Lane | None:
    method = scope.get("method", "GET")
    if method == "OPTIONS":
        return None
    path = scope.get("path", "")
    if path in _EXEMPT_EXACT or path.startswith(_EXEMPT_PREFIXES):
        return None
    if path in _BRIDGE_CACHED_EXACT and _bridge_token_cached(scope):
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


# ---------------------------------------------------------------------------
# 请求体上限 / request-body budget
#
# 审计 2026-10-26：EA 行情（/feed/*）、支付回调、图片上传都是先把整段请求体解析 / spool 完才
# 鉴权（token 在函数体里查、上传的 Depends 在 multipart 解析之后、IPN 先 json.loads 再验签），
# 应用里又没有任何请求体上限——匿名请求能按请求体大小花掉 CPU、内存与临时盘，上限只剩上游
# nginx 的 client_max_body_size。这里按路径给预算：声明的 Content-Length 超了直接 413，下游一
# 个字节都不读；没有 Content-Length 的分块请求，读到超限的那一块时抛 413（FastAPI 解析 body 时
# 原样重抛 HTTPException，路由里 await request.body() 的也一样），后面的解析 / 扫描都不会跑。
#
# Audit 2026-10-26: the EA feed, the payment IPN and the image uploads all parse or spool
# the whole body before authenticating, and nothing in the app capped body size. Budgets
# per path: a declared Content-Length over budget is a 413 before the app reads a byte; a
# chunked body is cut off with a 413 at the chunk that overflows (FastAPI re-raises an
# HTTPException from body parsing, as does a handler awaiting request.body()).
# ---------------------------------------------------------------------------

_KB = 1024
_SMALL_PREFIXES = (f"{_P}/webhook/", f"{_P}/telemetry/")
_UPLOAD_PATHS = frozenset({f"{_P}/admin/upload-image", f"{_P}/tickets/upload-image", f"{_P}/share/image"})
_BULK_PREFIXES = (f"{_P}/feed/", f"{_P}/bridge/")
_TOO_LARGE = "请求体过大 / Request body too large"


def body_budget(path: str) -> int:
    """这条路径允许的最大请求体字节数。/ Max request-body bytes for this path.

    · 支付回调、webhook、埋点：64KB（NOWPayments 回调 1~2KB；趋势批量 64 个品种也远小于此；
      埋点端点自己只收 8~16KB）；退订表单：16KB（只读前 4KB）；
    · 图片上传：UPLOAD_MAX_BYTES + 64KB 的 multipart 开销；
    · EA 行情与桥接：REQUEST_BODY_BULK_MAX_BYTES；其余：REQUEST_BODY_MAX_BYTES。
    IPN / webhooks / telemetry 64KB; unsubscribe 16KB; uploads UPLOAD_MAX_BYTES + 64KB
    multipart overhead; feed and bridge the bulk budget; everything else the default."""
    if path == f"{_P}/payments/webhook" or path.startswith(_SMALL_PREFIXES):
        return 64 * _KB
    if path.startswith(f"{_P}/email/"):
        return 16 * _KB
    if path in _UPLOAD_PATHS:
        return settings.UPLOAD_MAX_BYTES + 64 * _KB
    if path.startswith(_BULK_PREFIXES):
        return settings.REQUEST_BODY_BULK_MAX_BYTES
    return settings.REQUEST_BODY_MAX_BYTES


async def _reject_too_large(send) -> None:
    body = json.dumps({"detail": _TOO_LARGE}, ensure_ascii=False).encode("utf-8")
    await send({
        "type": "http.response.start",
        "status": 413,
        "headers": [
            (b"content-type", b"application/json"),
            (b"content-length", str(len(body)).encode()),
            (b"connection", b"close"),
        ],
    })
    await send({"type": "http.response.body", "body": body})


class BodyLimitMiddleware:
    """纯 ASGI：按 body_budget 限制请求体。WebSocket 与 lifespan 原样放过。
    Pure ASGI request-body cap per body_budget; websocket and lifespan pass through."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        budget = body_budget(scope.get("path", ""))
        declared = _header(scope, b"content-length")
        if declared is not None:
            try:
                n = int(declared)
            except ValueError:
                n = -1
            if n > budget:
                await _reject_too_large(send)
                return

        from starlette.exceptions import HTTPException

        seen = 0

        async def capped_receive():
            nonlocal seen
            msg = await receive()
            if msg["type"] == "http.request":
                seen += len(msg.get("body", b""))
                if seen > budget:
                    raise HTTPException(status_code=413, detail=_TOO_LARGE)
            return msg

        started = False

        async def tracking_send(msg):
            nonlocal started
            if msg["type"] == "http.response.start":
                started = True
            await send(msg)

        try:
            await self.app(scope, capped_receive, tracking_send)
        except HTTPException as exc:
            # 正常情况下路由里的 ExceptionMiddleware 已经把它转成 413；这里兜住从别处冒出来的。
            # Normally the router's ExceptionMiddleware turns it into the 413; this is the backstop.
            if exc.status_code != 413 or started:
                raise
            await _reject_too_large(send)
