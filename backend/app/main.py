"""PRISMX Signal Lab 后端入口 / Backend entrypoint."""
import asyncio
import functools
import logging
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from sqlalchemy.exc import TimeoutError as SQLAlchemyPoolTimeoutError
from uvicorn.middleware.proxy_headers import ProxyHeadersMiddleware

from app.core.config import settings, _WORKER_COUNT
from app.core.database import init_db
from app.core.rate_limit import limiter
from app.core.strategy_limits import user_limiter
from app.services.deps import get_current_user, require_admin
from app.engine.signal_engine import signal_expiry_loop, signal_loop
from app.routers import account, admin, announcements, auth, automation, bootstrap, bridge, chart, competitions, ea, emails, gamification, gateway, invite, notifications, orders, payments, sentiment, share, signals, site, strategies, telemetry, tickets, trends, webhook, ws
from app.routers.bridge import offline_monitor_loop
from app.routers.gateway import gateway_positions_loop
from app.routers.orders import stale_order_monitor_loop
from app.services.candle_store import candle_retention_sweep_loop
from app.services.gamification.loop import board_loop, competition_loop, gamification_loop
from app.services.plan_expiry import plan_expiry_sweep_loop
from app.services.email_broadcast import email_broadcast_loop
from app.services.sentiment_store import sentiment_loop
from app.services.signal_resolution import stale_signal_sweep_loop
from app.services.strategy.resolution import stale_strategy_signal_sweep_loop
from app.services.background import BackgroundLoops
from app.services import loop_health
from app.services.connection_manager import manager


# uvicorn 只配置自己的 logger，不动 root，所以应用代码里的 logger.info(...) 会
# 落到未配置的 root logger 上——默认级别 WARNING，全部被丢掉。后台循环的诊断日志
# 因此完全看不见，排查只能靠猜。这里显式配一次，让 INFO 能进 journald。
#
# uvicorn configures only its own loggers and leaves root untouched, so the app's
# logger.info(...) calls hit an unconfigured root logger whose default level is
# WARNING and get dropped — making the background loops undiagnosable. Configure
# it explicitly so INFO reaches journald.
logging.basicConfig(
    level=getattr(logging, settings.LOG_LEVEL.upper(), logging.INFO),
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)

# httpx 在 INFO 级别会为每个请求打一行。持仓事件是 250 毫秒拉一次的，放着不管
# 会以每秒四行的速度把 journald 冲满，真正要看的日志全被埋掉。降到 WARNING：
# 请求失败仍然会记（那才是需要看见的），成功的就不必逐条汇报了。
#
# httpx logs a line per request at INFO. The position-event tick runs every
# 250ms, which floods journald at four lines a second and buries everything
# worth reading. WARNING still surfaces failures, which is the part that matters.
logging.getLogger("httpx").setLevel(logging.WARNING)

logger = logging.getLogger("prismx.main")


# ---------- WebSocket permessage-deflate 窗口调小 ----------
# uvicorn 的 websockets 实现（uvicorn 0.30.6 protocols/websockets/websockets_impl.py）在
# **每条连接**的 WebSocketProtocol.__init__ 里执行 `ServerPerMessageDeflateFactory()`：
# 无参 = 15 位滑动窗口 + 默认 memLevel，每条连接的压缩上下文合计约 300~400 KB 内存。
# 这个名字是按模块全局在连接建立时才查的，所以在 import 期把它换成带参数的偏函数即可，
# 不用动 systemd 的启动命令。窗口 12 位 + memLevel 4：每连接降到几十 KB，压缩率略降
# （持仓帧几十 KB 的 JSON，重复度高，损失很小）。老 WebView 若不支持窗口协商，
# 退回不压缩而不是断连。每个 worker 都会先 import 本模块再收连接，所以每个进程都生效。
# 换了别的 uvicorn / websockets 版本对不上时只记日志、保持默认，不影响启动。
#
# Shrink the permessage-deflate window. uvicorn's websockets implementation builds
# ServerPerMessageDeflateFactory() inside each connection's WebSocketProtocol.__init__:
# no arguments = a 15-bit window, roughly 300-400 KB of compression context per
# connection. The name is a module global looked up at connect time, so swapping it for
# a partial at import time is enough (no systemd change). A 12-bit window with memLevel 4
# takes it to tens of KB at a small cost in ratio. If a different uvicorn / websockets
# layout is installed, it only logs and keeps the defaults.
WS_DEFLATE_WINDOW_BITS = 12
WS_DEFLATE_MEM_LEVEL = 4


