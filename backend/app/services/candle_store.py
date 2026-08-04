"""K 线历史落库：只保存已经走完（收盘）的 K 线，供策略回测/长期回看使用。

与 `chart_store.py`（内存，图表画图用，重启即空）完全独立、互不依赖——
这里落库的是"走完的"K 线，`chart_store` 里既有走完的也有正在形成中的那根。

Persists only closed (finished) candles for backtesting/longer lookback.
Fully independent of `chart_store.py` (in-memory, powers the live chart,
cleared on restart) — this module stores finished bars only; `chart_store`
also holds the still-forming bar.
"""
import asyncio
import logging
from datetime import datetime, timedelta, timezone
from math import gcd

from starlette.concurrency import run_in_threadpool

from app.core.database import SessionLocal
from app.models import Candle
from app.services.page_stats import prune_visitor_days, purge_admin_visitors
from app.services.settings_store import get_candle_settings

logger = logging.getLogger("prismx.candle_store")

# 各周期的秒数,用于判断一根 K 线是否已经走完(t + 秒数 <= 当前时间)。
# Seconds per interval, used to decide whether a bar has closed (t + seconds <= now).
INTERVAL_SECONDS: dict[str, int] = {
    "1": 60,
    "5": 5 * 60,
    "15": 15 * 60,
    "60": 60 * 60,
    "240": 4 * 60 * 60,
    "D": 24 * 60 * 60,
}

# 7x24 交易、周末照常有真实行情的品种,不受下面的周末闸门约束。
# 判定用"是否以 BTC/ETH 等加密货币计价单位开头"会随新品种上线漏判,所以用显式集合:
# 漏掉一个加密品种只是让它的周末数据被拦(可发现、可修),而错把外汇放进来会让伪造
# 数据重新流进库里(难发现)。宁可保守。
# Symbols that genuinely trade 7x24 and have real weekend data, exempt from the
# weekend gate below. An explicit set rather than a "starts with BTC/ETH" rule,
# which would silently miss newly listed pairs: omitting a crypto symbol merely
# blocks its weekend data (visible and fixable), whereas wrongly admitting an FX
# pair lets fabricated bars back in (hard to notice). Prefer the conservative side.
WEEKEND_TRADING_SYMBOLS: frozenset[str] = frozenset({"BTCUSD", "ETHUSD"})

# 周末休市窗口(UTC):周五 21:00 收盘,周日 21:00 开盘。
#
# 为什么用固定的 UTC 边界,而不是券商/MT5 的服务器时区:MT5 服务器时区本身是
# GMT+2(冬令时)/GMT+3(夏令时),会随夏令时切换,把它硬编码进来会在换季那周判错。
# 而"周末休市"这件事的物理边界是全球统一的——纽约周五收盘、悉尼周日开盘,对应
# 21:00 UTC 前后,不随任何券商的时区设置改变。喂价端时钟偏差也不影响:时间戳在
# routers/chart.py 的 _correct_future_skew() 里已经纠正成对齐服务器的标准 UTC 秒,
# 到这一层拿到的就是可直接比较的 UTC。
#
# 边界各留一小时余量(收盘用 21:00、开盘用 21:00),覆盖不同券商 20:55–22:05 的
# 细微差异和夏令时那一小时;代价是周五收盘前/周日开盘后最边缘的一小段真实 bar
# 可能被拦掉。这个取舍是刻意的:少存几根边缘 bar 对回测无实质影响,而放进来一段
# 伪造行情会污染指标、凭空造出信号。
#
# 前提:到这一层的时间戳必须是真 UTC。曾经不是——EA 用 TimeGMTOffset()(本地机器
# 偏移)去换算券商服务器时间,时间戳整条平移了两小时,于是这个闸门按错位后的时间
# 判断,拦掉的和放行的都不是原本该拦该放的那些。那是 EA 侧的 bug,不是边界取值的
# 问题,修在 BrokerUtcOffset()。
#
# An hour of margin on each side absorbs the 20:55–22:05 spread across brokers and
# the DST hour. The cost is that the most marginal real bars right before the
# Friday close or right after the Sunday open may be dropped. That trade-off is
# deliberate: a few missing edge bars don't meaningfully affect backtests, whereas
# admitting a stretch of fabricated data corrupts indicators and fabricates signals.
#
# This assumes timestamps reaching this layer are true UTC. They weren't once: the
# EA converted broker server time using TimeGMTOffset() (the local machine's
# offset), shifting the whole axis by two hours, so this gate judged shifted times
# and both admitted and rejected the wrong bars. That was an EA-side bug, not a
# problem with these bounds — fixed in BrokerUtcOffset().
#
# Weekend close window (UTC): Friday 21:00 to Sunday 21:00.
#
# Fixed UTC bounds rather than the broker's/MT5's server timezone: that timezone
# is itself GMT+2 (winter) / GMT+3 (summer) and shifts with DST, so hardcoding it
# would misjudge the changeover week. The physical boundary of "the weekend" is
# globally fixed — New York closes Friday, Sydney opens Sunday, both around 21:00
# UTC — independent of any broker's timezone setting. Feed clock skew doesn't
# matter either: timestamps are already corrected to server-aligned UTC seconds by
# _correct_future_skew() in routers/chart.py, so what arrives here is directly
# comparable UTC.
#
# An hour of margin on each side absorbs the 20:55–22:05 spread across brokers and
# the DST hour. The cost is that the most marginal real bars right before the
# Friday close or right after the Sunday open may be dropped. That trade-off is
# deliberate: a few missing edge bars don't meaningfully affect backtests, whereas
# admitting a stretch of fabricated data corrupts indicators and fabricates signals.
_FRIDAY = 4
_SATURDAY = 5
_SUNDAY = 6
WEEKEND_CLOSE_HOUR_UTC = 21  # 周五这个钟点起休市 / market shut from this hour on Friday
WEEKEND_OPEN_HOUR_UTC = 21   # 周日这个钟点起开盘 / market open from this hour on Sunday


def _is_market_closed(t: float, symbol: str) -> bool:
    """判断时间戳 t(标准 UTC 秒)是否落在该品种的休市窗口内。

    只判周末,不判节假日:节假日表要按年、按品种、按券商维护,猜错会拦掉真实行情;
    而周末边界是固定的、可验证的。节假日期间的重放由 _is_replayed_duplicate() 那
    一层兜住——两层各管一段,互不依赖。

    Whether timestamp t (standard UTC seconds) falls in this symbol's closed
    window.

    Weekends only, no holiday calendar: holidays would need per-year, per-symbol,
    per-broker upkeep and a wrong guess drops real bars, whereas the weekend
    boundary is fixed and verifiable. Replays during holidays are caught by the
    _is_replayed_duplicate() layer instead — the two layers cover different ground
    and don't depend on each other.
    """
    if symbol.upper() in WEEKEND_TRADING_SYMBOLS:
        return False
    moment = datetime.fromtimestamp(t, timezone.utc)
    weekday = moment.weekday()
    if weekday == _SATURDAY:
        return True
    if weekday == _FRIDAY:
        return moment.hour >= WEEKEND_CLOSE_HOUR_UTC
    if weekday == _SUNDAY:
        return moment.hour < WEEKEND_OPEN_HOUR_UTC
    return False


# 每天扫一次即可,K 线不是分秒必争的时效数据 / once a day is plenty; candles aren't latency-sensitive
RETENTION_SWEEP_INTERVAL_SECONDS = 24 * 60 * 60

# 首轮清扫延后一点再开始,让 uvicorn 先 bind 端口。清扫单轮要一分多钟,顶在启动
# 路径上会让 nginx 全程 502;延后多久不重要,清掉的都是过期数据,不差这几秒。
# Delay the first sweep so uvicorn binds the port first. A pass takes over a
# minute, and sitting on the startup path makes nginx serve 502s the whole time;
# the exact delay doesn't matter since only stale data is being removed.
RETENTION_SWEEP_STARTUP_DELAY_SECONDS = 30


