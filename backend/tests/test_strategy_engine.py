"""自定义策略引擎的单测：指标数学、十个模板的入场信号判定、参数校验/夹紧、
回测的成交与净值结算逻辑。

Unit tests for the custom-strategy engine: indicator math, entry-signal
detection for all ten templates, parameter validation/clamping, and the
backtest engine's trade-resolution/equity bookkeeping.
"""
import pytest

from app.services import strategy_engine as se


def _bars_from_closes(closes: list[float]) -> list[dict]:
    """构造 OHLC 全等于收盘价的简单 K 线,只用于测「基于收盘价」的指标/信号。
    Builds bars whose OHLC all equal the close — fine for testing
    close-price-only indicators/signals."""
    return [{"t": i, "o": c, "h": c, "l": c, "c": c, "v": 0} for i, c in enumerate(closes)]


# ---------- 指标数学 / indicator math ----------
def test_sma_of_constant_series_equals_the_constant():
    out = se._sma([5.0] * 10, 3)
    assert out[:2] == [None, None]
    assert all(v == pytest.approx(5.0) for v in out[2:])


def test_ema_of_constant_series_equals_the_constant():
    out = se._ema([7.0] * 10, 4)
    assert all(v is None for v in out[:3])
    assert all(v == pytest.approx(7.0) for v in out[3:])


def test_rsi_all_gains_saturates_to_100():
    values = [float(i) for i in range(1, 30)]  # 单调上涨,永无回撤 / strictly increasing, never down
    out = se._rsi(values, 14)
    resolved = [v for v in out if v is not None]
    assert resolved
    assert all(v == pytest.approx(100.0) for v in resolved)


def test_bollinger_bands_collapse_to_mid_on_flat_series():
    upper, lower = se._bollinger([3.0] * 10, 5, 2.0)
    for i in range(4, 10):
        assert upper[i] == pytest.approx(3.0)
        assert lower[i] == pytest.approx(3.0)


# ---------- 参数校验/夹紧 / param validation & clamping ----------
def test_unknown_template_rejected():
    with pytest.raises(ValueError):
        se.validate_and_clamp_params("not_a_template", {})


def test_out_of_range_values_are_clamped_not_rejected():
    out = se.validate_and_clamp_params("rsi_reversal", {"period": 999, "oversold": -5})
    assert out["period"] == 50  # max
    assert out["oversold"] == 1  # min


def test_ma_cross_slow_period_forced_above_fast():
    out = se.validate_and_clamp_params("ma_cross", {"fastPeriod": 20, "slowPeriod": 10})
    assert out["slowPeriod"] > out["fastPeriod"]


def test_defaults_used_when_missing():
    out = se.validate_and_clamp_params("bollinger_reversion", {})
    assert out["period"] == 20
    assert out["mult"] == 2.0
    assert out["direction"] == "both"


# ---------- 入场信号判定 / entry-signal detection ----------
def test_ma_cross_fires_buy_on_upward_cross():
    closes = [100.0] * 8 + [110.0, 125.0, 145.0, 170.0]
    bars = _bars_from_closes(closes)
    params = se.validate_and_clamp_params("ma_cross", {"maType": "SMA", "fastPeriod": 2, "slowPeriod": 4})
    signals = se.entry_signals(bars, "ma_cross", params)
    assert "BUY" in signals
    assert "SELL" not in signals


def test_ma_cross_direction_filter_drops_disallowed_side():
    closes = [100.0] * 8 + [110.0, 125.0, 145.0, 170.0]
    bars = _bars_from_closes(closes)
    params = se.validate_and_clamp_params("ma_cross", {"maType": "SMA", "fastPeriod": 2, "slowPeriod": 4, "direction": "short"})
    signals = se.entry_signals(bars, "ma_cross", params)
    assert all(s != "BUY" for s in signals)


def test_rsi_reversal_fires_buy_after_oversold_bounce():
    # 持续下跌把 RSI 压到超卖区,随后一根反弹 K 线让 RSI 重新穿回超卖线之上
    # A sustained decline pushes RSI into oversold; one bounce bar crosses back above it.
    closes = [100.0 - i * 3 for i in range(20)] + [70.0]
    bars = _bars_from_closes(closes)
    params = se.validate_and_clamp_params("rsi_reversal", {"period": 14, "oversold": 30, "overbought": 70})
    signals = se.entry_signals(bars, "rsi_reversal", params)
    assert signals[-1] == "BUY"


