"""回测引擎单测：成本、出场方法、超时、样本内外切分、过拟合判定。

用打桩的规则（"close > 0" 恒真、或指定 bar 才为真的构造）隔离撮合与净值逻辑，
不依赖真实指标——指标本身已在 test_strategy_indicators.py 覆盖。

Backtest engine tests: costs, exit methods, timeout, in/out-of-sample split and
the overfit verdict. Rules are stubbed (always-true, or true only on chosen
bars) to isolate fill/equity logic from indicator math, which
test_strategy_indicators.py already covers.
"""
import pytest

from app.services.strategy import backtest as bt
from app.services.strategy.costs import SymbolCosts

NO_COSTS = SymbolCosts(spread=0.0, commission_per_lot=0.0, slippage=0.0)


def _bars(rows, start_t=0, step=900):
    """rows 为 (open, high, low, close) 四元组序列。
    rows is a sequence of (open, high, low, close) tuples."""
    return [
        {"t": start_t + i * step, "o": o, "h": h, "l": lo, "c": c, "v": 1.0}
        for i, (o, h, lo, c) in enumerate(rows)
    ]


def _flat_bars(n, price=100.0, start_t=0, step=900):
    return _bars([(price, price, price, price)] * n, start_t=start_t, step=step)


def _rule_on(field="close", op="gt", value=0.0):
    """恒真规则（收盘价永远大于 0）/ an always-true rule."""
    return {
        "logic": "AND",
        "children": [
            {"left": {"kind": "price", "field": field}, "op": op, "right": {"kind": "const", "value": value}}
        ],
    }


def _long_only(value=0.0):
    return {"long": _rule_on(value=value), "short": None}


def _spec(sl_method="percent", sl_value=1.0, tp_method="rr", tp_value=2.0, timeout_bars=None):
    return bt.ExitSpec(
        sl_method=sl_method, sl_value=sl_value,
        tp_method=tp_method, tp_value=tp_value,
        timeout_bars=timeout_bars,
    )


# ---------- 出场价计算 / exit price computation ----------

def test_percent_sl_and_rr_tp():
    sl, tp = bt.exit_prices("BUY", 100.0, "TESTSYM", _spec("percent", 1.0, "rr", 2.0))
    assert sl == pytest.approx(99.0)
    assert tp == pytest.approx(102.0)


def test_sell_side_mirrors_the_distances():
    sl, tp = bt.exit_prices("SELL", 100.0, "TESTSYM", _spec("percent", 1.0, "rr", 2.0))
    assert sl == pytest.approx(101.0)
    assert tp == pytest.approx(98.0)


def test_atr_sl_uses_atr_multiple():
    sl, tp = bt.exit_prices("BUY", 100.0, "TESTSYM", _spec("atr", 2.0, "atr", 3.0), atr_value=0.5)
    assert sl == pytest.approx(99.0)   # 100 - 2 * 0.5
    assert tp == pytest.approx(101.5)  # 100 + 3 * 0.5


def test_atr_method_without_atr_value_raises():
    with pytest.raises(ValueError):
        bt.exit_prices("BUY", 100.0, "TESTSYM", _spec("atr", 2.0, "rr", 2.0), atr_value=None)


def test_steps_method_uses_point_size():
    sl, tp = bt.exit_prices("BUY", 2400.0, "UNKNOWNSYM", _spec("steps", 500, "steps", 1000))
    assert sl == pytest.approx(2400.0 - 500 * 0.01)
    assert tp == pytest.approx(2400.0 + 1000 * 0.01)


def test_unknown_method_raises():
    with pytest.raises(ValueError):
        bt.exit_prices("BUY", 100.0, "TESTSYM", _spec("bogus", 1.0, "rr", 2.0))


# ---------- 撮合 / trade resolution ----------

def test_resolve_trade_finds_take_profit():
    bars = _bars([(100, 100, 100, 100), (100, 103, 99.5, 102)])
    assert bt.resolve_trade(bars, 0, "BUY", 99.0, 102.0, None) == ("HIT_TP", 1)


def test_resolve_trade_same_bar_double_touch_counts_as_stop():
    bars = _bars([(100, 100, 100, 100), (100, 103, 98.0, 100)])
    assert bt.resolve_trade(bars, 0, "BUY", 99.0, 102.0, None) == ("HIT_SL", 1)