# 判定"重放副本"时,拿新 bar 与最近这么长时间内的已存 bar 比对。
#
# 早先这里是"最近 8 根"的滑动窗口,已被生产数据证伪:休市期间喂价端不只在两三个
# 模板之间交替,还会把**整段行情原样平移**——实测把 04:00–06:00 那 24 根 5 分钟线
# 搬到 06:00–08:00,每一根的原件都在 24 根之前。滑动窗口每接受一根就把它推进基线、
# 挤掉最老的一根,原件早被挤出去了,于是整段一根都拦不住。把窗口调大不是办法:已
# 验证放宽到 32 根会开始误判 4 小时线上跨越数月的偶然重合。
#
# 改成按时间跨度取基线。选 26 小时的依据:重放的原件一定来自"收盘前的真实行情",
# 而收盘时刻与当前时刻的距离在周末最长也就一天出头(周五收盘到周日重放的高峰),
# 26 小时能覆盖到收盘前那一段,又不会长到把几天前的行情拉进来比。
# 与"整段平移"正交:平移的偏移量是小时级(实测 2 小时),原件必然还在这个跨度内。
#
# Baseline for replay detection is now a time span, not a bar count.
#
# The previous "last 8 bars" sliding window was disproved by production data:
# while the market is closed the feed doesn't only alternate between a couple of
# templates, it also **replays whole stretches verbatim** — observed shifting the
# 24 five-minute bars of 04:00–06:00 onto 06:00–08:00, putting every original 24
# bars back. A sliding window pushes each accepted bar onto the baseline and
# evicts the oldest, so the originals were long gone and not one of them was
# caught. Enlarging the window isn't the fix: widening to 32 was verified to
# start misjudging coincidental matches months apart on the 4-hour series.
#
# 26 hours is chosen because a replay's original always comes from the real
# session before the close, and the distance from that close is at most a bit
# over a day (Friday close through the peak of weekend replaying). It reaches
# back past the close without dragging in days-old prices. This is orthogonal to
# the whole-stretch shifting: those offsets are hours (2h observed), so the
# original stays well inside the span.
#
# 26 小时只够覆盖普通周末。节假日连休(圣诞、元旦,或市场突然放假)会把休市拉长到
# 两三天甚至更久,那时重放的原件落在 26 小时之外,判定会和当初的滑动窗口一样整段
# 失效——已用 12 月场景实测确认:周三收盘、周五重放,间隔 48 小时,24 根副本里 23
# 根被照单全收。
#
# 但不能简单把常量调到 100 小时:跨度越长,基线里塞进的历史行情越多,4 小时线上
# 跨越数日的偶然重合就会开始被误判成副本(把窗口从 8 根放宽到 32 根时已经观察到
# 这个失效模式)。所以按周期分档:短周期(1/5/15 分钟)一天就有几百根,靠"根数"就足
# 以区分真伪,跨度可以给得很长而不担心误判;长周期(240 分钟、日线)本身根数稀少,
# 跨度必须收紧,否则会拿几周前的行情来比。
#
# 26 hours only covers an ordinary weekend. Holiday closures (Christmas, New
# Year, or a market that suddenly shuts) stretch the gap to two or three days or
# more, putting the replay's original outside the span — at which point the check
# fails wholesale exactly as the old sliding window did. Verified against a
# December scenario: a Wednesday close replayed on Friday, 48 hours apart, had 23
# of 24 copies accepted.
#
# Simply raising the constant to ~100 hours isn't safe either: a longer span pulls
# more history into the baseline, and coincidental matches days apart on the
# 4-hour series start being misjudged as copies (the same failure mode observed
# when widening the window from 8 to 32 bars). So the span is tiered by interval:
# short intervals (1/5/15m) have hundreds of bars per day, so sheer bar count
# distinguishes real from fake and the span can be generous; long intervals (240m,
# daily) are inherently sparse and need a tighter span or they'd be compared
# against weeks-old prices.
REPLAY_LOOKBACK_SECONDS = 26 * 60 * 60

# 按周期定制的基线跨度。未列出的周期回落到 REPLAY_LOOKBACK_SECONDS。
#
# 短周期给到 5 天:足以覆盖"周五收盘 → 下周三还在重放"这种极端长假,而 1 分钟线 5
# 天也就 7200 根,量化到小数第六位的五字段全等在真实行情里几乎不可能碰巧发生。
# 240 分钟线维持 26 小时不变:它一天只有 6 根,跨度放长最容易误伤——之前正是在这个
# 周期上验证出跨月偶然重合的误判。日线同理保持最短。
#
# Per-interval baseline spans; intervals not listed fall back to the constant.
#
# Short intervals get 5 days: enough for "Friday close still being replayed the
# following Wednesday", and 5 days of M1 is only ~7200 bars, where an exact
# five-field match quantised to six decimals essentially cannot occur by chance in
# real data. The 4-hour series stays at 26 hours: with only 6 bars a day it's the
# most vulnerable to a long span — it's the very series on which months-apart
# coincidental matches were observed. Daily stays tight for the same reason.
REPLAY_LOOKBACK_SECONDS_BY_INTERVAL: dict[str, int] = {
    "1": 5 * 24 * 60 * 60,
    "5": 5 * 24 * 60 * 60,
    "15": 5 * 24 * 60 * 60,
    "60": 3 * 24 * 60 * 60,
    "240": 26 * 60 * 60,
    "D": 26 * 60 * 60,
}

# 基线的行数上限,纯粹是防御性的内存/查询开销上限,不参与判定语义。
#
# 这个上限必须大于最长跨度实际会取到的行数,否则它会**悄悄**变成真正的窗口:查询按
# 时间倒序取,一旦被截断,跨度里最早的那些行(正是长假重放要比对的原件)会被丢掉,
# 判定退化成"最近 N 根"——也就是最初那个已被生产证伪的失效模式,而且没有任何报错。
# 1 分钟线 5 天 = 7200 根,给到 12000 留出余量。
#
# A defensive cap on baseline rows (memory/query cost only, no semantic role).
#
# It must exceed the row count the longest span actually reaches, or it silently
# becomes the real window: the query orders by time descending, so truncation drops
# the oldest rows in the span — precisely the originals a holiday replay needs to
# be compared against — degenerating the check into "last N bars", the very failure
# mode production already disproved, with no error to show for it. Five days of M1
# is 7200 bars, so 12000 leaves headroom.
REPLAY_BASELINE_MAX_ROWS = 12000

# OHLC 比较的精度:价格量化到小数第几位算"同一个报价"。价格是 Float 列,经过 JSON
# 与 float 往返后同一个报价可能有末位误差,精确相等会漏判;而外汇报五位小数,量化到
# 第六位远细于最小价位变动,不会把两个真正不同的价格合并成一个。
# 判定实现见 _replay_key():量化后进 set 做哈希查找,不再逐根比浮点差值。
# Precision for OHLC matching: the decimal place at which two prices count as the
# same quote. Prices are Float columns and a JSON/float round trip can leave
# last-bit error, so exact equality would miss matches; FX quotes to five
# decimals, and rounding at the sixth is far finer than the minimum tick, so two
# genuinely different prices are never merged.
# See _replay_key() for the implementation: quantised keys go into a set for hash
# lookup rather than per-bar float-difference comparisons.
_PRICE_DECIMALS = 6


# 喂价端换算 UTC 时可能用到的最细时区粒度(秒)。现实中券商时区偏移只有整小时或
# 半小时(GMT+5:30 这类),EA 侧的 BrokerUtcOffset() 也正是按这个粒度量化的。
# The finest timezone granularity a feed may use when converting to UTC. Real
# broker offsets are only ever whole or half hours (GMT+5:30 and friends), and the
# EA's BrokerUtcOffset() quantises to exactly this granularity.
_TIMEZONE_QUANTUM_SECONDS = 1800