def _shrink_ws_deflate_window() -> bool:
    try:
        from uvicorn.protocols.websockets import websockets_impl
        from websockets.extensions.permessage_deflate import ServerPerMessageDeflateFactory

        current = getattr(websockets_impl, "ServerPerMessageDeflateFactory", None)
        if current is None:
            return False                    # 没有这个名字：无从替换 / nothing to replace
        if isinstance(current, functools.partial):
            return True                     # 已替换过 / already done
        websockets_impl.ServerPerMessageDeflateFactory = functools.partial(
            ServerPerMessageDeflateFactory,
            server_max_window_bits=WS_DEFLATE_WINDOW_BITS,
            client_max_window_bits=WS_DEFLATE_WINDOW_BITS,
            compress_settings={"memLevel": WS_DEFLATE_MEM_LEVEL},
        )
        return True
    except Exception as e:  # noqa: BLE001 —— 版本对不上就保持默认 / keep defaults on a version mismatch
        logger.warning("permessage-deflate 窗口未调小，保持默认 / could not shrink the deflate window: %s", e)
        return False


_shrink_ws_deflate_window()


def _raise_nofile_limit() -> None:
    """把 RLIMIT_NOFILE 软上限抬到硬上限（最多 65536）。

    systemd 默认软上限 1024（Ubuntu 24.04 的 DefaultLimitNOFILE=1024:524288），uvicorn 不会自己
    抬；每条 WS 占 1 个 fd，再加 DB / Redis / httpx / nginx keepalive，单 worker 约 900 条
    WebSocket 就 `Too many open files`——accept 失败、nginx 无声 502。软上限抬到硬上限以内不需要
    root；lifespan 在每个 worker 进程里各执行一次。Windows 没有 resource 模块，直接跳过。
    硬上限本身若也是 1024，得在 systemd drop-in 里设 LimitNOFILE=65536（这里只记日志）。

    Raise the soft RLIMIT_NOFILE to the hard limit (capped at 65536). systemd's default soft
    limit is 1024 and uvicorn never raises it; each WebSocket holds an fd, so ~900 sockets per
    worker hit "Too many open files" and nginx answers a silent 502. Raising soft up to hard
    needs no root; the lifespan runs once per worker. Skipped where `resource` is missing
    (Windows). If the hard limit itself is 1024, set LimitNOFILE=65536 in the systemd drop-in.
    """
    try:
        import resource
    except ImportError:
        return
    try:
        soft, hard = resource.getrlimit(resource.RLIMIT_NOFILE)
        want = 65536 if hard == resource.RLIM_INFINITY else min(hard, 65536)
        if soft == resource.RLIM_INFINITY or soft >= want:
            logger.info("RLIMIT_NOFILE soft=%s hard=%s（无需调整）", soft, hard)
            return
        resource.setrlimit(resource.RLIMIT_NOFILE, (want, hard))
        soft, hard = resource.getrlimit(resource.RLIMIT_NOFILE)
        logger.info("RLIMIT_NOFILE 已抬高 / raised: soft=%s hard=%s", soft, hard)
    except (ValueError, OSError) as e:
        logger.warning("抬高 RLIMIT_NOFILE 失败 / could not raise RLIMIT_NOFILE: %s", e)


