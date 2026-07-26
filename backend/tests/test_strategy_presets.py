"""预设 AST 与旧引擎等价性测试。

核心验收：10 个模板逐个断言「转换后的 AST 在同一段历史上产出与旧引擎逐 bar
完全一致的信号序列」。另覆盖 rules.py 新增的 shift / scale 操作数字段。

Preset-AST tests. The acceptance bar: for each of the 10 templates, the
converted AST must produce a bar-for-bar identical signal series to the old
engine on the same history. Also covers the new shift/scale operand fields.
"""
import math

import pytest

from app.services.strategy import presets as ps
from app.services.strategy.rules import RuleError, evaluate_rules, validate_rules
from app.services.strategy_engine import entry_signals, validate_and_clamp_params


def _bars(closes, highs=None, lows=None, start_t=0, step=900):
    """按收盘价造 bars；未给 高/低 时围绕收盘价 ±1。
    Build bars from closes; highs/lows straddle the close by 1 when omitted."""
    return [
        {
            "t": start_t + i * step,
            "o": c,
            "h": c + 1.0 if highs is None else highs[i],
            "l": c - 1.0 if lows is None else lows[i],
            "c": c,
            "v": 1.0,
        }
        for i, c in enumerate(closes)
    ]


def _shift_ast(shift):
    return {
        "logic": "AND",
        "children": [
            {
                "left": {"kind": "price", "field": "close", "shift": shift},
                "op": "gt",
                "right": {"kind": "const", "value": 10.0},
            }
        ],
    }


def test_shift_moves_series_forward_and_pads_with_none():
    bars = _bars([20.0, 5.0, 20.0, 5.0])
    # shift=1 时第 i 位用第 i-1 根的收盘价；首位无前值，判 False
    assert evaluate_rules(bars, _shift_ast(1)) == [False, True, False, True]


def test_shift_zero_is_identity():
    bars = _bars([20.0, 5.0])
    assert evaluate_rules(bars, _shift_ast(0)) == [True, False]


def test_scale_multiplies_the_operand():
    bars = _bars([10.0, 10.0])
    ast = {
        "logic": "AND",
        "children": [
            {
                "left": {"kind": "price", "field": "close", "scale": 1.5},
                "op": "gt",
                "right": {"kind": "const", "value": 14.0},
            }
        ],
    }
    assert evaluate_rules(bars, ast) == [True, True]


def test_rejects_negative_shift():
    with pytest.raises(RuleError):
        validate_rules(_shift_ast(-1))


def test_rejects_shift_over_limit():
    with pytest.raises(RuleError):
        validate_rules(_shift_ast(301))


def test_rejects_scale_out_of_range():
    ast = {
        "logic": "AND",
        "children": [
            {
                "left": {"kind": "price", "field": "close", "scale": 9.0},
                "op": "gt",
                "right": {"kind": "const", "value": 1.0},
            }
        ],
    }
    with pytest.raises(RuleError):
        validate_rules(ast)


def test_same_indicator_with_different_shift_counts_as_two_instances():
    """shift/scale 参与指标实例去重——否则「同一均线的当根与前一根」会被算成
    一个实例，滥用上限失去意义。shift/scale take part in instance identity."""
    def cond(shift):
        return {
            "left": {"kind": "indicator", "fn": "ema", "params": {"period": 5}, "shift": shift},
            "op": "gt",
            "right": {"kind": "const", "value": 1.0},
        }

    with pytest.raises(RuleError):
        validate_rules({"logic": "AND", "children": [cond(i) for i in range(9)]})


# ---------- 与旧引擎的逐 bar 等价性 / bar-for-bar equivalence with the old engine ----------

def _history(n=400):
    """多频正弦 + 上行漂移的价格序列：涨跌、交叉、突破、回踩都会出现，且不会
    出现"价格恰好等于指标值"这种退化情况。
    Multi-frequency sine plus an upward drift: produces crossings, breakouts and
    pullbacks while never landing exactly on an indicator value."""
    closes = [
        100.0 + 8.0 * math.sin(i / 9.0) + 3.0 * math.sin(i / 2.7) + 0.05 * i
        for i in range(n)
    ]
    highs = [c + 1.1 for c in closes]
    lows = [c - 1.6 for c in closes]
    return _bars(closes, highs=highs, lows=lows)