def test_bollinger_reversion_fires_buy_on_reclaim_of_lower_band():
    closes = [100.0] * 25 + [90.0, 101.0]  # 骤跌破下轨,下一根收回轨内 / sharp drop below lower band, next bar reclaims it
    bars = _bars_from_closes(closes)
    params = se.validate_and_clamp_params("bollinger_reversion", {"period": 20, "mult": 2.0})
    signals = se.entry_signals(bars, "bollinger_reversion", params)
    assert signals[-1] == "BUY"


def test_macd_cross_fires_buy_on_bullish_cross():
    closes = [100.0] * 40 + [102.0, 105.0, 109.0, 114.0, 120.0]
    bars = _bars_from_closes(closes)
    params = se.validate_and_clamp_params("macd_cross", {})
    signals = se.entry_signals(bars, "macd_cross", params)
    assert "BUY" in signals
    assert "SELL" not in signals


def test_macd_cross_slow_period_forced_above_fast():
    out = se.validate_and_clamp_params("macd_cross", {"fastPeriod": 30, "slowPeriod": 10})
    assert out["slowPeriod"] > out["fastPeriod"]


def test_ma_pullback_fires_buy_on_dip_and_recover():
    # 上升趋势里回踩到均线附近但收盘仍站上均线 / an uptrend pullback that
    # dips near the MA but still closes back above it
    closes = [100.0 + i * 0.5 for i in range(30)] + [113.0]
    lows = list(closes)
    lows[-1] = 111.8
    bars = [{"c": c, "h": c + 0.5, "l": lo} for c, lo in zip(closes, lows)]
    params = se.validate_and_clamp_params("ma_pullback", {"period": 10, "touchTolerancePct": 1.0})
    signals = se.entry_signals(bars, "ma_pullback", params)
    assert signals[-1] == "BUY"


def test_bollinger_breakout_fires_buy_on_upside_break():
    closes = [100.0] * 30 + [100.0, 110.0]  # 突破上轨,不是回归 / breaks above the upper band, not a reversion
    bars = _bars_from_closes(closes)
    params = se.validate_and_clamp_params("bollinger_breakout", {"period": 20})
    signals = se.entry_signals(bars, "bollinger_breakout", params)
    assert signals[-1] == "BUY"


def test_rsi_momentum_fires_buy_on_midline_cross_up():
    closes = [100.0]
    for _ in range(20):
        closes.append(closes[-1] - 1)
    for _ in range(20):
        closes.append(closes[-1] + 1.5)
    bars = _bars_from_closes(closes)
    params = se.validate_and_clamp_params("rsi_momentum", {"period": 14})
    signals = se.entry_signals(bars, "rsi_momentum", params)
    assert "BUY" in signals


def test_donchian_breakout_fires_buy_on_new_high():
    closes = [100.0] * 30 + [101.0, 105.0]
    bars = _bars_from_closes(closes)
    params = se.validate_and_clamp_params("donchian_breakout", {"period": 20})
    signals = se.entry_signals(bars, "donchian_breakout", params)
    assert "BUY" in signals


def test_donchian_breakout_does_not_repeat_while_price_stays_elevated():
    closes = [100.0] * 30 + [101.0, 105.0, 105.5, 106.0]
    bars = _bars_from_closes(closes)
    params = se.validate_and_clamp_params("donchian_breakout", {"period": 20})
    signals = se.entry_signals(bars, "donchian_breakout", params)
    assert signals.count("BUY") == 1


def test_momentum_breakout_fires_buy_on_sharp_rise():
    closes = [100.0] * 15 + [103.0]
    bars = _bars_from_closes(closes)
    params = se.validate_and_clamp_params("momentum_breakout", {"lookback": 10, "thresholdPct": 1.0})
    signals = se.entry_signals(bars, "momentum_breakout", params)
    assert signals[-1] == "BUY"


def test_trend_rsi_filter_fires_buy_on_uptrend_dip_bounce():
    closes = [100.0 + i * 0.5 for i in range(30)]
    for _ in range(5):
        closes.append(closes[-1] - 0.8)
    closes.append(closes[-1] + 0.5)
    bars = [{"c": c, "h": c + 0.3, "l": c - 0.3} for c in closes]
    params = se.validate_and_clamp_params("trend_rsi_filter", {"trendPeriod": 20, "rsiPeriod": 5})
    signals = se.entry_signals(bars, "trend_rsi_filter", params)
    assert signals[-1] == "BUY"