# 同步端点线程池的大小，见 lifespan 里的说明 / sync-endpoint pool size, see lifespan
SYNC_THREAD_LIMIT = 256


@asynccontextmanager
async def lifespan(app: FastAPI):
    # 启动：建表 + 信号引擎 + 离线检测 + 超时订单清理
    # startup: tables + signal engine + offline monitor + stale-order sweep
    #
    # 这里的后台任务都不能在首个 await 之前跑同步阻塞代码:create_task 之间没有
    # await,任务要等 yield 才被调度,谁在那时同步阻塞就会把 uvicorn 的 bind 端口
    # 一起拖住,nginx 在整个窗口内只能回 502。曾经 candle_retention_sweep_loop 的
    # 首轮清扫就这样卡了 83.7 秒,startup 全程 85.6 秒。新增循环任务时同样注意。
    # None of the background tasks below may run synchronous blocking code before
    # their first await: there is no await between the create_task calls, so tasks
    # are only scheduled at the yield, and whatever blocks then also holds up
    # uvicorn's port bind — leaving nginx to serve 502s for the whole window. The
    # first candle_retention_sweep_loop pass once stalled it 83.7s, making startup
    # take 85.6s. Keep this in mind when adding loops.
    _raise_nofile_limit()
    init_db()

    # 进程内状态的部署前提，在日志里说一次。config.py 已经在「明确读出多 worker
    # + 进程内计数」时拒绝启动，这里补的是读不出 worker 数的那一半情况：容器、
    # supervisor、反代托管都可能在命令行之外拉起多个进程，判不出来时不能拦，但
    # 也不该一声不吭——真出事时，这一行是唯一能让人想起「限流是按进程算的」的线索。
    # State the deployment premise of the in-process counters once, in the log.
    # config.py already refuses to start when "multiple workers + in-process
    # counters" can be read off positively; this covers the other half, where the
    # worker count can't be determined — containers, supervisors and process
    # managers can all fan out beyond the command line. An unreadable count must
    # not block startup, but it shouldn't pass in silence either: when something
    # does go wrong, this line is the only thing that will remind anyone that the
    # limits are counted per process.
    if not settings.REDIS_URL.strip():
        logger.warning(
            "REDIS_URL 为空：限流/登录锁定/回测闸门/后台循环/WS 推送/EA 行情全在进程内，"
            "本部署必须是单 worker；多进程会让这些各算各的（检测到的 worker 数: %s）"
            " / REDIS_URL is empty: rate limits, lockouts, the backtest gate, background loops,"
            " WS pushes and the EA market stores are per-process; this deployment must run a"
            " single worker (detected worker count: %s)",
            _WORKER_COUNT if _WORKER_COUNT is not None else "未知/unknown",
            _WORKER_COUNT if _WORKER_COUNT is not None else "未知/unknown",
        )

    # 捕获主事件循环，供 gateway_client 的 run_on_main_loop 使用。
    # 必须在任何可能调用 gateway 客户端的代码之前设置。
    # Capture the main event loop for gateway_client's run_on_main_loop.
    # Must be set before any code that might call the gateway client.
    from app.services.gateway_client import init_client, set_main_loop, close_client
    set_main_loop(asyncio.get_running_loop())
    init_client()

    # 同步端点（下单/平仓/改单都是 def）跑在 anyio 的线程池里，默认只有 40 条。
    # 一笔网关交易会占住一条线程直到 dealer 回执（最长 65 秒），于是 40 笔同时在途
    # 就把**所有**同步接口一起排队——包括跟交易无关的页面。线程大部分时间在睡，
    # 放到 256 条只多一点内存。
    # Sync endpoints (every order route is a def) run on anyio's pool of 40. A gateway
    # trade holds one thread until the dealer answers (up to 65s), so 40 in flight
    # queued every sync route in the app. The threads mostly sleep; 256 costs little.
    import anyio.to_thread
    anyio.to_thread.current_default_thread_limiter().total_tokens = SYNC_THREAD_LIMIT
    from app.services import bridge_wake
    bridge_wake.bind_loop(asyncio.get_running_loop())
    
    # 后台循环统一交给 BackgroundLoops：单 worker 直接全部起（与从前一样）；配了
    # REDIS_URL 时每个 worker 只起一个监督协程去抢领导锁，抢到的那个跑全部循环
    # （见 services/background.py）。各条循环的用途见各自模块的 docstring。
    # Background loops go through BackgroundLoops: started directly on a single
    # worker (as before); with REDIS_URL each worker runs one supervisor and only
    # the lock holder runs the loops (see services/background.py).
    # 把后台循环里打出的 ERROR 日志记成该循环的「最近报错」，给管理后台系统状态页看
    # （services/loop_health.py）。/ Record loop ERROR logs for the admin status page.
    loop_health.install_error_handler()
    loops = BackgroundLoops({
        # 模拟信号引擎（本地开发用）/ mock signal engine (local development only)
        **({"signal_engine": signal_loop} if settings.ENABLE_MOCK_SIGNAL_ENGINE else {}),
        "offline_monitor": offline_monitor_loop,
        "stale_orders": stale_order_monitor_loop,
        # 信号过期广播：独立于模拟引擎，webhook 信号也依赖它 / expiry broadcast
        "signal_expiry": signal_expiry_loop,
        # 信号胜负判定的保险丝：清扫长期无行情更新的 PENDING 信号 / stale-signal safety net
        "stale_signals": stale_signal_sweep_loop,
        # 策略信号的 STALE 兜底（与平台信号的清扫各自独立）/ strategy-signal STALE safety net
        "stale_strategy_signals": stale_strategy_signal_sweep_loop,
        # 社区情绪定时抓取 / community sentiment fetch
        "sentiment": sentiment_loop,
        # 会员到期自动降级 / membership expiry downgrade
        "plan_expiry": plan_expiry_sweep_loop,
        # 管理后台群发邮件：逐封发送、限速、每日上限 / admin email broadcasts
        "email_broadcast": email_broadcast_loop,
        # 游戏化每小时循环（startup_delay 25s，与 K 线 30s 错开）/ gamification hourly pass
        "gamification": gamification_loop,
        # 比赛榜快循环（60 秒）/ fast competition-board loop
        "competitions": competition_loop,
        # 周期榜循环（5 分钟，startup_delay 40s）/ period-board loop
        "boards": board_loop,
        # K 线历史保留策略 / candle retention sweep
        "candle_retention": candle_retention_sweep_loop,
        # Gateway 账号持仓轮询 / gateway position polling
        "gateway_positions": gateway_positions_loop,
    })
    loops.launch()
    app.state.background_loops = loops
    # 多 worker 时每个进程都要跑的 WS 转发订阅与在线名单续期（单 worker 为空）。
    # Per-worker WS fan-out subscriber and presence refresh (empty on a single worker).
    cross_worker_tasks = manager.start_cross_worker_tasks() + bridge_wake.start_tasks()
    # 网关探活：每个 worker 一条，不选主——每个 worker 的请求线程都要读在线状态，
    # 各自要有新鲜的缓存（见 gateway_client.gateway_health_monitor_loop）。
    # Gateway liveness probe: one per worker, not leader-elected, since every
    # worker's request threads read the liveness cache.
    from app.services.gateway_client import gateway_health_monitor_loop
    cross_worker_tasks.append(
        asyncio.create_task(gateway_health_monitor_loop(), name="gateway-health")
    )
    # 页面埋点：每个 worker 各起一个 30 秒批量落库任务（不进只在领导 worker 跑的 BackgroundLoops）。
    # Pageview telemetry: a per-worker 30s batch flusher (not in the leader-only BackgroundLoops).
    pv_task = telemetry.start_pageview_flusher()
    yield
    await telemetry.stop_pageview_flusher(pv_task)
    # 关闭：停止后台任务（多 worker 时顺带释放领导锁），并等各循环的 finally 跑完——
    # 这里一返回 uvicorn 就重新 raise SIGTERM 结束进程，没跑完的收尾（比如网关事件泵
    # 交还消费权）会直接丢掉（见 BackgroundLoops.aclose）。
    # Shutdown: stop the loops and wait for their finally blocks; uvicorn kills
    # the process as soon as this returns (see BackgroundLoops.aclose).
    await loops.aclose()
    for t in cross_worker_tasks:
        t.cancel()
    
    # 关闭 gateway 客户端连接池
    await close_client()


