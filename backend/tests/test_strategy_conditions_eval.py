"""32 个用法的逐 bar 求值：每个用法与 indicators.py 的直接计算结果对齐，
预热期一律 False。

Per-bar evaluation of all 32 usages: each one is checked against a direct
computation from indicators.py, with warm-up bars always False.
"""
import math

from app.services.strategy import indicators as ind
from app.services.strategy.conditions import USAGES, evaluate_usage


def _bars(closes: list[float]) -> list[dict]:
    """把收盘价序列做成 bars，高低价按固定偏移撑开，t 按 15 分钟步进。
    Build bars from closes with fixed high/low offsets and a 15-minute step."""
    return [
        {"t": i * 900, "o": c, "h": c + 1.1, "l": c - 1.6, "c": c}
        for i, c in enumerate(closes)
    ]


def _wave(n: int = 200) -> list[float]:
    return [100.0 + 8.0 * math.sin(i / 9) + 3.0 * math.sin(i / 2.7) + 0.05 * i for i in range(n)]


def test_every_usage_returns_a_bool_series_of_the_same_length():
    bars = _bars(_wave())
    for key, spec in USAGES.items():
        out = evaluate_usage(bars, key, {name: ps.default for name, ps in spec.params.items()})
        assert len(out) == len(bars), key
        assert all(isinstance(v, bool) for v in out), key


def test_empty_bars_return_empty():
    assert evaluate_usage([], "rsi.below_level", {"period": 14, "level": 30}) == []


def test_ma_price_above_matches_sma_directly():
    closes = _wave(80)
    bars = _bars(closes)
    line = ind.sma(closes, 20)
    out = evaluate_usage(bars, "ma.price_above", {"maType": "SMA", "period": 20})
    expected = [line[i] is not None and closes[i] > line[i] for i in range(len(closes))]
    assert out == expected


def test_ma_price_cross_above_requires_below_on_the_previous_bar():
    # 前一根在均线下、当根在均线上才算上穿；一直在上方不算。
    closes = [10.0] * 10 + [10.5, 11.0, 11.5, 12.0, 12.5]
    bars = _bars(closes)
    out = evaluate_usage(bars, "ma.price_cross_above", {"maType": "SMA", "period": 5})
    assert out.count(True) == 1
    assert out[10] is True


def test_ma_rising_compares_the_line_with_its_previous_value():
    closes = [float(i) for i in range(40)]
    bars = _bars(closes)
    out = evaluate_usage(bars, "ma.rising", {"maType": "SMA", "period": 5})
    assert out[-1] is True
    assert evaluate_usage(bars, "ma.falling", {"maType": "SMA", "period": 5})[-1] is False


def test_ma_warmup_bars_are_false():
    bars = _bars([float(i) for i in range(40)])
    out = evaluate_usage(bars, "ma.price_above", {"maType": "EMA", "period": 20})
    assert out[:19] == [False] * 19


def test_macd_above_zero_matches_the_macd_line_sign():
    closes = _wave(200)
    bars = _bars(closes)
    line, _sig = ind.macd(closes, 12, 26, 9)
    out = evaluate_usage(bars, "macd.above_zero", {"fast": 12, "slow": 26, "signal": 9})
    expected = [line[i] is not None and line[i] > 0 for i in range(len(closes))]
    assert out == expected


def test_macd_cross_above_signal_is_the_golden_cross():
    closes = _wave(200)
    bars = _bars(closes)
    line, sig = ind.macd(closes, 12, 26, 9)
    out = evaluate_usage(bars, "macd.cross_above_signal", {"fast": 12, "slow": 26, "signal": 9})
    for i in range(1, len(closes)):
        if None in (line[i], line[i - 1], sig[i], sig[i - 1]):
            assert out[i] is False
            continue
        assert out[i] is (line[i - 1] <= sig[i - 1] and line[i] > sig[i])


def test_rsi_below_level_matches_rsi_directly():
    closes = _wave(120)
    bars = _bars(closes)
    series = ind.rsi(closes, 14)
    out = evaluate_usage(bars, "rsi.below_level", {"period": 14, "level": 45})
    expected = [series[i] is not None and series[i] < 45 for i in range(len(closes))]
    assert out == expected


