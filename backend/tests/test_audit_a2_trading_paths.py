"""安全审计 A2（交易路径）的回归用例，2026-10-26。

1. 桥接上报的持仓行不能驱动 gateway 账号上的自动改单 / 分批平仓
   （auto_manage: bridge-reported-rows-drive-gateway-auto-modify-close）。
2. 自动改止损失败后不能每拍重发（auto-modify-reissued-every-report-without-failure-backoff）。
3. 一键平仓不能被桥接那一路塞进来的假仓位放大成成千上万次网关平仓
   （close-all-gateway-fanout-from-bridge-reported-positions）。
4. 网关下单路径要守套餐账户名额（gateway-order-path-ignores-plan-account-slot-limit）。
5. 平仓 / 改单 / 改挂单 / 撤挂单也要过休市闸门，「只平」品种放行
   （close-modify-cancel-skip-market-closed-gate）。

Regression tests for security-audit group A2 (trading paths).
"""
import asyncio
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException

from app.core.config import settings
from app.models import AutoManageSettings, MT5Account, Order, User
from app.services import auto_manage, close_all, gateway_execute, market_hours
from app.services.auto_manage import GatewayPositions, evaluate_positions, invalidate_eligibility
from app.services.gateway_client import TradeRsp

GW_LOGIN = "500039"
BRIDGE_LOGIN = "600144"
POSITION = 17431512


# ---------------------------------------------------------------- 公共替身 / stubs

def _ok(**kw) -> TradeRsp:
    base = dict(ok=True, retcode="MT_RET_REQUEST_DONE", message="", deal=1, order=1, price=1.1,
                position=1)
    base.update(kw)
    return TradeRsp(**base)


def _fail(retcode="MT_RET_REQUEST_MARKET_CLOSED") -> TradeRsp:
    return TradeRsp(ok=False, retcode=retcode, message="closed", deal=0, order=0, price=0.0)


@pytest.fixture()
def gw(monkeypatch):
    """把 gateway_execute 里的网关调用全换成记录器，默认都回成功。"""
    calls: list[tuple] = []
    replies: dict[str, TradeRsp] = {}

    def _mk(name):
        async def _fn(*a, **kw):
            calls.append((name, a, kw))
            return replies.get(name) or _ok()
        return _fn

    for name in ("gw_open", "gw_pending", "gw_close", "gw_modify", "gw_modify_pending",
                 "gw_cancel"):
        monkeypatch.setattr(gateway_execute, name, _mk(name))

    from app.services.connection_manager import manager

    async def _no_push(*_a, **_k):
        return None

    monkeypatch.setattr(manager, "push_to_client", _no_push)
    return type("GW", (), {"calls": calls, "replies": replies})


@pytest.fixture()
def pushes(monkeypatch):
    sent: list[tuple] = []
    monkeypatch.setattr(auto_manage, "dispatch_event_push", lambda *a, **k: sent.append(a))
    return sent


def _snapshot(monkeypatch, by_source: dict):
    """设定跨 worker 持仓快照的分来源视图（auto_manage 与一键平仓读的就是它）。"""
    from app.services.connection_manager import manager

    monkeypatch.setattr(manager, "_shared_by_source", lambda kind, uid, skip=None: by_source)


# ---------------------------------------------------------------- 1. 自动仓管只信网关行

def _auto_user(db, *, login=GW_LOGIN, source="gateway", plan="PRO", revoked=False,
               entry=2000.0, sl=1990.0, **cfg_kw) -> str:
    user = User(id=f"a2-{login}-{source}", email=f"a2-{login}@t.local",
                api_token=f"tok-a2-{login}", plan=plan)
    db.add(user)
    db.add(MT5Account(
        user_id=user.id, login=login, server="", source=source,
        revoked_at=datetime.now(timezone.utc) if revoked else None,
    ))
    cfg = dict(enabled=True, be_enabled=True, be_trigger_r=1.0, trail_enabled=False,
               ptp_enabled=False)
    cfg.update(cfg_kw)
    db.add(AutoManageSettings(user_id=user.id, **cfg))
    db.add(Order(
        user_id=user.id, client_order_id=f"open-{login}", action="ORDER", status="FILLED",
        symbol="XAUUSD", side="BUY", volume=1.0, price=entry, sl=sl,
        mt5_login=login, mt5_ticket=POSITION, mt5_position=POSITION,
    ))
    db.commit()
    invalidate_eligibility(user.id)
    return user.id