def test_resolve_trade_returns_none_when_data_runs_out():
    bars = _flat_bars(3)
    assert bt.resolve_trade(bars, 0, "BUY", 99.0, 102.0, None) == (None, None)


def test_timeout_closes_at_that_bars_close():
    bars = _flat_bars(5)
    assert bt.resolve_trade(bars, 0, "BUY", 90.0, 110.0, 2) == ("TIMEOUT", 2)


def test_timeout_does_not_preempt_an_earlier_hit():
    bars = _bars([(100, 100, 100, 100), (100, 103, 100, 102), (100, 100, 100, 100)])
    assert bt.resolve_trade(bars, 0, "BUY", 99.0, 102.0, 2) == ("HIT_TP", 1)


# ---------- 成本 / costs ----------

def test_entry_fill_worsened_by_spread_and_slippage():
    bars = _flat_bars(40)
    costs = SymbolCosts(spread=0.4, commission_per_lot=0.0, slippage=0.1)
    res = bt.run_backtest(
        bars, _long_only(), _spec(timeout_bars=1),
        symbol="TESTSYM", risk_pct=1.0, capital=10_000, mode="flat", costs=costs,
    )
    assert res["trades"], "至少要有一笔交易 / expected at least one trade"
    assert res["trades"][0]["entryPrice"] == pytest.approx(100.3)


def test_total_cost_is_reported_and_positive_when_costs_exist():
    bars = _flat_bars(40)
    costs = SymbolCosts(spread=0.4, commission_per_lot=0.05, slippage=0.1)
    res = bt.run_backtest(
        bars, _long_only(), _spec(timeout_bars=1),
        symbol="TESTSYM", risk_pct=1.0, capital=10_000, mode="flat", costs=costs,
    )
    assert res["totalCost"] > 0


def test_without_costs_result_is_reported_alongside():
    bars = _flat_bars(40)
    costs = SymbolCosts(spread=0.4, commission_per_lot=0.05, slippage=0.1)
    res = bt.run_backtest(
        bars, _long_only(), _spec(timeout_bars=1),
        symbol="TESTSYM", risk_pct=1.0, capital=10_000, mode="flat", costs=costs,
    )
    assert "withoutCosts" in res
    # 平盘 + 超时平仓：不含成本时盈亏恰为 0，含成本时必然为负
    # Flat prices + timeout exit: zero P&L without costs, necessarily negative with them
    assert res["withoutCosts"]["summary"]["returnPct"] == pytest.approx(0.0)
    assert res["summary"]["returnPct"] < 0


def test_stop_exit_takes_an_extra_slippage_but_target_does_not():
    # 一根打到止损，一根打到止盈，各自独立开仓（关掉一次一单）
    # One run stops out, one takes profit
    sl_bars = _bars([(100, 100, 100, 100), (100, 100, 98.0, 99.0)])
    costs = SymbolCosts(spread=0.0, commission_per_lot=0.0, slippage=0.1)
    res = bt.run_backtest(
        sl_bars, _long_only(), _spec("percent", 1.0, "rr", 2.0),
        symbol="TESTSYM", risk_pct=1.0, capital=10_000, mode="flat", costs=costs,
    )
    # 入场 100.1（吃滑点），止损位 100.1*0.99 = 99.099，出场再吃一个滑点 -> 98.999
    # Entry 100.1 (one slippage), stop at 99.099, exit pays one more slippage
    entry = 100.1
    assert res["trades"][0]["exitPrice"] == pytest.approx(entry * 0.99 - 0.1)

    tp_bars = _bars([(100, 100, 100, 100), (100, 103, 100, 102)])
    res2 = bt.run_backtest(
        tp_bars, _long_only(), _spec("percent", 1.0, "rr", 2.0),
        symbol="TESTSYM", risk_pct=1.0, capital=10_000, mode="flat", costs=costs,
    )
    # 止盈位 100.1 + 2*1.001 = 102.102，round_price 在 >=100 量级取 2 位小数 -> 102.1，
    # 止盈不吃滑点，出场价就是这个位。
    # Target is 100.1 + 2*1.001 = 102.102, which round_price snaps to 102.1 at this
    # magnitude; a target pays no slippage, so that level is the fill.
    assert res2["trades"][0]["exitPrice"] == pytest.approx(102.1)


