"""图表行情路由：EA 写入 K 线/报价 + 前端读取。
Chart market-data router: the EA writes candles/quotes, the frontend reads them.

写入（/feed/candles、/feed/quotes）由 MT5 EA 调用，用 X-EA-Token 头鉴权
（不是用户，没有 JWT）。读取（/chart/history、/chart/latest、/quotes）复用
站内登录态，与 ChartsPage 的其它接口一致。

Writes (/feed/candles, /feed/quotes) are called by the MT5 EA, authenticated
via the X-EA-Token header (it's not a user, no JWT). Reads (/chart/history,
/chart/latest, /quotes) reuse the site's normal login, consistent with
ChartsPage's other endpoints.
"""
import secrets

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from pydantic import BaseModel, Field

from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.database import get_db
from app.models import User
from app.services import candle_store, chart_store, quotes_store, strategy_engine
from app.services.connection_manager import manager
from app.services.deps import get_current_user

router = APIRouter(tags=["chart"])

# 前端 ChartsPage 的周期 code 集合，须与 EA 推送的周期保持一致。
# Frontend ChartsPage's interval codes; must match what the EA pushes.
ALLOWED_INTERVALS = {"1", "5", "15", "60", "240", "D"}


def _valid_ea_token(token: str | None) -> bool:
    if not settings.EA_TOKEN or not token:
        return False
    return secrets.compare_digest(token.encode("utf-8"), settings.EA_TOKEN.encode("utf-8"))


# ---------- EA 写入 / EA write ----------
class FeedBar(BaseModel):
    t: int
    o: float
    h: float
    l: float
    c: float
    v: float = 0


class FeedSeries(BaseModel):
    symbol: str = Field(max_length=32)
    interval: str
    bars: list[FeedBar] = []


class FeedRequest(BaseModel):
    mode: str  # "backfill" | "tick"
    series: list[FeedSeries] = []


@router.post("/feed/candles")
async def feed_candles(
    req: FeedRequest,
    x_ea_token: str | None = Header(default=None),
    db: Session = Depends(get_db),
):
    """EA 上报 K 线：mode=backfill 整段替换，mode=tick 合并最新几根。
    EA reports candles: mode=backfill replaces the full series, mode=tick
    merges the latest few bars.

    顺手把已经走完的 K 线写进数据库长期保存（供策略回测/更长回看用），并对
    这个品种/周期下所有已启用的用户策略求值——两者都只在真的有一根新
    K 线收盘时才触发实质工作，绝大多数 tick 调用（bar 还在形成中）直接
    是空操作。见 services/candle_store.py、services/strategy_engine.py。

    Also persists closed bars to the database (for strategy backtests/longer
    lookback) and evaluates every enabled user strategy on this symbol/
    interval — both are near-no-ops on most tick calls (the bar is still
    forming); real work only happens when a bar has actually just closed.
    """
    if not _valid_ea_token(x_ea_token):
        raise HTTPException(status_code=401, detail="invalid feed token")
    for s in req.series:
        if s.interval not in ALLOWED_INTERVALS:
            continue
        symbol = s.symbol.upper()
        bars = [b.model_dump() for b in s.bars]
        if req.mode == "backfill":
            chart_store.replace_series(symbol, s.interval, bars)
        else:
            chart_store.merge_bars(symbol, s.interval, bars)
        new_count = candle_store.persist_closed_bars(db, symbol, s.interval, bars)
        if new_count:
            await strategy_engine.evaluate_new_candle(symbol, s.interval)
    return {"ok": True}


# ---------- EA 全局报价写入 / EA global quotes write ----------
class FeedQuote(BaseModel):
    symbol: str = Field(max_length=32)
    bid: float
    ask: float
    digits: int | None = Field(default=None, ge=0, le=10)
    # 休市兜底：EA 在市场关闭、SymbolInfoDouble 读不到实时报价时,退回最后一次
    # 真实成交价继续推送(不然该品种会因收不到报价而被判定"不活跃"从网页消失),
    # 并用这个字段告诉后端/前端"这不是实时跳动的价格"。
    # Closed-market fallback: the EA falls back to each symbol's last genuine
    # trade price when the market is closed and SymbolInfoDouble can't read a
    # live quote (otherwise the symbol goes quiet long enough to be marked
    # inactive and vanish from the web app); this field tells the backend/
    # frontend "this isn't a live-moving price".
    closed: bool = False


class FeedQuotesRequest(BaseModel):
    data: list[FeedQuote] = []


@router.post("/feed/quotes")
async def feed_quotes(req: FeedQuotesRequest, x_ea_token: str | None = Header(default=None)):
    """EA 上报全站统一报价（不区分用户）。仅把发生变化的条目广播给所有在线
    前端，控制 WebSocket 流量。
    EA reports one site-wide quote snapshot (not per-user). Only changed
    entries are broadcast to all online clients to keep WebSocket traffic
    minimal."""
    if not _valid_ea_token(x_ea_token):
        raise HTTPException(status_code=401, detail="invalid EA token")
    incoming = [{"symbol": q.symbol.upper(), "bid": q.bid, "ask": q.ask, "digits": q.digits, "closed": q.closed} for q in req.data]
    changed = quotes_store.update(incoming)
    if changed:
        await manager.broadcast_to_clients({"type": "GLOBAL_QUOTES", "data": changed})
    return {"ok": True}


@router.get("/quotes")
async def list_quotes(user: User = Depends(get_current_user)):
    """前端读取全站统一报价快照（首屏用，之后靠 WS GLOBAL_QUOTES 增量更新）。
    Frontend reads the site-wide quote snapshot (first load; WS GLOBAL_QUOTES
    delivers deltas afterwards)."""
    return {"quotes": quotes_store.get_all()}


@router.get("/symbols")
async def list_active_symbols(user: User = Depends(get_current_user)):
    """当前活跃品种：EA 的 InpSymbols 里配了什么、正在推什么，这里就返回什么，
    不是写死的列表。前端的报价表/图表选择器/仪表盘英雄板都应该以这份列表为
    准渲染，EA 端增删品种后数十秒内前端会自动跟上，不需要改前端代码。
    Currently active symbols: whatever the EA's InpSymbols is configured with
    and actively pushing, not a hardcoded list. The frontend's quotes table /
    chart symbol picker / dashboard hero should all render from this list —
    adding or removing a symbol on the EA side is reflected within seconds,
    no frontend code change needed."""
    return {"symbols": quotes_store.get_active_symbols()}


# ---------- 前端读取 / frontend read ----------
@router.get("/chart/history")
async def chart_history(
    symbol: str = Query(max_length=32),
    interval: str = Query(),
    limit: int = Query(default=500, ge=1, le=chart_store.MAX_BARS),
    user: User = Depends(get_current_user),
):
    if interval not in ALLOWED_INTERVALS:
        raise HTTPException(status_code=400, detail="bad interval")
    return {
        "symbol": symbol.upper(),
        "interval": interval,
        "bars": chart_store.get_history(symbol.upper(), interval, limit),
    }


@router.get("/chart/latest")
async def chart_latest(
    symbol: str = Query(max_length=32),
    interval: str = Query(),
    user: User = Depends(get_current_user),
):
    if interval not in ALLOWED_INTERVALS:
        raise HTTPException(status_code=400, detail="bad interval")
    return chart_store.get_latest(symbol.upper(), interval)