def test_rsi_cross_above_level_needs_a_transition():
    closes = _wave(200)
    bars = _bars(closes)
    series = ind.rsi(closes, 14)
    out = evaluate_usage(bars, "rsi.cross_above_level", {"period": 14, "level": 50})
    for i in range(1, len(closes)):
        if series[i] is None or series[i - 1] is None:
            assert out[i] is False
            continue
        assert out[i] is (series[i - 1] <= 50 and series[i] > 50)


def test_bollinger_break_upper_and_lower_are_price_vs_bands():
    closes = _wave(120)
    bars = _bars(closes)
    upper, _middle, lower = ind.bollinger(closes, 20, 2.0)
    up = evaluate_usage(bars, "bollinger.break_upper", {"period": 20, "mult": 2.0})
    low = evaluate_usage(bars, "bollinger.break_lower", {"period": 20, "mult": 2.0})
    for i in range(len(closes)):
        assert up[i] is (upper[i] is not None and closes[i] > upper[i])
        assert low[i] is (lower[i] is not None and closes[i] < lower[i])


def test_bollinger_bounce_off_lower_needs_the_previous_bar_below_the_band():
    closes = _wave(200)
    bars = _bars(closes)
    _upper, _middle, lower = ind.bollinger(closes, 20, 2.0)
    out = evaluate_usage(bars, "bollinger.bounce_off_lower", {"period": 20, "mult": 2.0})
    for i in range(1, len(closes)):
        if lower[i] is None or lower[i - 1] is None:
            assert out[i] is False
            continue
        assert out[i] is (closes[i - 1] <= lower[i - 1] and closes[i] > lower[i])


def test_donchian_new_high_uses_the_prior_window_only():
    # donchian_high 排除当根，所以「创新高」是收盘价高于此前 N 根的最高价。
    closes = [10.0] * 25 + [50.0]
    bars = _bars(closes)
    out = evaluate_usage(bars, "donchian.new_high", {"period": 20})
    assert out[-1] is True
    assert out[24] is False


def test_donchian_upper_half_compares_against_the_channel_midpoint():
    closes = _wave(120)
    bars = _bars(closes)
    high = ind.donchian_high([b["h"] for b in bars], 20)
    low = ind.donchian_low([b["l"] for b in bars], 20)
    out = evaluate_usage(bars, "donchian.upper_half", {"period": 20})
    for i in range(len(closes)):
        if high[i] is None or low[i] is None:
            assert out[i] is False
            continue
        assert out[i] is (closes[i] > (high[i] + low[i]) / 2)


def test_atr_above_and_below_average_are_mutually_exclusive_once_warm():
    closes = _wave(200)
    bars = _bars(closes)
    above = evaluate_usage(bars, "atr.volatility_above_average", {"period": 14, "mult": 1.0})
    below = evaluate_usage(bars, "atr.volatility_below_average", {"period": 14, "mult": 1.0})
    assert not any(above[i] and below[i] for i in range(len(bars)))
    assert any(above) or any(below)


def test_atr_warmup_is_longer_than_the_atr_period_itself():
    # 基准是 ATR 自身 3x period 的均值，所以预热期比 ATR 本身长得多。
    bars = _bars(_wave(200))
    out = evaluate_usage(bars, "atr.volatility_above_average", {"period": 14, "mult": 1.0})
    assert out[:14 * 3] == [False] * (14 * 3)


def test_mult_shifts_the_atr_threshold():
    bars = _bars(_wave(300))
    loose = evaluate_usage(bars, "atr.volatility_above_average", {"period": 14, "mult": 0.5})
    strict = evaluate_usage(bars, "atr.volatility_above_average", {"period": 14, "mult": 3.0})
    assert loose.count(True) > strict.count(True)


def test_params_fall_back_to_defaults_when_omitted():
    bars = _bars(_wave(120))
    assert evaluate_usage(bars, "rsi.below_level", {}) == evaluate_usage(
        bars, "rsi.below_level", {"period": 14, "level": 30}
    )