def _row(login=GW_LOGIN, *, entry=2000.0, current=2005.0, sl=1990.0, tp=2050.0, volume=1.0):
    return {"login": login, "ticket": POSITION, "side": "BUY", "symbol": "XAUUSD",
            "entryPrice": entry, "currentPrice": current, "stopLoss": sl, "takeProfit": tp,
            "volume": volume}


# 伪造行：真实入场 2000 / 止损 1990，伪造成入场 1000、现价 1020、止盈清零 → 保本会把止损
# 拉到 1000 并清掉止盈，分批止盈按伪造手数平仓。
_FORGED = _row(entry=1000.0, current=1020.0, sl=990.0, tp=0.0, volume=1.0)


def test_bridge_rows_naming_a_gateway_login_never_reach_the_gateway(db_session, gw, pushes):
    uid = _auto_user(db_session, ptp_enabled=True, ptp_trigger_r=1.0, ptp_fraction=0.5)

    created = evaluate_positions(db_session, uid, [_FORGED], source="bridge")

    assert created == 0
    assert gw.calls == []
    assert db_session.query(Order).filter(Order.action.in_(("MODIFY", "CLOSE"))).count() == 0


def test_legacy_caller_rows_are_checked_against_the_gateway_slice(db_session, gw, pushes,
                                                                  monkeypatch):
    """桥接路由目前不带 source：gateway 账号的行要换成网关那一路的真实数据。
    真实仓位浮盈 0.5R、不触发保本 → 伪造行什么也做不成。"""
    uid = _auto_user(db_session)
    _snapshot(monkeypatch, {"bridge": [_FORGED], "gateway": [_row(current=2005.0)]})

    assert evaluate_positions(db_session, uid, [_FORGED]) == 0
    assert gw.calls == []


def test_legacy_caller_rows_missing_from_the_gateway_slice_are_dropped(db_session, gw, pushes,
                                                                       monkeypatch):
    uid = _auto_user(db_session)
    _snapshot(monkeypatch, {"bridge": [_FORGED]})  # 网关那一路没有这张仓位

    assert evaluate_positions(db_session, uid, [_FORGED]) == 0
    assert gw.calls == []


def test_gateway_loop_rows_still_drive_the_gateway(db_session, gw, pushes):
    uid = _auto_user(db_session)

    created = evaluate_positions(db_session, uid, GatewayPositions([_row(current=2010.0)]))

    assert created == 1
    assert [c[0] for c in gw.calls] == ["gw_modify"]
    _, args, _ = gw.calls[0]
    assert args[1] == POSITION
    assert args[2] == pytest.approx(2000.0)   # 保本到真实入场价
    assert args[3] == pytest.approx(2050.0)   # 真实止盈原样保留


# ---------------------------------------------------------------- 2. 改止损失败退避

_BE_ROW = {"ticket": POSITION, "login": GW_LOGIN, "entryPrice": 1.1000, "currentPrice": 1.1050,
           "stopLoss": 1.0950, "takeProfit": 0, "volume": 0.1, "side": "BUY",
           "symbol": "EURUSD"}


def _be_user(db, *, login=GW_LOGIN, source="gateway", revoked=False) -> str:
    user = User(id=f"bo-{login}", email=f"bo-{login}@t.local", api_token=f"tok-bo-{login}",
                plan="PRO")
    db.add(user)
    db.add(MT5Account(user_id=user.id, login=login, server="", source=source,
                      revoked_at=datetime.now(timezone.utc) if revoked else None))
    db.add(AutoManageSettings(user_id=user.id, enabled=True, be_enabled=True, be_trigger_r=0.1,
                              trail_enabled=False, ptp_enabled=False))
    db.add(Order(user_id=user.id, client_order_id="open-bo", action="ORDER", status="FILLED",
                 symbol="EURUSD", side="BUY", volume=0.1, mt5_login=login,
                 mt5_ticket=POSITION, mt5_position=POSITION))
    db.commit()
    invalidate_eligibility(user.id)
    return user.id


def _auto_modifies(db) -> list[Order]:
    return (db.query(Order).filter(Order.action == "MODIFY",
                                   Order.client_order_id.like("auto_%")).all())


def test_failed_modify_is_not_reissued_on_every_report(db_session, gw, pushes, monkeypatch):
    """绑定已撤销：每条 MODIFY 当场被拒。以前 5 次上报 = 5 条拒单 + 5 条「止损已移至」推送。"""
    uid = _be_user(db_session, revoked=True)
    _snapshot(monkeypatch, {})

    for _ in range(5):
        evaluate_positions(db_session, uid, [dict(_BE_ROW)])

    rows = _auto_modifies(db_session)
    assert len(rows) == 1
    assert rows[0].status == "REJECTED"
    assert pushes == []  # 被拒的不再推成功措辞 / no success push for a rejection
    assert gw.calls == []