def test_unknown_template_still_rejected_after_expansion():
    with pytest.raises(ValueError):
        se.entry_signals(_bars_from_closes([1.0, 2.0, 3.0]), "not_a_template", {})


# ---------- 回测引擎:成交与净值结算(用打桩的入场信号,隔离测试撮合/净值逻辑) ----------
# ---------- Backtest engine: trade resolution & equity (entry signals stubbed
#             to isolate the fill/equity bookkeeping from crossing detection) ----------
def test_backtest_records_a_win_when_take_profit_is_hit(monkeypatch):
    bars = [
        {"t": 0, "o": 100, "h": 100, "l": 100, "c": 100},
        {"t": 1, "o": 100, "h": 100, "l": 100, "c": 100},  # 入场 bar / entry bar
        {"t": 2, "o": 100, "h": 103, "l": 99.5, "c": 102},  # 摸到止盈(102),没摸到止损(99) / hits TP, not SL
    ]
    monkeypatch.setattr(se, "entry_signals", lambda b, t, p: [None, "BUY", None])
    result = se.run_backtest(bars, "ma_cross", {}, stop_loss_method="percent", stop_loss_value=1.0, take_profit_method="rr", take_profit_value=2.0, risk_pct=1.0, capital=10000, mode="compound", symbol="TEST")
    assert result["summary"]["wins"] == 1
    assert result["summary"]["losses"] == 0
    assert result["summary"]["finalEquity"] > 10000
    assert result["trades"][0]["result"] == "HIT_TP"


def test_backtest_records_a_loss_when_stop_loss_is_hit(monkeypatch):
    bars = [
        {"t": 0, "o": 100, "h": 100, "l": 100, "c": 100},
        {"t": 1, "o": 100, "h": 100, "l": 100, "c": 100},
        {"t": 2, "o": 100, "h": 100.5, "l": 98.0, "c": 99},  # 摸到止损(99),没摸到止盈(102) / hits SL, not TP
    ]
    monkeypatch.setattr(se, "entry_signals", lambda b, t, p: [None, "BUY", None])
    result = se.run_backtest(bars, "ma_cross", {}, stop_loss_method="percent", stop_loss_value=1.0, take_profit_method="rr", take_profit_value=2.0, risk_pct=1.0, capital=10000, mode="compound", symbol="TEST")
    assert result["summary"]["wins"] == 0
    assert result["summary"]["losses"] == 1
    assert result["summary"]["finalEquity"] < 10000
    assert result["trades"][0]["result"] == "HIT_SL"


def test_backtest_same_bar_hitting_both_sl_and_tp_counts_as_loss(monkeypatch):
    """同一根 K 线内先摸到止损再摸到止盈——保守假设,判定为止损。
    A single bar that touches both SL and TP — the conservative assumption counts it as SL."""
    bars = [
        {"t": 0, "o": 100, "h": 100, "l": 100, "c": 100},
        {"t": 1, "o": 100, "h": 100, "l": 100, "c": 100},
        {"t": 2, "o": 100, "h": 110, "l": 90, "c": 100},  # 同一根摸到两边 / both SL and TP touched in one bar
    ]
    monkeypatch.setattr(se, "entry_signals", lambda b, t, p: [None, "BUY", None])
    result = se.run_backtest(bars, "ma_cross", {}, stop_loss_method="percent", stop_loss_value=1.0, take_profit_method="rr", take_profit_value=2.0, risk_pct=1.0, capital=10000, mode="compound", symbol="TEST")
    assert result["trades"][0]["result"] == "HIT_SL"


def test_backtest_unresolved_trade_at_end_of_data_is_not_counted(monkeypatch):
    bars = [
        {"t": 0, "o": 100, "h": 100, "l": 100, "c": 100},
        {"t": 1, "o": 100, "h": 100, "l": 100, "c": 100},  # 入场后没有更多 K 线可以判定结果 / no more bars to resolve it
    ]
    monkeypatch.setattr(se, "entry_signals", lambda b, t, p: [None, "BUY"])
    result = se.run_backtest(bars, "ma_cross", {}, stop_loss_method="percent", stop_loss_value=1.0, take_profit_method="rr", take_profit_value=2.0, risk_pct=1.0, capital=10000, mode="compound", symbol="TEST")
    assert result["summary"]["wins"] == 0
    assert result["summary"]["losses"] == 0
    assert result["trades"] == []
