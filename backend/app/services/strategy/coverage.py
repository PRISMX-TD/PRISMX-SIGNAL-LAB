"""K 线覆盖度与断档检测。

存在的理由：K 线唯一写入路径是 EA 推送，每 60 秒每个 (品种, 周期) 只回补最新
500 根，历史深度只能靠 EA 长期在线逐步累积，断线期间形成永久空洞且无补洞机制。
用户选了「回测 365 天」而库里只有 47 天，此前完全看不出来——回测数字看着精确，
实际建立在一段自己都不知道有多长的历史上。

Candle coverage and gap detection. Why this exists: the only write path for
candles is the EA push, which backfills just the latest 500 bars per (symbol,
interval) every 60 seconds. Historical depth accrues only while the EA stays
online, and a disconnection leaves a permanent hole with no repair mechanism. A
user asking to "backtest 365 days" against 47 days of stored history previously
had no way to tell — precise-looking numbers built on a history of unknown
length.
"""
from sqlalchemy import case, func, select
from sqlalchemy.orm import Session

from app.models import Candle
from app.services import quotes_store
from app.services.candle_store import INTERVAL_SECONDS

# 判定断档的容差倍数：相邻两根间隔超过 1.5 个周期才算缺口。取 1.5 而非 1.0 是
# 因为 EA 上报的时间戳可能有秒级抖动，1.0 会把正常序列判成满是缺口。
# Gap tolerance: a step longer than 1.5 intervals counts as a gap. 1.5 rather
# than 1.0 because EA timestamps can jitter by seconds, and 1.0 would report a
# perfectly normal series as riddled with gaps.
GAP_TOLERANCE_MULTIPLIER = 1.5

# 显式查询覆盖度时的品种数上限。刻意独立于 rules.MAX_SYMBOLS：后者是"单条策略最多
# 盯几个品种"（约束实时评估的计算量），而这里是只读聚合查询，用途是把未接入品种
# 置灰，必须能一次看完平台全部品种。取 32 是留足接入余量的防滥用护栏，不是业务规则；
# 不传 symbols 时走 active_symbols() 全量，不受本上限约束。
# Cap on symbols for an explicit coverage query. Deliberately separate from
# rules.MAX_SYMBOLS: that one caps how many symbols a single strategy may watch
# (bounding live-evaluation cost), whereas this is a read-only aggregate whose
# purpose is greying out unfed symbols, so it must cover every fed symbol at
# once. 32 is an anti-abuse guardrail with room to grow, not a business rule;
# omitting symbols uses the full active_symbols() list and is not subject to it.
MAX_COVERAGE_SYMBOLS = 32


def active_symbols() -> list[str]:
    """当前有报价在推的品种。可用品种由 EA 端 InpSymbols 决定，后端不维护白名单，
    因此"哪些品种能用"只能从最近的报价活跃度反推。
    Symbols currently being quoted. The available set is decided by the EA's
    InpSymbols and the backend keeps no whitelist, so "which symbols work" can
    only be inferred from recent quote activity."""
    return quotes_store.get_active_symbols()