app = FastAPI(title=settings.APP_NAME, lifespan=lifespan)

# 限流：注册 limiter、超限处理器与中间件 / rate limiting: limiter, handler, middleware
app.state.limiter = limiter
# 策略端点用按用户维度的第二个限流器；slowapi 的中间件读 app.state.limiter，
# 因此用户维度的这个通过端点装饰器直接生效，只需把超限异常处理器共用。
# The strategy endpoints use a second, user-keyed limiter. slowapi's middleware
# reads app.state.limiter, so the user-keyed one takes effect through its
# endpoint decorators; only the rate-limit exception handler is shared.
app.state.user_limiter = user_limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)


@app.exception_handler(SQLAlchemyPoolTimeoutError)
async def _db_pool_timeout_handler(request: Request, exc: SQLAlchemyPoolTimeoutError) -> JSONResponse:
    """连接池取不到连接（pool_timeout 到期）：回 503 + Retry-After，而不是一片 500。
    过载时让客户端「稍后再试」比抛 500 更准确，前端也能据此退避而不是当成业务错误。
    The pool ran out of connections within pool_timeout: answer 503 + Retry-After
    instead of a blanket 500, so clients back off rather than treating it as a bug."""
    logger.warning("DB 连接池等待超时 / DB pool timeout on %s %s: %s", request.method, request.url.path, exc)
    return JSONResponse(
        status_code=503,
        content={"detail": "服务繁忙，请稍后重试 / Service busy, please retry shortly"},
        headers={"Retry-After": "2"},
    )