def test_failed_gateway_modify_backs_off_then_retries(db_session, gw, pushes):
    uid = _be_user(db_session)
    gw.replies["gw_modify"] = _fail()

    for _ in range(3):
        evaluate_positions(db_session, uid, GatewayPositions([dict(_BE_ROW)]))
    assert len(gw.calls) == 1
    assert len(_auto_modifies(db_session)) == 1
    assert pushes == []

    # 退避窗口过了（第 1 次失败后 60 秒）才再试 / retried only once the window has passed
    first = _auto_modifies(db_session)[0]
    first.created_at = datetime.now(timezone.utc) - timedelta(
        seconds=auto_manage.MODIFY_RETRY_BASE_SECONDS + 5)
    db_session.commit()
    evaluate_positions(db_session, uid, GatewayPositions([dict(_BE_ROW)]))
    assert len(gw.calls) == 2

    # 第 2 次失败后要等 120 秒：刚过 60 秒仍不发 / after the 2nd failure 60s is not enough
    for o in _auto_modifies(db_session):
        o.created_at = datetime.now(timezone.utc) - timedelta(
            seconds=auto_manage.MODIFY_RETRY_BASE_SECONDS + 5)
    db_session.commit()
    evaluate_positions(db_session, uid, GatewayPositions([dict(_BE_ROW)]))
    assert len(gw.calls) == 2


def test_changed_reported_stop_resets_the_backoff(db_session, gw, pushes):
    uid = _be_user(db_session)
    gw.replies["gw_modify"] = _fail()
    evaluate_positions(db_session, uid, GatewayPositions([dict(_BE_ROW)]))
    assert len(gw.calls) == 1

    moved = dict(_BE_ROW, stopLoss=1.0960)  # 用户手动挪过止损：情况变了
    evaluate_positions(db_session, uid, GatewayPositions([moved]))
    assert len(gw.calls) == 2


def test_bridge_rejected_modify_also_backs_off(db_session, pushes):
    uid = _be_user(db_session, login=BRIDGE_LOGIN, source="bridge")
    row = dict(_BE_ROW, login=BRIDGE_LOGIN)

    for _ in range(4):
        evaluate_positions(db_session, uid, [dict(row)], source="bridge")
        for o in _auto_modifies(db_session):
            if o.status == "PENDING":
                o.status = "REJECTED"  # 桥接回执：MT5 拒了
        db_session.commit()

    assert len(_auto_modifies(db_session)) == 1


# ---------------------------------------------------------------- 3. 一键平仓不被假仓位放大

CA_LOGIN = "900001"


def _ca_user(db, uid="a2-ca") -> User:
    user = User(id=uid, email=f"{uid}@t.local", api_token=f"tok-{uid}", plan="PRO")
    db.add(user)
    db.add(MT5Account(user_id=uid, login=CA_LOGIN, server="", source="gateway"))
    db.commit()
    return user


def _close_all(db, monkeypatch, user, cid):
    from app.core import rate_limit
    import app.routers.orders as orders

    monkeypatch.setattr(rate_limit.limiter, "enabled", False)

    class _Bg:
        def __init__(self):
            self.tasks = []

        def add_task(self, fn, *a, **kw):
            self.tasks.append((fn, a, kw))

    bg = _Bg()
    out = orders.close_all_positions(
        request=None, req=orders.CloseAllRequest(clientOrderId=cid), background=bg,
        user=user, db=db,
    )
    return out, bg


def test_close_all_ignores_forged_bridge_rows_for_a_gateway_login(db_session, gw, monkeypatch):
    from app.services.connection_manager import manager

    user = _ca_user(db_session)
    forged = [{"ticket": k, "login": CA_LOGIN, "symbol": "EURUSD", "side": "BUY"}
              for k in range(1, 501)]
    asyncio.run(manager.push_positions(user.id, forged, source="bridge"))
    try:
        for cid in ("a", "b"):
            with pytest.raises(HTTPException) as exc:
                _close_all(db_session, monkeypatch, user, cid)
            assert exc.value.status_code == 400
        assert db_session.query(Order).count() == 0
        assert gw.calls == []
    finally:
        asyncio.run(manager.push_positions(user.id, [], source="bridge"))


