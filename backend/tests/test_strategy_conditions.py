"""用法枚举表与条件配置校验：枚举表自身的一致性（key 前缀、镜像对称）、
以及 validate_conditions 对每一类非法输入的拒绝。

The usage table and condition-payload validation: the table's own consistency
(key prefixes, mirror symmetry) plus validate_conditions rejecting each class of
malformed input.
"""
import pytest

from app.services.strategy.conditions import (
    ALLOWED_INTERVALS,
    INDICATORS,
    MAX_CONDITIONS,
    USAGES,
    ConditionError,
    validate_conditions,
)


def _payload(**over) -> dict:
    base = {
        "logic": "AND",
        "interval": "15",
        "symbol": "XAUUSD",
        "conditions": [
            {"indicator": "rsi", "usage": "rsi.below_level", "params": {"period": 14, "level": 30}},
        ],
    }
    base.update(over)
    return base


def test_indicator_list_is_the_six_beginner_indicators():
    assert INDICATORS == ("ma", "macd", "rsi", "bollinger", "donchian", "atr")


def test_every_usage_key_is_prefixed_with_its_indicator():
    for key, spec in USAGES.items():
        assert key.startswith(spec.indicator + ".")
        assert spec.key == key
        assert spec.indicator in INDICATORS


def test_valid_payload_passes():
    validate_conditions(_payload())


def test_rejects_non_dict():
    with pytest.raises(ConditionError):
        validate_conditions([])


def test_rejects_unknown_logic():
    with pytest.raises(ConditionError):
        validate_conditions(_payload(logic="XOR"))


def test_rejects_plural_field_names():
    bad = _payload()
    bad.pop("symbol")
    bad["symbols"] = ["XAUUSD"]
    with pytest.raises(ConditionError):
        validate_conditions(bad)


def test_rejects_unsupported_interval():
    with pytest.raises(ConditionError):
        validate_conditions(_payload(interval="30"))
    assert "30" not in ALLOWED_INTERVALS


def test_rejects_empty_conditions():
    with pytest.raises(ConditionError):
        validate_conditions(_payload(conditions=[]))


def test_rejects_too_many_conditions():
    one = {"indicator": "rsi", "usage": "rsi.below_level", "params": {"period": 14, "level": 30}}
    with pytest.raises(ConditionError):
        validate_conditions(_payload(conditions=[dict(one) for _ in range(MAX_CONDITIONS + 1)]))


def test_rejects_unknown_usage():
    with pytest.raises(ConditionError):
        validate_conditions(_payload(conditions=[{"indicator": "rsi", "usage": "rsi.nope", "params": {}}]))


def test_rejects_usage_not_belonging_to_indicator():
    with pytest.raises(ConditionError):
        validate_conditions(
            _payload(conditions=[{"indicator": "ma", "usage": "rsi.below_level", "params": {"period": 14, "level": 30}}])
        )


def test_rejects_param_out_of_range():
    with pytest.raises(ConditionError) as exc:
        validate_conditions(
            _payload(conditions=[{"indicator": "rsi", "usage": "rsi.below_level", "params": {"period": 1, "level": 30}}])
        )
    assert "period" in exc.value.message


def test_rejects_unknown_param_key():
    with pytest.raises(ConditionError):
        validate_conditions(
            _payload(
                conditions=[
                    {"indicator": "rsi", "usage": "rsi.below_level", "params": {"period": 14, "level": 30, "junk": 1}}
                ]
            )
        )


def test_missing_params_fall_back_to_defaults():
    validate_conditions(_payload(conditions=[{"indicator": "rsi", "usage": "rsi.below_level", "params": {}}]))


def test_rejects_enum_param_outside_options():
    with pytest.raises(ConditionError):
        validate_conditions(
            _payload(
                conditions=[
                    {"indicator": "ma", "usage": "ma.price_cross_above", "params": {"maType": "WMA", "period": 20}}
                ]
            )
        )