# ---------- 样本内外切分 / in-sample vs out-of-sample ----------

def test_split_is_seventy_thirty_by_bar_count():
    bars = _flat_bars(100)
    res = bt.run_backtest(
        bars, _long_only(), _spec(timeout_bars=1),
        symbol="TESTSYM", risk_pct=1.0, capital=10_000, mode="flat", costs=NO_COSTS,
    )
    assert res["inSample"]["barsUsed"] == 70
    assert res["outOfSample"]["barsUsed"] == 30


def test_split_sections_carry_their_own_full_metrics():
    bars = _flat_bars(100)
    res = bt.run_backtest(
        bars, _long_only(), _spec(timeout_bars=1),
        symbol="TESTSYM", risk_pct=1.0, capital=10_000, mode="flat", costs=NO_COSTS,
    )
    for section in ("inSample", "outOfSample"):
        s = res[section]["summary"]
        assert {"wins", "losses", "winRate", "returnPct", "maxDrawdownPct", "avgRr"} <= set(s)


def test_overfit_flagged_when_out_of_sample_win_rate_collapses():
    """样本内全胜、样本外全败：胜率跌 100 个百分点，远超 15 的阈值。
    All wins in-sample, all losses out — a 100-point drop, far past the 15."""
    win_bar = (100, 103, 100, 102)
    loss_bar = (100, 100, 97, 98)
    flat = (100, 100, 100, 100)
    rows = [flat, win_bar] * 35 + [flat, loss_bar] * 15
    res = bt.run_backtest(
        _bars(rows), _long_only(), _spec("percent", 1.0, "rr", 2.0),
        symbol="TESTSYM", risk_pct=1.0, capital=10_000, mode="flat", costs=NO_COSTS,
    )
    assert res["inSample"]["summary"]["winRate"] == pytest.approx(1.0)
    assert res["outOfSample"]["summary"]["winRate"] == pytest.approx(0.0)
    assert res["overfitRisk"]["flagged"] is True
    assert res["overfitRisk"]["reason"] == "winRateDrop"


def test_overfit_flagged_when_out_of_sample_return_turns_negative():
    """胜率跌幅不到 15 点，但收益翻负：走 returnFlip 这一支。

    80 根 K 线切成 56/24，即样本内 28 笔、样本外 12 笔（两段都过 MIN_PERF_SAMPLE）。
    样本内 10 胜 18 负：胜率 35.7%，RR=2 时收益 10*2-18 = +2 个风险单位（+2%）。
    样本外 3 胜 9 负：胜率 25%，收益 3*2-9 = -3 个风险单位（-3%）。胜率只跌
    10.7 个点（不到 15），所以只能由"收益翻负"这条触发。

    A sub-15-point win-rate drop with the return flipping negative: the
    returnFlip branch. 80 bars split 56/24 gives 28 in-sample trades and 12
    out (both clear MIN_PERF_SAMPLE). In-sample 10W/18L is 35.7% and, at RR 2,
    +2 risk units; out-of-sample 3W/9L is 25% and -3 risk units. The win rate
    falls only 10.7 points, so only the return flip can raise the flag.
    """
    win_bar = (100, 103, 100, 102)
    loss_bar = (100, 100, 97, 98)
    flat = (100, 100, 100, 100)
    rows = [flat, win_bar] * 10 + [flat, loss_bar] * 18 + [flat, win_bar] * 3 + [flat, loss_bar] * 9
    res = bt.run_backtest(
        _bars(rows), _long_only(), _spec("percent", 1.0, "rr", 2.0),
        symbol="TESTSYM", risk_pct=1.0, capital=10_000, mode="flat", costs=NO_COSTS,
    )
    assert res["inSample"]["summary"]["returnPct"] > 0
    assert res["outOfSample"]["summary"]["returnPct"] < 0
    assert res["overfitRisk"]["flagged"] is True
    assert res["overfitRisk"]["reason"] == "returnFlip"


def test_overfit_not_flagged_when_samples_are_similar():
    rows = [(100, 103, 100, 102), (100, 100, 100, 100)] * 50
    res = bt.run_backtest(
        _bars(rows), _long_only(), _spec("percent", 1.0, "rr", 2.0),
        symbol="TESTSYM", risk_pct=1.0, capital=10_000, mode="flat", costs=NO_COSTS,
    )
    assert res["overfitRisk"]["flagged"] is False