def test_close_all_keeps_rows_the_gateway_itself_reported(db_session, gw, monkeypatch):
    from app.services.connection_manager import manager

    user = _ca_user(db_session, uid="a2-ca2")
    real = {"ticket": 7, "login": CA_LOGIN, "symbol": "EURUSD", "side": "BUY"}
    forged = [{"ticket": k, "login": CA_LOGIN, "symbol": "EURUSD", "side": "BUY"}
              for k in range(100, 140)]
    monkeypatch.setattr(manager, "get_positions_shared", lambda _uid: [real] + forged)
    _snapshot(monkeypatch, {"gateway": [real], "bridge": forged})

    out, bg = _close_all(db_session, monkeypatch, user, "c")
    assert out.queued == 1
    assert out.orders[0].ticket == 7
    assert len(bg.tasks) == 1


def test_close_all_batch_is_capped(db_session):
    db_session.add(User(id="u-cap", email="cap@t.local", api_token="tok-cap", plan="PRO"))
    db_session.commit()
    rows = [{"ticket": k, "login": BRIDGE_LOGIN, "symbol": "EURUSD", "side": "BUY"}
            for k in range(1, close_all.CLOSE_ALL_MAX_POSITIONS + 301)]

    _, created, _ = close_all.queue(db_session, "u-cap", "co_cap", None, rows)
    assert len(created) == close_all.CLOSE_ALL_MAX_POSITIONS


# ---------------------------------------------------------------- 4. 网关下单守套餐名额

def _place():
    from app.routers.orders import place_order
    return place_order.__wrapped__


def _free_user_two_gateway_accounts(db) -> User:
    user = User(id="a2-free", email="free@t.local", api_token="tok-free", plan="FREE")
    db.add(user)
    for login in ("1001", "1002"):
        db.add(MT5Account(user_id=user.id, login=login, server="", source="gateway",
                          trade_mode=2, equity=100000))  # 2 = REAL，不占额外模拟名额
    db.commit()
    return user


def test_free_user_cannot_open_on_over_limit_gateway_account(db_session, gw):
    from app.schemas import OrderRequest

    user = _free_user_two_gateway_accounts(db_session)
    req = OrderRequest(symbol="EURUSD", side="BUY", volume=0.01, clientOrderId="co_t1",
                       mt5Login="1002")
    with pytest.raises(HTTPException) as exc:
        _place()(request=None, req=req, user=user, db=db_session)
    assert exc.value.status_code == 403
    assert gw.calls == []
    assert db_session.query(Order).count() == 0


def test_free_user_can_still_open_on_the_first_slot(db_session, gw):
    from app.schemas import OrderRequest

    user = _free_user_two_gateway_accounts(db_session)
    req = OrderRequest(symbol="EURUSD", side="BUY", volume=0.01, clientOrderId="co_t2",
                       mt5Login="1001")
    out = _place()(request=None, req=req, user=user, db=db_session)
    assert out.status == "FILLED"
    assert [c[0] for c in gw.calls] == ["gw_open"]


def test_over_limit_gateway_account_can_still_close(db_session, gw):
    from app.routers.orders import close_position
    from app.schemas import ClosePositionRequest

    user = _free_user_two_gateway_accounts(db_session)
    req = ClosePositionRequest(clientOrderId="co_c1", ticket=5, symbol="EURUSD", side="BUY",
                               mt5Login="1002")
    out = close_position.__wrapped__(request=None, req=req, user=user, db=db_session)
    assert out.status == "FILLED"
    assert [c[0] for c in gw.calls] == ["gw_close"]


def test_extra_demo_slot_account_is_not_over_limit(db_session, gw):
    from app.schemas import OrderRequest

    user = User(id="a2-free2", email="free2@t.local", api_token="tok-free2", plan="FREE")
    db_session.add(user)
    db_session.add(MT5Account(user_id=user.id, login="1001", server="", source="gateway",
                              trade_mode=2, equity=100000))
    db_session.add(MT5Account(user_id=user.id, login="1002", server="", source="gateway",
                              trade_mode=0, equity=100000))  # 0 = DEMO，占额外直连模拟名额
    db_session.commit()
    req = OrderRequest(symbol="EURUSD", side="BUY", volume=0.01, clientOrderId="co_t3",
                       mt5Login="1002")
    out = _place()(request=None, req=req, user=user, db=db_session)
    assert out.status == "FILLED"


# ---------------------------------------------------------------- 5. 平仓 / 改单 / 撤单的休市闸门