def _grid_seconds(interval_seconds: int) -> int:
    """这个周期的时间戳必须对齐到的网格(秒)——不管喂价端在哪个时区都成立的那个。

    不能直接用 interval_seconds 本身。分钟级周期(1/5/15 分钟)确实对齐到 UTC 整点
    网格,因为它们的长度整除半小时:喂价端减掉一个整数倍的半小时偏移后,网格位置不
    变。但 1 小时/4 小时/日线不是——它们对齐的是**券商当地的整点/午夜**,而券商可能
    在半小时时区(GMT+5:30),此时一根真实的小时线换算成 UTC 后就落在 :30 上。按
    interval_seconds 判会把这类券商的全部长周期 bar 误杀。

    取 gcd(周期长度, 半小时)得到"任何时区偏移下都必然成立"的最细网格:
      1 分钟 → 60、5 分钟 → 300、15 分钟 → 900、1 小时/4 小时/日线 → 1800。
    这个粒度足以抓住本次要防的错位(整分钟级),又不会误判任何合法时区。
    代价是 1 分钟线上的整分钟错位无法用网格判出来(60 秒的平移把网格映射回自身),
    这是这个判据的固有盲区,不是取值保守——没有外部信息可以区分。

    The grid (in seconds) this interval's timestamps must sit on, chosen so it
    holds regardless of the feed's timezone.

    interval_seconds itself won't do. Minute-level intervals (1/5/15m) genuinely
    align to the UTC grid because their length divides the half hour: subtracting a
    whole number of half-hour offsets leaves the grid position unchanged. H1/H4/D
    do not — they align to the *broker's local* hour/midnight, and a broker in a
    half-hour zone (GMT+5:30) produces a genuine hourly bar that lands on :30 once
    converted to UTC. Testing against interval_seconds would reject every
    long-interval bar from such a broker.

    gcd(interval, half hour) gives the finest grid that must hold under any
    timezone offset: 60 / 300 / 900 for 1/5/15m, 1800 for H1/H4/D. That's fine
    enough to catch the whole-minute misalignment this gate targets without
    misjudging any legitimate zone.
    The cost is that a whole-minute shift on the 1-minute series can't be detected
    this way (a 60s shift maps that grid onto itself). That's an inherent blind spot
    of the predicate rather than a conservative choice — no external information
    exists to distinguish the two.
    """
    return gcd(interval_seconds, _TIMEZONE_QUANTUM_SECONDS)


def _replay_key(bar: dict) -> tuple:
    """把一根 bar 的 OHLCV 压成可哈希的指纹,用于 O(1) 判重。

    价格量化到 _PRICE_DECIMALS 位小数:黄金报两位小数、外汇五位,量化到第六位不会把
    两个真正不同的报价合并,也能吸收 JSON/float 往返的末位误差。
    原来逐根线性比对在基线只有 8 根时无所谓,改成按时间跨度取基线后可达上千根(短
    周期放宽到 5 天后上限是 12000 根),一批又有几十根,再线性扫就是几十万次浮点比较;
    指纹入 set 后判定与基线大小无关——这也是能把跨度放宽到覆盖长假的前提。

    Collapses a bar's OHLCV into a hashable fingerprint for O(1) matching.

    Prices are quantised to _PRICE_DECIMALS: gold quotes to 2 decimals and FX to
    5, so rounding at the 6th never merges two genuinely different quotes, while
    still absorbing JSON/float round-trip error. The previous per-bar linear scan
    was fine against an 8-row baseline, but with a 26-hour span the baseline
    reaches thousands of rows and a batch carries dozens — a linear scan would
    mean tens of thousands of float comparisons. With fingerprints in a set the
    check no longer depends on baseline size.
    """
    return (
        round(bar["o"], _PRICE_DECIMALS),
        round(bar["h"], _PRICE_DECIMALS),
        round(bar["l"], _PRICE_DECIMALS),
        round(bar["c"], _PRICE_DECIMALS),
        bar.get("v", 0),
    )


# "价格停滞"判定:连续这么多根 bar 的收盘价完全不变,就认为该品种已经休市。
#
# 为什么需要这条:节假日、以及"突如其来"的临时休市(券商单方面停某个品种、突发事件
# 导致市场关闭)都不在任何固定日历里,按日期判一定会漏。而所有休市场景有一个共同的、
# 可直接观测的特征——真实成交停止后,报价不再变化。判这个特征不需要知道"今天是什么
# 节日",也不需要按年维护任何表,新品种上线、券商换规则都自动适用。
#
# 阈值取 6 根的依据:真实行情里连续 6 根收盘价完全相同(量化到小数第六位)需要极低的
# 流动性,在主要品种上不会发生;而只要 6 根就能在休市后很快收敛,不至于放进去太多。
# 取太小(比如 2~3 根)会误伤亚洲时段的清淡盘,那时确实可能连续两三根几乎不动。
#
# 与另外两道闸门正交:周末闸门按固定日期判、重放判定要求与历史某根全等,而这条只看
# "价格有没有在动",既不需要日历也不要求副本与历史重合——EA 若生成全新的、缓慢漂移
# 的伪造数据,前两道都拦不住,这条能拦住其中最常见的一类(报价冻结)。
#
# Stall detection: this many consecutive bars with an unchanged close means the
# symbol's market is treated as shut.
#
# Why this is needed: holidays and *sudden* closures (a broker unilaterally halting
# a symbol, an event shutting the market) appear in no fixed calendar, so any
# date-based rule will miss them. Every closure does share one directly observable
# trait, though — once real trading stops, the quote stops changing. Detecting that
# requires no knowledge of which holiday it is and no yearly upkeep, and it applies
# automatically to newly listed symbols and changed broker rules.
#
# The threshold of 6 comes from real data needing extraordinarily thin liquidity to
# print 6 consecutive identical closes (quantised to six decimals), which doesn't
# happen on major symbols, while still converging quickly after a close. A smaller
# value (2–3) would misfire during quiet Asian hours, where two or three nearly
# static bars genuinely occur.
#
# Orthogonal to the other two gates: the weekend gate judges by fixed dates and the
# replay check demands an exact match against history, whereas this one only asks
# whether the price is moving — no calendar, no need for the copy to coincide with
# history. If the EA produced wholly novel, slowly drifting fabrications the first
# two would miss them; this catches the most common such class (a frozen quote).
STALLED_CLOSE_BARS = 6


