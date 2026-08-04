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
from app.models import Candle, User
from app.services import candle_store, chart_store, quotes_store
from app.services.connection_manager import manager
from app.services.deps import get_current_user
from app.services.settings_store import get_feed_symbols, save_broker_symbol_catalogue
from app.services.strategy import live as strategy_live
from app.schemas import BrokerSymbolReport

logger = logging.getLogger("prismx.chart")

router = APIRouter(tags=["chart"])

# 前端 ChartsPage 的周期 code 集合，须与 EA 推送的周期保持一致。
# Frontend ChartsPage's interval codes; must match what the EA pushes.
ALLOWED_INTERVALS = {"1", "5", "15", "60", "240", "D"}

# 单次 /chart/history 请求最多返回多少根。不是"总共能看多少"的上限——前端靠
# `before` 游标一页页往左取,总深度只受数据库里实际存了多少限制。设这个上限是为了
# 挡住单次请求把几万根一次性序列化(那会同时打爆后端内存和浏览器)。
# Max bars a single /chart/history request returns. This is not a cap on how much
# history is viewable — the client pages backwards with the `before` cursor, so
# total depth is bounded only by what's actually stored. The cap exists to stop a
# single request from serializing tens of thousands of bars at once, which would
# blow up both the backend's memory and the browser.
CHART_HISTORY_MAX_LIMIT = 5000

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
    # "backfill" 整段替换内存缓存 | "tick" 合并最新几根 | "history" 只落库
    # "backfill" replaces the cache | "tick" merges latest | "history" stores only
    mode: str
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


def _apply_cached_skew(bars: list[dict], cache_key: tuple[str, str], interval_seconds: int) -> list[dict]:
    """按当前已探测到的纠偏量纠正一批历史 bar,但不读写迟滞缓存。

    历史回填批次不能走 _correct_future_skew():那个函数用"这一批最新一根 vs 服务器
    当前时间"来探测偏差,而历史批次最新的一根本来就在很久以前,算出来的差值必然为
    负,于是它会把该(品种,周期)的缓存整条 pop 掉——等于用历史数据擦掉了实时链路
    好不容易收敛出来的纠偏量,下一批实时 bar 得从头重新起算。

    但纠偏本身仍要做:如果 EA 那台机器时钟偏了,它推来的历史时间戳同样是偏的,不
    纠正就会和实时链路存进去的 bar 在时间轴上错开一截。所以这里复用实时链路已经
    探测好的那个值,只应用、不更新。缓存为空(时钟本来就是对的)时原样返回。

    Correct a batch of history bars using the already-detected skew, without
    reading or writing the hysteresis cache.

    History batches must not go through _correct_future_skew(): it detects the
    offset from "this batch's newest bar vs the server's current time", and a
    history batch's newest bar is old by definition, so the computed skew is
    negative and the function pops that (symbol, interval)'s cache entry —
    history data would wipe out the correction the live path worked to converge
    on, forcing it to start over on the next live batch.

    The correction itself is still needed: if the EA's host clock is off, the
    history timestamps it pushes are off by the same amount, and leaving them
    uncorrected would offset them from the bars the live path stored. So this
    applies the value the live path already detected without updating it. With
    an empty cache (the clock was fine all along) the bars pass through.
    """
    cached = _skew_cache.get(cache_key)
    if not cached:
        return bars
    shift = round(cached / interval_seconds) * interval_seconds
    return [{**b, "t": b["t"] - shift} for b in bars]


