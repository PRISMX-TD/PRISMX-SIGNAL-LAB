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
（订单、me、胜率、公告、通知、情绪、社交链接）；策略信号（仅管理员）不在本接口内。
策略分析（/signals/strategy-analysis）2026-11-16 移出 extras：它占整个响应的三分之二（实测
119 KB 里的 79 KB），而只有仪表盘的时段胜率卡用它——打开图表 / 订单页的人白下载，仪表盘上它
也排在账户与信号之后，拖着整个首屏一起等不值得。现在由那张卡自己单独请求（体验报告 M7）。

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
notifications, sentiment and social links (see the extras section below); strategy signals (admin
only) are not included. The strategy analysis left extras on 2026-11-16: two thirds of the
response (79 of 119 KB) for one below-the-fold dashboard card, downloaded even on pages
that never show it; the card now requests it on its own (QA report M7).
"""
import asyncio
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
from app.schemas import AnnouncementListOut, AnnouncementPopupOut, NotificationFeedOut
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
NOTIFICATION_PANEL_LIMIT = 20  # 必须等于前端 NotificationBell 的 PANEL_MESSAGES，否则预取永远命中不了 / must equal the frontend PANEL_MESSAGES or the prefetch never hits


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
    ):
        try:
            extras[path] = fn()
        except Exception:  # noqa: BLE001 —— 一份失败只是少一份预取 / a failure just means no prefetch
            logger.exception("bootstrap extra failed: %s", path)
            db.rollback()
    return extras


def _db_sections(user: User, db: Session, extras: bool) -> tuple[dict, list[str]]:
    """所有 DB 段在同一个线程、同一个会话里跑完（一次线程切换，一条连接）。
    Every DB section in one thread on one session: one hop, one pooled connection."""
    out, failed = _sync_sections(user, db)
    if extras:
        out["extras"] = _extra_sections(user, db)
    return out, failed


async def _gather_sections(user: User, db: Session, extras: bool):
    async def _safe(name: str, coro, wrap: str):
        try:
            return {wrap: await coro}
        except Exception:  # noqa: BLE001
            logger.exception("bootstrap section failed: %s", name)
            return None

    return await asyncio.gather(
        run_in_threadpool(_db_sections, user, db, extras),
        _safe("quotes", quotes_store.get_all_async(), "quotes"),
        _safe("symbols", quotes_store.get_active_symbols_async(), "symbols"),
    )


@router.get("", response_model=dict)
async def get_bootstrap(
    extras: bool = False,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    # 报价 / 品种是内存（或 Redis）读，与 DB 段并行，不再排在它们后面（体验报告 M7）。
    # DB 段之间刻意不并行：那要多借连接，几百人同时打开时正是连接池最紧的时候。
    # Quotes / symbols are memory (or Redis) reads and now run alongside the DB sections
    # instead of after them (QA report M7). The DB sections stay serial on purpose: running
    # them in parallel would borrow more pooled connections exactly when the pool is tightest.
    (out, failed), quotes, symbols = await _gather_sections(user, db, extras)
    out["quotes"] = quotes
    out["symbols"] = symbols
    if quotes is None:
        failed.append("quotes")
    if symbols is None:
        failed.append("symbols")
    out["failed"] = failed
    return out