def _stalled_tail_length(bars: list[dict], previous_closes: list[float]) -> int:
    """返回这批 bar 末尾有多少根处于"价格停滞"状态,应当作休市数据丢弃。

    丢的是**尾段**而不是头段:停滞一旦确认,从确认那根起往后全部是休市数据。头几根
    (凑够阈值之前的那些)反而必须放行,原因见下面循环处的注释。

    previous_closes 是库里已存的、紧邻这批之前的收盘价(时间升序)。必须带上它:休市
    后的第一批 bar 自身可能只有两三根,单看批内凑不满阈值,要接上库里那段才能判出
    "已经连续 N 根不动了"。

    完全平坦的 bar(h == l)不豁免:这里判的正是"价格不动",而平坦恰恰是休市冻结报价
    最典型的形态——_is_replayed_duplicate() 豁免平坦 bar 是因为它没有可被复制的内部
    结构、无法作为"副本"的证据,与这里的判据无关,两者不冲突。

    How many bars at the end of this batch are stalled and should be dropped as
    closed-market data.

    The **tail** is dropped, not the head: once a stall is confirmed, that bar and
    everything after it is closed-market data. The leading bars (those before the
    threshold is reached) must instead be let through; see the comment at the loop.

    previous_closes are the stored closes immediately preceding this batch (ascending
    order). They're required because the first batch after a close may itself hold
    only two or three bars — too few to reach the threshold on their own — and needs
    the stored tail to establish that the price has been static for N bars.

    Perfectly flat bars (h == l) are not exempt here: a static price is exactly what
    this checks, and flatness is the classic shape of a frozen quote.
    _is_replayed_duplicate() exempts flat bars because they carry no copyable
    internal structure and so can't evidence a *copy* — a different question, so the
    two rules don't conflict.
    """
    if not bars:
        return 0
    # 用与重放判定相同的量化精度,避免 JSON/float 往返的末位误差被当成"价格在动"。
    # Same quantisation as the replay check, so JSON/float round-trip error in the
    # last bit isn't mistaken for the price moving.
    prior = [round(c, _PRICE_DECIMALS) for c in previous_closes]
    batch = [round(b["c"], _PRICE_DECIMALS) for b in bars]

    # 把库里那段和本批接成一条连续序列,索引 offset 之后才是本批。这样"连续多少根不
    # 动"就是一次普通的游程统计,不必区分"来自库里"还是"来自批内"。
    # Splice the stored tail onto the batch as one continuous series, with the batch
    # starting at index `offset`. The "how many consecutive static bars" question is
    # then a plain run-length count, with no need to distinguish stored from batch.
    series = prior + batch
    offset = len(prior)

    # 从批次第一根往后走,累计"当前价格已经连续多少根没变"。
    #
    # 达到阈值之后的每一根都判为休市数据。阈值之内的前几根**必须放行**:休市刚发生的
    # 那一刻,"价格连续 3 根没动"与"亚洲时段清淡盘"在数据上无法区分,此时丢弃就会误伤
    # 真实行情。代价是每次休市会漏进阈值-1 根冻结 bar,这是这个判据的固有下限——它换来
    # 的是不需要任何日历、对突发休市同样有效。剩下那几根若与历史全等,还有重放判定兜。
    #
    # Walk forward from the batch's first bar, tracking how many consecutive bars the
    # current price has held.
    #
    # Every bar past the threshold is judged closed-market data. The first few within
    # the threshold **must be let through**: at the moment a closure begins, "the price
    # hasn't moved for 3 bars" is indistinguishable from a thin Asian session, and
    # dropping then would discard real data. The cost is that each closure admits
    # threshold-1 frozen bars — the inherent floor of this approach, in exchange for
    # needing no calendar and working on unscheduled closures. Any of those remaining
    # bars that exactly match history are still caught by the replay check.
    run = 1
    for i in range(1, offset + len(batch)):
        run = run + 1 if series[i] == series[i - 1] else 1
        if i < offset:
            continue
        if run >= STALLED_CLOSE_BARS:
            # 一旦确认停滞,这一根及其之后全部丢弃。不再检查是否"恢复波动":冻结价格之后
            # 若又开始变动,那是喂价端在伪造行情,而不是市场重开——市场重开会先有真实成交,
            # 表现为价格跳变,而跳变后的那批 bar 会以新批次进来,届时游程从 1 重新起算,
            # 自然放行。
            # Once a stall is confirmed, this bar and everything after it is dropped. No
            # check for "movement resumed": a price that starts varying after a freeze is
            # the feed fabricating data, not the market reopening — a genuine reopen
            # begins with real trades, i.e. a price jump, and those bars arrive in a later
            # batch where the run restarts at 1 and passes naturally.
            return len(batch) - (i - offset)
    return 0


def _is_replayed_duplicate(bar: dict, recent: set[tuple]) -> bool:
    """判断一根 bar 是不是喂价端重放的旧 bar 副本(休市期间的伪造 K 线)。

    休市之后 EA 仍然连着 MT5、仍然按周期推 bar,但推的不是冻结报价,而是把收盘前
    真实 bar 的 **o/h/l/c/v 五个字段整根复制**,只换上新的时间戳。实测有两种形态:

    形态一,少数模板来回交替(XAUUSD/15,2026-07-24 周五收盘后):

        20:30 o=4053.36 h=4055.70 l=4051.30 c=4055.12 v=1002   ← 真实
        20:45 o=4055.12 h=4055.77 l=4051.82 c=4052.66 v=795    ← 真实
        21:00 o=4055.12 h=4055.77 l=4051.82 c=4052.66 v=795    ← 20:45 的副本
        22:45 o=4053.36 h=4055.70 l=4051.30 c=4055.12 v=1002   ← 20:30 的副本
        (一直交替到周一开盘)

    形态二,整段行情原样平移(XAUUSD/5,2026-08-01 周六),偏移固定 2 小时:

        06:00 = 04:00 的副本
        06:05 = 04:05 的副本
        ...   (连续 24 根,一根不差)
        07:55 = 05:55 的副本

    形态二是"最近 8 根"滑动窗口失效的原因——每根的原件都在 24 根之前,而窗口每
    接受一根就挤掉最老的一根,原件早已不在基线里。所以基线按时间跨度取
    (REPLAY_LOOKBACK_SECONDS),不按根数。

    这些 bar 时间上确实"已收盘",能通过收盘判定,但它们不是行情。落库后:
      ① 回测图上休市段被一长串来回重复的蜡烛填满(两个模板一涨一跌,于是呈现为
         红绿相间的平带),真实的周末跳空被抹平;
      ② 更要紧的是回测被污染:同一段价格被反复喂给指标,BOLL 这类基于标准差的
         指标在这里收缩、均线被拉平,一到周一开盘必然触发穿越,凭空造出入场
         信号,胜率与信号数因此失真。

    判定用"整根 OHLCV 与近期某根完全相同",不去猜交易时段:时段表要处理各品种
    时段、夏令时、逐年变化的节假日和 broker 差异,维护成本高且猜错窗口会删掉真
    实 bar(不可逆)。而五个字段(两位小数的价格 + 上千的成交量)同时逐一相同,在
    真实行情里实际上不会发生,是个可直接验证的特征。

    注意不能只比价格:真实行情里相邻 bar 的 OHLC 偶然接近是可能的,但连 volume
    都一模一样才是"整根复制"的铁证,所以 volume 必须参与比较。

    Detects a bar that is a replayed copy of an older one (a fabricated bar
    pushed while the market is closed).

    After the close the EA stays connected to MT5 and keeps pushing bars on
    schedule — but not frozen quotes. It copies **all five o/h/l/c/v fields**
    of the last few real bars verbatim, stamps them with new timestamps, and
    cycles between two or three templates. Observed on XAUUSD/15 after the
    2026-07-24 Friday close (see the table above).

    These bars have genuinely "closed" in time terms and pass the closed check,
    but they aren't market data. Once stored:
      ① the backtest chart fills the closed session with a long run of
         repeating candles (the two templates being one up and one down, which
         renders as the red/green flat band), erasing the real weekend gap;
      ② more importantly the backtest is corrupted: the same stretch of price
         is fed to the indicators over and over, so stddev-based ones like
         Bollinger contract and moving averages flatten, making a cross at the
         Monday open inevitable — fabricated entry signals that skew win rate
         and signal counts.

    The predicate is "the whole OHLCV matches a recent bar" rather than a
    guess at trading sessions: a session calendar has to handle per-symbol
    hours, DST, yearly-changing holidays and broker differences, and guessing
    the window wrong deletes real bars (irreversible). Five fields matching
    exactly (two-decimal prices plus four-digit volume) effectively cannot
    happen in live data, which makes it a directly verifiable signal.

    Volume must take part in the comparison: neighbouring real bars can happen
    to have similar OHLC, but an identical volume as well is what proves the
    bar is a verbatim copy.

    完全平坦的 bar(h == l,即整根没有任何高低差)不参与判定,直接放行。这种 bar 没
    有"可被复制的内部结构",连续出现只说明该周期内价格确实没动过(极低流动性、或
    合成/测试数据),不是重放的证据;把它们也当副本删掉会误伤真实的平盘行情。生产
    上观察到的重放副本都带着真实的高低差(rng 3~8 美元),不受这条豁免影响。

    Perfectly flat bars (h == l, i.e. no intrabar range at all) are exempt and
    always pass. Such a bar has no internal structure that could be copied, so a
    run of them only means the price genuinely didn't move in that period (very
    thin liquidity, or synthetic/test data) — that isn't evidence of replay, and
    dropping them would discard real flat markets. The replays observed in
    production all carry a real high/low range (3–8 dollars), so this exemption
    doesn't weaken the fix.
    """
    if bar["h"] == bar["l"]:
        return False
    return _replay_key(bar) in recent


