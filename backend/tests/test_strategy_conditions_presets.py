"""6 条新手预设：每条都必须能通过校验、能求值出信号，且 key 与 schemas 的
模板校验器一致。

The six beginner presets: each must pass validation, produce signals when
evaluated, and line up with the template validator in schemas.
"""
import math

import pytest

from app.services.strategy.conditions import evaluate_conditions, validate_conditions
from app.services.strategy.presets import (
    PRESET_CONDITIONS,
    PRESET_LOGIC,
    TEMPLATE_KEYS,
    preset_payload,
)
from app import schemas


def _bars(n: int = 400) -> list[dict]:
    closes = [100.0 + 8.0 * math.sin(i / 9) + 3.0 * math.sin(i / 2.7) + 0.05 * i for i in range(n)]
    return [{"t": i * 900, "o": c, "h": c + 1.1, "l": c - 1.6, "c": c} for i, c in enumerate(closes)]


def test_there_are_exactly_six_presets():
    assert TEMPLATE_KEYS == (
        "ma_trend",
        "macd_cross",
        "rsi_reversal",
        "bollinger_breakout",
        "donchian_breakout",
        "macd_rsi_combo",
    )
    assert set(PRESET_CONDITIONS) == set(TEMPLATE_KEYS)
    assert set(PRESET_LOGIC) == set(TEMPLATE_KEYS)


@pytest.mark.parametrize("template", TEMPLATE_KEYS)
def test_each_preset_payload_validates(template):
    validate_conditions(preset_payload(template, "XAUUSD", "15"))


@pytest.mark.parametrize("template", TEMPLATE_KEYS)
def test_each_preset_produces_at_least_one_signal(template):
    out = evaluate_conditions(_bars(), preset_payload(template, "XAUUSD", "15"))
    assert any(v is not None for v in out), template


def test_preset_payload_carries_the_requested_symbol_and_interval():
    out = preset_payload("macd_cross", "EURUSD", "60")
    assert out["symbol"] == "EURUSD"
    assert out["interval"] == "60"
    assert out["logic"] == PRESET_LOGIC["macd_cross"]


def test_preset_payload_returns_a_deep_copy():
    # 调用方会直接改这份 payload 再存库，共享引用会污染模块级常量。
    first = preset_payload("rsi_reversal", "XAUUSD", "15")
    first["conditions"][0]["params"]["period"] = 99
    assert preset_payload("rsi_reversal", "XAUUSD", "15")["conditions"][0]["params"]["period"] != 99


def test_unknown_template_raises():
    with pytest.raises(KeyError):
        preset_payload("nope", "XAUUSD", "15")


def test_combo_preset_uses_two_indicators():
    conds = PRESET_CONDITIONS["macd_rsi_combo"]
    assert {c["indicator"] for c in conds} == {"macd", "rsi"}


def test_schemas_template_validator_accepts_the_new_keys():
    for key in TEMPLATE_KEYS:
        assert schemas.validate_template_key(key) == key
    assert schemas.validate_template_key(None) is None
    with pytest.raises(ValueError):
        schemas.validate_template_key("ma_cross")
