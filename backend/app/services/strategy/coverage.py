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


def active_symbols() -> list[str]:
    """当前有报价在推的品种。可用品种由 EA 端 InpSymbols 决定，后端不维护白名单，
    因此"哪些品种能用"只能从最近的报价活跃度反推。
    Symbols currently being quoted. The available set is decided by the EA's
    InpSymbols and the backend keeps no whitelist, so "which symbols work" can
    only be inferred from recent quote activity."""
    return quotes_store.get_active_symbols()


def coverage_for(db: Session, symbol: str, interval: str) -> dict:
    """某 (品种, 周期) 的实际根数、最早/最晚 bar 时间与断档情况。

    断档按周期秒数检测：相邻两根间隔超过 1.5 个周期即记一个缺口，缺失时长按
    整数根累加。周末休市同样会被报为缺口——本函数报的是"数据有多完整"这一
    事实，不替用户判断哪些缺失属于正常，交易时段的差异由前端呈现。

    Actual bar count, earliest/latest bar time and gap stats for one (symbol,
    interval). Gaps are detected against the interval's second count: a step
    over 1.5 intervals is one gap, and missing time accumulates in whole bars.
    Weekends show up as gaps too — this reports how complete the data is rather
    than deciding which absences are normal; the frontend presents the nuance.
    """
    seconds = INTERVAL_SECONDS.get(interval)
    if seconds is None:
        raise ValueError(f"不支持的周期 {interval}，可选 {sorted(INTERVAL_SECONDS)} / unsupported interval")

    # 只取时间列：覆盖度统计不需要 OHLC，一个 (品种, 周期) 可能有上万行。
    # Times only: coverage needs no OHLC and one series can run to tens of
    # thousands of rows.
    times = [
        row[0]
        for row in db.query(Candle.t)
        .filter(Candle.symbol == symbol, Candle.interval == interval)
        .order_by(Candle.t.asc())
        .all()
    ]
    feed_active = symbol in set(active_symbols())
    if not times:
        return {
            "symbol": symbol, "interval": interval, "bars": 0,
            "earliestT": None, "latestT": None, "spanDays": 0.0,
            "gapCount": 0, "missingSeconds": 0, "feedActive": feed_active,
        }

    threshold = seconds * GAP_TOLERANCE_MULTIPLIER
    gap_count = 0
    missing_seconds = 0
    for prev, cur in zip(times, times[1:]):
        step = cur - prev
        if step > threshold:
            gap_count += 1
            missing_seconds += (step // seconds - 1) * seconds

    return {
        "symbol": symbol,
        "interval": interval,
        "bars": len(times),
        "earliestT": times[0],
        "latestT": times[-1],
        "spanDays": (times[-1] - times[0]) / 86_400,
        "gapCount": gap_count,
        "missingSeconds": int(missing_seconds),
        "feedActive": feed_active,
    }


def coverage_matrix(db: Session, symbols: list[str], intervals: list[str]) -> list[dict]:
    """对每个 (品种, 周期) 组合各算一行。
    One row per (symbol, interval) combination."""
    return [coverage_for(db, s, i) for s in symbols for i in intervals]
