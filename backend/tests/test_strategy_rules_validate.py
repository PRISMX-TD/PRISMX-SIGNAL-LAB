"""规则 AST 校验单测：正反例 + 滥用上限。
Rule AST validation tests: valid/invalid cases plus abuse limits."""
import pytest

from app.services.strategy.rules import (
    MAX_INDICATOR_INSTANCES,
    RuleError,
    collect_intervals,
    validate_rules,
)


def _cond(fn="ema", period=20, op="gt", value=1.0):
    return {
        "left": {"kind": "indicator", "fn": fn, "params": {"period": period}},
        "op": op,
        "right": {"kind": "const", "value": value},
    }


def test_valid_minimal_ast_passes():
    ast = {"logic": "AND", "children": [_cond()]}
    validate_rules(ast)  # 不抛异常即通过


def test_valid_crossing_two_indicators():
    ast = {
        "logic": "AND",
        "children": [
            {
                "left": {"kind": "indicator", "fn": "ema", "params": {"period": 20}},
                "op": "crosses_above",
                "right": {"kind": "indicator", "fn": "ema", "params": {"period": 50}},
            }
        ],
    }
    validate_rules(ast)


def test_valid_price_operand():
    ast = {
        "logic": "AND",
        "children": [
            {
                "left": {"kind": "price", "field": "close"},
                "op": "gt",
                "right": {"kind": "indicator", "fn": "sma", "params": {"period": 20}},
            }
        ],
    }
    validate_rules(ast)


def test_rejects_empty_children():
    with pytest.raises(RuleError):
        validate_rules({"logic": "AND", "children": []})


def test_rejects_unknown_logic():
    with pytest.raises(RuleError):
        validate_rules({"logic": "XOR", "children": [_cond()]})


def test_rejects_unknown_operator():
    with pytest.raises(RuleError):
        validate_rules({"logic": "AND", "children": [_cond(op="approximately")]})


def test_rejects_unknown_indicator():
    with pytest.raises(RuleError):
        validate_rules({"logic": "AND", "children": [_cond(fn="ichimoku")]})


def test_rejects_unknown_price_field():
    ast = {
        "logic": "AND",
        "children": [
            {"left": {"kind": "price", "field": "vwap"}, "op": "gt", "right": {"kind": "const", "value": 1.0}}
        ],
    }
    with pytest.raises(RuleError):
        validate_rules(ast)


def test_rejects_param_out_of_range_instead_of_clamping():
    # period 上限 300；越界必须报错而不是静默夹取
    with pytest.raises(RuleError) as exc:
        validate_rules({"logic": "AND", "children": [_cond(period=5000)]})
    assert "300" in str(exc.value)


def test_rejects_missing_required_param():
    ast = {
        "logic": "AND",
        "children": [
            {"left": {"kind": "indicator", "fn": "ema", "params": {}}, "op": "gt", "right": {"kind": "const", "value": 1.0}}
        ],
    }
    with pytest.raises(RuleError):
        validate_rules(ast)


def test_rejects_too_many_conditions():
    ast = {"logic": "AND", "children": [_cond(period=10 + i) for i in range(13)]}
    with pytest.raises(RuleError) as exc:
        validate_rules(ast)
    assert "12" in str(exc.value)


def test_accepts_exactly_max_conditions():
    # 12 个条件复用 8 个指标实例：条件数刚好到上限，指标实例数也刚好到上限
    # 12 conditions reusing 8 indicator instances: both counts sit exactly on
    # their limits.
    ast = {"logic": "AND", "children": [_cond(period=10 + i % MAX_INDICATOR_INSTANCES) for i in range(12)]}
    validate_rules(ast)


def test_rejects_too_deep_nesting():
    # 深度 4：AND > AND > AND > AND
    ast = {
        "logic": "AND",
        "children": [
            {"logic": "AND", "children": [{"logic": "AND", "children": [{"logic": "AND", "children": [_cond()]}]}]}
        ],
    }
    with pytest.raises(RuleError) as exc:
        validate_rules(ast)
    assert "3" in str(exc.value)


def test_accepts_max_depth_nesting():
    ast = {"logic": "AND", "children": [{"logic": "OR", "children": [{"logic": "AND", "children": [_cond()]}]}]}
    validate_rules(ast)


def test_rejects_too_many_distinct_indicator_instances():
    # 9 个不同 (fn, params, interval) 组合，超过上限 8
    children = [_cond(period=10 + i) for i in range(9)]
    with pytest.raises(RuleError) as exc:
        validate_rules({"logic": "AND", "children": children})
    assert "8" in str(exc.value)


def test_same_indicator_instance_counts_once():
    # 12 条件但只有一个指标实例，应通过
    children = [_cond(period=20) for _ in range(12)]
    validate_rules({"logic": "AND", "children": children})


def test_rejects_too_many_intervals():
    children = [
        {
            "left": {"kind": "indicator", "fn": "ema", "params": {"period": 20}, "interval": iv},
            "op": "gt",
            "right": {"kind": "const", "value": 1.0},
        }
        for iv in ("5", "15", "60", "240")
    ]
    with pytest.raises(RuleError) as exc:
        validate_rules({"logic": "AND", "children": children})
    assert "3" in str(exc.value)


def test_rejects_unknown_interval():
    ast = {
        "logic": "AND",
        "children": [
            {
                "left": {"kind": "indicator", "fn": "ema", "params": {"period": 20}, "interval": "7"},
                "op": "gt",
                "right": {"kind": "const", "value": 1.0},
            }
        ],
    }
    with pytest.raises(RuleError):
        validate_rules(ast)


def test_collect_intervals_returns_explicit_intervals_only():
    ast = {
        "logic": "AND",
        "children": [
            {
                "left": {"kind": "indicator", "fn": "ema", "params": {"period": 20}, "interval": "240"},
                "op": "gt",
                "right": {"kind": "indicator", "fn": "sma", "params": {"period": 10}},
            }
        ],
    }
    assert collect_intervals(ast) == {"240"}
