"""PRISMX Signal Lab 后端入口 / Backend entrypoint."""
import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware
from uvicorn.middleware.proxy_headers import ProxyHeadersMiddleware

from app.core.config import settings, _WORKER_COUNT
from app.core.database import init_db
from app.core.rate_limit import limiter
from app.core.strategy_limits import user_limiter
from app.services.deps import require_admin
from app.engine.signal_engine import signal_expiry_loop, signal_loop
from app.routers import account, admin, auth, automation, bridge, chart, competitions, ea, gamification, gateway, invite, notifications, orders, payments, sentiment, signals, strategies, telemetry, tickets, trends, webhook, ws
from app.routers.bridge import offline_monitor_loop
from app.routers.gateway import gateway_positions_loop
from app.routers.orders import stale_order_monitor_loop
from app.services.candle_store import candle_retention_sweep_loop
from app.services.discipline import discipline_snapshot_loop
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
        # 纪律分每日快照 / discipline daily snapshot
        "discipline_snapshot": discipline_snapshot_loop,
        # 游戏化每小时循环（startup_delay 25s，与纪律 20s / K 线 30s 错开）/ gamification hourly pass
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
    cross_worker_tasks = manager.start_cross_worker_tasks()
    yield
    # 关闭：停止后台任务（多 worker 时顺带释放领导锁）/ shutdown: stop background tasks
    loops.shutdown()
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
app.add_middleware(SlowAPIMiddleware)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_origin_regex=settings.CORS_ORIGIN_REGEX,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    # 暴露滑动续期头，跨域下前端 JS 才能读取 / expose the sliding-renewal
    # header so cross-origin frontend JS can read it
    expose_headers=["X-Refreshed-Token"],
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
app.include_router(payments.router, prefix=settings.API_PREFIX)
app.include_router(strategies.router, prefix=settings.API_PREFIX)
app.include_router(telemetry.router, prefix=settings.API_PREFIX)
app.include_router(tickets.router, prefix=settings.API_PREFIX)
app.include_router(tickets.admin_router, prefix=settings.API_PREFIX, dependencies=[Depends(require_admin)])
app.include_router(invite.router, prefix=settings.API_PREFIX)
app.include_router(invite.admin_router, prefix=settings.API_PREFIX, dependencies=[Depends(require_admin)])
app.include_router(gamification.router, prefix=settings.API_PREFIX)
app.include_router(gamification.admin_router, prefix=settings.API_PREFIX, dependencies=[Depends(require_admin)])
app.include_router(competitions.router, prefix=settings.API_PREFIX)
app.include_router(competitions.admin_router, prefix=settings.API_PREFIX, dependencies=[Depends(require_admin)])
# WebSocket 路由 / WebSocket routers
app.include_router(ws.router)


@app.get("/")
def root():
    return {"app": settings.APP_NAME, "status": "ok"}
