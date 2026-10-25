"""下单前的交易时段闸门（2026-10-25）：MT5 不能交易时平台不收单，周末只有加密货币能下。

钉住四件事：
1. 固定周末日历兜底：周六 XAUUSD 休市、BTCUSD 照常；下一次开盘是周日 21:00 UTC。
2. 网关 /symbol-sessions 的判定优先于日历；网关答不上来才退回日历。
3. 休市时 place_order 以 409 拒单，且**不落库**（不能变成一条 PENDING 指令）。
4. MARKET_HOURS_GATE 关掉时放行。

The market-hours gate: refuse when MT5 cannot trade, crypto only on weekends. Pins the
calendar fallback, gateway-over-calendar precedence, the 409 with no persisted order,
and the bypass switch.
"""
import asyncio
from datetime import datetime, timezone

import pytest
from fastapi import HTTPException

from app.core.config import settings
from app.models import MT5Account, Order, User
from app.routers.orders import place_order as _place_decorated
from app.schemas import OrderRequest
from app.services import market_hours

_place = _place_decorated.__wrapped__

_SATURDAY = datetime(2026, 10, 24, 10, 0, tzinfo=timezone.utc)   # 周六 / Saturday
_WEDNESDAY = datetime(2026, 10, 21, 10, 0, tzinfo=timezone.utc)  # 周三 / Wednesday


def test_calendar_closes_forex_on_saturday_but_not_crypto():
    gold = market_hours._calendar_status("XAUUSD", now=_SATURDAY)
    assert gold.open is False
    assert gold.source == "calendar"
    # 下一次开盘：周日 21:00 UTC / next open: Sunday 21:00 UTC
    assert gold.next_open_at == datetime(2026, 10, 25, 21, 0, tzinfo=timezone.utc)

    btc = market_hours._calendar_status("BTCUSDT", now=_SATURDAY)
    assert btc.open is True
    assert btc.symbol == "BTCUSD"  # 别名归一到券商名 / alias normalised to the broker name
    assert btc.next_open_at is None


def test_calendar_open_midweek():
    assert market_hours._calendar_status("EURUSD", now=_WEDNESDAY).open is True


def test_gateway_answer_wins_over_calendar(monkeypatch):
    async def fake_sessions(symbol, login=None, timeout=3.0):
        assert symbol == "XAUUSD"
        assert login == 1001
        return {"ok": True, "openNow": False, "sessionsKnown": True, "nextOpenUtc": 1_800_000_000}

    monkeypatch.setattr(market_hours.gateway_client, "get_symbol_sessions", fake_sessions)
    st = asyncio.run(market_hours.market_status_async("XAUUSD", 1001))
    assert st.open is False
    assert st.source == "gateway"
    assert st.next_open_at == datetime.fromtimestamp(1_800_000_000, timezone.utc)

    # 30 秒内第二次查走缓存，不再打网关 / the second query within 30s is served from cache
    async def boom(*_a, **_k):
        raise AssertionError("should not hit the gateway again")

    monkeypatch.setattr(market_hours.gateway_client, "get_symbol_sessions", boom)
    again = asyncio.run(market_hours.market_status_async("XAUUSD", 1001))
    assert again is st


def test_gateway_unavailable_falls_back_to_calendar(monkeypatch):
    async def none(*_a, **_k):
        return None

    monkeypatch.setattr(market_hours.gateway_client, "get_symbol_sessions", none)
    st = asyncio.run(market_hours.market_status_async("XAUUSD"))
    assert st.source == "calendar"


def test_closed_message_carries_reopen_time_in_utc8():
    st = market_hours.MarketStatus(
        "XAUUSD", False, "gateway", datetime(2026, 10, 25, 21, 0, tzinfo=timezone.utc), 0.0,
    )
    msg = market_hours.closed_message(st)
    # 周日 21:00 UTC = 周一 05:00 UTC+8 / Sunday 21:00 UTC is Monday 05:00 UTC+8
    assert "10-26 05:00" in msg
    assert " / " in msg


def _setup(db) -> User:
    user = User(id="u1", email="u1@example.com", api_token="tok_u1", plan="PRO")
    db.add(user)
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    db.add(MT5Account(user_id="u1", login="1001", source="bridge", last_heartbeat=now, equity=100000))
    db.commit()
    return user


def _req(**kw) -> OrderRequest:
    base = dict(symbol="XAUUSD", side="BUY", volume=0.01, clientOrderId="c1", mt5Login="1001")
    base.update(kw)
    return OrderRequest(**base)


def _closed(symbol, login=None):
    return market_hours.MarketStatus(symbol, False, "gateway", None, 0.0)


def _open(symbol, login=None):
    return market_hours.MarketStatus(symbol, True, "gateway", None, 0.0)


def test_place_order_refused_when_market_closed(db_session, monkeypatch):
    user = _setup(db_session)
    monkeypatch.setattr(settings, "MARKET_HOURS_GATE", True)
    monkeypatch.setattr(market_hours, "market_status", _closed)

    with pytest.raises(HTTPException) as exc:
        _place(request=None, req=_req(), user=user, db=db_session)
    assert exc.value.status_code == 409
    assert "休市" in exc.value.detail
    # 不能落成一条 PENDING 指令 / must not become a PENDING command
    assert db_session.query(Order).count() == 0


def test_place_order_allowed_when_market_open(db_session, monkeypatch):
    user = _setup(db_session)
    monkeypatch.setattr(settings, "MARKET_HOURS_GATE", True)
    monkeypatch.setattr(market_hours, "market_status", _open)

    out = _place(request=None, req=_req(), user=user, db=db_session)
    assert out.status == "PENDING"
    assert db_session.query(Order).count() == 1


def test_gate_switch_bypasses_check(db_session, monkeypatch):
    user = _setup(db_session)
    monkeypatch.setattr(settings, "MARKET_HOURS_GATE", False)

    def boom(*_a, **_k):
        raise AssertionError("gate off must not consult market status")

    monkeypatch.setattr(market_hours, "market_status", boom)
    out = _place(request=None, req=_req(), user=user, db=db_session)
    assert out.status == "PENDING"


def test_serialize_shape():
    st = market_hours.MarketStatus("XAUUSD", False, "calendar", datetime(2026, 10, 25, 21, 0, tzinfo=timezone.utc), 0.0)
    assert market_hours.serialize(st) == {
        "symbol": "XAUUSD",
        "open": False,
        "source": "calendar",
        "nextOpenAt": "2026-10-25T21:00:00+00:00",
    }
