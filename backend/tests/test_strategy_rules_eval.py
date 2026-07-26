"""规则求值单测：布尔序列、交叉语义、多周期对齐的未来函数防护。
Rule evaluation tests: boolean series, crossing semantics, and the
look-ahead guard on multi-timeframe alignment."""
import pytest

from app.services.strategy.rules import align_series, evaluate_rules


def _bars(closes, start_t=0, step=900):
    """按给定收盘价造一串 bars，高低价围绕收盘价 ±1。
    Build bars from closes; highs/lows straddle the close by 1."""
    return [
        {"t": start_t + i * step, "o": c, "h": c + 1.0, "l": c - 1.0, "c": c, "v": 1.0}
        for i, c in enumerate(closes)
    ]


def test_price_gt_const_is_elementwise():
    bars = _bars([1.0, 5.0, 3.0])
    ast = {
        "logic": "AND",
        "children": [
            {"left": {"kind": "price", "field": "close"}, "op": "gt", "right": {"kind": "const", "value": 2.0}}
        ],
    }
    assert evaluate_rules(bars, ast) == [False, True, True]


def test_and_requires_both_conditions():
    bars = _bars([1.0, 5.0, 3.0])
    ast = {
        "logic": "AND",
        "children": [
            {"left": {"kind": "price", "field": "close"}, "op": "gt", "right": {"kind": "const", "value": 2.0}},
            {"left": {"kind": "price", "field": "close"}, "op": "lt", "right": {"kind": "const", "value": 4.0}},
        ],
    }
    assert evaluate_rules(bars, ast) == [False, False, True]


def test_or_requires_either_condition():
    bars = _bars([1.0, 5.0, 3.0])
    ast = {
        "logic": "OR",
        "children": [
            {"left": {"kind": "price", "field": "close"}, "op": "lt", "right": {"kind": "const", "value": 2.0}},
            {"left": {"kind": "price", "field": "close"}, "op": "gt", "right": {"kind": "const", "value": 4.0}},
        ],
    }
    assert evaluate_rules(bars, ast) == [True, True, False]


def test_nested_group_evaluates_correctly():
    bars = _bars([1.0, 5.0, 3.0, 9.0])
    ast = {
        "logic": "AND",
        "children": [
            {"left": {"kind": "price", "field": "close"}, "op": "gt", "right": {"kind": "const", "value": 2.0}},
            {
                "logic": "OR",
                "children": [
                    {"left": {"kind": "price", "field": "close"}, "op": "lt", "right": {"kind": "const", "value": 4.0}},
                    {"left": {"kind": "price", "field": "close"}, "op": "gt", "right": {"kind": "const", "value": 8.0}},
                ],
            },
        ],
    }
    assert evaluate_rules(bars, ast) == [False, False, True, True]


def test_crosses_above_is_true_only_on_the_crossing_bar():
    # 收盘价穿过常量 3：1,2,4,5 -> 只有 index 2 是上穿
    bars = _bars([1.0, 2.0, 4.0, 5.0])
    ast = {
        "logic": "AND",
        "children": [
            {"left": {"kind": "price", "field": "close"}, "op": "crosses_above", "right": {"kind": "const", "value": 3.0}}
        ],
    }
    assert evaluate_rules(bars, ast) == [False, False, True, False]


def test_crosses_below_is_true_only_on_the_crossing_bar():
    bars = _bars([5.0, 4.0, 2.0, 1.0])
    ast = {
        "logic": "AND",
        "children": [
            {"left": {"kind": "price", "field": "close"}, "op": "crosses_below", "right": {"kind": "const", "value": 3.0}}
        ],
    }
    assert evaluate_rules(bars, ast) == [False, False, True, False]


def test_first_bar_is_never_a_crossing():
    # 首根没有前值，不能判定为穿越
    bars = _bars([9.0, 9.0])
    ast = {
        "logic": "AND",
        "children": [
            {"left": {"kind": "price", "field": "close"}, "op": "crosses_above", "right": {"kind": "const", "value": 3.0}}
        ],
    }
    assert evaluate_rules(bars, ast) == [False, False]


def test_indicator_warmup_positions_are_false():
    bars = _bars([1.0, 2.0, 3.0, 4.0, 5.0])
    ast = {
        "logic": "AND",
        "children": [
            {
                "left": {"kind": "price", "field": "close"},
                "op": "gt",
                "right": {"kind": "indicator", "fn": "sma", "params": {"period": 3}},
            }
        ],
    }
    out = evaluate_rules(bars, ast)
    # SMA(3) 前两根为 None，对应位置必须是 False 而不是抛异常
    assert out[0] is False
    assert out[1] is False
    assert out[2] is True


def test_align_series_uses_only_closed_higher_tf_bars():
    """核心未来函数防护：4H 的值只能在该 4H bar 收盘之后才可用。

    主周期 15m（900s），非主周期 4H（14400s）。4H bar 从 t=0 开始，
    收盘时刻为 t=14400。因此 t<14400 的所有 15m bar 都不能看到这根 4H 的值。
    """
    base_times = [0, 900, 13500, 14400, 15300]
    other_times = [0, 14400]
    other_values = [111.0, 222.0]
    out = align_series(base_times, other_times, other_values, 14400)
    # t=0/900/13500：第一根 4H 还没收盘，无值可用
    assert out[0] is None
    assert out[1] is None
    assert out[2] is None
    # t=14400：第一根 4H 已收盘，其值可用
    assert out[3] == pytest.approx(111.0)
    # t=15300：第二根 4H 尚未收盘，仍只能用第一根的值
    assert out[4] == pytest.approx(111.0)


def test_align_series_carries_forward_last_closed_value():
    base_times = [14400, 15300, 16200, 28800]
    other_times = [0, 14400, 28800]
    other_values = [111.0, 222.0, 333.0]
    out = align_series(base_times, other_times, other_values, 14400)
    assert out[0] == pytest.approx(111.0)
    assert out[1] == pytest.approx(111.0)
    assert out[2] == pytest.approx(111.0)
    # t=28800：第二根 4H(t=14400) 已在 28800 收盘，其值可用
    assert out[3] == pytest.approx(222.0)


def test_align_series_skips_none_values():
    base_times = [14400, 28800]
    other_times = [0, 14400]
    other_values = [None, 222.0]
    out = align_series(base_times, other_times, other_values, 14400)
    assert out[0] is None
    assert out[1] == pytest.approx(222.0)


def test_multi_timeframe_rule_does_not_look_ahead():
    """整条规则层面的未来函数防护。

    非主周期 4H 的收盘价在第二根（t=14400，收盘于 28800）暴涨。
    主周期 15m 在 t<28800 的位置都不该看到这个暴涨值。
    """
    base = _bars([10.0] * 4, start_t=14400, step=4800)  # t=14400,19200,24000,28800
    higher = [
        {"t": 0, "o": 1.0, "h": 1.0, "l": 1.0, "c": 1.0, "v": 1.0},
        {"t": 14400, "o": 999.0, "h": 999.0, "l": 999.0, "c": 999.0, "v": 1.0},
    ]
    ast = {
        "logic": "AND",
        "children": [
            {
                "left": {"kind": "price", "field": "close", "interval": "240"},
                "op": "gt",
                "right": {"kind": "const", "value": 100.0},
            }
        ],
    }
    out = evaluate_rules(base, ast, extra_series={"240": higher})
    # t=14400/19200/24000：第二根 4H 未收盘，看到的是第一根的 1.0，不满足 >100
    assert out[0] is False
    assert out[1] is False
    assert out[2] is False
    # t=28800：第二根 4H 已收盘，999>100 成立
    assert out[3] is True
