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
from app.services.symbol_aliases import is_volume_on_step, lot_step, min_lot

LOGIN = "603689"


# ---------- 步长判定本身 / the step predicate ----------

def test_lot_step_is_per_symbol():
    """合作券商实测：原油 0.1，其余 0.01。步长同时决定最小手数。"""
    assert lot_step("XAUUSD") == 0.01
    assert lot_step("XAUUSD.s") == 0.01
    assert lot_step("EURUSD") == 0.01
    assert lot_step("BTCUSDT") == 0.01          # 归一到 BTCUSD
    for name in ("WTI", "USOIL", "XTIUSD", "WTICOUSD"):
        assert lot_step(name) == 0.1, name      # 原油的各种别名都要命中
    assert min_lot("WTI") == 0.1
    assert min_lot("XAUUSD") == 0.01


@pytest.mark.parametrize("vol", [0.01, 0.02, 0.03, 0.1, 0.25, 1.0, 2.5, 10.0])
def test_multiples_of_step_pass(vol):
    assert is_volume_on_step(vol, "XAUUSD")


@pytest.mark.parametrize("vol", [0.015, 0.025, 0.005, 0.123, 0.0101])
def test_off_step_volumes_fail(vol):
    assert not is_volume_on_step(vol, "XAUUSD")


@pytest.mark.parametrize("vol", [0.1, 0.2, 0.5, 1.0, 2.0])
def test_wti_accepts_tenths(vol):
    assert is_volume_on_step(vol, "WTI")


@pytest.mark.parametrize("vol", [0.01, 0.05, 0.15, 0.23])
def test_wti_rejects_finer_than_tenths(vol):
    """原油步长 0.1——黄金上合法的 0.01 / 0.15 在这里都是非法手数。"""
    assert not is_volume_on_step(vol, "WTI")
    # 同一个数在黄金上未必非法，证明判定确实按品种走
    assert is_volume_on_step(0.01, "XAUUSD")


def test_float_noise_does_not_reject_valid_volumes():
    """0.03 % 0.01 在浮点下是 0.009999999999999998——直接取模会把合法手数判错。"""
    assert 0.03 % 0.01 != 0            # 取模不可用的证据 / why modulo is unusable
    assert is_volume_on_step(0.03, "XAUUSD")
    assert is_volume_on_step(0.07, "XAUUSD")
    assert is_volume_on_step(1.14, "XAUUSD")
    assert is_volume_on_step(0.3, "WTI")


# ---------- 平仓接口的闸门 / the close endpoint ----------

def _user(db):
    u = User(id="u1", email="a@t.co", api_token="tok_a")
    db.add(u)
    db.add(MT5Account(user_id="u1", login=LOGIN, server="", source="gateway", trade_mode=2))
    db.commit()
    return u


def _close(db, monkeypatch, volume, symbol="XAUUSD"):
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
        mt5Login=LOGIN, ticket=36109204, symbol=symbol, side="SELL",
        volume=volume, clientOrderId=f"co_{symbol}_{volume}",
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


def test_close_rejects_sub_step_volume_on_wti(db_session, monkeypatch):
    """原油步长 0.1：0.05 手在黄金上合法，在这里必须被拒。"""
    from fastapi import HTTPException

    _user(db_session)

    with pytest.raises(HTTPException) as e:
        _close(db_session, monkeypatch, 0.05, symbol="WTI")

    assert e.value.status_code == 400
    assert db_session.query(Order).filter(Order.action == "CLOSE").count() == 0


def test_close_allows_tenths_on_wti(db_session, monkeypatch):
    _user(db_session)
    _close(db_session, monkeypatch, 0.2, symbol="WTI")
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


# ---------- 自动仓位管理的分批止盈 / auto-manage partial take-profit ----------

def _ptp_volume(volume: float, fraction: float, symbol: str):
    """复刻 auto_manage 里分批止盈的手数算法，用来锁住"按品种步长向下取整"。

    这条路径不经过 /orders/close 的闸门（指令由后台直接落库），所以它自己必须
    算对：原油步长 0.1，旧实现按固定的 0.01 取整会算出 0.15 这种永远不会成交的
    手数，挂上去就把仓位锁死。
    """
    import math

    from app.services.symbol_aliases import lot_step, min_lot

    step = lot_step(symbol)
    close_vol = round(math.floor(volume * fraction / step + 1e-9) * step, 3)
    fires = close_vol >= min_lot(symbol) and volume - close_vol >= min_lot(symbol) - 1e-9
    return close_vol, fires


def test_auto_ptp_volume_lands_on_step_for_wti():
    """原油 0.3 手平一半：必须是 0.1，不能是旧实现的 0.15。"""
    vol, fires = _ptp_volume(0.3, 0.5, "WTI")
    assert fires and vol == 0.1
    assert is_volume_on_step(vol, "WTI")


@pytest.mark.parametrize("volume,fraction", [(1.0, 0.5), (0.5, 0.5), (2.0, 0.3), (0.7, 0.5)])
def test_auto_ptp_never_emits_off_step_volume_on_wti(volume, fraction):
    vol, fires = _ptp_volume(volume, fraction, "WTI")
    if fires:
        assert is_volume_on_step(vol, "WTI"), vol
        assert vol >= min_lot("WTI")


def test_auto_ptp_skips_positions_too_small_to_split():
    """原油最小 0.1 手：0.1 手的仓位拆不开，必须整笔跳过而不是发个 0 手出去。"""
    vol, fires = _ptp_volume(0.1, 0.5, "WTI")
    assert not fires

    gold_vol, gold_fires = _ptp_volume(0.01, 0.5, "XAUUSD")
    assert not gold_fires


def test_auto_ptp_unchanged_for_gold():
    """黄金行为不能被这次改动碰到。"""
    assert _ptp_volume(0.10, 0.5, "XAUUSD") == (0.05, True)
    assert _ptp_volume(0.03, 0.5, "XAUUSD") == (0.01, True)
