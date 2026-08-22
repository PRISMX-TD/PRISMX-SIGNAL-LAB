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


def _empty_bucket(days: int, with_daily: bool = True) -> dict:
    """一个空桶。`with_daily=False` 时不分配那条长度 = days 的每日计数列表。

    品种层从不下发 dailySamples（`_shape_symbols` 恒传 include_daily=False），
    而桶的数量是 策略 × 品种 × (时段 + total)，days=90 时每桶白分配一个 90 长的
    列表纯属浪费。`with_daily` 必须与 `_accumulate` 的同名参数成对传：这里给了
    `[]`，那边就绝不能再去 `_daily[day_idx] += 1`。

    An empty bucket. With `with_daily=False` it skips the per-day counter list of
    length `days`.

    The symbol layer never ships dailySamples (`_shape_symbols` always passes
    include_daily=False), and buckets are counted strategy x symbol x (session +
    total), so a 90-long list per bucket at days=90 is pure waste. `with_daily`
    must be passed in step with `_accumulate`'s parameter of the same name: given
    `[]` here, that side must never touch `_daily[day_idx]`.
    """
    return {
        "hitTp": 0, "hitSl": 0, "pending": 0, "stale": 0,
        # 内部累加器，_finalize 时弹出 / internal accumulators, popped by _finalize
        # _daily：自窗口起点每 24h 一格的信号总数，喂推荐卡的迷你活跃度柱图，
        # 回答的是"最近这几天忙不忙"。
        # _wdTp / _wdSl：按**星期几**（UTC，周一=0）累计的止盈/止损笔数，长度恒为 7，
        # 喂详情区的"星期胜负"图，回答的是"这个策略周几表现好"。
        # 两条序列刻意分开：一条按滚动天、一条按星期几，问的是两个不同的问题，
        # 合并成一条就得让某一侧将就另一侧的分桶方式。
        #
        # 星期几取 UTC：外汇周本来就以 UTC 为参照（周五纽约盘尾在 UTC 仍是周五，
        # 换成任一观察者的本地时区就可能滑到周六），而这一页的时段各按自己金融
        # 中心的本地时间定义、并不存在统一的"本地"。前端在图注里写明是 UTC。
        #
        # _daily: signal counts per 24h from the window start, feeding the
        # recommendation card's activity sparkline — "how busy have the last few
        # days been". _wdTp / _wdSl: take-profit and stop-loss counts by weekday
        # (UTC, Monday=0), always length 7, feeding the detail area's weekday
        # chart — "which weekday does this strategy do well on". Deliberately two
        # series: one bucketed by rolling day, one by weekday, answering two
        # different questions; merging them would force one to adopt the other's
        # bucketing.
        #
        # Weekday is taken in UTC: the FX week is conventionally referenced to it
        # (a Friday New York close is still Friday in UTC but can slip to
        # Saturday in an observer's local zone), and this page's sessions are each
        # defined in their own centre's local time, so there is no single "local".
        # The UI says UTC in the caption.
        "_resolveSum": 0.0, "_resolveN": 0,
        "_daily": [0] * days if with_daily else [],
        # 星期几 × 方向的交叉格子：7 格，每格三组胜负（全部 / 做多 / 做空）。
        # 交叉而不是两条独立序列，是因为要回答的问题本身是交叉的——"周一做多
        # 的胜率"不能由"周一整体胜率"和"整体做多胜率"推出来。
        # Weekday x direction cells: seven slots, each holding three win/loss
        # pairs (all / long / short). Crossed rather than two separate series
        # because the question itself is crossed: "Monday's long win rate" cannot
        # be derived from "Monday overall" plus "long overall".
        "_wd": [
            {"tp": 0, "sl": 0, "buyTp": 0, "buySl": 0, "sellTp": 0, "sellSl": 0}
            for _ in range(7)
        ] if with_daily else [],
    }


def _accumulate(
    buckets: dict[str, dict],
    keys: tuple[str, ...],
    result_key: str,
    day_idx: int,
    weekday: int,
    side_key: str | None,
    resolve_seconds: float | None,
    with_daily: bool,
) -> None:
    """把一条信号记进 `buckets` 里 `keys` 指定的那几个桶。

    主循环里策略层/总计层/品种层三处要做的累加逐字相同，抽在这里一处实现：
    三份副本的时候，"判定用时只在真判出胜负时才进均值"这类规则要同时改三个
    地方才不出错，而漏改一处的症状是数字静静地偏掉，不会报错。

    `with_daily=False` 跳过每日计数——品种层的 `_daily` 是空列表（见
    `_empty_bucket`），本来也不下发。

    Record one signal into the `keys` buckets of `buckets`.

    The strategy, overall and symbol layers of the main loop all did this
    verbatim; one implementation instead. With three copies, a rule like "the
    mean time-to-resolution only counts actually resolved signals" had to be
    changed in three places at once, and the symptom of missing one is a number
    quietly drifting rather than an error.

    `with_daily=False` skips the per-day counter — the symbol layer's `_daily`
    is an empty list (see `_empty_bucket`) and is never shipped anyway.
    """
    for bkey in keys:
        b = buckets[bkey]
        b[result_key] += 1
        if with_daily:
            b["_daily"][day_idx] += 1
            # 星期几只累计已判出胜负的：未判定的信号在星期图上不出现（产品要求），
            # 等它真走出结果那天再计进来。方向认不出的行只进"全部"那一组，不进
            # 做多/做空——与 SIDE_KEYS 的处理一致，不猜方向。
            # The weekday cells count only resolved signals: unresolved ones do
            # not appear on that chart (a product decision) and join it on the day
            # they actually reach an outcome. A row whose side is unrecognized
            # lands in the "all" pair only, never long or short — same rule as
            # SIDE_KEYS: never guess a direction.
            if result_key in ("hitTp", "hitSl"):
                cell = b["_wd"][weekday]
                short = "tp" if result_key == "hitTp" else "sl"
                cell[short] += 1
                if side_key == "BUY":
                    cell["buy" + short.capitalize()] += 1
                elif side_key == "SELL":
                    cell["sell" + short.capitalize()] += 1
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


