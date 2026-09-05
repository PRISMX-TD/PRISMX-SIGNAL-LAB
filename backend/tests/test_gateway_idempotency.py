"""网关开仓/平仓的幂等链路（后端侧）。

**为什么要测。** 网关等 dealer 回执最长 60 秒、后端 65 秒超时。超时后这笔单可能
已经成交；以前直接落 REJECTED，用户看到"失败"重下，真仓里就多一笔。现在：
  · 请求体带 clientOrderId（网关按它缓存 24 小时，重复只回放不重下）；
  · 超时或网关回 IN_PROGRESS → 用**同一个** clientOrderId 再问一次；
  · 第二问拿到结果 → 按结果落库；还是没有 → FAILED（不是 REJECTED），文案提示
    先核对持仓。

Backend half of the gateway idempotency path: clientOrderId rides on open/close,
a timeout or IN_PROGRESS triggers exactly one follow-up with the same id, and a
second unknown lands as FAILED with a "check positions" message.
"""
import pytest

from app.models import MT5Account, Order, User
from app.routers import orders as orders_mod
from app.services import gateway_client

LOGIN = "601144"


@pytest.fixture()
def stub(monkeypatch):
    """按调用顺序回不同响应的 _post 替身；记录每次 (path, body)。"""
    class _Stub:
        def __init__(self):
            self.calls: list[tuple[str, dict]] = []
            self.responses: list[dict] = []

        async def post(self, path, body, timeout=None):
            self.calls.append((path, dict(body)))
            if len(self.responses) > 1:
                return self.responses.pop(0)
            return dict(self.responses[0])

    s = _Stub()
    monkeypatch.setattr(gateway_client, "_post", s.post)
    monkeypatch.setattr(gateway_client, "_main_loop", None)   # run_on_main_loop → asyncio.run
    return s


def _order(db, action="ORDER", **kw):
    u = User(id="u1", email="a@t.co", api_token="tok_a"); db.add(u)
    db.add(MT5Account(user_id="u1", login=LOGIN, server="", source="gateway", trade_mode=2))
    o = Order(user_id="u1", mt5_login=LOGIN, action=action, symbol="XAUUSD", side="BUY",
              volume=0.1, status="PENDING", client_order_id="co_abc", ticket=kw.get("ticket"))
    db.add(o); db.commit()
    return o


OK = {"ok": True, "retcode": "MT_RET_REQUEST_DONE", "deal": 11, "order": 22, "position": 22, "price": 2000.0}
TIMEOUT = {"ok": False, "error": "timeout", "message": "Gateway 响应超时", "status": 0}


def test_open_and_close_carry_client_order_id(stub, db_session):
    stub.responses = [OK]
    o = _order(db_session)
    orders_mod._try_gateway_execute(db_session, o)
    assert len(stub.calls) == 1
    path, body = stub.calls[0]
    assert path == "/trade/open" and body["clientOrderId"] == "co_abc" and body["tag"] == "co_abc"
    assert o.status == "FILLED" and o.mt5_position == 22

    stub.calls.clear()
    c = Order(user_id="u1", mt5_login=LOGIN, action="CLOSE", symbol="XAUUSD", side="SELL",
              volume=0, status="PENDING", client_order_id="co_close", ticket=22)
    db_session.add(c); db_session.commit()
    orders_mod._try_gateway_execute(db_session, c)
    assert stub.calls[0][0] == "/trade/close" and stub.calls[0][1]["clientOrderId"] == "co_close"


def test_timeout_then_replay_fills_without_second_execution(stub, db_session):
    stub.responses = [TIMEOUT, dict(OK, replayed=True)]
    o = _order(db_session)
    orders_mod._try_gateway_execute(db_session, o)
    assert [p for p, _ in stub.calls] == ["/trade/open", "/trade/open"]
    assert stub.calls[0][1]["clientOrderId"] == stub.calls[1][1]["clientOrderId"] == "co_abc"
    assert o.status == "FILLED" and o.mt5_ticket == 22 and o.filled_price == 2000.0


def test_in_progress_then_result(stub, db_session):
    stub.responses = [
        {"ok": False, "retcode": "IN_PROGRESS", "message": "仍在执行", "replayed": True},
        {"ok": False, "retcode": "MT_RET_REQUEST_INVALID_STOPS", "message": "止损太近", "replayed": True},
    ]
    o = _order(db_session)
    orders_mod._try_gateway_execute(db_session, o)
    assert len(stub.calls) == 2
    assert o.status == "REJECTED" and "MT_RET_REQUEST_INVALID_STOPS" in o.message


def test_double_timeout_lands_failed_with_check_positions_hint(stub, db_session):
    stub.responses = [TIMEOUT, TIMEOUT]
    o = _order(db_session)
    orders_mod._try_gateway_execute(db_session, o)
    assert len(stub.calls) == 2                       # 只多问一次，不无限重试
    assert o.status == "FAILED"
    assert "GATEWAY_TIMEOUT" in o.message and "核对持仓" in o.message


def test_main_loop_timeout_is_treated_like_transport_timeout(stub, db_session, monkeypatch):
    calls = []
    real = orders_mod.run_on_main_loop

    def _flaky(coro, timeout):
        calls.append(timeout)
        if len(calls) == 1:
            coro.close()
            raise TimeoutError("主循环排队超时")
        return real(coro, timeout)

    monkeypatch.setattr(orders_mod, "run_on_main_loop", _flaky)
    stub.responses = [dict(OK, replayed=True)]
    o = _order(db_session)
    orders_mod._try_gateway_execute(db_session, o)
    assert len(calls) == 2 and calls[1] > calls[0]    # 第二问给的时限更长
    assert o.status == "FILLED"


def test_rejection_does_not_trigger_follow_up(stub, db_session):
    stub.responses = [{"ok": False, "retcode": "MT_RET_REQUEST_REJECT", "message": "no money"}]
    o = _order(db_session)
    orders_mod._try_gateway_execute(db_session, o)
    assert len(stub.calls) == 1 and o.status == "REJECTED"


def test_trade_rsp_parses_new_fields_with_old_gateway_defaults():
    old = gateway_client._trade_rsp({"ok": True, "retcode": "MT_RET_REQUEST_DONE", "deal": 1, "order": 2, "price": 1.0})
    assert old.replayed is False and old.error == "" and old.position == 0
    new = gateway_client._trade_rsp(dict(OK, replayed=True, error=None))
    assert new.replayed is True and new.error == ""


def test_gateway_account_lookup_is_scoped_to_the_ordering_user(stub, db_session):
    """两个用户绑同一登录号：A 的绑定已撤销，B 下单不能拿到 A 那一行来判断。"""
    from app.services.gateway_binding import REASON_PASSWORD_CHANGED, revoke
    stub.responses = [OK]
    o = _order(db_session)                                     # u1 正常绑定
    db_session.add(User(id="u2", email="b@t.co", api_token="tok_b"))
    revoked = MT5Account(user_id="u2", login=LOGIN, server="", source="gateway")
    db_session.add(revoked); db_session.commit()
    revoke(db_session, revoked, REASON_PASSWORD_CHANGED)

    assert orders_mod._gateway_account(db_session, LOGIN, "u2").revoked_at is not None
    assert orders_mod._gateway_account(db_session, LOGIN, "u1").revoked_at is None
    assert orders_mod._gateway_account(db_session, LOGIN, "nobody") is None

    orders_mod._try_gateway_execute(db_session, o)
    assert o.status == "FILLED" and len(stub.calls) == 1