def filter_tradeable_bars(
    db, symbol: str, interval: str, bars: list[dict],
    include_forming: bool = False,
) -> list[dict]:
    """把 `bars` 过成"确实是真实交易时段产生的"那一部分,按时间升序返回。

    四道闸门都在这里:周期网格(按时间戳自身的合法性)、周末窗口(按时间)、价格停滞
    (按行为)、重放副本(按内容)。网格那道必须最先跑,后面三道都以"时间戳可信"为前提。
    persist_closed_bars() 拿它的结果写库;routers/chart.py 拿它的结果更新内存缓存,
    两条路径因此看到完全一致的过滤结果。

    **闸门必须集中在这一个函数里**,不能让调用方各自过滤。之前内存缓存那条路就是
    直接用了未过滤的原始 bars,结果库里被正确拦掉的伪造 K 线照样出现在前端图表上
    ——同一份数据经过两套不同的判断,是这类漏洞的根源。任何新增的数据出口都应该
    调这个函数,而不是自己重写判断。

    `include_forming=True` 时保留最后那根仍在形成中的 bar(其余闸门照常生效)。内存
    缓存要用这个:图表最右侧那根跳动的蜡烛正是它,全过滤掉的话日线图上"今天"会整根
    消失、分钟图的最新一根永远慢一个周期。数据库不能用——库里只存已收盘的 bar,存进
    未收盘的会让回测把一根没走完的 bar 当成事实。
    注意:休市判定仍然照常作用于这根,所以休市期间它依然会被拦掉,不会漏出伪造蜡烛。

    Filter `bars` down to those genuinely produced by a live session, in ascending
    time order.

    With `include_forming=True` the final still-forming bar is kept (all other gates
    still apply). The in-memory cache needs this: that bar *is* the live rightmost
    candle, and dropping it would make "today" vanish from a daily chart and leave
    minute charts permanently one interval behind. The database must not use it —
    it stores only closed bars, and persisting an unfinished one would let backtests
    treat a partial bar as fact.
    Note the closure gates still apply to this bar, so during a closure it is still
    rejected and no fabricated candle leaks through.

    All four gates live here: the interval grid (the timestamp's own validity), the
    weekend window (by time), the stalled price (by behaviour) and replayed copies
    (by content). The grid gate must run first — the other three all presume a
    trustworthy timestamp. persist_closed_bars() writes the result to the database
    and routers/chart.py feeds the same result into the in-memory cache, so both
    paths see identical filtering.

    **The gates must stay centralised in this one function** rather than being
    reapplied by each caller. The in-memory cache path previously used the raw,
    unfiltered bars, so fabricated candles correctly rejected from the database
    still reached the frontend chart — one dataset judged by two different code
    paths is the root of that class of bug. Any new data outlet should call this
    function instead of reimplementing the checks.
    """
    seconds = INTERVAL_SECONDS.get(interval)
    if seconds is None or not bars:
        return []

    # 第零道闸门:时间戳必须落在这个周期的网格上,不在的直接拒收。
    #
    # 放在所有闸门最前面,因为后面每一道都以"时间戳可信"为前提:收盘判定要拿 t+周期
    # 跟当前时间比、周末闸门要按 t 换算星期与钟点、停滞判定要沿时间轴数游程。喂错位
    # 的时间戳喂给它们,它们不会报错,只会静静地算错——正是这个模块反复吃过亏的那类
    # 失败。
    #
    # 拦的是这个:喂价端把整批 bar 的时间戳平移了非整周期的量(实测 EA 的
    # BrokerUtcOffset() 曾因整数除法向下截断,在 tick 滞后 1 秒时把偏移少算 60 秒,
    # 于是 10:30 那根 15 分钟线带着 10:31 的时间戳发过来)。这种 bar 落在网格之外,
    # 内存缓存把它当成一根全新的 bar 追加、库里 (symbol,interval,t) 唯一约束也认为
    # 它是新行,于是图表上多出一根 10:31 的蜡烛;更糟的是它还会顶掉之后那根正确的
    # 10:30——两者 OHLCV 完全相同,正确的那根会被重放闸门当成副本丢弃,于是错位的
    # 时间戳永久留在库里。
    #
    # 已经在 EA 侧修掉了根因(改用 TimeTradeServer + 四舍五入到半小时),这道闸门是
    # 独立的兜底:喂价端是部署在用户机器上的、我们无法保证版本的组件,任何一个跑着
    # 旧版 EA 的用户、或将来任何新喂价器的类似算错,都不该再污染库和图表。
    #
    # Gate zero: timestamps must sit on this interval's grid; off-grid bars are
    # rejected outright.
    #
    # First of all the gates, because every later one presumes the timestamp is
    # trustworthy: the closed check compares t+interval against now, the weekend gate
    # derives a weekday and hour from t, and the stall check counts a run along the
    # time axis. Fed a misaligned timestamp none of them raise — they quietly compute
    # the wrong answer, the exact failure class this module has been bitten by
    # repeatedly.
    #
    # What it catches: a feed shifting a whole batch by a non-interval amount. The
    # EA's BrokerUtcOffset() did this via truncating integer division — with a tick
    # lagging one second it subtracted 60 seconds too little, so the 10:30 bar of a
    # 15-minute series arrived stamped 10:31. Such a bar lands off-grid, the
    # in-memory cache appends it as a brand-new bar and the database's
    # (symbol, interval, t) uniqueness accepts it as a new row, so the chart grows a
    # stray 10:31 candle. Worse, it then displaces the correct 10:30 bar: the two
    # share identical OHLCV, so the real one is discarded as a replay and the
    # misaligned timestamp stays in the database permanently.
    #
    # The root cause is fixed EA-side (TimeTradeServer plus rounding to the half
    # hour); this gate is the independent backstop. The feed runs on user machines at
    # a version we can't guarantee, and neither a user still on an old EA build nor
    # any future feeder making a similar arithmetic slip should be able to pollute
    # the database and the chart again.
    grid = _grid_seconds(seconds)
    aligned = [b for b in bars if b["t"] % grid == 0]
    misaligned_count = len(bars) - len(aligned)
    if misaligned_count:
        # 这个必须是 warning:与周末/停滞/重放不同,错位的时间戳**永远**意味着喂价端
        # 算错了,没有任何正常场景会产生它。静默丢弃会让一个跑着旧版 EA 的部署始终少
        # 数据而没人知道——这个模块上一次的静默故障持续了三天。
        # Warning level, unlike the weekend/stall/replay gates: a misaligned timestamp
        # *always* means the feed miscomputed, with no legitimate scenario producing
        # one. Dropping it silently would leave a deployment on an old EA build quietly
        # short of data — this module's last silent failure ran for three days.
        example = next(b["t"] for b in bars if b["t"] % grid != 0)
        logger.warning(
            "filter_tradeable_bars: %s/%s rejected %d bar(s) whose timestamp is off "
            "the %ds grid (e.g. t=%d, %+ds off; the feed converted its clock to UTC "
            "with a non-whole-interval offset — check the EA's BrokerUtcOffset and "
            "that it's running the current build)",
            symbol, interval, misaligned_count, grid, example, example % grid,
        )
    if not aligned:
        return []
    bars = aligned

    now = datetime.now(timezone.utc).timestamp()
    # 一根 bar 满足下面任一条件就算"已收盘"：
    # ① 绝对时钟判定——bar 的收盘时刻早于等于服务器当前时间(常规情况下这条
    #    就够了)；
    # ② 相对判定——同一批里存在时间戳比它更晚的 bar,说明喂价端已经开始形成
    #    更新的一根,这一根必然已经走完,不管喂价端的时钟跟服务器时钟是否对
    #    得上都成立(tick 模式固定推最新 2 根、backfill 模式最后一根才是仍在
    #    形成中的,前面的都有"更晚的邻居"作证)。
    # 加②是为了在喂价端(EA/其运行机器)时钟跑偏、且两边时钟都不方便/不允许
    # 改动时依然能正确判定——真实事故:EA 时钟超前约 11 小时,MT5 服务器时间
    # 改不了、本地系统时间本身是对的也不该为了这个去改,①在这种情况下永远
    # 为假,1 分钟线永远插不进数据库。②不依赖任何一边的绝对时钟,天然免疫
    # 这类偏差。
    # A bar counts as "closed" if EITHER: ① the absolute-clock check — its
    # close time is at or before the server's current time (sufficient under
    # normal conditions); OR ② the relative check — this batch also contains
    # a bar with a strictly later timestamp, proving the feed has already
    # started forming a newer bar, so this one must be finished regardless of
    # whether the feed's clock agrees with the server's (tick mode always
    # sends the latest 2 bars; in backfill mode only the very last bar is
    # still forming — every earlier one has a "later neighbor" vouching for it).
    # ② exists so a skewed feed clock (EA / its host machine) doesn't
    # permanently block persistence in situations where neither clock can
    # reasonably be changed — a real incident had the EA clock running ~11h
    # fast, with the broker's server time not being user-adjustable and the
    # local system clock already correct and not something to touch just for
    # this. ① would stay permanently false in that case; ② doesn't depend on
    # either side's absolute clock, so it's immune to this class of skew.
    latest_t = max(b["t"] for b in bars)
    # ②的门槛是"更晚的邻居至少跨过一个完整周期",不是单纯"存在更晚的邻居"。
    #
    # 原先只要 b["t"] < latest_t 就算收盘,而 tick 模式固定推最新 2 根:这 2 根里
    # 较早的那根其实仍在形成中,却因为有个只晚一个周期、自己也没收盘的邻居就被
    # 放行入库。配合 persist_closed_bars() 的"已存在就跳过",库里那根被永久定格
    # 在形成初期的半成品上——实测 XAUUSD 20:55 那根 5 分钟线锁死在 C=4055.14,
    # 而它后 4 分钟真实跌到 4043.82,存下来的收盘价比自己后来的真实最低价还高。
    #
    # 要求邻居跨过一个完整周期,才真正证明这一根已经走完。同时保留了②抗时钟偏移
    # 的初衷:EA 时钟偏移 11 小时时,backfill 批次里每根都有远超一个周期的更晚邻
    # 居,判定照旧成立。
    #
    # ② requires the later neighbour to be at least one full interval ahead, not
    # merely later. The old `b["t"] < latest_t` admitted the earlier of the two
    # bars that tick mode always sends, which is itself still forming; combined
    # with persist_closed_bars() skipping timestamps that already exist, the row
    # got frozen at that half-formed snapshot (observed: XAUUSD 20:55 M5 stuck at
    # C=4055.14 while price went on to 4043.82 within the same bar, leaving a
    # stored close above the bar's own later low). Demanding a full interval of
    # separation proves the bar actually finished, while keeping ②'s clock-skew
    # immunity: with an 11h-fast EA clock every backfill bar still has a
    # neighbour far more than one interval ahead.
    # include_forming 只放宽"是否收盘"这一条,后面三道休市闸门对它一视同仁。
    # include_forming relaxes only the closed-or-not test; the three closure gates
    # below still apply to it exactly as they do to every other bar.
    closed = [
        b for b in bars
        if include_forming or b["t"] + seconds <= now or b["t"] + seconds <= latest_t
    ]

    if not closed:
        # 有了②(相对判定)之后,这条分支只在批次里连"更晚的邻居"都找不到时才
        # 会走到——也就是这批实际上只有一根独一无二的时间戳,且它本身还没到
        # 绝对时钟的收盘门槛(单根 tick 的极端情况;正常 tick/backfill 批次都有
        # 至少 2 根,不会触发这里)。比引入②之前更少见,但一旦出现仍然值得关注,
        # 打一行 WARNING 方便第一时间在日志里发现——之前一次真实事故里,喂价端
        # 时钟跑偏导致的类似状态安安静静持续了三天才被发现。
        # With ② (the relative check) in place, this branch is only reached
        # when the batch doesn't even have a "later neighbor" to fall back on
        # — i.e. it's effectively a single unique timestamp that also misses
        # the absolute-clock threshold (an edge case; normal tick/backfill
        # batches always have at least 2 bars and won't hit this). Rarer than
        # before ② existed, but still worth flagging — a real incident once
        # had a feed-clock-skew situation like this persist silently for three
        # days before anyone noticed; this WARNING surfaces it immediately.
        latest_gap_hours = (max(b["t"] for b in bars) - now) / 3600
        logger.warning(
            "filter_tradeable_bars: %s/%s got %d bar(s) but none are closed yet "
            "(latest bar is %.1fh ahead of server time; positive means the feed's "
            "clock is running fast — check the EA/feeder's time source if this recurs)",
            symbol, interval, len(bars), latest_gap_hours,
        )
        return []

    # 第一道休市闸门:周末休市期间的 bar 一律不收(BTCUSD 等 7x24 品种豁免)。
    #
    # 这一层与下面的重放判定是**两道独立的闸门**,故意都保留:
    #   · 周末闸门按时间判定,不看内容。哪怕 EA 推来的是全新的、不重复任何历史的
    #     伪造数据,只要落在休市窗口内就拦住。这是"周末绝对不该有数据"这条业务
    #     事实的直接表达,不依赖对伪造手法的任何假设。
    #   · 重放判定按内容判定,不看时间。它覆盖周末之外的场景:节假日休市、EA 断线
    #     重连后重放缓存、盘中喂价异常。
    # 单靠重放判定不够——它的前提是"副本必须与某根真实 bar 完全相同",而这是关于
    # 伪造手法的假设,生产上已经被推翻过一次(整段平移穿过了滑动窗口)。周末闸门不
    # 做这种假设,所以放在前面。
    #
    # First gate: reject bars stamped inside the weekend close (7x24 symbols like
    # BTCUSD are exempt).
    #
    # This and the replay check below are **two independent gates**, both kept on
    # purpose:
    #   · The weekend gate judges by time, ignoring content. Even wholly novel
    #     fabricated data that duplicates nothing is rejected if it lands in the
    #     closed window. It states the business fact "there is no weekend data"
    #     directly, without assuming anything about how the fabrication looks.
    #   · The replay check judges by content, ignoring time. It covers what the
    #     weekend gate can't: holiday closures, a reconnecting EA flushing its
    #     cache, mid-session feed glitches.
    # The replay check alone isn't enough — it presumes a copy matches some real
    # bar exactly, an assumption about the fabrication's shape that production has
    # already falsified once (whole-stretch shifting slipped past the sliding
    # window). The weekend gate makes no such assumption, so it goes first.
    in_session = [b for b in closed if not _is_market_closed(b["t"], symbol)]
    closed_market_count = len(closed) - len(in_session)
    if closed_market_count:
        # 周末拦下数据是预期行为,记 info 而非 warning:每个周末都会出现,升到
        # warning 会让真正的异常被噪音埋掉(这个模块已经吃过一次这种亏)。
        # Rejecting weekend bars is expected, so info rather than warning: it
        # happens every weekend and escalating would bury genuine anomalies in
        # noise (a lesson this module has already learned once).
        logger.info(
            "filter_tradeable_bars: %s/%s rejected %d bar(s) stamped inside the "
            "weekend close (market shut; only 7x24 symbols may report then)",
            symbol, interval, closed_market_count,
        )
    closed = in_session
    if not closed:
        return []

    # 第二道休市闸门:价格停滞即视为休市,丢掉这批末尾连续不动的那一段。
    #
    # 这道专门补节假日和"突如其来"的临时休市——它们不在任何固定日历里,周末闸门按日期
    # 判必然漏掉。判据是所有休市共有的、可直接观测的特征:报价不再变化。理由与阈值取
    # 值见 _stalled_tail_length() 与 STALLED_CLOSE_BARS。
    #
    # 需要库里紧邻这批之前的收盘价:休市后第一批可能只有两三根,单看批内凑不满阈值。
    # 多取几根(阈值的两倍)是因为游程可能跨过批次边界继续往前延伸。
    #
    # Second gate: a static price means the market is shut, so drop the stalled run at
    # the tail of this batch.
    #
    # This covers holidays and *sudden* closures, which appear in no fixed calendar and
    # which the date-based weekend gate necessarily misses. The signal is the one trait
    # every closure shares and that can be observed directly: the quote stops moving.
    # See _stalled_tail_length() and STALLED_CLOSE_BARS for the reasoning.
    #
    # The stored closes immediately preceding this batch are needed because the first
    # batch after a close may hold only two or three bars, too few to reach the
    # threshold alone. Twice the threshold is fetched since the run can extend back
    # past the batch boundary.
    #
    # 必须显式按时间排序:停滞判定要沿时间轴数游程,丢弃的也是"末尾"那一段,两者都以升序
    # 为前提。而这批 bar 的顺序完全取决于喂价端怎么发,上游没有任何地方排过序——顺序若乱,
    # 判定不会报错,只会静静地算错,这正是这个模块反复吃过亏的那类失败。
    #
    # Sorting is explicit and required: the stall check counts a run along the time axis
    # and drops the *tail*, both of which assume ascending order. The batch's order is
    # whatever the feed sent, and nothing upstream sorts it — out-of-order input wouldn't
    # raise, it would quietly compute the wrong answer, the very failure class this module
    # has been bitten by repeatedly.
    closed.sort(key=lambda b: b["t"])
    earliest_t = min(b["t"] for b in closed)
    previous_closes = [
        r[0]
        for r in db.query(Candle.c)
        .filter(
            Candle.symbol == symbol,
            Candle.interval == interval,
            Candle.t < earliest_t,
        )
        .order_by(Candle.t.desc())
        .limit(STALLED_CLOSE_BARS * 2)
        .all()
    ][::-1]  # 查询是倒序,反转回时间升序 / query is descending; restore ascending order
    stalled_count = _stalled_tail_length(closed, previous_closes)
    if stalled_count:
        # 与周末闸门同理记 info:节假日休市是预期行为,不是故障。
        # info for the same reason as the weekend gate: a holiday closure is expected
        # behaviour, not a fault.
        logger.info(
            "filter_tradeable_bars: %s/%s rejected %d bar(s) with a stalled price "
            "(close unchanged for %d+ bars, indicating the market is shut — "
            "holiday or unscheduled closure)",
            symbol, interval, stalled_count, STALLED_CLOSE_BARS,
        )
        closed = closed[:-stalled_count]
        if not closed:
            return []

    # 休市期间喂价端重放的旧 bar 副本在这里丢掉,理由见 _is_replayed_duplicate()。
    #
    # 放在上面那条 WARNING 之后而不是之前:两个判断诊断的是两件不同的事。"一根都
    # 没收盘"指向喂价端时钟异常,而"收盘了但全是重放副本"是周末的正常现象;若先
    # 过滤再判空,每个周末批次都会打出那条 clock-skew WARNING,把一条本该罕见的
    # 告警变成噪音,真出时钟问题时反而看不见了。
    #
    # 比对基准取库里已存的最近若干根:休市第一根副本要跟收盘前的真实 bar 比才能
    # 认出来,而那根真实 bar 只在库里。基准里再把本批已接受的 bar 追加进去,让同
    # 一批内部也能连锁判定——backfill 一次可能送来整个周末,若只跟库里比,批内互
    # 为副本的那些会全部漏掉。
    #
    # 丢弃要留痕:正常交易时段本不该出现这类 bar,一旦成批出现说明喂价端有问题
    # (比如断线后重放缓存),静默丢弃会让这种故障无声无息——上面那条 WARNING 就是
    # 为同一类"安静地出错"而存在的(那次真实事故静默持续了三天)。常态量记在
    # debug,整批都是副本时才升到 info,避免周末稳态运行刷屏。
    #
    # Drop bars the feed replayed while the market was closed; see
    # _is_replayed_duplicate() for why.
    #
    # Placed after the WARNING above rather than before it: the two checks
    # diagnose different things. "nothing closed" points at a feed clock
    # problem, whereas "closed but all replays" is simply what a weekend looks
    # like. Filtering first would fire that clock-skew WARNING on every weekend
    # batch, turning a should-be-rare alert into noise that hides the real thing
    # when it happens.
    #
    # The comparison baseline is the most recent stored bars: recognising the
    # first replay of a close requires comparing it against the last real bar,
    # which only exists in the database. Accepted bars from this batch are
    # appended to that baseline so matches can chain within the batch too — a
    # backfill can deliver a whole weekend at once, and comparing only against
    # stored rows would miss every bar that is a copy of another bar in the same
    # batch.
    #
    # Dropping is logged on purpose: these shouldn't occur during a live
    # session, so a sudden run of them means something is wrong upstream (e.g.
    # the feed replaying its cache after a disconnect), and silent dropping
    # would hide that — the WARNING above exists for the same class of "fails
    # quietly" bug (that real incident went unnoticed for three days).
    # Steady-state counts go to debug, escalating to info only when the whole
    # batch is a replay, so weekends don't flood the logs.
    #
    # 时间下界以"这批里最早那根"为锚往前推,而不是以服务器当前时间往前推:backfill
    # 可能送来几天前的历史,按当前时间取基线的话那批 bar 的原件根本不在基线里,判定
    # 会对整批失效。以批次自身的时间为锚,补历史和实时推送都成立。
    #
    # The lower bound is measured back from the earliest bar in this batch, not
    # from the server's current time: a backfill can carry history from days ago,
    # and anchoring on "now" would leave those bars' originals outside the
    # baseline entirely, making the check useless for that batch. Anchoring on the
    # batch's own time works for both backfill and live pushes.
    lookback = REPLAY_LOOKBACK_SECONDS_BY_INTERVAL.get(interval, REPLAY_LOOKBACK_SECONDS)
    batch_floor = min(b["t"] for b in closed)
    baseline_floor = batch_floor - lookback
    # 基线必须排除时间戳落在本批之内的行,否则 bar 会跟"自己上一次推送时存进去的
    # 那一行"比对,被判成自己的副本。
    #
    # tick 模式每隔几秒重复推同样的最新几根:第一次通过闸门后落库,之后每一次推送
    # 的同一根都能在基线里找到 t 完全相同、OHLCV 完全相同的自己,于是永久判为重放
    # 副本被丢弃。实测 XAUUSD/5 replay_dropped=3/3、chart_store 拿不到任何 bar,
    # 前端图表停在旧数据上不再更新(2026-08-05)。
    #
    # 判据的语义本来就是"与**更早的**某根相同",上界取本批最早那根即可:同一时间戳
    # 的行是这根 bar 自己的历史版本,不是它复制的原件。真正的重放副本原件必然更早,
    # 不受影响;批内互为副本的情况仍由下面循环里往 baseline 追加已接受 bar 来覆盖。
    #
    # The baseline must exclude rows whose timestamps fall inside this batch, or a
    # bar gets compared against the row it wrote itself on a previous push and is
    # judged a copy of itself.
    #
    # tick mode re-sends the same latest bars every few seconds: once the first
    # push passes the gates and persists, every later push finds itself in the
    # baseline at the identical t with identical OHLCV, so it is dropped as a
    # replay forever. Observed as XAUUSD/5 replay_dropped=3/3 with chart_store
    # receiving nothing, freezing the frontend chart on stale data (2026-08-05).
    #
    # The predicate always meant "identical to an *earlier* bar", so the upper
    # bound is this batch's earliest timestamp: a row at the same timestamp is this
    # bar's own earlier version, not an original it copied. Genuine replays have
    # strictly older originals and are unaffected; copies within one batch are
    # still caught by appending accepted bars to the baseline in the loop below.
    baseline = {
        _replay_key({"o": r[0], "h": r[1], "l": r[2], "c": r[3], "v": r[4]})
        for r in db.query(Candle.o, Candle.h, Candle.l, Candle.c, Candle.v)
        .filter(
            Candle.symbol == symbol,
            Candle.interval == interval,
            Candle.t >= baseline_floor,
            Candle.t < batch_floor,
        )
        .order_by(Candle.t.desc())
        .limit(REPLAY_BASELINE_MAX_ROWS)
        .all()
    }
    accepted: list[dict] = []
    replay_count = 0
    for b in closed:
        if _is_replayed_duplicate(b, baseline):
            replay_count += 1
            continue
        accepted.append(b)
        # 平坦 bar(h == l)豁免判定,不该进基线,否则会把后续真实的平盘行情误判成副本。
        # Flat bars (h == l) are exempt from the check and must stay out of the
        # baseline, or later genuine flat bars would be misjudged as copies.
        if b["h"] != b["l"]:
            baseline.add(_replay_key(b))
    if replay_count:
        logger.log(
            logging.INFO if not accepted else logging.DEBUG,
            "filter_tradeable_bars: %s/%s skipped %d replayed bar(s) (OHLCV identical "
            "to a recent bar — expected while the market is closed; if this appears "
            "during a live session, check the feed)",
            symbol, interval, replay_count,
        )
    return accepted