def test_overfit_not_flagged_when_either_sample_is_too_small():
    """任一段判定笔数不足 MIN_PERF_SAMPLE 时不做过拟合判定——用 3 笔对 1 笔算
    出来的"胜率暴跌"是噪声，不是证据。
    No verdict when either side has fewer than MIN_PERF_SAMPLE resolved
    trades: a "collapse" computed from 3 vs 1 trades is noise, not evidence."""
    bars = _bars([(100, 100, 100, 100), (100, 103, 100, 102)] + [(100, 100, 100, 100)] * 38)
    res = bt.run_backtest(
        bars, _long_only(), _spec("percent", 1.0, "rr", 2.0),
        symbol="TESTSYM", risk_pct=1.0, capital=10_000, mode="flat", costs=NO_COSTS,
    )
    assert res["overfitRisk"]["flagged"] is False
    assert res["overfitRisk"]["insufficientSample"] is True
    assert res["overfitRisk"]["reason"] is None


# ---------- 仓位模式 / position modes ----------

def test_one_trade_at_a_time_skips_signals_while_position_open():
    rows = [(100, 100, 100, 100)] * 6 + [(100, 103, 100, 102)] + [(100, 100, 100, 100)] * 3
    res = bt.run_backtest(
        _bars(rows), _long_only(), _spec("percent", 1.0, "rr", 2.0),
        symbol="TESTSYM", risk_pct=1.0, capital=10_000, mode="flat",
        one_trade_at_a_time=True, costs=NO_COSTS,
    )
    assert len(res["trades"]) == 1


def test_one_trade_at_a_time_off_opens_overlapping_trades():
    rows = [(100, 100, 100, 100)] * 6 + [(100, 103, 100, 102)] + [(100, 100, 100, 100)] * 3
    res = bt.run_backtest(
        _bars(rows), _long_only(), _spec("percent", 1.0, "rr", 2.0),
        symbol="TESTSYM", risk_pct=1.0, capital=10_000, mode="flat",
        one_trade_at_a_time=False, costs=NO_COSTS,
    )
    assert len(res["trades"]) > 1


def test_still_open_positions_are_reported_not_dropped():
    bars = _flat_bars(10)
    res = bt.run_backtest(
        bars, _long_only(), _spec("percent", 1.0, "rr", 2.0),
        symbol="TESTSYM", risk_pct=1.0, capital=10_000, mode="flat",
        one_trade_at_a_time=True, costs=NO_COSTS,
    )
    assert res["trades"] == []
    assert len(res["openPositions"]) == 1


def test_open_positions_all_collected_when_one_trade_at_a_time_off():
    bars = _flat_bars(10)
    res = bt.run_backtest(
        bars, _long_only(), _spec("percent", 1.0, "rr", 2.0),
        symbol="TESTSYM", risk_pct=1.0, capital=10_000, mode="flat",
        one_trade_at_a_time=False, costs=NO_COSTS,
    )
    assert len(res["openPositions"]) == 10


def test_equity_compounds_in_compound_mode():
    rows = [(100, 100, 100, 100), (100, 103, 100, 102)] * 20
    flat = bt.run_backtest(
        _bars(rows), _long_only(), _spec("percent", 1.0, "rr", 2.0),
        symbol="TESTSYM", risk_pct=1.0, capital=10_000, mode="flat", costs=NO_COSTS,
    )
    comp = bt.run_backtest(
        _bars(rows), _long_only(), _spec("percent", 1.0, "rr", 2.0),
        symbol="TESTSYM", risk_pct=1.0, capital=10_000, mode="compound", costs=NO_COSTS,
    )
    assert comp["summary"]["finalEquity"] > flat["summary"]["finalEquity"]


def test_empty_bars_returns_empty_result_without_raising():
    res = bt.run_backtest(
        [], _long_only(), _spec(),
        symbol="TESTSYM", risk_pct=1.0, capital=10_000, mode="flat", costs=NO_COSTS,
    )
    assert res["trades"] == []
    assert res["barsUsed"] == 0
    assert res["overfitRisk"]["flagged"] is False