def _finalize(bucket: dict, days: int, include_daily: bool) -> dict:
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
        # 品种层与方向桶不下发这两条序列：样本太薄，图全是零 / omitted there
        # daily：自窗口起点每 24h 一格的信号总数（含未判定），推荐卡的活跃度柱图用
        # daily: signal totals per 24h from the window start (unresolved included),
        # for the recommendation card's activity sparkline
        "daily": list(bucket["_daily"]) if include_daily else None,
        # weekday：星期几（UTC，周一=0，长度恒 7）× 方向的交叉格，只含已判定。
        # 每格给 全部/做多/做空 三组 tp+sl，前端据此算三个胜率并各自守 5 笔门槛。
        # 做多+做空可能小于全部：方向认不出的行只进"全部"。
        # weekday: weekday (UTC, Monday=0, length 7) x direction cells, resolved
        # only. Each slot carries tp/sl for all, long and short, from which the UI
        # derives three win rates each gated on its own sample size. Long + short
        # may fall short of "all": rows with an unrecognized side join only "all".
        "weekday": [
            {
                "tp": c["tp"], "sl": c["sl"],
                "buyTp": c["buyTp"], "buySl": c["buySl"],
                "sellTp": c["sellTp"], "sellSl": c["sellSl"],
            }
            for c in bucket["_wd"]
        ] if include_daily else None,
    }


def compute_strategy_session_winrate(db: Session, days: int = 7) -> dict:
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
    rows = (
        db.query(Signal.indicator, Signal.symbol, Signal.side, Signal.created_at,
                 Signal.result, Signal.resolved_at)
        .filter(
            Signal.source == "tradingview",
            Signal.created_at >= cutoff_naive,
        )
        .all()
    )

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
    overall: dict[str, dict] = {k: _empty_bucket(days) for k in [*all_keys, "total", *SIDE_KEYS]}
    # {策略名: {品种: {时段键或 "total": 桶}}} / {strategy: {symbol: {session key or "total": bucket}}}
    per_strategy_symbols: dict[str, dict[str, dict[str, dict]]] = {}

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
        # 星期几按 UTC 取。created_at 列存的是 naive UTC（见 models 的 _now），
        # 直接 .weekday() 即为 UTC 星期几，周一=0。
        # Weekday in UTC: created_at stores naive UTC (see _now in models), so
        # .weekday() is already the UTC weekday, Monday=0.
        weekday = created_at.weekday()
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
            per_strategy[name] = {k: _empty_bucket(days) for k in [*all_keys, "total", *SIDE_KEYS]}
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
        _accumulate(per_strategy[name], bucket_keys, key, day_idx, weekday, side_key, resolve_seconds, True)
        _accumulate(overall, bucket_keys, key, day_idx, weekday, side_key, resolve_seconds, True)

        # 品种子分层：同样避免 setdefault(key, {昂贵默认值}) ——两层查找都先判空
        # 再赋值，理由与上面 per_strategy 完全一致。
        # with_daily=False 一路贯穿到底：品种层的每日分布既不分配也不累加，
        # `_shape_symbols` 本来就恒传 include_daily=False，此前那次累加是纯死计算。
        # Per-symbol sub-layer: same "check then assign" pattern as per_strategy
        # above, for the identical reason — setdefault's default arg is built
        # whether or not the key already exists.
        # with_daily=False runs all the way through: the symbol layer neither
        # allocates nor accumulates a per-day distribution. `_shape_symbols`
        # already always passes include_daily=False, which made the old
        # accumulation dead work.
        if name not in per_strategy_symbols:
            per_strategy_symbols[name] = {}
        sym_map = per_strategy_symbols[name]
        if symbol not in sym_map:
            sym_map[symbol] = {
                k: _empty_bucket(days, with_daily=False)
                for k in [*all_keys, "total", *SIDE_KEYS]
            }
        _accumulate(sym_map[symbol], bucket_keys, key, day_idx, weekday, side_key, resolve_seconds, False)

    def _shape(buckets: dict[str, dict]) -> dict:
        return {
            "total": _finalize(buckets["total"], days, True),
            "sessions": {k: _finalize(buckets[k], days, True) for k in all_keys},
            # 方向桶不下发每日分布：再按天切一刀样本就更薄了，而"做多还是做空更好"
            # 是个跨整个窗口的问题，不需要按天看。
            # Side buckets ship no per-day distribution: slicing by day on top of
            # by direction thins the sample further, and "does long or short do
            # better" is a whole-window question anyway.
            "sides": {k: _finalize(buckets[k], days, False) for k in SIDE_KEYS},
        }

    def _shape_symbols(sym_map: dict[str, dict]) -> list[dict]:
        rows = [
            {
                "symbol": sym,
                "total": _finalize(b["total"], days, False),
                "sessions": {k: _finalize(b[k], days, False) for k in all_keys},
                "sides": {k: _finalize(b[k], days, False) for k in SIDE_KEYS},
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
            "strategy": name, **_shape(buckets),
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
        "overall": {"strategy": "", **_shape(overall), "symbols": []},
        "strategies": strategies,
    }