def persist_closed_bars(
    db, symbol: str, interval: str, bars: list[dict],
    prefiltered: list[dict] | None = None,
) -> int:
    """把 `bars` 里通过休市闸门的部分写入数据库,已存在的(symbol, interval, t)跳过。

    过滤逻辑全部在 filter_tradeable_bars() 里,这里只负责落库。
    返回本次新写入的行数(纯观测用,调用方可忽略)。

    `prefiltered` 给已经调过 filter_tradeable_bars() 的调用方复用结果用(routers/chart.py
    要拿同一份结果去更新内存缓存)。过滤过程本身要查两次库(取前序收盘价、取重放基准),
    重复过滤等于白查一遍,而且两次调用之间若有并发写入,两条路径还可能得出不同结果。
    不传则内部自行过滤。

    Persist the subset of `bars` that clears the closure gates; rows already
    present for (symbol, interval, t) are skipped. All filtering lives in
    filter_tradeable_bars(); this function only writes.
    Returns the number of newly-inserted rows (for observability; callers may ignore it).

    `prefiltered` lets a caller that already called filter_tradeable_bars() reuse the
    result (routers/chart.py needs the same list to update the in-memory cache).
    Filtering issues two queries of its own (preceding closes, replay baseline), so
    redoing it is wasted work — and with a concurrent write between the two calls the
    two paths could even disagree. Omit it to filter internally.
    """
    closed = prefiltered if prefiltered is not None else filter_tradeable_bars(db, symbol, interval, bars)
    if not closed:
        return 0

    existing = {
        row[0]
        for row in db.query(Candle.t)
        .filter(
            Candle.symbol == symbol,
            Candle.interval == interval,
            Candle.t.in_([b["t"] for b in closed]),
        )
        .all()
    }
    new_count = 0
    for b in closed:
        if b["t"] in existing:
            continue
        db.add(
            Candle(
                symbol=symbol, interval=interval, t=b["t"],
                o=b["o"], h=b["h"], l=b["l"], c=b["c"], v=b.get("v", 0),
            )
        )
        new_count += 1
    if new_count:
        db.commit()
    return new_count


