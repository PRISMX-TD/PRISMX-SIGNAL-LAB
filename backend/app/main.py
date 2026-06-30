"""PRISMX Signal Lab 后端入口 / Backend entrypoint."""
import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware

from app.core.config import settings
from app.core.database import init_db
from app.core.rate_limit import limiter
from app.engine.signal_engine import signal_loop
from app.routers import account, auth, bridge, ea, ea_poll, notifications, orders, signals, webhook, ws
from app.routers.bridge import offline_monitor_loop


@asynccontextmanager
async def lifespan(app: FastAPI):
    # 启动：建表 + 启动信号引擎 + 离线检测 / startup: tables + engine + offline monitor
    init_db()
    task = (
        asyncio.create_task(signal_loop())
        if settings.ENABLE_MOCK_SIGNAL_ENGINE
        else None
    )
    monitor = asyncio.create_task(offline_monitor_loop())
    yield
    # 关闭：停止后台任务 / shutdown: stop background tasks
    if task is not None:
        task.cancel()
    monitor.cancel()


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
)

# REST 路由 / REST routers
app.include_router(auth.router, prefix=settings.API_PREFIX)
app.include_router(signals.router, prefix=settings.API_PREFIX)
app.include_router(orders.router, prefix=settings.API_PREFIX)
app.include_router(ea.router, prefix=settings.API_PREFIX)
app.include_router(ea_poll.router, prefix=settings.API_PREFIX)
app.include_router(bridge.router, prefix=settings.API_PREFIX)
app.include_router(webhook.router, prefix=settings.API_PREFIX)
app.include_router(account.router, prefix=settings.API_PREFIX)
app.include_router(notifications.router, prefix=settings.API_PREFIX)
# WebSocket 路由 / WebSocket routers
app.include_router(ws.router)


@app.get("/")
def root():
    return {"app": settings.APP_NAME, "status": "ok"}