def _closed(symbol, login=None):
    return market_hours.MarketStatus(symbol, False, "gateway", None, 0.0, 4)


def _close_only(symbol, login=None):
    return market_hours.MarketStatus(symbol, False, "gateway", None, 0.0,
                                     market_hours.TRADE_MODE_CLOSEONLY)


def _gate(monkeypatch, status_fn):
    monkeypatch.setattr(settings, "MARKET_HOURS_GATE", True)
    monkeypatch.setattr(market_hours, "market_status", status_fn)


def _gw_user(db, login="900001", source="gateway") -> User:
    user = User(id=f"mh-{login}", email=f"mh-{login}@t.local", api_token=f"tok-mh-{login}",
                plan="PRO")
    db.add(user)
    db.add(MT5Account(user_id=user.id, login=login, server="", source=source))
    db.commit()
    return user


def _manage_calls():
    from app.routers import orders
    from app.schemas import (CancelPendingRequest, ClosePositionRequest, ModifyPendingRequest,
                             ModifyPositionRequest)

    return [
        (orders.close_position, ClosePositionRequest(
            clientOrderId="m1", ticket=1, symbol="EURUSD", side="BUY", mt5Login="900001")),
        (orders.modify_position, ModifyPositionRequest(
            clientOrderId="m2", ticket=1, symbol="EURUSD", side="BUY", mt5Login="900001",
            stopLoss=1.0)),
        (orders.modify_pending_order, ModifyPendingRequest(
            clientOrderId="m3", ticket=1, symbol="EURUSD", mt5Login="900001", stopLoss=1.0)),
        (orders.cancel_pending_order, CancelPendingRequest(
            clientOrderId="m4", ticket=1, symbol="EURUSD", mt5Login="900001")),
    ]


def test_close_modify_cancel_refused_when_market_closed(db_session, gw, monkeypatch):
    user = _gw_user(db_session)
    _gate(monkeypatch, _closed)

    for fn, req in _manage_calls():
        with pytest.raises(HTTPException) as exc:
            fn.__wrapped__(request=None, req=req, user=user, db=db_session)
        assert exc.value.status_code == 409
        assert "休市" in exc.value.detail
    assert gw.calls == []
    assert db_session.query(Order).count() == 0


def test_close_allowed_on_a_close_only_symbol(db_session, gw, monkeypatch):
    from app.routers.orders import close_position
    from app.schemas import ClosePositionRequest

    user = _gw_user(db_session)
    _gate(monkeypatch, _close_only)
    req = ClosePositionRequest(clientOrderId="m5", ticket=1, symbol="EURUSD", side="BUY",
                               mt5Login="900001")
    out = close_position.__wrapped__(request=None, req=req, user=user, db=db_session)
    assert out.status == "FILLED"
    assert [c[0] for c in gw.calls] == ["gw_close"]


def test_bridge_account_close_is_not_gated(db_session, gw, monkeypatch):
    """桥接走 MT5 终端，休市当场被终端拒，不需要这一层。"""
    from app.routers.orders import close_position
    from app.schemas import ClosePositionRequest

    user = _gw_user(db_session, login="700001", source="bridge")
    _gate(monkeypatch, _closed)
    req = ClosePositionRequest(clientOrderId="m6", ticket=1, symbol="EURUSD", side="BUY",
                               mt5Login="700001")
    out = close_position.__wrapped__(request=None, req=req, user=user, db=db_session)
    assert out.status == "PENDING"


def test_gateway_execute_rejects_manage_actions_when_closed(db_session, gw, monkeypatch):
    """一键平仓 / 自动仓管不经路由闸门，直接进 try_gateway_execute：在那里落成 REJECTED。"""
    user = _gw_user(db_session)
    _gate(monkeypatch, _closed)
    order = Order(user_id=user.id, client_order_id="ca_x#900001#1", action="CLOSE",
                  symbol="EURUSD", side="BUY", volume=0.0, ticket=1, mt5_login="900001",
                  status="PENDING")
    db_session.add(order)
    db_session.commit()

    payload = gateway_execute.try_gateway_execute(db_session, order)
    assert payload is not None
    assert order.status == "REJECTED"
    assert "休市" in order.message
    assert gw.calls == []


def test_auto_manage_issues_nothing_while_closed(db_session, gw, pushes, monkeypatch):
    uid = _be_user(db_session)
    _gate(monkeypatch, _closed)

    assert evaluate_positions(db_session, uid, GatewayPositions([dict(_BE_ROW)])) == 0
    assert gw.calls == []
    assert _auto_modifies(db_session) == []
