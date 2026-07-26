"""指标数学：从 strategy_engine.py 抽出的纯函数，输入输出都是等长序列。
Indicator math: pure functions lifted out of strategy_engine.py; inputs and
outputs are equal-length series."""
import statistics


def sma(values: list[float], period: int) -> list[float | None]:
    out: list[float | None] = [None] * len(values)
    total = 0.0
    for i, v in enumerate(values):
        total += v
        if i >= period:
            total -= values[i - period]
        if i >= period - 1:
            out[i] = total / period
    return out


def ema(values: list[float], period: int) -> list[float | None]:
    out: list[float | None] = [None] * len(values)
    if len(values) < period:
        return out
    seed = sum(values[:period]) / period
    out[period - 1] = seed
    k = 2 / (period + 1)
    prev = seed
    for i in range(period, len(values)):
        prev = values[i] * k + prev * (1 - k)
        out[i] = prev
    return out


def rsi(values: list[float], period: int) -> list[float | None]:
    out: list[float | None] = [None] * len(values)
    if len(values) <= period:
        return out
    gain_sum = loss_sum = 0.0
    for i in range(1, period + 1):
        diff = values[i] - values[i - 1]
        if diff >= 0:
            gain_sum += diff
        else:
            loss_sum -= diff
    avg_gain, avg_loss = gain_sum / period, loss_sum / period
    out[period] = 100.0 if avg_loss == 0 else 100 - 100 / (1 + avg_gain / avg_loss)
    for i in range(period + 1, len(values)):
        diff = values[i] - values[i - 1]
        gain = diff if diff > 0 else 0.0
        loss = -diff if diff < 0 else 0.0
        avg_gain = (avg_gain * (period - 1) + gain) / period
        avg_loss = (avg_loss * (period - 1) + loss) / period
        out[i] = 100.0 if avg_loss == 0 else 100 - 100 / (1 + avg_gain / avg_loss)
    return out


def bollinger(
    values: list[float], period: int, mult: float
) -> tuple[list[float | None], list[float | None], list[float | None]]:
    """布林带：返回 (上轨, 中轨, 下轨)。中轨即 SMA，标准差用总体标准差
    （statistics.pstdev），与前端 indicators.ts 口径一致。
    Bollinger bands: returns (upper, middle, lower). The middle band is the
    SMA; the deviation is the population stdev (statistics.pstdev), matching
    the frontend's indicators.ts."""
    middle = sma(values, period)
    upper: list[float | None] = [None] * len(values)
    lower: list[float | None] = [None] * len(values)
    for i in range(period - 1, len(values)):
        m = middle[i]
        if m is None:
            continue
        sd = statistics.pstdev(values[i - period + 1 : i + 1])
        upper[i] = m + mult * sd
        lower[i] = m - mult * sd
    return upper, middle, lower


def macd(
    values: list[float], fast: int, slow: int, signal_period: int
) -> tuple[list[float | None], list[float | None]]:
    """MACD：DIF=快慢 EMA 之差，DEA(signal)=DIF 的 EMA——移植自 indicators.ts 的
    macd()，同样先抽出 DIF 里第一个非空值开始的连续段再算 EMA，再按原位置拼回去
    （慢线预热期会让 DIF 数组开头有一段 None）。
    MACD: DIF = fast EMA - slow EMA, signal (DEA) = EMA of DIF — ported from
    indicators.ts's macd(), pulling out the dense run starting at DIF's first
    non-null value before running EMA over it (the slow EMA's warm-up leaves a
    None head), then splicing the result back into position."""
    fast_ema = ema(values, fast)
    slow_ema = ema(values, slow)
    macd_line: list[float | None] = [
        None if fast_ema[i] is None or slow_ema[i] is None else fast_ema[i] - slow_ema[i]
        for i in range(len(values))
    ]
    first_valid = next((i for i, v in enumerate(macd_line) if v is not None), -1)
    signal: list[float | None] = [None] * len(values)
    if first_valid >= 0:
        dense = macd_line[first_valid:]
        dense_signal = ema(dense, signal_period)
        for i, v in enumerate(dense_signal):
            signal[first_valid + i] = v
    return macd_line, signal