def coverage_for(db: Session, symbol: str, interval: str, *, feed_active: bool | None = None) -> dict:
    """某 (品种, 周期) 的实际根数、最早/最晚 bar 时间与断档情况。

    断档按周期秒数检测：相邻两根间隔超过 1.5 个周期即记一个缺口，缺失时长按
    整数根累加。周末休市同样会被报为缺口——本函数报的是"数据有多完整"这一
    事实，不替用户判断哪些缺失属于正常，交易时段的差异由前端呈现。

    统计全部在数据库内完成（LAG 窗口函数取前一根的时间戳），不把逐行时间戳
    载入内存：一个 (品种, 周期) 的历史会长到几十万行，而 5 分钟以上周期没有
    保留期清理，只增不减。

    feed_active 传入时直接采用，供 coverage_matrix 在一次请求内只求值一次；
    省的不只是开销——同一次请求里所有组合对"这个品种是否在推"必须给出一致
    的答案。

    Actual bar count, earliest/latest bar time and gap stats for one (symbol,
    interval). Gaps are detected against the interval's second count: a step
    over 1.5 intervals is one gap, and missing time accumulates in whole bars.
    Weekends show up as gaps too — this reports how complete the data is rather
    than deciding which absences are normal; the frontend presents the nuance.

    Everything is computed inside the database (LAG gives the previous bar's
    timestamp); no per-row timestamps are loaded. One (symbol, interval) series
    can reach hundreds of thousands of rows, and intervals above 1m are never
    swept by retention, so it only ever grows.

    A caller-supplied feed_active is used as-is so coverage_matrix can evaluate
    it once per request — not merely to save work, but because every pair in one
    response must agree on whether a symbol is being fed.
    """
    seconds = INTERVAL_SECONDS.get(interval)
    if seconds is None:
        raise ValueError(f"不支持的周期 {interval}，可选 {sorted(INTERVAL_SECONDS)} / unsupported interval")

    if feed_active is None:
        feed_active = symbol in set(active_symbols())

    # 子查询：每根 bar 带上前一根的时间戳。窗口函数在 SQLite 3.25+ 与 Postgres
    # 上语义一致，不需要按方言分支。
    # Subquery: each bar carries the previous bar's timestamp. Window-function
    # semantics match on SQLite 3.25+ and Postgres, so no dialect branching.
    prev_t = func.lag(Candle.t).over(order_by=Candle.t.asc()).label("prev_t")
    stepped = (
        select(Candle.t.label("t"), prev_t)
        .where(Candle.symbol == symbol, Candle.interval == interval)
        .subquery()
    )
    step = stepped.c.t - stepped.c.prev_t

    # 缺口判定必须是严格大于，且阈值用整数比较避免浮点误差：
    # step > seconds * 1.5  等价于  step * 2 > seconds * 3
    # 1.5 这个容差是为了容忍 EA 时间戳的秒级抖动，不能去掉。
    # The gap test must be strictly greater-than, compared in integers to keep
    # floats out of it: step > seconds * 1.5 is step * 2 > seconds * 3. The 1.5
    # tolerance absorbs the EA's second-level timestamp jitter; it stays.
    is_gap = step * 2 > seconds * 3
    # 缺失时长按整数根累加，与 Python 的 (step // seconds - 1) * seconds 一致。
    # 用 // 而非 /：SQLAlchemy 2.0 的 / 是真除法（会 CAST 成 NUMERIC 得到小数），
    # // 才渲染成向下取整的整数除法；t 是恒非负的 Integer 列，两者逐位相同。
    # Missing time accumulates in whole bars, matching Python's
    # (step // seconds - 1) * seconds. Use // not /: SQLAlchemy 2.0's / is true
    # division (it casts to NUMERIC and yields fractions), while // renders
    # floored integer division. t is a non-negative Integer column, so the two
    # agree bit for bit.
    missing = (step // seconds - 1) * seconds

    row = db.execute(
        select(
            func.count(stepped.c.t),
            func.min(stepped.c.t),
            func.max(stepped.c.t),
            func.coalesce(func.sum(case((is_gap, 1), else_=0)), 0),
            func.coalesce(func.sum(case((is_gap, missing), else_=0)), 0),
        ).select_from(stepped)
    ).one()
    bars, earliest, latest, gap_count, missing_seconds = row

    if not bars:
        return {
            "symbol": symbol, "interval": interval, "bars": 0,
            "earliestT": None, "latestT": None, "spanDays": 0.0,
            "gapCount": 0, "missingSeconds": 0, "feedActive": feed_active,
        }

    return {
        "symbol": symbol,
        "interval": interval,
        "bars": int(bars),
        "earliestT": int(earliest),
        "latestT": int(latest),
        "spanDays": (int(latest) - int(earliest)) / 86_400,
        "gapCount": int(gap_count),
        "missingSeconds": int(missing_seconds),
        "feedActive": feed_active,
    }


def coverage_matrix(db: Session, symbols: list[str], intervals: list[str]) -> list[dict]:
    """对每个 (品种, 周期) 组合各算一行。
    One row per (symbol, interval) combination."""
    return [coverage_for(db, s, i) for s in symbols for i in intervals]
