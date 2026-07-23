"""PRISMX Signal Lab 后端入口 / Backend entrypoint."""
import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware
from uvicorn.middleware.proxy_headers import ProxyHeadersMiddleware

from app.core.config import settings
from app.core.database import init_db
from app.core.rate_limit import limiter
from app.engine.signal_engine import signal_expiry_loop, signal_loop
from app.routers import account, admin, auth, automation, bridge, chart, ea, notifications, orders, payments, sentiment, signals, strategies, trends, webhook, ws
from app.routers.bridge import offline_monitor_loop
from app.routers.orders import stale_order_monitor_loop
from app.services.candle_store import candle_retention_sweep_loop
from app.services.discipline import discipline_snapshot_loop
from app.services.plan_expiry import plan_expiry_sweep_loop
from app.services.sentiment_store import sentiment_loop
from app.services.signal_resolution import stale_signal_sweep_loop


@asynccontextmanager
async def lifespan(app: FastAPI):
    # 启动：建表 + 信号引擎 + 离线检测 + 超时订单清理
    # startup: tables + signal engine + offline monitor + stale-order sweep
    init_db()
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
    # K 线历史保留策略：每天清理过期的 1 分钟线（见 services/candle_store.py）
    # Candle retention sweep: trims expired 1-minute candles daily
    candle_retention_task = asyncio.create_task(candle_retention_sweep_loop())
    yield
    # 关闭：停止后台任务 / shutdown: stop background tasks
    if task is not None:
        task.cancel()
    monitor.cancel()
    stale_sweep.cancel()
    expiry_sweep.cancel()
    stale_signal_sweep.cancel()
    sentiment_task.cancel()
    plan_expiry_task.cancel()
    discipline_task.cancel()
    candle_retention_task.cancel()


app = FastAPI(title=settings.APP_NAME, lifespan=lifespan)

# 限流：注册 limiter、超限处理器与中间件 / rate limiting: limiter, handler, middleware
app.state.limiter = limiter
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
app.include_router(chart.router, prefix=settings.API_PREFIX)
app.include_router(webhook.router, prefix=settings.API_PREFIX)
app.include_router(account.router, prefix=settings.API_PREFIX)
app.include_router(notifications.router, prefix=settings.API_PREFIX)
app.include_router(admin.router, prefix=settings.API_PREFIX)
app.include_router(automation.router, prefix=settings.API_PREFIX)
app.include_router(sentiment.router, prefix=settings.API_PREFIX)
app.include_router(payments.router, prefix=settings.API_PREFIX)
app.include_router(strategies.router, prefix=settings.API_PREFIX)
# WebSocket 路由 / WebSocket routers
app.include_router(ws.router)


@app.get("/")
def root():
    return {"app": settings.APP_NAME, "status": "ok"}