# 每个模板一组刻意能在 _history() 上触发的参数（默认参数在这段数据上未必出信号，
# 而一条"两边都是空序列"的等价断言毫无意义）。
# One firing parameter set per template — the defaults don't necessarily fire on
# this series, and comparing two all-None series proves nothing.
EQUIV_CASES = [
    ("ma_cross", {"maType": "EMA", "fastPeriod": 5, "slowPeriod": 20}),
    ("ma_cross", {"maType": "SMA", "fastPeriod": 5, "slowPeriod": 20}),
    ("rsi_reversal", {"period": 14, "oversold": 40, "overbought": 60}),
    ("bollinger_reversion", {"period": 20, "mult": 1.5}),
    ("macd_cross", {"fastPeriod": 12, "slowPeriod": 26, "signalPeriod": 9}),
    ("ma_pullback", {"maType": "EMA", "period": 20, "touchTolerancePct": 1.0}),
    ("bollinger_breakout", {"period": 20, "mult": 1.5}),
    ("rsi_momentum", {"period": 14}),
    ("donchian_breakout", {"period": 10}),
    ("momentum_breakout", {"lookback": 5, "thresholdPct": 1.0}),
    ("trend_rsi_filter", {"trendPeriod": 30, "rsiPeriod": 14, "oversold": 45, "overbought": 55}),
]


@pytest.mark.parametrize("template,params", EQUIV_CASES)
@pytest.mark.parametrize("direction", ["both", "long", "short"])
def test_converted_ast_matches_old_engine_bar_for_bar(template, params, direction):
    bars = _history()
    raw = {**params, "direction": direction}
    old = entry_signals(bars, template, validate_and_clamp_params(template, raw))
    new = ps.evaluate_strategy(bars, ps.template_to_ast(template, raw))
    assert new == old


@pytest.mark.parametrize("template,params", EQUIV_CASES)
def test_every_template_actually_fires_on_the_equivalence_series(template, params):
    """等价断言的前提：这段数据上确实有信号，否则等于什么都没验证。
    Precondition for the equivalence assertions: this series really does fire."""
    bars = _history()
    new = ps.evaluate_strategy(bars, ps.template_to_ast(template, {**params, "direction": "both"}))
    assert any(s is not None for s in new)


def test_all_ten_templates_are_covered_by_equivalence_cases():
    """覆盖度自检：EQUIV_CASES 必须覆盖 TEMPLATE_KEYS 的全部 10 个。
    Coverage guard: EQUIV_CASES must cover all 10 of TEMPLATE_KEYS."""
    assert {t for t, _ in EQUIV_CASES} == set(ps.TEMPLATE_KEYS)
    assert len(ps.TEMPLATE_KEYS) == 10


def test_rsi_momentum_midline_defaults_to_fifty_and_is_tunable():
    """旧实现硬编码中轴 50；转换后成为可调常量，默认 50 保证迁移后行为不变。
    The old branch hardcoded a midline of 50; it's now a tunable constant
    defaulting to 50 so migrated strategies behave identically."""
    bars = _history()
    old = entry_signals(bars, "rsi_momentum", validate_and_clamp_params("rsi_momentum", {"period": 14}))
    assert ps.evaluate_strategy(bars, ps.template_to_ast("rsi_momentum", {"period": 14})) == old
    shifted = ps.evaluate_strategy(
        bars, ps.template_to_ast("rsi_momentum", {"period": 14, "midline": 60})
    )
    assert shifted != old


def test_direction_long_prunes_the_short_side():
    rules = ps.template_to_ast("ma_cross", {"direction": "long"})
    assert rules["short"] is None
    assert rules["long"] is not None


def test_preset_rules_exist_and_validate_for_every_template():
    for key in ps.TEMPLATE_KEYS:
        ps.validate_strategy_rules(ps.PRESET_RULES[key])


def test_envelope_requires_at_least_one_side():
    with pytest.raises(RuleError):
        ps.validate_strategy_rules({"long": None, "short": None})


def test_envelope_rejects_unknown_keys():
    with pytest.raises(RuleError):
        ps.validate_strategy_rules({"long": ps.PRESET_RULES["ma_cross"]["long"], "middle": None})


def test_condition_cap_applies_to_both_sides_combined():
    """多空各 7 条合计 14 条，超过上限 12——分侧判上限会让真实上限翻倍。
    7 + 7 = 14 exceeds the cap of 12; per-side caps would double the real
    limit."""
    side = {
        "logic": "AND",
        "children": [
            {
                "left": {"kind": "indicator", "fn": "ema", "params": {"period": 5 + i}},
                "op": "gt",
                "right": {"kind": "const", "value": 1.0},
            }
            for i in range(7)
        ],
    }
    with pytest.raises(RuleError):
        ps.validate_strategy_rules({"long": side, "short": side})


def test_count_conditions_sums_both_sides():
    rules = ps.template_to_ast("trend_rsi_filter", {})
    assert ps.count_conditions(rules) == 4


def test_evaluate_strategy_prefers_long_when_both_sides_fire():
    bars = _bars([1.0, 5.0])
    always = {
        "logic": "AND",
        "children": [
            {"left": {"kind": "price", "field": "close"}, "op": "gt", "right": {"kind": "const", "value": 0.0}}
        ],
    }
    assert ps.evaluate_strategy(bars, {"long": always, "short": always}) == ["BUY", "BUY"]


def test_unknown_template_raises_rule_error():
    with pytest.raises(RuleError):
        ps.template_to_ast("no_such_template", {})