def cleanup_old_m1(db, retention_days: int) -> int:
    """删掉超过保留天数的 1 分钟线,其余周期不动。返回删除行数。
    Delete 1-minute candles past the retention window; other intervals are
    untouched. Returns the number of rows deleted."""
    cutoff = datetime.now(timezone.utc).timestamp() - retention_days * 86400
    deleted = (
        db.query(Candle)
        .filter(Candle.interval == "1", Candle.t < cutoff)
        .delete(synchronize_session=False)
    )
    if deleted:
        db.commit()
    return deleted


def _run_retention_sweep() -> None:
    """执行一轮保留期清扫(同步,由 candle_retention_sweep_loop 放到线程池里跑)。
    Run one retention sweep (synchronous; the loop dispatches it to a thread)."""
    db = SessionLocal()
    try:
        cfg = get_candle_settings(db)
        deleted = cleanup_old_m1(db, int(cfg["m1_retention_days"]))
        if deleted:
            logger.info("candle_retention_sweep_loop: deleted %d expired 1m candle(s)", deleted)
        # 顺带清页面统计的去重标记：同样是每天一次的保留期清理，
        # 为一张小表另开一个后台任务不值得（VPS 是 2 核单进程）。
        # Also prune page-stat dedup markers: same daily retention job,
        # not worth a separate background task for one small table.
        pruned = prune_visitor_days(db)
        if pruned:
            logger.info("candle_retention_sweep_loop: pruned %d expired visitor marker(s)", pruned)
        purged = purge_admin_visitors(db)
        if purged:
            logger.info("candle_retention_sweep_loop: purged %d admin visitor marker(s)", purged)
    finally:
        db.close()


