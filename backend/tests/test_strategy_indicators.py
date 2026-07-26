"""指标模块单测：用手写序列断言数值，不碰数据库。
Indicator unit tests: assert on hand-written series, no DB involved."""
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