# 响应压缩：≥1 KB 的 JSON 才压（信号列表、榜单、订单页这些几十 KB 的负载压完只剩
# 零头；更小的压了反而多花 CPU）。线上 nginx 没有对 API 开 gzip，这是应用层的兜底。
# compresslevel 取 5：JSON 在 5 以上压缩率几乎不再提高，CPU 却成倍上涨（Starlette
# 默认 9）。
# 对其它通道无影响：Starlette 的 GZipMiddleware 只处理 scope["type"] == "http"，
# WebSocket 原样放过；text/event-stream 默认不压（本项目也没有 SSE /
# StreamingResponse 端点）；已带 Content-Encoding 的响应原样透传。
# 位置：最里层。曾经这里还有个 SlowAPIMiddleware（BaseHTTPMiddleware，把响应改成分块
# 流式转发），GZip 必须排在它前面才不会把每个响应都当「流式」处理；那个中间件已删除
# （限流全靠端点装饰器 @limiter.limit 完成，限流器没有 default_limits，中间件什么都不做），
# 但 GZip 仍保持最内层：直接面对路由返回的完整响应体。CORS 在更外层：预检由它直接
# 应答（远小于 1 KB，不压），普通响应先压缩、再补跨域头，Vary 头两边各自追加、互不覆盖。
# Response compression for JSON of 1 KB and up (production nginx doesn't gzip
# the API; this is the application-level fallback). compresslevel 5: past that
# JSON barely shrinks while CPU climbs (Starlette defaults to 9). WebSockets are
# untouched (only "http" scopes are handled), text/event-stream is excluded by
# default (and there are no SSE/streaming endpoints), and responses already
# carrying Content-Encoding pass through. Innermost, so GZip sees the route's whole
# body. (A SlowAPIMiddleware used to sit outside it — a BaseHTTPMiddleware that
# re-streams every response, which is why GZip had to be inside it. It was removed:
# limits are enforced entirely by the @limiter.limit endpoint decorators and the
# limiters have no default_limits, so the middleware did nothing but add a task group
# and a memory stream per request.) CORS sits further out: it answers preflights
# itself (tiny, never compressed) and adds its headers after compression; each
# appends its own Vary.
app.add_middleware(GZipMiddleware, minimum_size=1024, compresslevel=5)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_origin_regex=settings.CORS_ORIGIN_REGEX,
    # 全站鉴权只有 Bearer 头，一个 cookie 都不用（连 WebSocket 也是先 HTTP 升级再
    # 在首帧传 token），所以 allow_credentials 对我们没有任何收益，只是白留一条
    # 「浏览器愿意带上凭证跨域」的通道。白名单里还有 https://localhost（安卓 App 的
    # WebView origin）——本机任何一个 HTTPS 开发服务都能冒充它，一旦将来引入 cookie
    # 会话，那就是一个带凭证的跨域入口。关掉是在它还没有代价的时候关掉。
    # The whole app authenticates with a Bearer header and no cookies at all (even
    # the WebSocket upgrades over HTTP and sends its token in the first frame), so
    # allow_credentials buys us nothing and only leaves open a "browsers may attach
    # credentials cross-origin" channel. The allowlist also contains
    # https://localhost (the Android WebView's origin), which any local HTTPS dev
    # server can impersonate — the day a cookie session appears, that becomes a
    # credentialed cross-origin entry point. Turned off now, while it costs nothing.
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
    # 暴露滑动续期头，跨域下前端 JS 才能读取 / expose the sliding-renewal
    # header so cross-origin frontend JS can read it
    expose_headers=["X-Refreshed-Token"],
    # 预检结果让浏览器缓存一天：前端每个带 Authorization 头的跨域请求都会先发一次
    # OPTIONS，不缓存（默认 600 秒）就是隔十分钟每个接口多一个往返。浏览器自己还会
    # 封顶（Chromium 2 小时、Firefox 24 小时），这里给上限值即可。
    # Let browsers cache preflights for a day: every cross-origin request with an
    # Authorization header is preceded by an OPTIONS, which by default (600s) is
    # re-sent every ten minutes per endpoint. Browsers cap it themselves
    # (Chromium 2h, Firefox 24h), so the maximum is fine here.
    max_age=86400,
)

