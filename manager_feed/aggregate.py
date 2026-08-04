"""M1 聚合为高周期 K 线。
Aggregate M1 bars into higher intervals.

Manager API 的 ChartRequest 只返回 M1（实测：请求 3 小时得到 180 根，相邻间隔全为 60 秒，
且该方法没有周期参数）。EA 时代高周期由 MT5 终端算好，换成 Manager 后必须自己聚合。

这个模块是本次改动里唯一的全新逻辑，也是最需要小心的地方——历史上休市期间产生过垃圾
K 线，后端为此加了三道闸门。所以这里的原则是**宁缺勿假**：

  1. 只用真实存在的 M1，不做任何填充；
  2. 一根高周期 bar 必须集齐它覆盖的全部 M1 才生成，缺一根就不生成；
  3. 只输出已经收盘的 bar。

Manager API's ChartRequest only returns M1 (measured: a 3-hour request yields 180
bars, every adjacent gap exactly 60s, and the call takes no timeframe argument).
The EA got higher intervals from the MT5 terminal; the gateway must build them.

This module is the only genuinely new logic in this change and the riskiest part —
closed-market sessions have produced junk candles before, which is why the backend
grew three gates. The rule here is therefore **omit rather than invent**:

  1. only real M1 bars, never any filling;
  2. a higher-interval bar is emitted only if every M1 it covers is present;
  3. only closed bars are emitted.
"""
from __future__ import annotations

import logging

logger = logging.getLogger(__name__)

# 周期代码 -> 秒数。与 EA 的 g_candleTf 对齐：M1 M5 M15 H1 H4 D1。
# Interval code -> seconds. Matches the EA's g_candleTf: M1 M5 M15 H1 H4 D1.
INTERVAL_SECONDS: dict[str, int] = {
    "M1": 60,
    "M5": 5 * 60,
    "M15": 15 * 60,
    "H1": 60 * 60,
    "H4": 4 * 60 * 60,
    "D1": 24 * 60 * 60,
}

# K 线推送的周期顺序 / candle intervals to push, in order
CANDLE_INTERVALS: tuple[str, ...] = ("M1", "M5", "M15", "H1", "H4", "D1")

# 趋势用的周期，与 EA 的 g_trendTf 对齐（有 M30、无 D1，和 K 线那组刻意不同）。
# Trend intervals, matching the EA's g_trendTf (has M30, no D1 — deliberately
# different from the candle set).
TREND_INTERVALS: tuple[str, ...] = ("M1", "M5", "M15", "M30", "H1", "H4")

# 趋势需要 M30，但 K 线不推它，所以单独登记秒数。
# M30 is needed for trends but not pushed as candles, so register it separately.
INTERVAL_SECONDS["M30"] = 30 * 60


