"""指标模块单测：用手写序列断言数值，不碰数据库。
Indicator unit tests: assert on hand-written series, no DB involved."""
import math

import pytest

from app.services.strategy.indicators import (
    atr, bollinger, cmp_with_tol, donchian_high, donchian_low, ema, macd, rsi, sma,
)


def test_sma_warmup_is_none_then_averages():
    out = sma([1.0, 2.0, 3.0, 4.0], 2)
    assert out[0] is None
    assert out[1] == pytest.approx(1.5)
    assert out[2] == pytest.approx(2.5)
    assert out[3] == pytest.approx(3.5)


def test_ema_seeds_with_sma_at_period_minus_one():
    out = ema([1.0, 2.0, 3.0, 4.0], 2)
    assert out[0] is None
    assert out[1] == pytest.approx(1.5)
    # k = 2/(2+1) = 2/3; next = 3*2/3 + 1.5*1/3 = 2.5
    assert out[2] == pytest.approx(2.5)


def test_ema_returns_all_none_when_shorter_than_period():
    assert ema([1.0, 2.0], 5) == [None, None]


def test_rsi_all_gains_is_hundred():
    out = rsi([1.0, 2.0, 3.0, 4.0, 5.0], 2)
    assert out[2] == pytest.approx(100.0)


def test_rsi_flat_series_is_hundred_when_no_loss():
    # 全平盘：无涨也无跌，avg_loss 为 0，沿用现有实现返回 100
    out = rsi([5.0, 5.0, 5.0, 5.0], 2)
    assert out[2] == pytest.approx(100.0)


def test_bollinger_returns_upper_middle_lower():
    values = [1.0, 2.0, 3.0, 4.0, 5.0]
    upper, middle, lower = bollinger(values, 3, 2.0)
    assert middle[2] == pytest.approx(2.0)  # SMA of 1,2,3
    assert upper[2] > middle[2]
    assert lower[2] < middle[2]
    assert upper[0] is None and middle[0] is None and lower[0] is None


@pytest.mark.parametrize(
    "label,values",
    [
        # 最常见也最难算的情形：均值 2000，20 根窗口内只走几毛钱。大数相减在这里
        # 抵消掉最多有效位，不减偏移的实现会在这组上把误差暴露出来。
        # The common and hardest case: mean 2000, cents of movement per 20-bar
        # window. Cancellation is worst here; an implementation without the offset
        # shows its error on this set.
        ("金价窄幅 / gold tight range",
         [2000.0 + math.sin(i / 3.0) * 0.4 + i * 0.002 for i in range(400)]),
        # 大数值品种，量级 1e5
        # A high-priced instrument, order 1e5
        ("BTC 量级 / BTC scale",
         [95000.0 + math.sin(i / 5.0) * 30.0 + i * 0.05 for i in range(400)]),
        # 长期趋势：偏移基准取首根，价格翻倍后偏移不再贴近当前价位
        # A long trend: the origin is the first bar, so after a doubling it no
        # longer sits near the current level
        ("两年翻倍 / doubling trend",
         [2000.0 + i * 5.0 + math.sin(i / 3.0) * 0.5 for i in range(400)]),
    ],
)
def test_bollinger_matches_pstdev(label, values):
    """滑动递推必须与 statistics.pstdev 的逐窗口结果一致。

    bollinger() 为了把 O(n×period) 降到 O(n)，改用「减固定偏移的滑动平方和」算标准
    差，不再逐根调 pstdev。这条测试是那次改动的正确性依据：拿 pstdev 当参照实现逐点
    对比。容差 rel=1e-13 刻意收得比「反正够用」紧:当前实现实测 1.1e-15,去掉减偏移
    那一步会退到 1.8e-11。两者之间必须有个能把后者挡下来的阈值,否则这条测试就只是
    在陪跑。1e-13 距当前实现有 100 倍余量,距退化实现有 180 倍,两边都不贴边。

    The rolling recurrence must agree with per-window statistics.pstdev. bollinger()
    switched to an offset sum-of-squares recurrence to drop O(n*period) to O(n);
    this test is the correctness basis, comparing against pstdev point by point.
    The rel=1e-13 tolerance is deliberately tighter than "good enough": the current
    implementation measures 1.1e-15 and dropping the offset step regresses to
    1.8e-11. A threshold between the two is what makes this test able to catch that
    regression rather than merely tag along. 1e-13 leaves 100x headroom over the
    current implementation and 180x margin against the regressed one.
    """
    import statistics

    period, mult = 20, 2.0
    upper, middle, lower = bollinger(values, period, mult)

    for i in range(period - 1, len(values)):
        window = values[i - period + 1 : i + 1]
        want_mid = sum(window) / period
        want_sd = statistics.pstdev(window)
        assert middle[i] == pytest.approx(want_mid, rel=1e-13), label
        assert upper[i] == pytest.approx(want_mid + mult * want_sd, rel=1e-13), label
        assert lower[i] == pytest.approx(want_mid - mult * want_sd, rel=1e-13), label


def test_bollinger_flat_series_has_zero_width():
    """全平序列的标准差是 0，递推不能因浮点负零让 sqrt 抛错。

    平方和递推在方差理论值为 0 时可能算出 -1e-13 这类极小负数，未钳位就会
    ValueError。上下轨应与中轨重合。

    A flat series has zero stdev and the recurrence must not let floating-point
    negative zero make sqrt raise: the sum-of-squares form can land on values like
    -1e-13 where the true variance is 0, which would ValueError unclamped. Bands
    should collapse onto the middle.
    """
    upper, middle, lower = bollinger([2000.0] * 50, 20, 2.0)
    assert middle[-1] == pytest.approx(2000.0)
    assert upper[-1] == pytest.approx(2000.0)
    assert lower[-1] == pytest.approx(2000.0)


def test_bollinger_shorter_than_period_is_all_none():
    upper, middle, lower = bollinger([1.0, 2.0], 20, 2.0)
    assert upper == [None, None]
    assert middle == [None, None]
    assert lower == [None, None]


def test_macd_returns_dif_and_dea():
    values = [float(i) for i in range(1, 60)]
    dif, dea = macd(values, 12, 26, 9)
    assert dif[0] is None
    assert dif[-1] is not None
    assert dea[-1] is not None


def test_atr_of_constant_range_equals_that_range():
    highs = [11.0] * 10
    lows = [9.0] * 10
    closes = [10.0] * 10
    out = atr(highs, lows, closes, 3)
    assert out[2] == pytest.approx(2.0)
    assert out[-1] == pytest.approx(2.0)
    assert out[0] is None


def test_donchian_high_excludes_current_bar():
    highs = [1.0, 5.0, 2.0, 3.0]
    out = donchian_high(highs, 2)
    assert out[0] is None
    assert out[1] is None
    # index 2 看前两根 (1,5) -> 5；当根自己的 2 不参与
    assert out[2] == pytest.approx(5.0)
    # index 3 看前两根 (5,2) -> 5
    assert out[3] == pytest.approx(5.0)


def test_donchian_low_excludes_current_bar():
    lows = [4.0, 1.0, 3.0, 2.0]
    out = donchian_low(lows, 2)
    assert out[2] == pytest.approx(1.0)
    assert out[3] == pytest.approx(1.0)


def test_cmp_with_tol_treats_float_residue_as_equal():
    assert cmp_with_tol(100.0, 100.00000000000001) == 0
    assert cmp_with_tol(1.0, 2.0) == -1
    assert cmp_with_tol(2.0, 1.0) == 1
