"""镜像取反与策略级求值：单条件取反的交易语义、整条策略的空头条件推导，
以及 AND/OR 合并成逐 bar 的 BUY/SELL/None。

Mirroring and strategy-level evaluation: the trading semantics of inverting one
condition, deriving a whole strategy's short side, and combining conditions
under AND/OR into per-bar BUY/SELL/None.
"""
import math

from app.services.strategy.conditions import (
    USAGES,
    evaluate_conditions,
    evaluate_side,
    evaluate_usage,
    mirror_condition,
    mirror_conditions,
)


def _bars(closes: list[float]) -> list[dict]:
    return [{"t": i * 900, "o": c, "h": c + 1.1, "l": c - 1.6, "c": c} for i, c in enumerate(closes)]


def _wave(n: int = 200) -> list[float]:
    return [100.0 + 8.0 * math.sin(i / 9) + 3.0 * math.sin(i / 2.7) + 0.05 * i for i in range(n)]


def _cond(indicator: str, usage: str, **params) -> dict:
    return {"indicator": indicator, "usage": usage, "params": params}


def test_every_mirror_is_symmetric():
    # A 的镜像是 B，则 B 的镜像必须是 A。表里写错方向靠这条抓。
    for key, spec in USAGES.items():
        if spec.mirror is None:
            continue
        assert USAGES[spec.mirror].mirror == key, key


def test_mirror_swaps_the_usage_and_keeps_params():
    out = mirror_condition(_cond("ma", "ma.price_cross_above", maType="EMA", period=20))
    assert out == {"indicator": "ma", "usage": "ma.price_cross_below", "params": {"maType": "EMA", "period": 20}}


def test_rsi_threshold_mirror_flips_the_level():
    out = mirror_condition(_cond("rsi", "rsi.below_level", period=14, level=30))
    assert out == {"indicator": "rsi", "usage": "rsi.above_level", "params": {"period": 14, "level": 70}}


def test_rsi_cross_mirror_flips_the_level_too():
    out = mirror_condition(_cond("rsi", "rsi.cross_above_level", period=14, level=35))
    assert out["usage"] == "rsi.cross_below_level"
    assert out["params"]["level"] == 65


def test_rsi_slope_mirror_does_not_touch_the_level_since_it_has_none():
    out = mirror_condition(_cond("rsi", "rsi.rising", period=14))
    assert out == {"indicator": "rsi", "usage": "rsi.falling", "params": {"period": 14}}


def test_atr_has_no_mirror():
    assert mirror_condition(_cond("atr", "atr.volatility_above_average", period=14, mult=1.2)) is None


def test_mirror_fills_defaults_for_omitted_params():
    out = mirror_condition({"indicator": "rsi", "usage": "rsi.below_level", "params": {}})
    assert out["params"] == {"period": 14, "level": 70}


def test_mirror_conditions_keeps_atr_as_is():
    # ATR 无镜像时原样保留，因为波动率条件多空共用同一判定——不是「忽略它」。
    payload = {
        "logic": "AND",
        "interval": "15",
        "symbol": "XAUUSD",
        "conditions": [
            _cond("rsi", "rsi.below_level", period=14, level=30),
            _cond("atr", "atr.volatility_above_average", period=14, mult=1.2),
        ],
    }
    out = mirror_conditions(payload)
    assert out[0]["usage"] == "rsi.above_level"
    assert out[1]["usage"] == "atr.volatility_above_average"


def test_evaluate_side_and_requires_every_condition():
    bars = _bars(_wave(200))
    c1 = _cond("rsi", "rsi.below_level", period=14, level=45)
    c2 = _cond("ma", "ma.price_below", maType="SMA", period=20)
    s1 = evaluate_usage(bars, c1["usage"], c1["params"])
    s2 = evaluate_usage(bars, c2["usage"], c2["params"])
    out = evaluate_side(bars, [c1, c2], "AND")
    assert out == [s1[i] and s2[i] for i in range(len(bars))]


def test_evaluate_side_or_requires_any_condition():
    bars = _bars(_wave(200))
    c1 = _cond("rsi", "rsi.below_level", period=14, level=45)
    c2 = _cond("ma", "ma.price_below", maType="SMA", period=20)
    s1 = evaluate_usage(bars, c1["usage"], c1["params"])
    s2 = evaluate_usage(bars, c2["usage"], c2["params"])
    out = evaluate_side(bars, [c1, c2], "OR")
    assert out == [s1[i] or s2[i] for i in range(len(bars))]


def test_evaluate_side_with_no_conditions_is_all_false():
    bars = _bars(_wave(20))
    assert evaluate_side(bars, [], "AND") == [False] * len(bars)


def test_evaluate_conditions_emits_buy_and_sell():
    payload = {
        "logic": "AND",
        "interval": "15",
        "symbol": "XAUUSD",
        "conditions": [_cond("rsi", "rsi.below_level", period=14, level=40)],
    }
    out = evaluate_conditions(_bars(_wave(300)), payload)
    assert len(out) == 300
    assert "BUY" in out
    assert "SELL" in out
    assert None in out


def test_evaluate_conditions_sell_bars_match_the_mirrored_side():
    payload = {
        "logic": "AND",
        "interval": "15",
        "symbol": "XAUUSD",
        "conditions": [_cond("rsi", "rsi.below_level", period=14, level=40)],
    }
    bars = _bars(_wave(300))
    out = evaluate_conditions(bars, payload)
    shorts = evaluate_usage(bars, "rsi.above_level", {"period": 14, "level": 60})
    for i in range(len(bars)):
        if out[i] == "SELL":
            assert shorts[i] is True


def test_evaluate_conditions_long_wins_when_both_sides_fire():
    # 只有 ATR 条件时多空条件完全相同，两侧同时成立，结果必须是 BUY。
    payload = {
        "logic": "AND",
        "interval": "15",
        "symbol": "XAUUSD",
        "conditions": [_cond("atr", "atr.volatility_above_average", period=14, mult=1.0)],
    }
    out = evaluate_conditions(_bars(_wave(200)), payload)
    assert "SELL" not in out
    assert "BUY" in out


def test_evaluate_conditions_on_empty_bars():
    payload = {
        "logic": "AND",
        "interval": "15",
        "symbol": "XAUUSD",
        "conditions": [_cond("rsi", "rsi.below_level", period=14, level=30)],
    }
    assert evaluate_conditions([], payload) == []
