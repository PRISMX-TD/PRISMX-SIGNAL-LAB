"""GET /api/bootstrap：Dashboard 首屏基础数据合并成一个请求（只读）。

进 Dashboard 时前端 refreshAll 并行打 signals / accounts / trends / quotes / symbols
（另有 orders、策略信号等），每个请求都要过一遍 get_current_user（一次用户表查询 + 一次
连接借还）。这里把「全员同值或轻量」的那几份合成一个响应，只走一次 get_current_user、
一个 DB 会话；内部**复用现有函数**（信号走它自己的 shared_cache 载荷，账户走
bridge.list_accounts，趋势走 10 秒共享缓存，报价/品种是纯内存读），不新增任何查询。

响应结构（每一段与对应单独接口的响应逐字相同，前端可直接喂给原来的 setState）：
  {
    "signals":       {"signals": [...]}                                  # = GET /signals
    "accounts":      {"accounts": [...], "accountLimit": n|null,
                      "brokerLock": {...}}                               # = GET /bridge/accounts
    "trends":        {"trends": [...]}                                   # = GET /trends
    "quotes":        {"quotes": [...]}                                   # = GET /quotes
    "symbols":       {"symbols": [...]}                                  # = GET /symbols
    "failed":        ["trends", ...]                                     # 这一次算失败的段（通常为空）
  }
某一段失败时该段为 null 并列入 failed，其余照常返回——前端对 failed 里的段回退到逐个请求，
不能因为 bootstrap 局部失败就判「后端不可达」（live.tsx 的 setBackendUnreachable 依赖
signals/accounts 各自的成败）。带 ?extras=1 时另有 "extras"：{前端请求路径: 响应}，见下方 extras 一节
（订单、me、胜率、公告、通知、情绪、社交链接、策略分析）；策略信号（仅管理员）不在本接口内。

One read-only request for the Dashboard's base data. refreshAll fans out several calls
and each pays a get_current_user (a users-table query plus a pooled connection). The
identical-for-everyone or cheap sections are merged here behind a single
get_current_user and DB session, reusing the existing functions (signals via its own
shared_cache payload, accounts via bridge.list_accounts, trends via the 10s shared
cache, quotes/symbols are in-memory reads) — no new queries. Each section is
byte-identical to its standalone endpoint. A failing section is null and named in
`failed`; the client falls back to the individual request for those and must not
conclude "backend unreachable" from a partial failure. With ?extras=1 an "extras" map
{frontend request path: response} adds orders, me, win rates, announcements,
notifications, sentiment, social links and the strategy analysis (see the extras section below); strategy signals (admin
only) are not included.
"""
import logging

from fastapi import APIRouter, Depends
from fastapi.encoders import jsonable_encoder
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from app.core.database import get_db
from app.models import User
from app.routers import account as account_router
from app.routers import announcements as announcements_router
from app.routers import bridge as bridge_router
from app.routers import notifications as notifications_router
from app.routers import orders as orders_router
from app.routers import sentiment as sentiment_router
from app.routers import signals as signals_router
from app.routers import trends as trends_router
from app.routers import site as site_router
from app.schemas import AdminStrategyWinRateOut, AnnouncementListOut, AnnouncementPopupOut, NotificationFeedOut
from app.services import quotes_store
from app.services.deps import get_current_user

logger = logging.getLogger("prismx.bootstrap")

router = APIRouter(prefix="/bootstrap", tags=["bootstrap"])


def _sync_sections(user: User, db: Session) -> tuple[dict, list[str]]:
    """三段同步 DB 读，各自兜底：一段挂了不拖累其它段。
    The three blocking DB sections, each guarded so one failure doesn't sink the rest."""
    out: dict = {}
    failed: list[str] = []
    for name, fn in (
        ("signals", lambda: signals_router.list_signals(user=user, db=db)),
        ("accounts", lambda: bridge_router.list_accounts(user=user, db=db)),
        ("trends", lambda: trends_router.list_trends(user=user, db=db)),
    ):
        try:
            out[name] = fn()
        except Exception:  # noqa: BLE001
            logger.exception("bootstrap section failed: %s", name)
            db.rollback()
            out[name] = None
            failed.append(name)
    return out, failed


