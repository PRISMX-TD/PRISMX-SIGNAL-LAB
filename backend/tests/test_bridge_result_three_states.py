"""桥接回执的三态契约。

背景：`BridgeResultRequest` 原来只有 `success: bool`，表达不了「不知道成没成」。
MT5 最常见的模糊结局恰恰是这一种——`order_send` 返回 TRADE_RETCODE_PLACED（券商
收单但还没成交）、返回 None、或者超时。老口径把 PLACED 当 success=True 落 FILLED，
于是平仓没真平时订单页显示「已平」而仓位还在；把「不知道」当 success=False 落
REJECTED，而 REJECTED 在界面上的意思是「已被拒绝，可以重下」——重下就可能变成双倍
仓位。

网关那条通道一直有 PLACED_UNCONFIRMED → FAILED（services/gateway_execute.py），
桥接这条没有，两条通道的状态机因此不一致。加 `status` 字段把它们对齐。

这些用例钉住的是**协议契约**，不是实现细节：
  1. 新桥接给什么状态就落什么状态；
  2. 老桥接（不带 status）仍按老口径工作，不被挡在门外；
  3. FAILED 不是终态——迟到的真结果仍能纠正它；
  4. FAILED 不打 trade_mode 章（打章等于断言已成交）。

The three-state contract for bridge receipts. See BridgeResultRequest.status in
app/routers/bridge.py for the full rationale.
"""
from datetime import datetime, timezone

import pytest

from app.models import Order
from app.routers.bridge import BridgeResultRequest, _result_db_work, _result_status


def _mk_order(db, user_id: int, client_order_id: str, status: str) -> Order:
    order = Order(
        user_id=user_id,
        client_order_id=client_order_id,
        action="OPEN",
        symbol="XAUUSD",
        side="BUY",
        volume=0.01,
        status=status,
        created_at=datetime.now(timezone.utc),
    )
    db.add(order)
    db.commit()
    db.refresh(order)
    return order


# ---- 映射本身 / the mapping ------------------------------------------------

def test_explicit_status_wins_over_success_flag():
    """新桥接给了 status 就以 status 为准，success 只是伴随字段。

    这条特意让两者矛盾（success=True 但 status=FAILED）：PLACED 之后二次确认没查到
    成交就是这个组合——单子确实发出去了（所以桥接侧的 success 语义为真），但成没成
    交不知道。以 status 为准才是对的。
    """
    req = BridgeResultRequest(clientOrderId="c-1", success=True, status="FAILED")
    assert _result_status(req) == "FAILED"


@pytest.mark.parametrize("status", ["FILLED", "REJECTED", "FAILED"])
def test_all_three_states_pass_through(status):
    req = BridgeResultRequest(clientOrderId="c-1", success=False, status=status)
    assert _result_status(req) == status


def test_legacy_bridge_without_status_falls_back():
    """不带 status 的老桥接必须继续工作（回落有损，但不能把人挡在门外）。"""
    assert _result_status(BridgeResultRequest(clientOrderId="c-1", success=True)) == "FILLED"
    assert _result_status(BridgeResultRequest(clientOrderId="c-1", success=False)) == "REJECTED"


def test_status_rejects_unknown_value():
    """status 是 Literal，拼错的值必须在入口就被拒，而不是悄悄落进 status 列。"""
    with pytest.raises(Exception):
        BridgeResultRequest(clientOrderId="c-1", success=False, status="UNCONFIRMED")


# ---- 落库行为 / persistence ------------------------------------------------

def test_failed_is_persisted_not_rejected(db_session):
    """FAILED 必须原样落库。

    这是整组用例的核心：只要它退回成 REJECTED，界面就会告诉用户「可以重下」，
    而这正是可能已经成交的那笔。
    """
    _mk_order(db_session, 1, "c-failed", "PENDING")

    got, duplicate = _result_db_work(
        db_session, 1,
        BridgeResultRequest(clientOrderId="c-failed", success=False, status="FAILED",
                            mt5Ticket=987654321, message="unconfirmed"),
    )

    assert duplicate is False
    assert got.status == "FAILED"
    # 票号在 FAILED 时也要留下：事后去 MT5 核对这张单到底成没成交，全靠它。
    assert got.mt5_ticket == 987654321


def test_failed_is_not_terminal_and_late_fill_corrects_it(db_session):
    """FAILED 之后迟到的真结果仍能改写成 FILLED。

    这正是 FAILED 与 REJECTED 的分野：REJECTED/FILLED 是终态（幂等判重挡住重复回执），
    FAILED 是「还不知道」，必须留着被纠正的余地。
    """
    _mk_order(db_session, 1, "c-late", "PENDING")

    _result_db_work(db_session, 1, BridgeResultRequest(
        clientOrderId="c-late", success=False, status="FAILED"))

    got, duplicate = _result_db_work(db_session, 1, BridgeResultRequest(
        clientOrderId="c-late", success=True, status="FILLED",
        mt5Ticket=42, filledPrice=2400.5))

    assert duplicate is False, "FAILED 不该被当成终态挡下"
    assert got.status == "FILLED"
    assert got.filled_price == pytest.approx(2400.5)


def test_rejected_stays_terminal(db_session):
    """对照组：REJECTED 是终态，迟到回执不覆盖（幂等判重照旧）。"""
    _mk_order(db_session, 1, "c-rej", "PENDING")

    _result_db_work(db_session, 1, BridgeResultRequest(
        clientOrderId="c-rej", success=False, status="REJECTED"))
    got, duplicate = _result_db_work(db_session, 1, BridgeResultRequest(
        clientOrderId="c-rej", success=True, status="FILLED"))

    assert duplicate is True
    assert got.status == "REJECTED"


def test_failed_does_not_stamp_trade_mode(db_session, monkeypatch):
    """FAILED 不打 trade_mode 章——打章等于断言这笔成交了，而这恰恰是未知的。

    trade_mode 是成交时从账号行拷的不可变快照（设计 §1.2），榜单与竞赛都按它判赛道。
    给一笔可能没成交的单打上章，等于把它放进了成绩单。
    """
    called = []

    def _spy(db, user_id, login):
        called.append(login)
        return 1

    monkeypatch.setattr("app.services.gamification.stamp.lookup_trade_mode", _spy)

    _mk_order(db_session, 1, "c-nostamp", "PENDING")
    got, _ = _result_db_work(db_session, 1, BridgeResultRequest(
        clientOrderId="c-nostamp", success=False, status="FAILED", login="500123"))

    assert got.status == "FAILED"
    assert called == [], "FAILED 不应触发 trade_mode 打章"
    assert got.trade_mode is None


def test_filled_still_stamps_trade_mode(db_session, monkeypatch):
    """对照组：FILLED 仍然打章，确认上一条不是把打章整个改坏了。"""
    monkeypatch.setattr("app.services.gamification.stamp.lookup_trade_mode",
                        lambda db, user_id, login: 1)

    _mk_order(db_session, 1, "c-stamp", "PENDING")
    got, _ = _result_db_work(db_session, 1, BridgeResultRequest(
        clientOrderId="c-stamp", success=True, status="FILLED", login="500123"))

    assert got.status == "FILLED"
    assert got.trade_mode == 1
