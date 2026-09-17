"""平仓手数步长闸门，以及「服务器收下了但没成交」的落库方式。

**为什么要测。** 2026-09-17 有用户对同一张黄金仓位连平 35 次、三个半小时平不掉，
最后爆仓。链路是这样的：一笔 0.015 手的部分平仓（黄金步长 0.01，不是整数倍）被
MT5 接受成一张**永远不会成交**的订单，dealer 只答 MT_RET_REQUEST_PLACED；网关把
PLACED 当成交，回执写「已平 0.015 手」，可那张订单就挂在仓位上，此后每一次平仓都被
MT_RET_REQUEST_CLOSE_ORDER_EXIST 挡下。

两道闸门各测一边：
  · 非整数倍手数根本发不出去（本文件的 step 部分）；
  · 真发出去了、网关确认没成交时，订单落 FAILED 而不是 FILLED，也不是 REJECTED
    ——它既不是成交也不是拒绝，文案要引导用户先核对持仓而不是重下。

Gate on the lot step, plus how an "accepted but never executed" close is recorded.
An off-step close is not rejected by MT5; it becomes an order that can never fill and
then blocks every later close on that position.
"""
import pytest

from app.core.config import settings
from app.models import MT5Account, Order, User
from app.services import gateway_client
from app.services import gateway_execute as gx
from app.services.deps import is_volume_on_step

LOGIN = "603689"


# ---------- 步长判定本身 / the step predicate ----------

@pytest.mark.parametrize("vol", [0.01, 0.02, 0.03, 0.1, 0.25, 1.0, 2.5, 10.0])
def test_multiples_of_step_pass(vol):
    assert is_volume_on_step(vol)


@pytest.mark.parametrize("vol", [0.015, 0.025, 0.005, 0.123, 0.0101])
def test_off_step_volumes_fail(vol):
    assert not is_volume_on_step(vol)


def test_float_noise_does_not_reject_valid_volumes():
    """0.03 % 0.01 在浮点下是 0.009999999999999998——直接取模会把合法手数判错。"""
    assert 0.03 % 0.01 != 0            # 取模不可用的证据 / why modulo is unusable
    assert is_volume_on_step(0.03)
    assert is_volume_on_step(0.07)
    assert is_volume_on_step(1.14)


# ---------- 平仓接口的闸门 / the close endpoint ----------

def _user(db):
    u = User(id="u1", email="a@t.co", api_token="tok_a")
    db.add(u)
    db.add(MT5Account(user_id="u1", login=LOGIN, server="", source="gateway", trade_mode=2))
    db.commit()
    return u


def _close(db, monkeypatch, volume):
    """直接调 /orders/close 的实现函数。

    本仓库的路由测试惯例是 service 级：Depends 全部按普通参数显式传进去，不起
    TestClient。限流器按 IP 计数，与本用例无关，临时关掉。
    """
    from app.core import rate_limit
    import app.routers.orders as orders

    monkeypatch.setattr(rate_limit.limiter, "enabled", False)
    # 闸门测的是"发不发得出去"，网关那一跳不参与。
    monkeypatch.setattr(orders, "_try_gateway_execute", lambda _db, _o: None)

    req = orders.ClosePositionRequest(
        mt5Login=LOGIN, ticket=36109204, symbol="XAUUSD", side="SELL",
        volume=volume, clientOrderId=f"co_{volume}",
    )
    return orders.close_position(request=None, req=req, user=db.get(User, "u1"), db=db)


def test_close_rejects_off_step_volume(db_session, monkeypatch):
    """0.015 手——正是把生产仓位锁死的那个手数——必须在下单之前就被拒。"""
    from fastapi import HTTPException

    _user(db_session)

    with pytest.raises(HTTPException) as e:
        _close(db_session, monkeypatch, 0.015)

    assert e.value.status_code == 400
    assert "整数倍" in e.value.detail or "multiple" in e.value.detail
    # 没有留下任何待执行指令 / nothing was queued
    assert db_session.query(Order).filter(Order.action == "CLOSE").count() == 0


def test_close_allows_full_close_with_zero_volume(db_session, monkeypatch):
    """全平用 0 表示，不受步长限制：仓位自身的手数必然合法。"""
    _user(db_session)
    _close(db_session, monkeypatch, 0)
    assert db_session.query(Order).filter(Order.action == "CLOSE").count() == 1


def test_close_allows_on_step_partial(db_session, monkeypatch):
    """0.02 手是合法的部分平仓，闸门不能误伤。"""
    _user(db_session)
    _close(db_session, monkeypatch, 0.02)
    assert db_session.query(Order).filter(Order.action == "CLOSE").count() == 1


# ---------- 「收下了但没成交」的落库 / the unconfirmed outcome ----------

def test_placed_unconfirmed_lands_failed_not_filled(monkeypatch, db_session):
    """网关确认平仓没成交时，订单不能是 FILLED，也不该是 REJECTED。"""
    async def _post(path, body, timeout=None):
        return {
            "ok": False,
            "retcode": gx.PLACED_UNCONFIRMED,
            "message": "平仓请求已被服务器接受,但未在确认时限内成交,仓位手数没有变化。",
        }

    monkeypatch.setattr(gateway_client, "_post", _post)
    monkeypatch.setattr(gateway_client, "_main_loop", None)

    _user(db_session)
    o = Order(user_id="u1", mt5_login=LOGIN, action="CLOSE", symbol="XAUUSD",
              side="SELL", volume=0, status="PENDING", client_order_id="co_x",
              ticket=36109204)
    db_session.add(o)
    db_session.commit()

    gx.try_gateway_execute(db_session, o)

    assert o.status == "FAILED"
    assert o.status != "REJECTED"
    assert gx.PLACED_UNCONFIRMED in o.message
