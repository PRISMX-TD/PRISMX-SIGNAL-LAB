"""按「策略 × 交易时段」统计平台信号的客观胜率。

口径与 `GET /signals/winrate` **完全一致**：只看行情是否先碰到止盈或止损
（Signal.result），与任何用户的实际下单/平仓行为无关；分母只含 HIT_TP + HIT_SL，
PENDING（还没走出结果）与 STALE（行情追踪中断，见 signal_resolution.py）都不进
分母，但如实回给前端展示。两处口径必须保持一致，否则同一批信号在"总胜率"和
"分时段胜率"里会给出互相矛盾的数字。

只统计 source == "tradingview" 的信号。mock 引擎那批的 indicator 是
"MA5/MA20 金叉, RSI=34.7 / Dead cross" 这种把参数值拼进去的描述文本，按它分组
会炸出上百个只有一条样本的"策略"；TradingView 警报的 strategy 字段才是稳定的
策略名（见 routers/webhook.py 的 _persist_signal_sync）。

Objective win rate for platform signals, broken down by strategy x trading
session.

Same definition as `GET /signals/winrate`: purely whether price reached
take-profit or stop-loss first (Signal.result), independent of any user's real
orders; the denominator is HIT_TP + HIT_SL only, with PENDING (no outcome yet)
and STALE (price tracking broke, see signal_resolution.py) excluded but still
reported for display. The two must stay in step or the same signals would yield
contradictory "overall" and "per-session" numbers.

Only source == "tradingview" signals are counted. The mock engine's `indicator`
is descriptive text with parameter values baked in ("MA5/MA20 golden cross,
RSI=34.7"), which would explode into hundreds of one-sample "strategies";
TradingView's `strategy` field is the stable name (see _persist_signal_sync in
routers/webhook.py).
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models import Signal


@dataclass(frozen=True)
class TradingSession:
    """一个交易时段：在该金融中心的**本地**时间上取 [start_hour, end_hour) 小时区间。

    刻意用 IANA 时区 + 本地小时，而不是固定的 UTC 区间——伦敦与纽约每年各切换两次
    夏令时，且切换日期不同（欧美错开约两周）。写死 UTC 区间的话，每年会有约四段
    共十几周的时间，整个时段整体错位一小时：信号被算进隔壁时段，胜率跟着串。

    One trading session: the half-open hour range [start_hour, end_hour) in that
    financial centre's **local** time.

    Deliberately an IANA zone plus local hours rather than a fixed UTC range:
    London and New York each shift twice a year, on different dates (the EU and
    US changeovers are ~2 weeks apart). A hard-coded UTC range would be an hour
    off for several weeks every year, filing signals under the neighbouring
    session and skewing both sessions' win rates.
    """

    key: str
    tz: str
    start_hour: int
    end_hour: int


# 三大时段，用各自金融中心的本地时间定义。东京不实行夏令时（1951 年后废止），
# 但仍走同一套 ZoneInfo 逻辑，不为它开特例。
# The three sessions, defined in their own centre's local time. Tokyo has no DST
# (abolished after 1951) but still goes through the same ZoneInfo path — no
# special case for it.
SESSIONS: tuple[TradingSession, ...] = (
    TradingSession("asia", "Asia/Tokyo", 9, 18),
    TradingSession("europe", "Europe/London", 8, 17),
    TradingSession("newyork", "America/New_York", 8, 17),
)

# 不落在任何时段内的信号（主要是亚洲收盘到伦敦开盘之间、以及纽约收盘后的几小时）。
# 单列一桶而不是丢弃：丢掉的话三个时段的样本数加起来对不上总数，看的人会以为
# 数据缺失。
# Signals in none of the sessions (mostly the gap between the Tokyo close and
# the London open, plus the hours after the New York close). Bucketed rather
# than dropped: dropping them would make the three sessions fail to add up to
# the total and read as missing data.
OUTSIDE_KEY = "outside"

# 做多/做空两个方向桶。与时段桶并排住在同一个 dict 里（`_accumulate` 的 keys
# 元组一次带上），而不是另起一套累加结构——一条信号只遍历一次就同时记进
# 总计、它命中的各时段、以及它自己的方向。
# 方向值域来自 webhook 摄入侧的 `payload.side.upper()`（Literal 已限定 BUY/SELL，
# 见 routers/webhook.py），但历史行仍可能是别的写法：**认不出的方向不进任何
# 方向桶**，宁可让 BUY+SELL 加起来小于总数，也不把一条方向不明的信号硬塞进
# 某一侧——那会让"做多更赚还是做空更赚"这个结论建立在猜测上。
# Long/short buckets, living in the same dict as the session buckets (carried in
# the same `_accumulate` keys tuple) rather than a second accumulator: one pass
# per signal records it into the total, each session it hits, and its own side.
# The value domain comes from `payload.side.upper()` at ingest (a Literal
# restricted to BUY/SELL, see routers/webhook.py), but legacy rows may hold
# anything: an unrecognized side joins NO side bucket. Better that BUY+SELL sum
# to less than the total than to shove a direction-unknown signal onto one side
# and build "does long or short do better" on a guess.
SIDE_KEYS: tuple[str, ...] = ("BUY", "SELL")

# 时段之间**故意允许重叠**：伦敦 08:00–17:00 与纽约 08:00–17:00 在夏令时下有
# 四小时重叠（伦敦 13:00–17:00），那正是外汇日内波动最大的一段。落在重叠区的
# 信号同时计入两个时段，因此各时段样本数之和 > 总样本数——这是正确的（问的是
# "欧洲盘时段内的胜率如何"，而不是"把信号切成互斥的几堆"），前端需要说明这一点。
# Sessions deliberately overlap: London 08:00-17:00 and New York 08:00-17:00
# share four hours under DST (13:00-17:00 London), which is exactly the most
# active stretch of the FX day. A signal in the overlap counts toward both
# sessions, so the per-session counts sum to MORE than the total — which is
# correct (the question is "how do signals fired during the European session
# do", not "partition the signals"), and the UI has to say so.

_ZONES: dict[str, ZoneInfo] = {}


def _zone(name: str) -> ZoneInfo:
    """ZoneInfo 实例缓存。构造会读磁盘上的 tz 数据库，而这里每条信号 × 三个时段
    都要用一次，不缓存就是每次统计成千上万次文件读。

    Cached ZoneInfo instances: constructing one reads the tz database from disk,
    and this is needed once per signal per session — thousands of file reads per
    request without the cache."""
    zone = _ZONES.get(name)
    if zone is None:
        zone = ZoneInfo(name)
        _ZONES[name] = zone
    return zone


def session_keys_for(ts: datetime) -> list[str]:
    """某个时刻落在哪些时段内；不落在任何时段则返回 [OUTSIDE_KEY]。

    naive 输入按 UTC 解读——signals.created_at 列存的就是 naive UTC（见
    models/__init__.py 的 _now）。

    Which sessions an instant falls in; [OUTSIDE_KEY] when it's in none. A naive
    input is read as UTC — signals.created_at stores naive UTC (see _now in
    models/__init__.py)."""
    aware = ts if ts.tzinfo is not None else ts.replace(tzinfo=timezone.utc)
    keys = [
        s.key
        for s in SESSIONS
        if s.start_hour <= aware.astimezone(_zone(s.tz)).hour < s.end_hour
    ]
    return keys or [OUTSIDE_KEY]


def _empty_bucket(days: int, *, with_daily: bool = True, with_hourly: bool = True) -> dict:
    """一个空桶。两条可选序列各有一个开关，互不牵连。

    **分配即开关**：`_accumulate` 和 `_finalize` 都不再接收"要不要这条序列"的
    标志，而是看桶里这条列表是不是空的——分配、累加、下发三件事从此由同一个
    事实驱动。原来的写法要求调用方把同名标志"成对传"给两个函数，漏传一处的
    症状是数字静静地偏掉或者下发一个空数组，两种都不报错；而现在要加第二条
    序列（`_hr`），那种耦合会从两处变成四处。

    An empty bucket, with an independent switch per optional series.

    **Allocation is the switch**: neither `_accumulate` nor `_finalize` takes a
    "should this series exist" flag any more — they look at whether the bucket's
    list is empty, so allocating, accumulating and shipping are all driven by one
    fact. The previous shape required callers to pass matching flags to two
    functions in step; missing one silently skewed a number or shipped an empty
    array, neither of which raises. Adding a second series (`_hr`) would have
    turned that two-way coupling into a four-way one.
    """
    return {
        "hitTp": 0, "hitSl": 0, "pending": 0, "stale": 0,
        # 内部累加器，_finalize 时弹出 / internal accumulators, popped by _finalize
        # _daily：自窗口起点每 24h 一格的信号总数，喂推荐卡的迷你活跃度柱图，
        # 回答的是"最近这几天忙不忙"。
        # _hr：按**一天中的第几个小时**（UTC，0–23）累计的止盈/止损笔数，长度恒 24，
        # 喂详情区的"哪个小时更准"图。它取代了原来的星期几序列：产品要回答的是
        # "一天里什么时候该盯"，星期几回答不了这个问题。
        # 两条序列刻意分开：一条按滚动天、一条按钟点，问的是两个不同的问题，
        # 合并成一条就得让某一侧将就另一侧的分桶方式。
        #
        # 小时取 UTC，前端再旋转成浏览者本地钟点。后端不可能知道看的人在哪个时区，
        # 而 24 个格子是一个完整的循环，旋转是无损的；夏令时切换会让窗口里跨切换点
        # 的那部分数据糊一个小时，前端在图注里写明。
        #
        # _daily: signal counts per 24h from the window start, feeding the
        # activity sparkline — "how busy have the last few days been". _hr:
        # take-profit and stop-loss counts by hour of day (UTC, 0-23), always
        # length 24, feeding the detail area's "which hour is better" chart. It
        # replaces the old weekday series: the product question is "when in the
        # day should I watch", which a weekday cannot answer. Deliberately two
        # series: one bucketed by rolling day, one by clock hour, answering two
        # different questions; merging them would force one to adopt the other's
        # bucketing.
        #
        # Hours are bucketed in UTC and rotated into the viewer's local clock by
        # the frontend: the backend cannot know the reader's zone, and 24 slots
        # are a full cycle so the rotation is lossless. A DST changeover inside
        # the window smears the affected part by an hour; the UI says so.
        "_resolveSum": 0.0, "_resolveN": 0,
        "_daily": [0] * days if with_daily else [],
        # 每个钟点一格，只记胜负两个数——不再按方向拆。24 × 2 个格子读不过来，
        # 而"做多还是做空更准"在详情区本来就有自己一块。
        # One slot per clock hour holding just a win/loss pair — no direction
        # split. 24 x 2 cells is more than anyone reads, and "long or short"
        # already has its own block in the detail area.
        "_hr": [{"tp": 0, "sl": 0} for _ in range(24)] if with_hourly else [],
    }


def _bucket_set(days: int, all_keys: list[str], *, per_symbol: bool = False) -> dict[str, dict]:
    """建一整组桶（total + 各时段 + 做多/做空）。**哪个桶带哪条序列只在这里决定。**

    - **方向桶两条都不带**：再按天或按钟点切一刀样本就太薄，而"做多还是做空更准"
      本来就是个跨整个窗口的问题。（此前方向桶是照常分配、照常累加、就是不下发，
      纯空转；现在不分配，`_accumulate` 自然跳过。）
    - **品种层不带 `_daily`**：活跃度柱图只画策略层。
    - **品种层带 `_hr`，且只在 total 上**：用户要看"这个策略在这个品种上，一天里
      哪个小时更准"。时段桶和方向桶不带——页面读的是 `total.hourly`，给了也没人看，
      而品种 × 时段 × 24 格的样本已经薄到没有意义。

    Build one full set of buckets (total + each session + long/short). **Which
    bucket carries which series is decided only here.**

    Side buckets carry neither: slicing by day or by hour on top of by direction
    leaves too thin a sample, and "long or short" is a whole-window question
    anyway. (They used to allocate and accumulate both, then not ship them —
    pure dead work.) The symbol layer skips `_daily` (the activity sparkline is
    strategy-level only) but keeps `_hr` on `total`, because "which hour is this
    strategy best at on this symbol" is exactly what the detail view asks; its
    session and side buckets skip it, since the UI reads `total.hourly` and a
    symbol x session x 24-cell sample is meaninglessly thin.
    """
    keys = [*all_keys, "total", *SIDE_KEYS]
    if per_symbol:
        return {
            k: _empty_bucket(days, with_daily=False, with_hourly=(k == "total"))
            for k in keys
        }
    return {
        k: _empty_bucket(days, with_daily=k not in SIDE_KEYS, with_hourly=k not in SIDE_KEYS)
        for k in keys
    }


def _accumulate(
    buckets: dict[str, dict],
    keys: tuple[str, ...],
    result_key: str,
    day_idx: int,
    hour: int,
    side_key: str | None,
    resolve_seconds: float | None,
) -> None:
    """把一条信号记进 `buckets` 里 `keys` 指定的那几个桶。

    主循环里策略层/总计层/品种层三处要做的累加逐字相同，抽在这里一处实现：
    三份副本的时候，"判定用时只在真判出胜负时才进均值"这类规则要同时改三个
    地方才不出错，而漏改一处的症状是数字静静地偏掉，不会报错。

    两条可选序列**各自按这个桶有没有分配来决定累不累加**（见 `_bucket_set`），
    不再由调用方传标志：没分配的是空列表，跳过；分配了的就一定会被累加，也一定
    会被下发。

    Record one signal into the `keys` buckets of `buckets`.

    The strategy, overall and symbol layers of the main loop all did this
    verbatim; one implementation instead. With three copies, a rule like "the
    mean time-to-resolution only counts actually resolved signals" had to be
    changed in three places at once, and the symptom of missing one is a number
    quietly drifting rather than an error.

    Each optional series accumulates **iff this bucket allocated it** (see
    `_bucket_set`) rather than on a caller-passed flag: an unallocated series is
    an empty list and is skipped, and an allocated one is always both
    accumulated and shipped.
    """
    for bkey in keys:
        b = buckets[bkey]
        b[result_key] += 1
        if b["_daily"]:
            b["_daily"][day_idx] += 1
        # 钟点格只累计已判出胜负的：未判定的信号不出现在这张图上（产品要求），
        # 等它真走出结果那天再计进来。
        # The hour cells count only resolved signals: unresolved ones do not
        # appear on that chart (a product decision) and join it on the day
        # they actually reach an outcome.
        if b["_hr"] and result_key in ("hitTp", "hitSl"):
            b["_hr"][hour]["tp" if result_key == "hitTp" else "sl"] += 1
        if resolve_seconds is not None:
            b["_resolveSum"] += resolve_seconds
            b["_resolveN"] += 1


# result 列到桶键的映射。未知值（历史遗留的 WIN/LOSS 等）一律并入 pending：
# 不认识的状态绝不能当成"赢"，也不该悄悄消失在总数之外。
# result column -> bucket key. Unknown values (legacy WIN/LOSS rows) all fall
# into pending: an unrecognized state must never be counted as a win, and must
# not silently vanish from the totals either.
_RESULT_KEYS = {"HIT_TP": "hitTp", "HIT_SL": "hitSl", "STALE": "stale"}


def wilson_lower_bound(hit: int, n: int, z: float = 1.96) -> float | None:
    """胜率的 Wilson 95% 置信区间下限，推荐榜的排序键。

    用下限而不是原始胜率排序：样本少的高胜率（80% × 5 笔）区间宽、下限被压低，
    样本多的稳定胜率（55% × 40 笔）区间窄、下限反而更高——薄样本自动沉底，
    不需要另设门槛或合成分。n = 已判定笔数（hitTp + hitSl）。

    The Wilson 95% lower bound, used as the recommendation ranking key. Ranking
    by the bound rather than the raw rate makes thin samples sink on their own:
    80% of 5 has a wide interval and a low bound, 55% of 40 a narrow one and a
    higher bound. n is the resolved count.
    """
    bounds = wilson_bounds(hit, n, z)
    return None if bounds is None else bounds[0]


def wilson_bounds(hit: int, n: int, z: float = 1.96) -> tuple[float, float] | None:
    """胜率的 Wilson 95% 置信区间（下限, 上限）。分母为 0 时返回 None。

    前端把这个区间画成点图上的横杠：**区间宽窄就是样本厚薄的可视化**。
    5 笔的 50% 与 1296 笔的 50% 在只画一个百分比时长得一模一样，画成区间后
    前者横跨大半个轴、后者收成一个点，读的人不用去看小字笔数就知道该信谁。

    The Wilson 95% interval (low, high); None on an empty denominator.

    The UI renders this as the whisker on a dot plot: **the interval's width is
    the visualization of sample size**. A 50% from 5 trades and a 50% from 1296
    look identical when drawn as a bare percentage; as intervals the first spans
    half the axis and the second collapses to a point, so the reader knows which
    to trust without hunting for the sample count in small print.
    """
    if n <= 0:
        return None
    p = hit / n
    denom = 1.0 + z * z / n
    centre = p + z * z / (2.0 * n)
    margin = z * math.sqrt(p * (1.0 - p) / n + z * z / (4.0 * n * n))
    return (max(0.0, (centre - margin) / denom), min(1.0, (centre + margin) / denom))


def _finalize(bucket: dict, days: int) -> dict:
    resolved = bucket["hitTp"] + bucket["hitSl"]
    _bounds = wilson_bounds(bucket["hitTp"], resolved)
    samples = resolved + bucket["pending"] + bucket["stale"]
    resolve_n = bucket["_resolveN"]
    return {
        "hitTp": bucket["hitTp"], "hitSl": bucket["hitSl"],
        "pending": bucket["pending"], "stale": bucket["stale"],
        "resolved": resolved,
        "samples": samples,
        # 分母为 0 时给 None 而不是 0：前端要能区分"这个时段 0% 胜率"和"这个
        # 时段还没有已判定的样本"。
        # None rather than 0 on an empty denominator so the UI can tell "0% win
        # rate here" apart from "no resolved samples here yet".
        "winRate": (bucket["hitTp"] / resolved) if resolved > 0 else None,
        "wilsonLow": _bounds[0] if _bounds else None,
        "wilsonHigh": _bounds[1] if _bounds else None,
        "avgResolveSeconds": (bucket["_resolveSum"] / resolve_n) if resolve_n else None,
        "weeklySignals": round(samples / days * 7, 1),
        # 两条序列都是"分配了就下发，没分配就是 None"——哪些桶分配见 `_bucket_set`。
        # 空列表判否是刻意的：`[0] * days` 这种全零列表非空、照常下发（"这几天一条
        # 信号都没有"本身就是要给前端看的信息），只有压根没分配的 `[]` 才变 None。
        # Both series ship iff allocated (see `_bucket_set`), otherwise None.
        # Testing the list for emptiness is deliberate: an all-zero `[0] * days`
        # is non-empty and still ships — "no signals on those days" is itself
        # information the UI needs — and only an unallocated `[]` becomes None.
        #
        # daily：自窗口起点每 24h 一格的信号总数（含未判定），活跃度柱图用
        # daily: signal totals per 24h from the window start (unresolved included)
        "daily": list(bucket["_daily"]) if bucket["_daily"] else None,
        # hourly：一天中每个钟点（UTC，0–23，长度恒 24）的止盈/止损笔数，只含已判定。
        # 前端按浏览者时区旋转成本地钟点，并各自守样本门槛后才显示百分比。
        # hourly: take-profit / stop-loss counts per hour of day (UTC, 0-23,
        # always length 24), resolved only. The UI rotates them into the viewer's
        # local clock and gates each slot on its own sample size.
        "hourly": [{"tp": c["tp"], "sl": c["sl"]} for c in bucket["_hr"]]
        if bucket["_hr"] else None,
    }


def _shape(buckets: dict[str, dict], days: int, all_keys: list[str]) -> dict:
    """一组桶 → 下发形状。模块级而不是闭包：`_empty_payload` 也要用它，两处形状
    必须一模一样，复制一份迟早会漂移。
    Buckets → wire shape. Module-level rather than a closure because
    `_empty_payload` needs it too and the two shapes must stay identical; a copy
    would drift.
    """
    # 三层一律 `_finalize(bucket, days)`：带不带 daily/hourly 由建桶时决定
    # （`_bucket_set`），这里不再重复一遍规则——重复就会有一天两处说法不一致。
    # All three layers call the same `_finalize(bucket, days)`: whether a bucket
    # carries daily/hourly was settled at construction (`_bucket_set`), and not
    # restating the rule here is what keeps the two places from disagreeing.
    return {
        "total": _finalize(buckets["total"], days),
        "sessions": {k: _finalize(buckets[k], days) for k in all_keys},
        "sides": {k: _finalize(buckets[k], days) for k in SIDE_KEYS},
    }


def _empty_payload(days: int, now: datetime) -> dict:
    """空名单时的零结果，形状与正常返回**完全一致**。

    直接 return 而不是让空查询自然跑完，是为了省掉一次必然为空的全表扫描；
    但形状必须一字不差，否则前端会在"公开名单为空"这条路径上撞到 undefined，
    而那恰恰是这个设置上线后的**默认状态**——最常走的路径最不能出错。

    A zero result for an empty whitelist, shaped **identically** to a normal
    return. Returning early skips a scan that is guaranteed to match nothing, but
    the shape has to match exactly or the frontend hits undefined on the
    empty-whitelist path — which is this setting's **default state** after ship,
    i.e. the most-travelled path of all.
    """
    all_keys = [s.key for s in SESSIONS] + [OUTSIDE_KEY]
    buckets = _bucket_set(days, all_keys)
    return {
        "days": days,
        "windowStart": now - timedelta(days=days),
        "windowEnd": now,
        "lastResolvedAt": None,
        "sessions": [
            {"key": s.key, "tz": s.tz, "startHour": s.start_hour, "endHour": s.end_hour}
            for s in SESSIONS
        ],
        "overall": {"strategy": "", **_shape(buckets, days, all_keys), "symbols": []},
        "strategies": [],
    }


def compute_strategy_session_winrate(
    db: Session, days: int = 7, only_strategies: list[str] | None = None
) -> dict:
    """近 `days` 天（滚动窗口，按信号创建时间）每个策略在各时段的胜率。

    按 created_at 而不是 resolved_at 归档与分桶：问的是"这个策略在欧洲盘发出的
    信号后来赢了没有"，时段属性属于信号发出的那一刻；用 resolved_at 会把一条亚洲
    盘发出、纽约盘才走出结果的信号记成纽约盘。窗口过滤也必须用同一根时间轴，
    否则会漏掉/多算跨窗口的信号。

    Per-strategy, per-session win rate over the last `days` days (a rolling
    window on the signal's creation time).

    Bucketed and windowed by created_at, not resolved_at: the question is "how
    do this strategy's European-session signals turn out", and the session is a
    property of the moment it fired — resolved_at would file an Asia-session
    signal that only reached TP during New York hours under New York. The window
    filter must use the same axis or signals straddling the edge get dropped or
    double-counted.
    """
    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(days=days)

    # 只取需要的列。信号表最宽的几列（entry/sl/tp/baseline_*）这里一个都用不上，
    # 全行 SELECT 在 Supabase 上是纯浪费的 Egress——同 signal_resolution.py 的做法。
    # symbol 用于品种子分层（Task 3）。
    # Only the needed columns: none of the wide columns (entry/sl/tp/baseline_*)
    # are used here, and a full-row SELECT is pure wasted Egress on Supabase —
    # same reasoning as signal_resolution.py. symbol feeds the per-symbol
    # breakdown (Task 3).
    cutoff_naive = cutoff.replace(tzinfo=None)
    query = db.query(
        Signal.indicator, Signal.symbol, Signal.side, Signal.created_at,
        Signal.result, Signal.resolved_at,
    ).filter(
        Signal.source == "tradingview",
        Signal.created_at >= cutoff_naive,
    )
    # 白名单过滤在**取数这一层**，不是在结果里删几行：用户端的时段胜率、品种胜率
    # 都要只用白名单内策略的信号算，分母跟着变。只公开 AIFT 时，"欧洲盘 56%"
    # 必须是 AIFT 在欧洲盘的胜率，而不是全平台的 56% 配一份只剩 AIFT 的策略列表——
    # 后者会让两个数字互相矛盾，且没有任何地方说明为什么。
    #
    # `only_strategies == []`（空名单，也就是默认的"一个都不公开"）与 None 必须
    # 区分开：None = 不过滤（管理页），[] = 过滤掉一切（用户端未配置时）。用
    # `is not None` 判断，不要写成 `if only_strategies:`——那会把空名单当成不过滤，
    # 一行代码把"默认不公开"变成"默认全公开"。
    #
    # The whitelist filters **at the fetch**, not by dropping rows from the
    # result: the user-facing page's session and symbol win rates must be computed
    # from whitelisted strategies alone, denominator included. With only AIFT
    # published, "European 56%" has to be AIFT's European win rate, not the
    # platform's 56% next to a list containing only AIFT — those two numbers would
    # contradict each other with nothing on the page explaining why.
    #
    # `only_strategies == []` (the default "publish nothing") must stay distinct
    # from None: None means no filtering (admin), [] means filter everything out.
    # Hence `is not None` — writing `if only_strategies:` would treat the empty
    # list as "no filter" and turn "publish nothing by default" into "publish
    # everything" in one line.
    if only_strategies is not None:
        if not only_strategies:
            return _empty_payload(days, now)
        query = query.filter(Signal.indicator.in_(only_strategies))
    rows = query.all()

    # 判定链路的健康读数：全表最近一次成功判定的时间，**刻意不受窗口限制**。
    # 判定只在 POST /webhook/trend 带着 high/low 进来时发生（见 routers/webhook.py），
    # 一旦那条链路断了——趋势推送停了、payload 少了 high/low、或 symbol 串对不上——
    # 表格会满屏"0 笔"，而窗口内的任何数字都无法区分"最近没走出结果"和"判定
    # 功能已经坏了几周"。这个时间戳能：null = 从来没判定成功过，几周前 = 断了。
    # Health reading for the resolution pipeline: when a signal was last
    # successfully resolved, deliberately NOT limited to the window. Resolution
    # only happens when POST /webhook/trend arrives carrying high/low (see
    # routers/webhook.py); if that path breaks — pushes stop, the payload drops
    # high/low, or the symbol strings stop matching — the table fills with
    # zeros, and nothing inside the window distinguishes "nothing has resolved
    # lately" from "resolution has been dead for weeks". This timestamp does:
    # null means it never worked, a date weeks back means it stopped.
    last_resolved = (
        db.query(func.max(Signal.resolved_at))
        .filter(
            Signal.source == "tradingview",
            Signal.result.in_(("HIT_TP", "HIT_SL")),
        )
        .scalar()
    )

    all_keys = [s.key for s in SESSIONS] + [OUTSIDE_KEY]
    # {策略名: {时段键或 "total": 桶}} / {strategy: {session key or "total": bucket}}
    per_strategy: dict[str, dict[str, dict]] = {}
    overall: dict[str, dict] = _bucket_set(days, all_keys)
    # {策略名: {品种: {时段键或 "total": 桶}}} / {strategy: {symbol: {session key or "total": bucket}}}
    per_strategy_symbols: dict[str, dict[str, dict[str, dict]]] = {}
    # 全平台的品种分布（不分策略），喂总览层的「分品种表现」。
    # "哪些品种在跑、哪些在赢"是跨策略的问题：同一个品种可能有三个策略在发信号，
    # 逐策略看只能看到碎片。这份聚合不能由前端把各策略的 symbols 加起来求得——
    # 胜率不是可加量，必须在这里按原始行重新累加。
    # Platform-wide per-symbol distribution (across all strategies), feeding the
    # overview layer. "Which symbols are active and which are winning" is a
    # cross-strategy question: one symbol may carry three strategies' signals, and
    # looking strategy by strategy only ever shows fragments. The UI cannot derive
    # this by summing each strategy's symbols — a win rate is not additive, so it
    # has to be accumulated here from the raw rows.
    overall_symbols: dict[str, dict[str, dict]] = {}

    for indicator, symbol, side, created_at, result, resolved_at in rows:
        if created_at is None:
            continue
        # 策略名缺失的信号归到一个显式的空串键，前端展示成「未命名策略」。
        # 丢弃它们会让分组之和对不上 /signals/winrate 的总数。
        # Signals with no strategy name go under an explicit empty-string key,
        # shown as "Unnamed" by the UI. Dropping them would make the groups fail
        # to add up to /signals/winrate's totals.
        name = (indicator or "").strip()
        key = _RESULT_KEYS.get(result or "", "pending")
        session_keys = session_keys_for(created_at)
        # 24h 桶下标：自窗口起点起算，floor。spec 原文是"按 UTC 日"，但滚动窗口
        # 起点不在午夜，按日历日会得到 days+1 个桶且首尾残缺；改为 24h 桶后长度
        # 恒等于 days，最后一桶即"最近 24 小时"。clamp 只防御浮点边缘。
        # 24h-bucket index counted from the window start, floored. The spec text
        # says "by UTC calendar day", but the rolling window doesn't start at
        # midnight, so calendar-day slicing yields days+1 buckets with ragged
        # ends; switching to 24h buckets keeps the length always == days, with
        # the last bucket meaning "the last 24 hours". The clamp only guards
        # floating-point edge cases.
        day_idx = min(days - 1, max(0, int(
            (created_at - cutoff_naive).total_seconds() // 86400)))
        # 钟点按 UTC 取。created_at 列存的是 naive UTC（见 models 的 _now），
        # 直接 .hour 即为 UTC 的第几个小时，0–23。
        # Hour in UTC: created_at stores naive UTC (see _now in models), so
        # .hour is already the UTC hour of day, 0-23.
        hour = created_at.hour
        resolve_seconds = None
        if result in ("HIT_TP", "HIT_SL") and resolved_at is not None:
            resolve_seconds = (resolved_at - created_at).total_seconds()

        # 不用 setdefault(name, {...}) ：它的第二个参数无论 key 在不在都会先求值，
        # 相当于给已经存在的策略也重新构造一整套桶（现在每个桶还带一个最长 90
        # 的 _daily 列表）再当场丢弃，按信号数 × days 线性放大浪费。品种子分层
        # （Task 3）还要加一层同款查找，这里先改掉，免得被复制三份。
        # Not setdefault(name, {...}): its second argument is evaluated whether
        # or not the key exists, so every already-seen strategy still builds a
        # full fresh set of buckets (each now carrying a _daily list up to 90
        # long) just to discard it — waste that scales with signal count x days.
        # The per-symbol breakdown (Task 3) adds another lookup just like this
        # one, so fix the pattern here before it gets copied three times.
        if name not in per_strategy:
            per_strategy[name] = _bucket_set(days, all_keys)
        # 这条信号要记进哪几个桶：总计 + 它命中的每个时段（时段之间会重叠，所以
        # 可能不止一个）。三层累加共用同一份 keys。
        # Which buckets this signal lands in: the total plus every session it hit
        # (sessions overlap, so possibly more than one). All three layers share it.
        # 方向认不出就不进方向桶（见 SIDE_KEYS 的说明），此时该信号仍正常
        # 计入总计与时段——只是不参与做多/做空对比。
        # An unrecognized side joins no side bucket (see SIDE_KEYS); the signal
        # still counts toward the total and its sessions, just not the long/short
        # comparison.
        side_key = (side or "").strip().upper()
        if side_key not in SIDE_KEYS:
            side_key = None
        bucket_keys = ("total", *session_keys)
        if side_key is not None:
            bucket_keys = (*bucket_keys, side_key)
        _accumulate(per_strategy[name], bucket_keys, key, day_idx, hour, side_key, resolve_seconds)
        _accumulate(overall, bucket_keys, key, day_idx, hour, side_key, resolve_seconds)

        # 品种子分层：同样避免 setdefault(key, {昂贵默认值}) ——两层查找都先判空
        # 再赋值，理由与上面 per_strategy 完全一致。
        # 带哪条序列由 `_bucket_set(per_symbol=True)` 一处决定：不要 daily，
        # total 上要 hourly（「这个策略在这个品种上，一天里哪个小时更准」）。
        # Per-symbol sub-layer: same "check then assign" pattern as per_strategy
        # above, for the identical reason — setdefault's default arg is built
        # whether or not the key already exists. Which series each bucket carries
        # is decided in one place by `_bucket_set(per_symbol=True)`: no daily,
        # hourly on total.
        if name not in per_strategy_symbols:
            per_strategy_symbols[name] = {}
        sym_map = per_strategy_symbols[name]
        if symbol not in sym_map:
            sym_map[symbol] = _bucket_set(days, all_keys, per_symbol=True)
        _accumulate(sym_map[symbol], bucket_keys, key, day_idx, hour, side_key, resolve_seconds)

        # 同一条信号再记进全平台的品种桶。同样先判空再赋值，不用 setdefault。
        # The same signal also lands in the platform-wide symbol bucket.
        if symbol not in overall_symbols:
            overall_symbols[symbol] = _bucket_set(days, all_keys, per_symbol=True)
        _accumulate(overall_symbols[symbol], bucket_keys, key, day_idx, hour, side_key,
                    resolve_seconds)

    def _shape_symbols(sym_map: dict[str, dict]) -> list[dict]:
        rows = [
            {
                "symbol": sym,
                "total": _finalize(b["total"], days),
                "sessions": {k: _finalize(b[k], days) for k in all_keys},
                "sides": {k: _finalize(b[k], days) for k in SIDE_KEYS},
            }
            for sym, b in sym_map.items()
        ]
        # 已判定笔数降序，与外层策略行的排序键一致，再按品种名兜底稳定顺序。
        # Resolved count desc, same tiebreak convention as the strategy rows,
        # then the symbol name for a stable order.
        rows.sort(key=lambda r: (-r["total"]["resolved"], -r["total"]["samples"], r["symbol"]))
        return rows

    strategies = [
        {
            "strategy": name, **_shape(buckets, days, all_keys),
            "symbols": _shape_symbols(per_strategy_symbols.get(name, {})),
        }
        for name, buckets in per_strategy.items()
    ]
    # 已判定样本多的排前面，再按总样本数，最后按名字——保证顺序稳定，否则每次
    # 刷新表格行都在跳。
    # Most resolved samples first, then total samples, then name — a stable order,
    # otherwise the table rows shuffle on every refresh.
    strategies.sort(
        key=lambda s: (-s["total"]["resolved"], -s["total"]["samples"], s["strategy"])
    )

    return {
        "days": days,
        "windowStart": cutoff,
        "windowEnd": now,
        "lastResolvedAt": last_resolved,
        "sessions": [
            {"key": s.key, "tz": s.tz, "startHour": s.start_hour, "endHour": s.end_hour}
            for s in SESSIONS
        ],
        # overall 与每个策略行同形状（strategy 为空串），前端可以用同一个渲染
        # 函数画汇总行和明细行。symbols 显式给 []（而不是靠 schema 默认值兜底）：
        # 这个函数的返回值本身就是被测的契约，调用方不一定会经过 Pydantic。
        # Same shape as a strategy row (with an empty strategy), so the UI renders
        # the summary row and the detail rows through one function. symbols is
        # explicitly [] here (not left to the schema's default) — this dict is
        # itself the tested contract, and callers won't necessarily go through
        # Pydantic.
        # overall 与每个策略行同形状（strategy 为空串），前端可以用同一个渲染
        # 函数画总览层和单策略层。symbols 这里是**全平台**的品种分布，不再是空
        # 列表——总览层要靠它回答"哪些品种在跑、哪些在赢"。
        # Same shape as a strategy row (empty strategy), so one renderer serves
        # both the overview and the per-strategy layer. `symbols` here is the
        # platform-wide distribution rather than an empty list: the overview
        # layer needs it to answer "which symbols are active and winning".
        "overall": {"strategy": "", **_shape(overall, days, all_keys),
                    "symbols": _shape_symbols(overall_symbols)},
        "strategies": strategies,
    }
