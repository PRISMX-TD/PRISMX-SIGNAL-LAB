"""券商已回执、写库时连接池却排不上：不能把订单记成 FAILED（2026-10-10 压测发现）。

压测里 250 笔以上同时下单时，46 笔券商已成交的单因为写回那一步等满 DB_POOL_TIMEOUT，
落进 try_gateway_execute 的异常分支被改成 FAILED、成交号丢失。约定：
1. 写回遇到连接池超时就重试，最终按券商的真实结果落库；
2. 重试用尽后，异常分支用真实结果再写一次，而不是写 FAILED；
3. 连那一次也写不进去：不碰数据库，用快照回一帧 FAILED（界面语义「先核对持仓」），文案带成交号。

When the broker has answered but the pool has no connection for the write-back, the
order must not become FAILED: retry, then record the real outcome in the except branch,
and only if even that fails answer from a snapshot with the deal number.
"""
import pytest
from sqlalchemy.exc import DBAPIError
from sqlalchemy.exc import TimeoutError as PoolTimeoutError

from app.models import MT5Account, Order, User
from app.services import gateway_client
from app.services import gateway_execute as gx

LOGIN = "601177"
OK = {"ok": True, "retcode": "MT_RET_REQUEST_DONE", "deal": 31, "order": 42, "position": 42, "price": 2001.5}


@pytest.fixture()
def gateway_ok(monkeypatch):
    async def post(path, body, timeout=None):
        return dict(OK)

    monkeypatch.setattr(gateway_client, "_post", post)
    monkeypatch.setattr(gateway_client, "_main_loop", None)


def _order(db):
    db.add(User(id="u1", email="a@t.co", api_token="tok_a"))
    db.add(MT5Account(user_id="u1", login=LOGIN, server="", source="gateway", trade_mode=2))
    o = Order(user_id="u1", mt5_login=LOGIN, action="ORDER", symbol="XAUUSD", side="BUY",
              volume=0.1, status="PENDING", client_order_id="co_retry")
    db.add(o)
    db.commit()
    return o


def _pool_timeout():
    return PoolTimeoutError("QueuePool limit of size 8 overflow 4 reached")


def _server_dropped():
    # 数据库端掐断连接：SQLAlchemy 包成 DBAPIError 并标 connection_invalidated
    # A server-side disconnect: SQLAlchemy wraps it as DBAPIError with connection_invalidated
    return DBAPIError("SELECT 1", {}, Exception("server closed the connection unexpectedly"),
                      connection_invalidated=True)


def _flaky_status_query(db, monkeypatch, failures, make_exc=_pool_timeout):
    """让写回第一步那条 SELECT（Order.status, Order.message）前 failures 次抛 make_exc()。
    Make the write-back's first SELECT raise make_exc() `failures` times."""
    real_query = db.query
    left = {"n": failures}

    def query(*entities, **kw):
        # 用 is 比：列属性的 == 会生成 SQL 表达式 / compare by identity: == on columns builds SQL
        is_status_read = len(entities) == 2 and entities[0] is Order.status and entities[1] is Order.message
        if is_status_read and left["n"] > 0:
            left["n"] -= 1
            raise make_exc()
        return real_query(*entities, **kw)

    monkeypatch.setattr(db, "query", query)
    return left


@pytest.mark.parametrize("make_exc", [_pool_timeout, _server_dropped], ids=["pool-timeout", "server-dropped"])
def test_write_back_failure_is_retried(gateway_ok, db_session, monkeypatch, make_exc):
    o = _order(db_session)
    _flaky_status_query(db_session, monkeypatch, failures=1, make_exc=make_exc)
    payload = gx.try_gateway_execute(db_session, o)
    assert payload["data"]["status"] == "FILLED"
    row = db_session.query(Order).filter_by(client_order_id="co_retry").one()
    assert row.status == "FILLED" and row.mt5_ticket == 42 and row.mt5_position == 42
    assert row.trade_mode == 2, "trade_mode 章用调网关前记下的账号值"


def test_other_errors_still_record_failed(gateway_ok, db_session, monkeypatch):
    """不是连接类的错误（比如数据本身写不进去）照旧落 FAILED，行为不变。
    A non-connection error keeps the old behaviour: FAILED."""
    o = _order(db_session)
    _flaky_status_query(db_session, monkeypatch, failures=1, make_exc=lambda: ValueError("bad value"))
    payload = gx.try_gateway_execute(db_session, o)
    assert payload["data"]["status"] == "FAILED"


def test_retries_exhausted_still_records_the_real_outcome(gateway_ok, db_session, monkeypatch):
    o = _order(db_session)
    _flaky_status_query(db_session, monkeypatch, failures=99)
    payload = gx.try_gateway_execute(db_session, o)
    assert payload["data"]["status"] == "FILLED", "券商已成交，绝不能落 FAILED"
    row = db_session.query(Order).filter_by(client_order_id="co_retry").one()
    assert row.status == "FILLED" and row.mt5_ticket == 42


def test_database_gone_answers_from_snapshot_with_deal_number(gateway_ok, db_session, monkeypatch):
    o = _order(db_session)
    _flaky_status_query(db_session, monkeypatch, failures=99)

    def commit_fails():
        raise PoolTimeoutError("still no connection")

    # 异常分支里的那次补写也写不进去 / the last-ditch write fails too
    real_rollback = db_session.rollback
    calls = {"rollbacks": 0}

    def rollback():
        calls["rollbacks"] += 1
        real_rollback()
        if calls["rollbacks"] >= 2:  # 重试的回滚之后，补写阶段的 commit 开始失败
            monkeypatch.setattr(db_session, "commit", commit_fails)

    monkeypatch.setattr(db_session, "rollback", rollback)
    payload = gx.try_gateway_execute(db_session, o)
    assert payload["data"]["status"] == "FAILED"
    assert "31" in payload["data"]["message"], "文案要带成交号，便于用户核对"
    assert payload["data"]["clientOrderId"] == "co_retry"
    # 调用方随后会 _serialize(order)：此时数据库仍不可用，读的必须全是内存。会话关掉后再读，
    # 只要有一个字段需要回库就会抛 DetachedInstanceError。
    # Callers then _serialize(order) while the DB is still unavailable: everything must come
    # from memory. Reading after closing the session raises if any field needs the DB.
    from app.services.order_payload import serialize_order
    db_session.close()
    out = serialize_order(o)
    assert out.status == "FAILED" and out.clientOrderId == "co_retry" and "31" in (out.message or "")
