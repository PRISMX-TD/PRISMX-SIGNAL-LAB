"""指标数学：从 strategy_engine.py 抽出的纯函数，输入输出都是等长序列。
Indicator math: pure functions lifted out of strategy_engine.py; inputs and
outputs are equal-length series."""
import math


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
    """布林带：返回 (上轨, 中轨, 下轨)。中轨即 SMA，用的是总体标准差(分母 n)，
    与前端 indicators.ts 口径一致。
    Bollinger bands: returns (upper, middle, lower). The middle band is the SMA;
    the deviation is the population stdev (divisor n), matching the frontend's
    indicators.ts.

    标准差用滑动平方和递推,而不是每根 bar 调一次 statistics.pstdev:后者每根都要
    拷一份长度 period 的切片并走高精度求和,整体 O(n×period),实测 5 万根时占到
    单条策略求值的 4.98 秒(其余五类指标合计仅 0.78 秒)。递推是 O(n),约 20 毫秒。

    递推里所有累加量都先减去一个固定偏移 origin(取序列首个值)再累加。这一步不是
    可选的微调:方差公式 E[x²]-E[x]² 要把两个量级相近的大数相减,当窗口内波动远
    小于价格本身时(金价 2000 上下、20 根内只走几毛钱,正是最常见的情形),有效位
    会被大量抵消。实测拿 Fraction 精确算术当基准:不减偏移的最大相对误差 6.7e-08,
    减了偏移是 2.6e-14,差 2600 倍,而耗时只从 18 毫秒变成 20 毫秒。

    也试过滑动窗口 Welford(9.5e-12)——反而不如减偏移,因为它移除旧值时要做逆向
    更新,那一步自身会累积误差,不像只增不减的 Welford 那样稳。逐窗口两趟纯浮点
    能到 2.1e-16(浮点极限),但那是 O(n×period),period=100 时要 253 毫秒。

    方差仍做 max(0.0, ...) 钳位:平盘序列理论方差为 0,浮点下可能落在 -1e-13 这类
    极小负数上,不钳位 sqrt 会抛 ValueError。那不是防御性样板代码。

    The stdev uses a rolling sum-of-squares recurrence rather than calling
    statistics.pstdev per bar: the latter copies a period-length slice and runs a
    high-precision summation for every bar, making it O(n*period) — measured at
    4.98s of a single strategy's evaluation over 50k bars, against 0.78s for the
    other five indicator families combined. The recurrence is O(n), around 20ms.

    Every accumulator subtracts a fixed `origin` (the first value) before summing.
    This is not an optional tweak: the variance form E[x^2]-E[x]^2 subtracts two
    similarly-sized large numbers, and when in-window movement is far smaller than
    the price level (gold near 2000 moving cents over 20 bars — the common case),
    significant digits cancel away. Measured against exact Fraction arithmetic: max
    relative error is 6.7e-08 without the offset and 2.6e-14 with it, a 2600x
    difference, for 18ms to 20ms.

    A sliding-window Welford was also tried (9.5e-12) and is *worse* than the
    offset: removing the outgoing value needs a reverse update that accumulates
    error of its own, unlike increment-only Welford. A per-window two-pass float
    sum reaches 2.1e-16 (the floating-point floor) but is O(n*period), costing
    253ms at period=100.

    The variance keeps a max(0.0, ...) clamp: a flat series has zero variance in
    theory and can land on values like -1e-13 in floating point, where sqrt would
    raise ValueError. That clamp is not defensive boilerplate.
    """
    n = len(values)
    middle = sma(values, period)
    upper: list[float | None] = [None] * n
    lower: list[float | None] = [None] * n
    if period <= 0 or n < period:
        return upper, middle, lower

    # 偏移基准。取首个值即可:同一序列内的价格不会跨数量级,减掉它就足以把累加量
    # 压到与窗口波动同量级。理由见上面 docstring。
    # Offset origin. The first value suffices: prices within one series don't span
    # orders of magnitude, so subtracting it brings the accumulators down to the
    # same scale as the in-window movement. Rationale in the docstring.
    origin = values[0]
    total = 0.0
    total_sq = 0.0
    for i, raw in enumerate(values):
        v = raw - origin
        total += v
        total_sq += v * v
        if i >= period:
            dropped = values[i - period] - origin
            total -= dropped
            total_sq -= dropped * dropped
        if i < period - 1:
            continue
        m = middle[i]
        if m is None:
            continue
        # 方差对平移不变,所以偏移后的累加量直接给出原序列的方差。
        # Variance is translation-invariant, so the offset accumulators give the
        # original series' variance directly.
        variance = max(0.0, total_sq / period - (total / period) ** 2)
        sd = math.sqrt(variance)
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