# 反代真实 IP 还原：挂在同机 Nginx 后面时，把 X-Forwarded-For 里的真实客户端
# IP 还原到 request.client.host，让 slowapi 的按 IP 限流与按邮箱登录锁定按真
# 实客户端计数，而不是全部落在 Nginx 的本机 IP 上（否则等于没有限流）。只信
# 任 TRUSTED_PROXY_IPS 里的对端，直连或伪造 XFF 无法借此绕过。必须最后添加
# ——Starlette 里后添加的中间件在最外层、最先执行，才能在端点装饰器限流读取
# request.client 之前把它改写好。留空则不启用（如本地开发直连）。
# Restore the real client IP behind the same-host Nginx: rewrite
# request.client.host from X-Forwarded-For so slowapi's per-IP rate limits and
# per-email login lockout count per real client instead of collapsing onto
# Nginx's loopback IP. Only peers in TRUSTED_PROXY_IPS are trusted, so a direct
# connection or a forged XFF can't abuse it. Added last on purpose — in
# Starlette the most-recently-added middleware is outermost and runs first, so
# it rewrites `client` before the endpoint decorators' limiter reads it. Empty disables it (e.g.
# local dev with a direct connection).
if settings.TRUSTED_PROXY_IPS.strip():
    app.add_middleware(ProxyHeadersMiddleware, trusted_hosts=settings.TRUSTED_PROXY_IPS)

