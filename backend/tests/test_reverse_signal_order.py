"""反向跟单（2026-10-11）：按信号的反方向下单、止盈止损对调。

钉住三件事：
1. 反向单的方向必须正好是信号的反方向，止损止盈由后端按信号对调（不靠前端传）。
2. 反向标记只能和一条真实存在的信号一起用。
3. 不带 reverse 的正向跟单行为不变：方向仍须与信号一致。

Reverse copy-trading: opposite side, SL/TP swapped. Pins the side check, the
server-derived swap, the "needs a real signal" rule, and that forward copies are
unchanged.
"""
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException

from app.models import MT5Account, Order, Signal, User
from app.routers.orders import place_order as _place_decorated
from app.schemas import OrderRequest
from app.services.order_payload import ORDER_SOURCE_REVERSE, order_source_tag

# 剥掉 slowapi 装饰器（同 test_order_dispatch_guards.py）/ strip the rate-limit decorator
_place = _place_decorated.__wrapped__


def _setup(db, *, side: str = "BUY") -> tuple[User, Signal]:
    user = User(id="u1", email="u1@example.com", api_token="tok_u1", plan="PRO")
    db.add(user)
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    db.add(MT5Account(user_id="u1", login="1001", source="bridge", last_heartbeat=now, equity=100000))
    sig = Signal(
        id="sig-1", symbol="XAUUSD", side=side, entry=2400.0,
        stop_loss=2390.0 if side == "BUY" else 2410.0,
        take_profit=2420.0 if side == "BUY" else 2380.0,
        indicator="AIFT", status="ACTIVE",
        expire_at=now + timedelta(minutes=10),
    )
    db.add(sig)
    db.commit()
    return user, sig


def _req(**kw) -> OrderRequest:
    base = dict(signalId="sig-1", symbol="XAUUSD", side="SELL", volume=0.01, clientOrderId="c1", mt5Login="1001")
    base.update(kw)
    return OrderRequest(**base)


def test_reverse_flips_side_and_swaps_levels(db_session):
    user, _ = _setup(db_session, side="BUY")

    _place(request=None, req=_req(reverse=True), user=user, db=db_session)

    o = db_session.query(Order).filter(Order.client_order_id == "c1").one()
    assert o.side == "SELL"
    # 信号的止盈 2420 变成止损、止损 2390 变成止盈 / TP becomes the stop, SL the target
    assert o.sl == 2420.0
    assert o.tp == 2390.0
    assert o.signal_id == "sig-1"
    assert o.source == ORDER_SOURCE_REVERSE
    # 券商备注仍按跟单记 / broker comment still tagged as a signal copy
    assert order_source_tag(o) == "SIG"


def test_reverse_keeps_user_edited_levels(db_session):
    user, _ = _setup(db_session, side="BUY")

    _place(request=None, req=_req(reverse=True, stopLoss=2425.0, takeProfit=2385.0), user=user, db=db_session)

    o = db_session.query(Order).filter(Order.client_order_id == "c1").one()
    assert (o.sl, o.tp) == (2425.0, 2385.0)


def test_reverse_rejects_same_side_as_signal(db_session):
    user, _ = _setup(db_session, side="BUY")

    with pytest.raises(HTTPException) as e:
        _place(request=None, req=_req(side="BUY", reverse=True), user=user, db=db_session)
    assert e.value.status_code == 400


def test_reverse_requires_signal(db_session):
    user, _ = _setup(db_session)

    with pytest.raises(HTTPException) as e:
        _place(request=None, req=_req(signalId=None, reverse=True), user=user, db=db_session)
    assert e.value.status_code == 400

    with pytest.raises(HTTPException) as e:
        _place(request=None, req=_req(signalId="nope", reverse=True, clientOrderId="c2"), user=user, db=db_session)
    assert e.value.status_code == 404


def test_forward_copy_unchanged(db_session):
    user, _ = _setup(db_session, side="BUY")

    with pytest.raises(HTTPException) as e:
        _place(request=None, req=_req(side="SELL"), user=user, db=db_session)
    assert e.value.status_code == 400

    _place(request=None, req=_req(side="BUY", clientOrderId="c3"), user=user, db=db_session)
    o = db_session.query(Order).filter(Order.client_order_id == "c3").one()
    assert (o.side, o.sl, o.tp, o.source) == ("BUY", 2390.0, 2420.0, None)
