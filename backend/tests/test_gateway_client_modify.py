"""trade_modify 的载荷形状：None 必须发成 null（网关保留现值），0 原样发（清除）。

这条不变式守的是 2026-09-21 修掉的雷：自动仓管给网关账号移止损时 tp 被 `or 0` 收敛成 0，
网关把 0 当清除，用户止盈被抹掉。
Payload shape of trade_modify: None must go out as null (gateway keeps the current
value), 0 goes out as 0 (clear). Guards the 2026-09-21 fix where a stop-only modify
reached the gateway as takeProfit=0 and wiped the take-profit.
"""
import asyncio

from app.services import gateway_client


def _capture(monkeypatch):
    sent: dict = {}

    async def fake_post(path, body, timeout=None):
        sent["path"] = path
        sent["body"] = body
        return {"ok": True, "retcode": "MT_RET_REQUEST_DONE"}

    monkeypatch.setattr(gateway_client, "_post", fake_post)
    return sent


def test_unspecified_side_is_sent_as_null(monkeypatch):
    sent = _capture(monkeypatch)
    asyncio.run(gateway_client.trade_modify(601144, 12345, sl=3300.5, tp=None))
    assert sent["path"] == "/trade/modify"
    assert sent["body"]["stopLoss"] == 3300.5
    assert sent["body"]["takeProfit"] is None      # null，不是 0 / null, not 0


def test_explicit_zero_still_clears(monkeypatch):
    sent = _capture(monkeypatch)
    asyncio.run(gateway_client.trade_modify(601144, 12345, sl=0, tp=4200.0))
    assert sent["body"]["stopLoss"] == 0
    assert sent["body"]["takeProfit"] == 4200.0


def test_defaults_are_none_not_zero(monkeypatch):
    sent = _capture(monkeypatch)
    asyncio.run(gateway_client.trade_modify(601144, 12345))
    assert sent["body"]["stopLoss"] is None
    assert sent["body"]["takeProfit"] is None