def atr(
    highs: list[float], lows: list[float], closes: list[float], period: int
) -> list[float | None]:
    """ATR：真实波幅的 Wilder 平滑均值，与 rsi() 同一套平滑口径。

    首根 bar 没有前收盘价，真实波幅退化为当根高低差。前 period 根用简单平均
    做种子，其后按 Wilder 递推。

    ATR: Wilder-smoothed average true range, same smoothing convention as
    rsi(). The first bar has no previous close, so its true range degenerates
    to the high-low span. The first `period` bars seed with a simple average;
    subsequent bars use Wilder's recursion.
    """
    n = len(closes)
    out: list[float | None] = [None] * n
    if n < period or period < 1:
        return out
    trs: list[float] = []
    for i in range(n):
        if i == 0:
            trs.append(highs[i] - lows[i])
        else:
            prev_close = closes[i - 1]
            trs.append(max(highs[i] - lows[i], abs(highs[i] - prev_close), abs(lows[i] - prev_close)))
    prev = sum(trs[:period]) / period
    out[period - 1] = prev
    for i in range(period, n):
        prev = (prev * (period - 1) + trs[i]) / period
        out[i] = prev
    return out


def donchian_high(highs: list[float], period: int) -> list[float | None]:
    """每个位置取该 bar 之前(不含当根)最近 period 根的最高价。

    排除当根是刻意的：突破类条件要判断"当根价格是否超过之前的极值"，把当根
    自己算进极值会让突破永远不成立。等价于原 strategy_engine._rolling_max_excl
    的逐 bar 版本，这里一次算出整条序列供规则引擎消费。

    For each position, the highest high of the `period` bars strictly before
    it. Excluding the current bar is deliberate: a breakout condition asks
    whether the current price exceeds the prior extreme, and including the
    current bar in that extreme would make a breakout impossible. Equivalent
    to the per-bar _rolling_max_excl in the old strategy_engine, computed as a
    whole series here for the rule engine to consume.
    """
    out: list[float | None] = [None] * len(highs)
    for i in range(period, len(highs)):
        out[i] = max(highs[i - period : i])
    return out


def donchian_low(lows: list[float], period: int) -> list[float | None]:
    """每个位置取该 bar 之前(不含当根)最近 period 根的最低价。见 donchian_high。
    Lowest low of the `period` bars strictly before each position. See
    donchian_high."""
    out: list[float | None] = [None] * len(lows)
    for i in range(period, len(lows)):
        out[i] = min(lows[i - period : i])
    return out


def cmp_with_tol(a: float, b: float, rel_tol: float = 1e-9) -> int:
    """带容差比较两个浮点数,返回 -1/0/1。

    两条完全由同一批重复价格递推出来的 EMA,理论上应该分毫不差——但
    `prev = value*k + prev*(1-k)` 这种递归乘加运算,只要平滑系数 k=2/(period+1)
    在二进制浮点下不能精确表示(取决于具体的 period,不可预测哪些值会中招,
    实测 period=30 就会、12/26/9/14/50 不会),就会残留 1e-13~1e-14 级别的
    误差(比如 100.0 变成 100.00000000000001)。这点误差如果直接拿去和另一
    条均线做严格的 `<`/`>` 比较,会被误判成"刚刚穿越",凭空报出一个不存在
    的交叉。容差取两数量级的 1e-9 倍(至少 1e-9),比这类浮点残留大出几个
    数量级,又远小于任何真实报价的最小变动单位,不会掩盖真实的交叉。

    Tolerance-based float compare, returns -1/0/1.

    Two EMAs built off literally the same repeated prices should be
    identical in theory — but the recursive multiply-add `prev = value*k +
    prev*(1-k)` leaves ~1e-13-to-1e-14-level residue (e.g. 100.0 becomes
    100.00000000000001) whenever the smoothing constant k=2/(period+1) isn't
    exactly representable in binary floating point — which specific periods
    trigger this is unpredictable (period=30 does, 12/26/9/14/50 don't, in
    this codebase's own tests). Feeding that residue straight into a strict
    `<`/`>` comparison against another series misreads it as "just crossed",
    firing a signal out of thin air. The tolerance is 1e-9 relative (1e-9
    floor) — orders of magnitude above that residue, and orders of magnitude
    below any real quote's tick size, so it never masks an actual crossover.
    """
    tol = max(abs(a), abs(b)) * rel_tol + rel_tol
    if a > b + tol:
        return 1
    if a < b - tol:
        return -1
    return 0
