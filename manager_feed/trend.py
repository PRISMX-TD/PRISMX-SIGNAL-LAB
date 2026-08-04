"""多周期趋势判定，复刻 EA 的算法。
Multi-timeframe trend detection, replicating the EA's logic.

EA 用 EMA(10) 与 EMA(30) 的相对位置加慢线斜率判方向，参数来自 InpTrendFastLen=10、
InpTrendSlowLen=30、InpTrendSlopeLen=3。这里保持同样的参数与判据，让切换前后前端趋势页
的读数一致。

The EA judges direction from EMA(10) vs EMA(30) plus the slow line's slope, with
InpTrendFastLen=10, InpTrendSlowLen=30, InpTrendSlopeLen=3. The same parameters and
predicate are kept here so the frontend trend page reads the same across the switch.
"""
from __future__ import annotations

import logging

logger = logging.getLogger(__name__)

# 后端 TrendDir 只接受这三个值 / the backend's TrendDir accepts only these
UP, DOWN, FLAT = "UP", "DOWN", "FLAT"


def ema(values: list[float], length: int) -> list[float]:
    """指数移动平均，返回与输入等长的序列。

    用前 length 根的简单平均做种子，与 MT5 的 iMA 一致；不足 length 根时返回空列表，
    宁可不给趋势也不给一个用两三根算出来的假趋势。

    EMA over `values`, same length as the input.

    Seeded with the SMA of the first `length` values, matching MT5's iMA. Returns an
    empty list when there are fewer than `length` values: no trend beats a fake one
    derived from two or three bars.
    """
    if len(values) < length or length <= 0:
        return []
    k = 2.0 / (length + 1.0)
    seed = sum(values[:length]) / length
    out = [0.0] * (length - 1) + [seed]
    prev = seed
    for v in values[length:]:
        prev = v * k + prev * (1.0 - k)
        out.append(prev)
    return out


def direction(closes: list[float], fast_len: int = 10, slow_len: int = 30,
              slope_len: int = 3) -> str:
    """按收盘价序列判趋势方向。数据不足返回 FLAT。

    判据（与 EA 一致）：快线在慢线之上且慢线在上行 -> UP；快线在下且慢线下行 -> DOWN；
    其余（含快慢线交叉但斜率背离的震荡区）-> FLAT。

    要求两个条件同时成立而不是只看快慢线关系，是为了滤掉横盘里频繁的假交叉——那种
    情形下快慢线会反复穿越，但慢线整体是平的。

    Trend direction from a close series; FLAT when data is insufficient.

    Predicate (as in the EA): fast above slow with the slow line rising -> UP; fast
    below with the slow line falling -> DOWN; anything else (including crossovers
    whose slope disagrees) -> FLAT.

    Both conditions are required rather than just the fast/slow relation, to filter
    the frequent false crossovers of a range, where the pair crosses repeatedly
    while the slow line stays flat.
    """
    need = slow_len + slope_len
    if len(closes) < need:
        return FLAT

    fast = ema(closes, fast_len)
    slow = ema(closes, slow_len)
    if not fast or not slow or len(slow) <= slope_len:
        return FLAT

    f_now, s_now = fast[-1], slow[-1]
    s_prev = slow[-1 - slope_len]

    if f_now > s_now and s_now > s_prev:
        return UP
    if f_now < s_now and s_now < s_prev:
        return DOWN
    return FLAT


def compute_trends(closes_by_interval: dict[str, list[float]], fast_len: int = 10,
                   slow_len: int = 30, slope_len: int = 3) -> dict[str, str]:
    """算出各周期的趋势方向。

    数据不足的周期直接不放进结果里，而不是填 FLAT：FLAT 表示"判定过，是震荡"，缺数据
    是"没法判定"，两者含义不同，混在一起会让前端把无数据显示成震荡。

    Per-interval trend directions.

    Intervals without enough data are omitted rather than set to FLAT: FLAT means
    "evaluated, ranging" while missing data means "couldn't evaluate". Conflating
    them would make the frontend show absent data as a range.
    """
    out: dict[str, str] = {}
    for interval, closes in closes_by_interval.items():
        if len(closes) < slow_len + slope_len:
            continue
        out[interval] = direction(closes, fast_len, slow_len, slope_len)
    return out
