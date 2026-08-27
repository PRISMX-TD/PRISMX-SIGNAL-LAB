"""#10 把回执落库搬进线程池后，幂等判重从"先读状态再无条件写"改成了
"带条件的 UPDATE + 用受影响行数判定"。这是本次改造里唯一改了逻辑形状的地方，
所以单独覆盖：终态不被覆盖、非终态正常写入、判重标志正确。

Covers the idempotency rewrite in _result_db_work: the check moved into the
UPDATE's WHERE clause and is decided by the affected row count.
"""
from datetime import datetime, timezone

import pytest

from app.models import Order
from app.routers.bridge import BridgeResultRequest, _result_db_work


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


def _req(client_order_id: str, success: bool = True) -> BridgeResultRequest:
    return BridgeResultRequest(
        clientOrderId=client_order_id,
        success=success,
        mt5Ticket=12345,
        filledPrice=2400.5,
        message="ok",
    )


def test_pending_order_is_filled(db_session):
    """PENDING 回执正常写入，且不算重复。"""
    order = _mk_order(db_session, user_id=1, client_order_id="c-1", status="PENDING")

    got, duplicate = _result_db_work(db_session, 1, _req("c-1"))

    assert duplicate is False
    assert got is not None
    assert got.status == "FILLED"
    assert got.mt5_ticket == 12345
    assert got.filled_price == pytest.approx(2400.5)


def test_terminal_order_is_not_overwritten(db_session):
    """已是 FILLED 的订单不被迟到回执覆盖，且返回 duplicate=True。

    这正是幂等判重：改造前靠先读状态判断，现在靠 UPDATE 的 WHERE + rowcount。
    """
    order = _mk_order(db_session, user_id=1, client_order_id="c-2", status="FILLED")
    order.mt5_ticket = 999
    db_session.commit()

    got, duplicate = _result_db_work(
        db_session, 1, _req("c-2", success=False)  # 迟到的"被拒绝"回执
    )

    assert duplicate is True
    db_session.refresh(order)
    assert order.status == "FILLED", "终态不该被迟到回执改写"
    assert order.mt5_ticket == 999, "终态订单的成交单号不该被覆盖"


def test_rejected_order_is_also_terminal(db_session):
    """REJECTED 同样是终态，不被后续回执覆盖。"""
    order = _mk_order(db_session, user_id=1, client_order_id="c-3", status="REJECTED")

    got, duplicate = _result_db_work(db_session, 1, _req("c-3", success=True))

    assert duplicate is True
    db_session.refresh(order)
    assert order.status == "REJECTED"


def test_failed_order_can_be_corrected_by_late_result(db_session):
    """超时作废成 FAILED 的订单**允许**被真实回执纠正——实际执行结果为准。

    这条守的是既有行为：FAILED 不在终态集合里，迟到的真实回执应当覆盖它。
    """
    order = _mk_order(db_session, user_id=1, client_order_id="c-4", status="FAILED")

    got, duplicate = _result_db_work(db_session, 1, _req("c-4", success=True))

    assert duplicate is False
    assert got.status == "FILLED"


def test_missing_order_returns_none(db_session):
    """查不到订单时返回 (None, False)，由端点转成 404。"""
    got, duplicate = _result_db_work(db_session, 1, _req("does-not-exist"))

    assert got is None
    assert duplicate is False


def test_login_backfill_does_not_overwrite_existing(db_session):
    """兜底路由补账号：原本没有 mt5_login 的补上，已有的不覆盖。"""
    a = _mk_order(db_session, user_id=1, client_order_id="c-5", status="PENDING")
    b = _mk_order(db_session, user_id=1, client_order_id="c-6", status="PENDING")
    b.mt5_login = "111111"
    db_session.commit()

    req_a = BridgeResultRequest(
        clientOrderId="c-5", success=True, mt5Ticket=1, filledPrice=1.0, login="222222"
    )
    req_b = BridgeResultRequest(
        clientOrderId="c-6", success=True, mt5Ticket=2, filledPrice=1.0, login="333333"
    )

    got_a, _ = _result_db_work(db_session, 1, req_a)
    got_b, _ = _result_db_work(db_session, 1, req_b)

    assert got_a.mt5_login == "222222", "空的账号该被补上"
    assert got_b.mt5_login == "111111", "已指定的账号不该被覆盖"
