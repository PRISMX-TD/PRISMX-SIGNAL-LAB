"""PRISMX Signal Lab 后端入口 / Backend entrypoint."""
import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware
from uvicorn.middleware.proxy_headers import ProxyHeadersMiddleware

from app.core.config import settings, _WORKER_COUNT
from app.core.database import init_db
from app.core.rate_limit import limiter
from app.core.strategy_limits import user_limiter
from app.services.deps import get_current_user, require_admin
from app.engine.signal_engine import signal_expiry_loop, signal_loop
from app.routers import account, admin, announcements, auth, automation, bridge, chart, competitions, ea, gamification, gateway, invite, notifications, orders, payments, sentiment, signals, site, strategies, telemetry, tickets, trends, webhook, ws
from app.routers.bridge import offline_monitor_loop
from app.routers.gateway import gateway_positions_loop
from app.routers.orders import stale_order_monitor_loop
from app.services.candle_store import candle_retention_sweep_loop
from app.services.gamification.loop import competition_loop, gamification_loop
from app.services.plan_expiry import plan_expiry_sweep_loop
from app.services.sentiment_store import sentiment_loop
from app.services.signal_resolution import stale_signal_sweep_loop
from app.services.strategy.resolution import stale_strategy_signal_sweep_loop
from app.services.background import BackgroundLoops
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
        # 游戏化每小时循环（startup_delay 25s，与 K 线 30s 错开）/ gamification hourly pass
        "gamification": gamification_loop,
        # 比赛榜快循环（60 秒）/ fast competition-board loop
        "competitions": competition_loop,
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
    yield
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
# 响应压缩：≥1 KB 的 JSON 才压（信号列表、榜单、订单页这些几十 KB 的负载压完只剩
# 零头；更小的压了反而多花 CPU）。线上 nginx 没有对 API 开 gzip，这是应用层的兜底。
# compresslevel 取 5：JSON 在 5 以上压缩率几乎不再提高，CPU 却成倍上涨（Starlette
# 默认 9）。
# 对其它通道无影响：Starlette 的 GZipMiddleware 只处理 scope["type"] == "http"，
# WebSocket 原样放过；text/event-stream 默认不压（本项目也没有 SSE /
# StreamingResponse 端点）；已带 Content-Encoding 的响应原样透传。
# 位置：必须是**最里层**（先于 SlowAPIMiddleware 添加）。SlowAPIMiddleware 是
# BaseHTTPMiddleware，它把下游响应改成分块流式转发（首块 more_body=True）；GZip 若
# 包在它外面，看到的每个响应都是「流式」，minimum_size 形同虚设——41 字节的
# {"status":"ok"} 也会被压缩、还丢掉 Content-Length（测试里实测如此）。放在最里层，
# GZip 直接面对路由返回的完整响应体。CORS 在更外层：预检由它直接应答（远小于
# 1 KB，不压），普通响应先压缩、再补跨域头，Vary 头两边各自追加、互不覆盖。
# Response compression for JSON of 1 KB and up (production nginx doesn't gzip
# the API; this is the application-level fallback). compresslevel 5: past that
# JSON barely shrinks while CPU climbs (Starlette defaults to 9). WebSockets are
# untouched (only "http" scopes are handled), text/event-stream is excluded by
# default (and there are no SSE/streaming endpoints), and responses already
# carrying Content-Encoding pass through. It must be the *innermost* middleware
# (added before SlowAPIMiddleware): that one is a BaseHTTPMiddleware which
# re-streams every response in chunks, so a GZip wrapped around it sees every
# response as streaming and ignores minimum_size — even a 41-byte body got
# compressed and lost its Content-Length. Innermost, GZip sees the route's
# whole body. CORS sits further out: it answers preflights itself (tiny, never
# compressed) and adds its headers after compression; each appends its own Vary.
app.add_middleware(GZipMiddleware, minimum_size=1024, compresslevel=5)
app.add_middleware(SlowAPIMiddleware)

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
# ——Starlette 里后添加的中间件在最外层、最先执行，才能在 SlowAPIMiddleware
# 之前把 client 改写好。留空则不启用（如本地开发直连）。
# Restore the real client IP behind the same-host Nginx: rewrite
# request.client.host from X-Forwarded-For so slowapi's per-IP rate limits and
# per-email login lockout count per real client instead of collapsing onto
# Nginx's loopback IP. Only peers in TRUSTED_PROXY_IPS are trusted, so a direct
# connection or a forged XFF can't abuse it. Added last on purpose — in
# Starlette the most-recently-added middleware is outermost and runs first, so
# it rewrites `client` before SlowAPIMiddleware sees it. Empty disables it (e.g.
# local dev with a direct connection).
if settings.TRUSTED_PROXY_IPS.strip():
    app.add_middleware(ProxyHeadersMiddleware, trusted_hosts=settings.TRUSTED_PROXY_IPS)

# REST 路由 / REST routers
app.include_router(auth.router, prefix=settings.API_PREFIX)
app.include_router(signals.router, prefix=settings.API_PREFIX)
app.include_router(trends.router, prefix=settings.API_PREFIX)
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
# WebSocket 路由 / WebSocket routers
app.include_router(ws.router)


@app.get("/")
def root():
    return {"app": settings.APP_NAME, "status": "ok"}