# REST 路由 / REST routers
app.include_router(auth.router, prefix=settings.API_PREFIX)
app.include_router(signals.router, prefix=settings.API_PREFIX)
app.include_router(trends.router, prefix=settings.API_PREFIX)
app.include_router(bootstrap.router, prefix=settings.API_PREFIX)
app.include_router(orders.router, prefix=settings.API_PREFIX)
app.include_router(ea.router, prefix=settings.API_PREFIX)
app.include_router(bridge.router, prefix=settings.API_PREFIX)
app.include_router(gateway.router, prefix=settings.API_PREFIX)
app.include_router(chart.router, prefix=settings.API_PREFIX)
app.include_router(webhook.router, prefix=settings.API_PREFIX)
app.include_router(account.router, prefix=settings.API_PREFIX)
app.include_router(notifications.router, prefix=settings.API_PREFIX)
app.include_router(admin.router, prefix=settings.API_PREFIX)
app.include_router(automation.router, prefix=settings.API_PREFIX)
app.include_router(sentiment.router, prefix=settings.API_PREFIX)
app.include_router(site.router, prefix=settings.API_PREFIX)
app.include_router(payments.router, prefix=settings.API_PREFIX)
app.include_router(strategies.router, prefix=settings.API_PREFIX)
app.include_router(telemetry.router, prefix=settings.API_PREFIX)
app.include_router(tickets.router, prefix=settings.API_PREFIX)
app.include_router(share.router, prefix=settings.API_PREFIX)
app.include_router(tickets.admin_router, prefix=settings.API_PREFIX, dependencies=[Depends(require_admin)])
app.include_router(invite.router, prefix=settings.API_PREFIX)
app.include_router(invite.admin_router, prefix=settings.API_PREFIX, dependencies=[Depends(require_admin)])
# 代理端点要求**登录**（不是管理员）：「是不是代理」由 invite_link_agents 里有没有
# 这个人的行决定，每个端点再按 link 归属校验，见 invite.agent_router 的说明。
# 挂载级依赖与 admin_router 同一个理由：端点上各自写一次 Depends(get_current_user)
# 是给读代码的人看的，这一行才是兜底——将来有人加一个忘了写依赖的 /agent/* 端点，
# 不会因为这一处疏漏就变成任何人（含未登录）都能拉代理看板与客户名单。
# FastAPI 对同一依赖在单次请求内只求值一次，重复声明不会多打一次库。
# The agent endpoints require a *logged-in user*, not an admin: agent-ness is a
# row in invite_link_agents, and each endpoint re-checks link ownership (see
# invite.agent_router). The mount-level dependency exists for the same reason as
# on the admin routers — the per-endpoint Depends is what a reader sees, this
# line is the backstop, so a future /agent/* endpoint that forgets its dependency
# cannot ship as an open door onto agents' dashboards and customer lists.
# FastAPI evaluates an identical dependency once per request, so it costs nothing.
app.include_router(
    invite.agent_router,
    prefix=settings.API_PREFIX,
    dependencies=[Depends(get_current_user)],
)
app.include_router(gamification.router, prefix=settings.API_PREFIX)
app.include_router(gamification.admin_router, prefix=settings.API_PREFIX, dependencies=[Depends(require_admin)])
app.include_router(competitions.router, prefix=settings.API_PREFIX)
app.include_router(competitions.admin_router, prefix=settings.API_PREFIX, dependencies=[Depends(require_admin)])
app.include_router(announcements.router, prefix=settings.API_PREFIX)
app.include_router(announcements.admin_router, prefix=settings.API_PREFIX, dependencies=[Depends(require_admin)])
app.include_router(emails.router, prefix=settings.API_PREFIX)
app.include_router(emails.admin_router, prefix=settings.API_PREFIX, dependencies=[Depends(require_admin)])
# WebSocket 路由 / WebSocket routers
app.include_router(ws.router)


@app.get("/")
def root():
    return {"app": settings.APP_NAME, "status": "ok"}