@router.post("/feed/candles")
async def feed_candles(
    req: FeedRequest,
    x_ea_token: str | None = Header(default=None),
    db: Session = Depends(get_db),
):
    """EA 上报 K 线：mode=backfill 整段替换，mode=tick 合并最新几根，
    mode=history 只落库（一次性历史回填）。
    EA reports candles: mode=backfill replaces the full series, mode=tick
    merges the latest few bars, mode=history only persists (one-off backfill).

    mode=history 是 EA 首次上线时一次性灌入历史的通道，与日常的 backfill/tick
    刻意分开处理，两点差异都是必须的：

    ① 不碰 chart_store。内存缓存服务的是"最新一屏"，replace_series 会整段替换
       成这一批。历史批次推的是很久以前的一段，替换进去会让实时图表突然显示
       两年前的蜡烛，而且下一次日常 backfill 才会恢复。
    ② 不触发 evaluate_new_candle。策略求值的语义是"刚有一根新 K 线收盘"，会
       写信号、推送通知、并推进去重游标 last_signal_bar_t。历史数据灌进来时
       每一批都会被当成"刚收盘"，凭空产生成千上万条两年前的历史信号并给用户
       发推送；游标被推到历史某个点之后，真实的新 K 线反而可能被判为已处理。

    mode=history is the one-off channel for seeding history when the EA is first
    deployed, deliberately handled apart from the routine backfill/tick paths.
    Both differences are necessary:

    ① It doesn't touch chart_store. The in-memory cache serves "the latest
       screenful", and replace_series swaps the whole series for this batch. A
       history batch carries a stretch from long ago, so writing it there makes
       the live chart suddenly display two-year-old candles until the next
       routine backfill repairs it.
    ② It doesn't trigger evaluate_new_candle. Strategy evaluation means "a new
       bar just closed": it writes signals, sends push notifications and
       advances the last_signal_bar_t dedup cursor. Seeding history would treat
       every batch as just-closed, fabricating thousands of two-year-old signals
       and pushing them to users; and once the cursor is dragged to some point
       in the past, genuinely new bars can be judged already-handled.

    顺手把已经走完的 K 线写进数据库长期保存（供策略回测/更长回看用），并对
    这个品种/周期下所有已启用的用户策略求值——两者都只在真的有一根新
    K 线收盘时才触发实质工作，绝大多数 tick 调用（bar 还在形成中）直接
    是空操作。见 services/candle_store.py、services/strategy/live.py。

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
        # history 批次只落库,不碰内存缓存也不求值策略,理由见本函数 docstring;
        # 纠偏也走只读那条,不能让历史批次擦掉实时链路的迟滞缓存(见 _apply_cached_skew)。
        # history batches only persist; see this function's docstring. Skew
        # correction goes through the read-only path so a history batch can't wipe
        # the live hysteresis cache (see _apply_cached_skew).
        if req.mode == "history":
            bars = _apply_cached_skew(bars, (symbol, s.interval), interval_seconds)
            new_count = candle_store.persist_closed_bars(db, symbol, s.interval, bars)
            logger.info(
                "feed_candles: %s/%s history batch stored %d/%d bar(s)",
                symbol, s.interval, new_count, len(bars),
            )
            continue
        bars, skew, is_new_regime = _correct_future_skew(bars, now, (symbol, s.interval), interval_seconds)
        if is_new_regime:
            logger.warning(
                "feed_candles: %s/%s feed clock is %.1fh ahead of server time, "
                "correcting timestamps by -%ds before storing (check the EA/its "
                "host machine's clock if this persists)",
                symbol, s.interval, skew / 3600, int(skew),
            )
        # 内存缓存与数据库必须写同一份已过滤的数据。
        #
        # 这里以前直接写未过滤的 bars,于是休市期间的伪造 K 线被闸门正确地拦在数据库
        # 之外,却照样进了内存缓存,并通过 GET /chart/latest 出现在前端图表最右侧那根
        # 跳动的蜡烛上——同一份数据经过两套判断,库里干净、界面上还是假的。
        #
        # 缓存这条路要 include_forming=True 保留仍在形成中的那根:它正是图表最右侧那根
        # 跳动的蜡烛(GET /chart/latest 取的就是它)。若跟着数据库一起把未收盘的过滤掉,
        # 日线图上"今天"会整根消失、分钟图永远慢一个周期。休市闸门对这根照常生效,所以
        # 保留它不会让伪造蜡烛漏出去。数据库那条路不能带它——库里只存已收盘的 bar。
        #
        # The cache and the database must be written from the same filtered data.
        #
        # This previously wrote the raw, unfiltered bars, so fabricated candles during
        # a closure were correctly kept out of the database yet still entered the cache
        # and surfaced via GET /chart/latest as the live rightmost candle — one dataset
        # judged by two code paths, leaving the database clean and the UI still wrong.
        #
        # The cache path passes include_forming=True to keep the still-forming bar: it is
        # the live rightmost candle (exactly what GET /chart/latest serves). Filtering it
        # out alongside the database would make "today" vanish from a daily chart and
        # leave minute charts an interval behind. The closure gates still apply to it, so
        # keeping it leaks no fabricated candle. The database path must not include it —
        # only closed bars belong in storage.
        cacheable = candle_store.filter_tradeable_bars(
            db, symbol, s.interval, bars, include_forming=True,
        )
        tradeable = candle_store.filter_tradeable_bars(db, symbol, s.interval, bars)
        # 临时诊断（图表不更新排查用，定位后删除）:比对"进来的 bar"与"过滤后
        # 留下的"和"缓存里已有的末根",一行日志就能区分是闸门拦掉、还是
        # merge_bars 的追加条件没满足。
        # TEMPORARY diagnostic for the stale-chart investigation; remove once
        # located. One line separates "a gate dropped it" from "merge_bars
        # refused to append".
        if symbol == "XAUUSD" and s.interval == "5":
            _existing = chart_store.get_latest(symbol, s.interval, 1)["bars"]
            logger.warning(
                "DIAG %s/%s mode=%s in=%d(t=%s..%s) -> cacheable=%d gates=%s "
                "cache_last_t=%s skew=%s",
                symbol, s.interval, req.mode,
                len(bars), bars[0]["t"] if bars else None, bars[-1]["t"] if bars else None,
                len(cacheable),
                candle_store.explain_gates(db, symbol, s.interval, bars),
                _existing[0]["t"] if _existing else None,
                int(skew),
            )
        if req.mode == "backfill":
            # backfill 是整段替换。过滤后为空时不能替换:那会把缓存里原有的真实历史
            # 清空,前端图表直接空白。保留旧数据、等下一批有效数据再替换。
            # backfill replaces the whole series. Don't replace when the filtered result
            # is empty: that would wipe the genuine history already cached and blank the
            # chart. Keep the old data and wait for the next valid batch.
            if cacheable:
                chart_store.replace_series(symbol, s.interval, cacheable)
        else:
            chart_store.merge_bars(symbol, s.interval, cacheable)
        new_count = candle_store.persist_closed_bars(
            db, symbol, s.interval, bars, prefiltered=tradeable,
        )
        if new_count:
            # 策略评估是同步 SQLAlchemy + 纯 Python 指标循环：留在事件循环里会
            # 拖住 WebSocket 推送与桥接轮询（生产 2 核单进程）。推送部分本身是
            # 异步的，由 live 内部在提交之后自行 await（见 strategy/live.py）。
            # Strategy evaluation is blocking SQLAlchemy plus a pure-Python
            # indicator loop: leaving it on the event loop stalls the WebSocket
            # pushes and bridge polling it shares (2 cores, single process in
            # production). The push half is async and awaited inside live after
            # the commit.
            await strategy_live.evaluate_new_candle(symbol, s.interval)
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


# ---------- 网关品种配置 / gateway symbol configuration ----------
#
# 这两个端点服务于 manager_feed 网关，用 X-EA-Token 鉴权而不是管理员登录态，所以放在
# 这里而不是 admin.py——那个模块的约定是"所有端点都在 require_admin 之后"，塞一个
# 令牌鉴权的进去会破坏这条可以一眼验证的规则。
#
# These two serve the manager_feed gateway and authenticate with X-EA-Token rather than
# an admin session, so they live here rather than in admin.py: that module's contract is
# that every endpoint sits behind require_admin, and slipping in a token-authenticated
# one would break a rule that's otherwise verifiable at a glance.

@router.get("/feed/symbols-config")
async def feed_symbols_config(
    x_ea_token: str | None = Header(default=None),
    db: Session = Depends(get_db),
):
    """网关拉取要推送的品种配置。

    返回的是"该推什么"，与 /symbols（前端读"正在推什么"）方向相反：这个是配置的下发，
    那个是运行状态的反映。

    The gateway pulls the symbol configuration to push.

    This returns what *should* be pushed, the opposite direction from /symbols (which
    tells the frontend what *is* being pushed): config going out versus runtime state
    coming back.
    """
    if not _valid_ea_token(x_ea_token):
        raise HTTPException(status_code=401, detail="invalid EA token")
    return {"symbols": get_feed_symbols(db)}


@router.post("/feed/broker-symbols")
async def feed_broker_symbols(
    req: BrokerSymbolReport,
    x_ea_token: str | None = Header(default=None),
    db: Session = Depends(get_db),
):
    """网关上报券商可见的全部品种，供后台配置页做下拉选择。

    后端跑在 Linux 上装不了 MT5Manager，没法自己枚举券商品种，这份清单只能由运行在
    Windows 上的网关提供。

    The gateway reports every symbol the broker exposes, for the admin page's dropdown.

    The backend runs on Linux where MT5Manager can't be installed, so it can't enumerate
    broker symbols itself; only the Windows-side gateway can supply this.
    """
    if not _valid_ea_token(x_ea_token):
        raise HTTPException(status_code=401, detail="invalid EA token")
    save_broker_symbol_catalogue(db, [s.model_dump() for s in req.symbols])
    db.commit()
    logger.info("gateway reported %d broker symbols", len(req.symbols))
    return {"ok": True, "count": len(req.symbols)}


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
    limit: int = Query(default=1000, ge=1, le=CHART_HISTORY_MAX_LIMIT),
    before: int | None = Query(default=None, description="只返回 t < before 的 bar / only bars with t < before"),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """图表历史 K 线：读数据库,支持用 `before` 时间游标往更早翻页。

    改为读库(以前读 chart_store 内存缓存)的原因有三:
      ① 与策略回测同源。回测一直读的是 Candle 表,而图表读内存缓存那 500 根,
         两边时间范围不同——同一个品种在行情图上看到的和策略据以计算的可能不是
         同一批数据(回测图曾经就因为这个分裂而标记错位,见 _load_backtest_bars)。
      ② 内存缓存进程重启即空,得等 EA 下一轮 backfill 才有数据;数据库不会。
      ③ 内存缓存硬上限 500 根,库里存着两年历史却看不到。

    仍在形成中的那根不在这里返回——数据库只存已收盘的 bar。前端用
    GET /chart/latest(读 chart_store)拿最右侧那根跳动的,两路拼接。

    `before` 是往更早翻页的游标(取前端当前最早那根的 t),配合 limit 实现左拖
    加载。取法固定为"倒序取 limit 根再翻回正序":正序 limit 会永远返回最早的
    那些,新数据再多也追不上(与 _load_backtest_bars 同一个坑)。

    Chart history bars: read from the database, paginated backwards via the
    `before` cursor.

    Reading the database (it used to read the chart_store in-memory cache) for
    three reasons: ① same source as the strategy backtest, which always read the
    Candle table while the chart read 500 cached bars — different time ranges, so
    what a user saw on the chart and what a strategy computed on could be
    different data (exactly the split that misaligned the backtest chart's
    markers, see _load_backtest_bars); ② the cache empties on restart and stays
    empty until the EA's next backfill, the database doesn't; ③ the cache is
    capped at 500 bars, so two years of stored history was invisible.

    The still-forming bar is not returned here — the database only stores closed
    bars. The frontend gets the live rightmost bar from GET /chart/latest (which
    reads chart_store) and joins the two.

    `before` is the cursor for paging backwards (pass the earliest `t` the client
    currently holds). The fetch is always "newest `limit` rows descending, then
    reversed": an ascending limit would forever return the oldest rows no matter
    how much new data arrives (the same trap documented in _load_backtest_bars).
    """
    if interval not in ALLOWED_INTERVALS:
        raise HTTPException(status_code=400, detail="bad interval")
    q = db.query(Candle).filter(Candle.symbol == symbol.upper(), Candle.interval == interval)
    if before is not None:
        q = q.filter(Candle.t < before)
    rows = q.order_by(Candle.t.desc()).limit(limit).all()
    rows.reverse()
    return {
        "symbol": symbol.upper(),
        "interval": interval,
        "bars": [{"t": r.t, "o": r.o, "h": r.h, "l": r.l, "c": r.c, "v": r.v} for r in rows],
        # 前端据此判断"还能不能继续往左拉":拿满一整页就假定还有更早的。
        # Tells the client whether to keep paging left: a full page implies more.
        "hasMore": len(rows) == limit,
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