def bucket_start(t: int, interval: str, tz_offset_seconds: int = 0) -> int:
    """这个时间戳所属高周期 bar 的起始时刻（券商时区对齐）。

    ``tz_offset_seconds`` 为券商服务器所在时区相对 UTC 的秒数偏移。默认 0 对
    M1/M5/M15/M30/H1 这些整除 3600 的周期无影响（它们的边界与时区无关），但对
    H4 和 D1 至关重要——不同时区下的 4 小时/日窗口覆盖的是不同段的数据，OHLC
    完全不同，趋势方向自然对不上。

    The start of the higher-interval bar, broker-timezone-aligned.

    ``tz_offset_seconds`` is the broker timezone offset from UTC in seconds.
    Default 0 has no effect on M1/M5/M15/M30/H1 (tz-agnostic boundaries), but
    is essential for H4 and D1 — their windows cover different stretches across
    timezones, yielding different OHLC and therefore different trend directions.
    """
    size = INTERVAL_SECONDS[interval]
    return ((t - tz_offset_seconds) // size) * size + tz_offset_seconds


def aggregate(m1_bars: list[dict], interval: str, tz_offset_seconds: int = 0) -> list[dict]:
    """把 M1 聚合成指定周期，只返回完整且已收盘的 bar。

    m1_bars 必须按时间升序，每项形如
    {"t": int, "o": float, "h": float, "l": float, "c": float, "v": float}。

    完整性判据是"这一桶收齐了 size/60 根 M1"。这是本模块最重要的一条：休市、缺口、
    数据尚未同步完都会让某一桶缺 M1，此时生成出来的 bar 是残缺的（比如一根 H4 只用
    了 3 根 M1 算出来的 OHLC），推给后端就是垃圾数据。缺就不生成，等下一轮数据齐了
    自然会补上。

    ``tz_offset_seconds`` 券商时区偏移（秒），传给 bucket_start 对齐 H4/D1 边界。

    Aggregate M1 into `interval`, returning only complete, closed bars.

    m1_bars must be ascending, each item shaped
    {"t", "o", "h", "l", "c", "v"}.

    Completeness means "this bucket holds all size/60 of its M1 bars". This is the
    module's central rule: closures, gaps and not-yet-synced data all leave a
    bucket short, and a bar built from a partial bucket is malformed (an H4 whose
    OHLC came from 3 M1 bars, say) — junk once pushed. A short bucket is skipped;
    a later pass emits it once the data is there.

    ``tz_offset_seconds`` broker timezone offset in seconds, forwarded to
    bucket_start for correct H4/D1 boundary alignment.
    """
    if interval == "M1":
        return list(m1_bars)
    if interval not in INTERVAL_SECONDS:
        raise ValueError(f"未知周期 / unknown interval: {interval}")

    size = INTERVAL_SECONDS[interval]
    expected = size // 60

    buckets: dict[int, list[dict]] = {}
    for bar in m1_bars:
        buckets.setdefault(bucket_start(bar["t"], interval, tz_offset_seconds), []).append(bar)

    out: list[dict] = []
    skipped_incomplete = 0
    for start in sorted(buckets):
        group = buckets[start]
        if len(group) < expected:
            skipped_incomplete += 1
            continue
        group.sort(key=lambda b: b["t"])
        out.append(
            {
                "t": start,
                "o": group[0]["o"],
                "h": max(b["h"] for b in group),
                "l": min(b["l"] for b in group),
                "c": group[-1]["c"],
                "v": sum(b.get("v", 0) or 0 for b in group),
            }
        )

    if skipped_incomplete:
        # 正常现象：最新那一桶通常还在形成中。只在 DEBUG 记录，避免刷日志。
        # Expected: the newest bucket is usually still forming. DEBUG only.
        logger.debug(
            "%s: 跳过 %d 个不完整时段 / skipped %d incomplete bucket(s)",
            interval, skipped_incomplete, skipped_incomplete,
        )
    return out


def drop_forming_bar(bars: list[dict], interval: str, now: int,
                     tz_offset_seconds: int = 0) -> list[dict]:
    """丢掉仍在形成中的最后一根。

    必须做这件事：后端 feed_candles 对每根新收盘的 bar 触发策略求值——写信号、发推送、
    推进 last_signal_bar_t 去重游标。把未收盘的 bar 当成已收盘推上去，会用一根还在变
    的价格产生信号，并且把游标提前推过去，导致这根真正收盘时反而被判为已处理。

    ``tz_offset_seconds`` 券商时区偏移，传给 bucket_start 对齐 H4/D1 判定。

    Drop the still-forming final bar.

    Required: the backend's feed_candles evaluates strategies on every newly closed
    bar — writing signals, sending pushes, advancing the last_signal_bar_t dedup
    cursor. Pushing an unfinished bar as closed produces a signal from a price that
    is still moving and advances the cursor past it, so the genuine close is later
    judged already-handled.

    ``tz_offset_seconds`` broker timezone offset, forwarded to bucket_start for
    correct H4/D1 forming-bar detection.
    """
    size = INTERVAL_SECONDS[interval]
    current = ((now - tz_offset_seconds) // size) * size + tz_offset_seconds
    return [b for b in bars if b["t"] < current]
