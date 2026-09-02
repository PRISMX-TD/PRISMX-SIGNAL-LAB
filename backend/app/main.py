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
from app.routers import account, admin, auth, automation, bridge, chart, ea, gamification, gateway, invite, notifications, orders, payments, sentiment, signals, strategies, telemetry, tickets, trends, webhook, ws
from app.routers.bridge import offline_monitor_loop
from app.routers.gateway import gateway_positions_loop
from app.routers.orders import stale_order_monitor_loop
from app.services.candle_store import candle_retention_sweep_loop
from app.services.discipline import discipline_snapshot_loop
from app.services.gamification.loop import gamification_loop
from app.services.plan_expiry import plan_expiry_sweep_loop
from app.services.sentiment_store import sentiment_loop
from app.services.signal_resolution import stale_signal_sweep_loop
from app.services.strategy.resolution import stale_strategy_signal_sweep_loop


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
    if not settings.RATE_LIMIT_STORAGE_URI.strip():
        logger.warning(
            "限流/登录锁定/回测闸门为进程内计数，本部署必须是单 worker；"
            "多进程会让这些防护各算各的（检测到的 worker 数: %s）"
            " / rate limits, login lockout and the backtest gate are per-process counters;"
            " this deployment must run a single worker (detected worker count: %s)",
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
    
    task = (
        asyncio.create_task(signal_loop())
        if settings.ENABLE_MOCK_SIGNAL_ENGINE
        else None
    )
    monitor = asyncio.create_task(offline_monitor_loop())
    stale_sweep = asyncio.create_task(stale_order_monitor_loop())
    # 信号过期广播：独立于模拟引擎，webhook 信号也依赖它 / expiry broadcast,
    # independent of the mock engine; webhook signals rely on it too
    expiry_sweep = asyncio.create_task(signal_expiry_loop())
    # 信号胜负判定的保险丝：清扫长期无行情更新的 PENDING 信号 / win-rate safety
    # net: sweep PENDING signals stuck without any price update
    stale_signal_sweep = asyncio.create_task(stale_signal_sweep_loop())
    # 策略信号的 STALE 兜底：数据源中断会让策略信号永久 PENDING，进而使「一次
    # 一单」策略永久卡死不再触发。与平台信号的清扫各自独立，因为两张表的
    # PENDING 集合与判定驱动源不同。
    # STALE safety net for strategy signals: a feed outage would leave them
    # PENDING forever, which in turn permanently jams any one-trade-at-a-time
    # strategy. Kept separate from the platform sweep since the two tables have
    # different PENDING sets and different resolution triggers.
    stale_strategy_sweep = asyncio.create_task(stale_strategy_signal_sweep_loop())
    # 社区情绪定时抓取（FXSSI 公开聚合数据，见 services/sentiment_store.py）
    # Community sentiment periodic fetch (FXSSI's public aggregate data, see
    # services/sentiment_store.py)
    sentiment_task = asyncio.create_task(sentiment_loop())
    # 会员到期自动降级：把到期的付费用户落库改回 FREE（读取时即时降级的兜底，
    # 覆盖只被 WS 广播/推送按 DB plan 命中的在线用户，见 services/plan_expiry.py）
    # Auto-downgrade expired memberships to FREE in the DB (a safety net behind
    # the read-time downgrade, covering online users only hit via the DB plan by
    # WS broadcast/push; see services/plan_expiry.py)
    plan_expiry_task = asyncio.create_task(plan_expiry_sweep_loop())
    # 纪律分每日快照：给近期有信号单成交的用户落库当日纪律分，驱动前端 30 天
    # 趋势线（见 services/discipline.py）。
    # Discipline-score daily snapshot: persists today's score for recently
    # active users, powering the frontend's 30-day trend line.
    discipline_task = asyncio.create_task(discipline_snapshot_loop())
    # 游戏化每小时循环：账号/订单 trade_mode 补章 + 全量条件与勋章判定
    # （见 services/gamification/loop.py）。startup_delay 25s，与上面 discipline
    # 的 20s、下面 candle 的 30s 错开，避免首轮同时抢占启动窗口。
    # Gamification hourly loop: trade_mode backfill for accounts/orders plus a
    # full pass of condition and badge judging (see services/gamification/loop.py).
    # startup_delay is 25s, offset from discipline's 20s and candle's 30s below so
    # their first passes don't all compete for the startup window at once.
    gamification_task = asyncio.create_task(gamification_loop())
    # K 线历史保留策略：每天清理过期的 1 分钟线（见 services/candle_store.py）
    # Candle retention sweep: trims expired 1-minute candles daily
    candle_retention_task = asyncio.create_task(candle_retention_sweep_loop())
    # Gateway 账号持仓轮询：gateway 账号没有桥接上报，持仓列表/图表标记/自动仓管
    # 这条链路要靠后端主动拉（见 routers/gateway.py）。
    # Gateway position polling: gateway accounts have no bridge report, so the
    # backend pulls positions to feed the same UI/auto-manage path.
    gateway_positions_task = asyncio.create_task(gateway_positions_loop())
    yield
    # 关闭：停止后台任务 / shutdown: stop background tasks
    if task is not None:
        task.cancel()
    monitor.cancel()
    stale_sweep.cancel()
    expiry_sweep.cancel()
    stale_signal_sweep.cancel()
    stale_strategy_sweep.cancel()
    sentiment_task.cancel()
    plan_expiry_task.cancel()
    discipline_task.cancel()
    gamification_task.cancel()
    candle_retention_task.cancel()
    gateway_positions_task.cancel()
    
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
# WebSocket 路由 / WebSocket routers
app.include_router(ws.router)


@app.get("/")
def root():
    return {"app": settings.APP_NAME, "status": "ok"}
