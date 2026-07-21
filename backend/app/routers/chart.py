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
import logging
import secrets
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from pydantic import BaseModel, Field

from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.database import get_db
from app.models import User
from app.services import candle_store, chart_store, quotes_store, strategy_engine
from app.services.connection_manager import manager
from app.services.deps import get_current_user

logger = logging.getLogger("prismx.chart")

router = APIRouter(tags=["chart"])

# 前端 ChartsPage 的周期 code 集合，须与 EA 推送的周期保持一致。
# Frontend ChartsPage's interval codes; must match what the EA pushes.
ALLOWED_INTERVALS = {"1", "5", "15", "60", "240", "D"}

# 喂价端(EA/其运行机器)的时钟如果比服务器明显跑快,会把 K 线时间戳打进
# "未来"——超过这个阈值(5 分钟,远大于正常网络延迟/处理耗时)才当作真的时钟
# 跑偏去纠正,而不是把偶发的几秒抖动也当成异常。
# If the feed's (EA / its host machine) clock runs noticeably fast, it
# stamps bars into the "future" — only treat it as genuine clock skew (worth
# correcting) past this threshold (5 minutes, well above normal network
# latency/processing time), not the occasional few-second jitter.
FUTURE_SKEW_CORRECTION_THRESHOLD_SECONDS = 300


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


def _correct_future_skew(bars: list[dict], now: float) -> tuple[list[dict], float]:
    """喂价端(EA/其运行机器)时钟跑偏、把 K 线时间戳打进"未来"时,用这一批里
    最新一根(通常是仍在形成中的那根)跟服务器当前时间的差值反向纠正全部
    时间戳,让存进内存缓存/数据库的都是对齐服务器时钟的时间——不依赖喂价端
    与服务器的绝对时钟一致,也不需要改动喂价端那台机器或经纪商服务器时间
    (真实场景里两者都不方便/不允许调整)。只在明显是"未来"时才纠正(超过
    `FUTURE_SKEW_CORRECTION_THRESHOLD_SECONDS` 阈值);喂价端时钟偏慢、或者
    行情在收市期间原地不动导致最新一根落在过去,都不触发纠正——那种情况下
    "把旧数据往前挪"只是瞎猜，不是纠正。

    返回(纠正后的 bars,本次检测到的偏差秒数——0 表示没有纠正/无需纠正)。

    If the feed's (EA / its host machine) clock runs fast, it stamps bars
    into the "future" — use the newest bar in the batch (usually the one
    still forming) vs the server's own current time to shift every bar back
    by that gap, so what lands in the in-memory cache / database is aligned
    to the server clock — without requiring the feed's and server's absolute
    clocks to agree, or touching the feed's host machine or the broker's
    server time (in the real scenario neither is convenient or allowed to
    adjust). Only corrects when clearly "future" (past
    `FUTURE_SKEW_CORRECTION_THRESHOLD_SECONDS`); a feed clock running slow,
    or a market-closed period where the newest bar is genuinely in the past,
    never triggers this — shifting old data "forward" would be a guess, not
    a correction.

    Returns (corrected bars, the detected skew in seconds — 0 means no
    correction was applied/needed).
    """
    if not bars:
        return bars, 0.0
    skew = max(b["t"] for b in bars) - now
    if skew <= FUTURE_SKEW_CORRECTION_THRESHOLD_SECONDS:
        return bars, 0.0
    shift = int(skew)
    return [{**b, "t": b["t"] - shift} for b in bars], skew


# 记一下"最近一次给这个品种/周期打纠偏日志时,偏差量是多少"——tick 模式几秒
# 一次,同一个偏差值没必要每次都重复打日志,只在第一次出现、或者偏差量发生
# 明显变化(比如喂价端断线重连、DST 切换)时才打一次,避免长期存在的偏差把
# 日志刷屏。进程重启后自然清空,不需要持久化。
# Tracks "the skew value we last logged a correction for, per symbol/
# interval" — tick mode fires every few seconds; no need to re-log an
# unchanged skew every time, only the first occurrence or a meaningful shift
# (e.g. the feed reconnecting, a DST transition). Resets naturally on process
# restart; no persistence needed.
_last_logged_skew: dict[tuple[str, str], float] = {}


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
    now = datetime.now(timezone.utc).timestamp()
    for s in req.series:
        if s.interval not in ALLOWED_INTERVALS:
            continue
        symbol = s.symbol.upper()
        bars = [b.model_dump() for b in s.bars]
        bars, skew = _correct_future_skew(bars, now)
        if skew:
            key = (symbol, s.interval)
            last = _last_logged_skew.get(key)
            if last is None or abs(skew - last) > 60:
                logger.warning(
                    "feed_candles: %s/%s feed clock is %.1fh ahead of server time, "
                    "correcting timestamps by -%ds before storing (check the EA/its "
                    "host machine's clock if this persists)",
                    symbol, s.interval, skew / 3600, int(skew),
                )
                _last_logged_skew[key] = skew
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