async def candle_retention_sweep_loop(
    startup_delay: float = RETENTION_SWEEP_STARTUP_DELAY_SECONDS,
) -> None:
    """每天清理一次过期的 1 分钟线。
    Daily sweep that trims expired 1-minute candles.

    清扫走线程池并延后首轮,不挡启动:这里全是同步 DB 调用,生产库还是远端
    Supabase,每条都带网络往返。曾经同步跑在事件循环上,首轮把 uvicorn 的 bind
    端口一起堵住 83.7 秒(nginx 全程 502),之后每天再冻住所有请求一次。清扫都不
    紧急,让端口先起来。
    The sweep runs in a thread and delays its first pass so it never blocks
    startup: the body is all synchronous DB calls, and production talks to a
    remote Supabase instance, so each one carries a network round trip. Running it
    on the event loop once held up uvicorn's port bind for 83.7s (nginx serving
    502s throughout) and then froze every request once a day. None of this is
    urgent, so the port comes up first.

    startup_delay 可覆盖,便于测试里立即跑首轮。
    startup_delay is overridable so tests can run the first pass immediately.
    """
    if startup_delay:
        await asyncio.sleep(startup_delay)
    while True:
        try:
            await run_in_threadpool(_run_retention_sweep)
        except Exception:
            logger.exception("candle_retention_sweep_loop error")
        await asyncio.sleep(RETENTION_SWEEP_INTERVAL_SECONDS)
