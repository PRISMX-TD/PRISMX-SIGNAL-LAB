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
signals/accounts 各自的成败）。orders、策略信号（仅管理员）、me 不在本接口内，前端照旧单独请求。

One read-only request for the Dashboard's base data. refreshAll fans out several calls
and each pays a get_current_user (a users-table query plus a pooled connection). The
identical-for-everyone or cheap sections are merged here behind a single
get_current_user and DB session, reusing the existing functions (signals via its own
shared_cache payload, accounts via bridge.list_accounts, trends via the 10s shared
cache, quotes/symbols are in-memory reads) — no new queries. Each section is
byte-identical to its standalone endpoint. A failing section is null and named in
`failed`; the client falls back to the individual request for those and must not
conclude "backend unreachable" from a partial failure. orders, strategy signals
(admin only) and me are not included.
"""
import logging

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from app.core.database import get_db
from app.models import User
from app.routers import bridge as bridge_router
from app.routers import signals as signals_router
from app.routers import trends as trends_router
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


@router.get("", response_model=dict)
async def get_bootstrap(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    out, failed = await run_in_threadpool(_sync_sections, user, db)
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
