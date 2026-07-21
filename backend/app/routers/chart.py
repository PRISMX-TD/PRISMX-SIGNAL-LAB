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


# 每个(品种,周期)当前生效的纠偏量(秒)。用带迟滞的"同一挡位内取最小值"
# 缓存,不能直接拿"这一刻现算的偏差"——同一根 bar 在形成期间(最长可以是
# 整个周期的时长,比如日线最长 24 小时)自己的时间戳不变,服务器时钟却一直
# 在走,两者差值会持续缩小(见 _correct_future_skew 内的详细注释);如果每次
# 请求都直接用现算值纠正,同一根还在形成中的 bar 会在其形成过程中被纠正到
# 不停变化的时间点,chart_store 把每次都当成一根新 bar,图表看起来就像"每次
# 请求都冒出一根新蜡烛"(2026-07-21 真实回归:纠偏功能刚上线当天就复现)。
# 进程重启后自然清空,不需要持久化。
# The correction currently in effect per (symbol, interval), in seconds. Uses
# a hysteresis-and-maximum cache — not "whatever the skew computes to right
# now": a single bar's own timestamp doesn't change for as long as it's
# forming (up to the interval's full duration, e.g. 24h for a daily bar)
# while the server clock keeps advancing, so the raw gap between them keeps
# shrinking (see the detailed comment inside _correct_future_skew). Applying
# the raw value on every request would correct the same still-forming bar to
# a different point in time each time, and chart_store would treat every one
# as a brand-new bar — the chart appears to spawn a fresh candle on every
# request (a real regression reproduced the day this correction feature
# shipped, 2026-07-21). Resets naturally on process restart; no persistence
# needed.
_skew_cache: dict[tuple[str, str], float] = {}


def _correct_future_skew(
    bars: list[dict], now: float, cache_key: tuple[str, str], interval_seconds: int,
) -> tuple[list[dict], float, bool]:
    """喂价端(EA/其运行机器)时钟跑偏、把 K 线时间戳打进"未来"时,用这一批里
    最新一根(通常是仍在形成中的那根)跟服务器当前时间的差值反向纠正全部
    时间戳,让存进内存缓存/数据库的都是对齐服务器时钟的时间——不依赖喂价端
    与服务器的绝对时钟一致,也不需要改动喂价端那台机器或经纪商服务器时间
    (真实场景里两者都不方便/不允许调整)。只在明显是"未来"时才纠正(超过
    `FUTURE_SKEW_CORRECTION_THRESHOLD_SECONDS` 阈值);喂价端时钟偏慢、或者
    行情在收市期间原地不动导致最新一根落在过去,都不触发纠正——那种情况下
    "把旧数据往前挪"只是瞎猜，不是纠正。

    纠偏量不能直接拿"这一刻现算的偏差"——同一根 bar 在形成期间(最长可以是
    整个周期时长)自己的时间戳不变,服务器时钟却一直在走,两者差值会持续
    缩小;一到下一根 bar 开始形成,差值又跳回接近真实基准偏差的高点。这是
    一个随每根 bar 重复的"锯齿"形状:每根 bar 刚开始形成、刚被观测到时差值
    最大、最接近真实基准偏差(这一刻服务器时钟还没来得及在这根 bar 自己的
    时间戳上"追"出多少差距);越往后同一根 bar 被反复请求,差值越小,到下
    一根 bar 开始时跳回高点。直接用现算值会让同一根 bar 在形成过程中被纠正
    到不停变化的时间点。用带迟滞的"同一挡位内取最大值"缓存锁定纠偏量:
    偏差量真的跳变(超出这个周期一整根 bar 的自然漂移范围,说明喂价端断线
    重连、DST 切换等真的换挡了)才重新起算,否则在同一挡位内持续取观测到
    的最大值——收敛到真实基准偏差,不会被同一根 bar 形成越久、差值越小的
    后续观测拉低,也不会因为反复现算而抖动。

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

    The correction can't just be "whatever the skew computes to right now" —
    a single bar's own timestamp doesn't change for as long as it's forming
    (up to the interval's full duration), so the gap naturally shrinks as the
    server clock keeps advancing (a sawtooth that resets — largest, closest
    to the true base offset, right when a bar is first observed just as it
    starts forming — the server clock hasn't had time to "catch up" against
    that bar's own fixed timestamp yet — then shrinks the longer that same
    bar keeps getting re-requested, resetting back up at the next bar). Using
    the raw value directly would correct the same forming bar to a different
    point in time on every request. A hysteresis-and-maximum cache pins the
    correction instead: only re-anchor when the skew jumps by more than this
    interval's own full duration (a genuine regime change — the feed
    reconnecting, a DST transition); otherwise keep the maximum observed
    value within the current regime, converging to the true base offset
    instead of getting pulled down by later, deeper-into-formation
    observations of the same bar, and without jitter from re-deriving it on
    every request.

    返回(纠正后的 bars,本次生效的纠偏量,这次是不是刚发生了"换挡"——仅供
    调用方决定要不要打日志,不代表本次是否真的做了纠正)。
    Returns (corrected bars, the correction currently in effect, whether this
    call just detected a regime change — for the caller's logging decision
    only, not whether a correction was actually applied this call).
    """
    if not bars:
        return bars, 0.0, False
    latest_t = max(b["t"] for b in bars)
    raw_skew = latest_t - now
    if raw_skew <= FUTURE_SKEW_CORRECTION_THRESHOLD_SECONDS:
        _skew_cache.pop(cache_key, None)
        return bars, 0.0, False

    hysteresis = interval_seconds + 60  # 覆盖这个周期一整根 bar 的自然漂移 + 余量
    cached = _skew_cache.get(cache_key)
    is_new_regime = cached is None or abs(raw_skew - cached) > hysteresis
    cached = raw_skew if is_new_regime else max(cached, raw_skew)
    _skew_cache[cache_key] = cached

    # 纠偏量必须是这个周期长度的整数倍,否则减完之后 bar 的时间戳会偏离自己
    # 所在的周期网格(比如 5 分钟线不再落在 :00/:05/:10 这种整点上),存进数据库
    # 后跟同周期其它干净的 bar 对不上格,图表上看起来就是错位/重复的蜡烛——
    # 这正是 2026-07-21 那次回测图表蜡烛错位事故的根因。四舍五入到最近的整
    # 周期数,既贴近真实偏差,又保证纠正后的时间戳和原始时间戳落在同一个网格。
    # The correction must be a whole multiple of this interval's length,
    # otherwise subtracting it knocks the bar's timestamp off its own periodic
    # grid (e.g. a 5-minute bar no longer lands on :00/:05/:10) — once stored,
    # it won't line up with the other clean bars of the same interval, and the
    # chart renders it as a duplicate/misaligned candle. This was the root
    # cause of the 2026-07-21 backtest-chart misaligned-candle incident.
    # Rounding to the nearest whole interval keeps the correction close to the
    # true offset while guaranteeing the corrected timestamp stays on the same
    # grid as the original.
    shift = round(cached / interval_seconds) * interval_seconds
    return [{**b, "t": b["t"] - shift} for b in bars], cached, is_new_regime


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
        interval_seconds = candle_store.INTERVAL_SECONDS.get(s.interval, 60)
        bars, skew, is_new_regime = _correct_future_skew(bars, now, (symbol, s.interval), interval_seconds)
        if is_new_regime:
            logger.warning(
                "feed_candles: %s/%s feed clock is %.1fh ahead of server time, "
                "correcting timestamps by -%ds before storing (check the EA/its "
                "host machine's clock if this persists)",
                symbol, s.interval, skew / 3600, int(skew),
            )
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
