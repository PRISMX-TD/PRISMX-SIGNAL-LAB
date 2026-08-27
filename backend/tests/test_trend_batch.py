"""#14 /webhook/trend 增加批量格式后，单条格式必须一天都不能断。

后端会先于 EA 上线，那段时间线上跑的还是每品种发一次的旧 EA；而 TradingView
指标走的也是单条契约。所以这里重点覆盖"两种格式并存"，而不只是新格式能用。

Covers the batch payload added in #14 alongside the pre-existing single payload.
The backend ships before the EA, so the single form must keep working.
"""
import json

import pytest

from app.routers.webhook import TrendBatch, TrendSignal, _extract_json_block


SECRET = "test-secret-value"


def _single(symbol="XAUUSD"):
    return {
        "secret": SECRET,
        "symbol": symbol,
        "trends": {"M5": "UP", "H1": "DOWN"},
        "high": 2410.0,
        "low": 2395.5,
    }


def _batch(symbols=("XAUUSD", "EURUSD", "BTCUSD")):
    return {
        "secret": SECRET,
        "items": [
            {
                "symbol": s,
                "trends": {"M5": "UP", "H1": "FLAT"},
                "high": 100.0,
                "low": 90.0,
            }
            for s in symbols
        ],
    }


# ---------- 载荷模型 / payload models ----------


def test_single_payload_still_validates():
    """旧的单条格式必须照常通过校验。"""
    p = TrendSignal.model_validate(_single())
    assert p.symbol == "XAUUSD"
    assert p.trends["M5"] == "UP"
    assert p.high == pytest.approx(2410.0)


def test_batch_payload_validates():
    """新的批量格式能解析，且条目数正确。"""
    b = TrendBatch.model_validate(_batch())
    assert b.secret == SECRET
    assert len(b.items) == 3
    assert [i.symbol for i in b.items] == ["XAUUSD", "EURUSD", "BTCUSD"]


def test_batch_items_do_not_carry_secret():
    """密钥只在外层带一次；条目里多写一个 secret 不影响解析（被忽略）。"""
    payload = _batch()
    payload["items"][0]["secret"] = "ignored"
    b = TrendBatch.model_validate(payload)
    assert not hasattr(b.items[0], "secret")


def test_batch_rejects_empty_items():
    """空批次没有意义，应当被拒——否则 EA 出 bug 时会静默发空包。"""
    with pytest.raises(ValueError):
        TrendBatch.model_validate({"secret": SECRET, "items": []})


def test_batch_rejects_oversized_items():
    """超过上限的畸形载荷被拒，防止单次请求被撑爆。"""
    too_many = {
        "secret": SECRET,
        "items": [
            {"symbol": "XAUUSD", "trends": {"M5": "UP"}} for _ in range(65)
        ],
    }
    with pytest.raises(ValueError):
        TrendBatch.model_validate(too_many)


def test_batch_rejects_bad_trend_direction():
    """方向枚举照常生效，批量不会绕过校验。"""
    payload = _batch(("XAUUSD",))
    payload["items"][0]["trends"]["M5"] = "SIDEWAYS"
    with pytest.raises(ValueError):
        TrendBatch.model_validate(payload)


def test_high_low_optional_in_batch():
    """缺 high/low 的条目合法：只更新趋势、跳过信号判定，与单条语义一致。"""
    payload = {
        "secret": SECRET,
        "items": [{"symbol": "WTI", "trends": {"H4": "DOWN"}}],
    }
    b = TrendBatch.model_validate(payload)
    assert b.items[0].high is None
    assert b.items[0].low is None


# ---------- 端点的格式判别 / endpoint shape detection ----------


def test_items_key_distinguishes_batch_from_single():
    """端点靠 items 键区分两种格式。这里锁死这个判别条件本身。"""
    assert "items" in _batch()
    assert "items" not in _single()


def test_extract_json_block_still_works_for_both():
    """TradingView 会把说明文字和 JSON 拼在一起发，抠 JSON 块的兜底对两种格式都要生效。"""
    for payload in (_single(), _batch()):
        blob = "Alert fired!\n" + json.dumps(payload) + "\ntrailing text"
        extracted = _extract_json_block(blob)
        assert extracted is not None
        assert json.loads(extracted) == payload