# ---------- extras：首屏其它组件各自要发的那几个请求（?extras=1 才带）----------
# 2026-10-11 生产压测：几百人同时打开页面时最慢的就是这几个首屏请求（通知、公告弹窗、情绪、
# 胜率……p50 1–2 秒），每个都要单独走一遍鉴权与请求开销。带上 ?extras=1 时把它们一并算好，
# 按**前端请求时的路径**做键，前端的 request() 先查这份预取再决定要不要发请求
# （frontend/src/api/prefetch.ts）。每一份都是直接调用对应端点函数、按它的 response_model
# 序列化，与单独请求逐字相同；某一份失败就不放进来，前端照常单独请求。旧前端不带这个参数，
# 响应与以前完全一样。这里只收「无限流装饰器」的端点：带 IP 限流的（比赛、勋章、排行榜）
# 放进来就等于绕开了限流。
# Extras: the requests the other first-screen components would each make, only with
# ?extras=1. In the 2026-10-11 production test these were the slowest requests while
# hundreds opened the page at once (p50 1-2 s), each paying its own auth and request
# overhead. Keyed by the path the frontend requests, so its request() consults the
# prefetch first (frontend/src/api/prefetch.ts). Each payload calls the endpoint function
# itself and serializes it through its response_model — identical to the standalone
# response; a failing one is simply omitted and the frontend requests it as usual. Older
# frontends don't send the flag and get the old response. Only endpoints without a rate
# limit are included: folding in an IP-limited one would bypass its limit.
NOTIFICATION_PANEL_LIMIT = 4  # frontend NotificationBell PANEL_MESSAGES


def _encode(value, model=None):
    """按端点的 response_model 序列化（与 FastAPI 一致：先过模型再转 JSON 兼容类型）。
    Serialize like FastAPI does for the endpoint's response_model."""
    if model is not None and value is not None and not isinstance(value, model):
        value = model.model_validate(value)
    return jsonable_encoder(value)


def _extra_sections(user: User, db: Session) -> dict:
    extras: dict = {}
    for path, fn in (
        ("/orders", lambda: _encode(orders_router.list_orders(
            limit=100, offset=0, since=None, until=None, login=None, user=user, db=db))),
        ("/auth/me", lambda: _encode(
            account_router.get_account(db=db, current_user=user), account_router.AccountInfoOut)),
        ("/orders/winrate", lambda: _encode(orders_router.order_winrate(login=None, user=user, db=db))),
        ("/signals/winrate", lambda: _encode(signals_router.signal_winrate(user=user, db=db))),
        ("/announcements/popup", lambda: _encode(
            announcements_router.get_popup_announcement(db=db, user=user), AnnouncementPopupOut)),
        (f"/notifications/feed?limit={NOTIFICATION_PANEL_LIMIT}", lambda: _encode(
            notifications_router.notification_feed(limit=NOTIFICATION_PANEL_LIMIT, db=db, current_user=user),
            NotificationFeedOut)),
        ("/sentiment", lambda: _encode(sentiment_router.get_sentiment(user_id=user.id))),
        ("/notifications/prefs", lambda: _encode(
            notifications_router.get_prefs(db=db, current_user=user), notifications_router.NotificationPrefsOut)),
        ("/announcements", lambda: _encode(
            announcements_router.list_announcements(db=db, user=user, limit=100), AnnouncementListOut)),
        ("/site/social", lambda: _encode(site_router.get_social_links(db=db))),
        ("/signals/strategy-analysis", lambda: _encode(
            signals_router.strategy_analysis(_user=user, db=db), AdminStrategyWinRateOut)),
    ):
        try:
            extras[path] = fn()
        except Exception:  # noqa: BLE001 —— 一份失败只是少一份预取 / a failure just means no prefetch
            logger.exception("bootstrap extra failed: %s", path)
            db.rollback()
    return extras


@router.get("", response_model=dict)
async def get_bootstrap(
    extras: bool = False,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    out, failed = await run_in_threadpool(_sync_sections, user, db)
    if extras:
        out["extras"] = await run_in_threadpool(_extra_sections, user, db)
    try:
        out["quotes"] = {"quotes": await quotes_store.get_all_async()}
    except Exception:  # noqa: BLE001
        logger.exception("bootstrap section failed: quotes")
        out["quotes"] = None
        failed.append("quotes")
    try:
        out["symbols"] = {"symbols": await quotes_store.get_active_symbols_async()}
    except Exception:  # noqa: BLE001
        logger.exception("bootstrap section failed: symbols")
        out["symbols"] = None
        failed.append("symbols")
    out["failed"] = failed
    return out
