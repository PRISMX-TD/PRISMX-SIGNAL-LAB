"""2026-11-16 下单 / 平仓 / 改单提速：数据库往返从每笔 19 次降到 10 次，一键平仓不再逐笔重读。

每一条往返在生产上约 4 毫秒（Supabase 新加坡），所以这里钉的是**语句条数**，不是耗时：
  · 落库后不再 refresh 订单，用户与账号行也不再因为提交而各重读一次；
  · gateway 指令落库时就带着「已下发」，调网关前不再单独 UPDATE + COMMIT；
  · 平仓 / 改单一笔只查一次 mt5_accounts（原来归属、休市闸门、网关执行各查一次）；
  · 成交后推持仓要用的账号列表不在下单响应的路上查；
  · 一键平仓：落库不逐笔重读；后台执行整批只准备一次，每笔只剩写回结果。
同时钉住不能变的东西：桥接指令不能被提前标成已下发、本地拒掉的指令不带已下发、响应里的
时间仍是不带时区的。

Trade-path speed-up: 19 database round trips per trade down to 10, and close-all no
longer re-reads each leg. A round trip is ~4ms in production, so these tests pin the
statement counts, plus what must not change: bridge commands are never pre-marked
delivered, locally refused commands carry no delivered mark, and response timestamps
stay timezone-naive.
"""
import asyncio
import threading
from datetime import datetime, timezone

import pytest
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker

from app.core.config import settings
from app.models import MT5Account, Order, User
from app.services import close_all, gateway_client, gateway_execute, market_hours
from app.services.gateway_client import TradeRsp

GW = "601144"
BRIDGE = "80412337"
OK = {"ok": True, "retcode": "MT_RET_REQUEST_DONE", "deal": 11, "order": 22, "position": 33,
      "price": 3300.5}


class _Sql:
    """记录某个引擎上执行过的 SQL（线程安全：list.append 是原子的）。"""

    def __init__(self, engine):
        self.stmts: list[str] = []

        def _before(conn, cursor, statement, *a):
            self.stmts.append(" ".join(statement.split()))

        event.listen(engine, "before_cursor_execute", _before)

    def count(self, kind: str, needle: str) -> int:
        kind = kind.upper()
        return sum(1 for s in self.stmts if s.upper().startswith(kind) and needle in s)


@pytest.fixture()
def gateway(monkeypatch):
    """只替换发往网关的 HTTP；真实的下单路由与 try_gateway_execute 完整跑一遍。"""
    import app.routers.orders as orders
    from app.services.connection_manager import manager

    calls: list[tuple[str, dict]] = []

    async def _post(path, body, timeout=None):
        calls.append((path, body))
        return dict(OK)

    monkeypatch.setattr(gateway_client, "_post", _post)
    monkeypatch.setattr(gateway_client, "is_gateway_online", lambda: True)
    # 关的是路由模块手里那个限流器对象：test_limiter_shared_storage 会 reload
    # app.core.rate_limit，之后 rate_limit.limiter 已经是另一个对象了。
    # Disable the router's own limiter object: test_limiter_shared_storage reloads
    # app.core.rate_limit, after which rate_limit.limiter is a different object.
    monkeypatch.setattr(orders.limiter, "enabled", False)
    monkeypatch.setattr(manager, "find_position_shared", lambda *a, **k: None)

    pushed: list[dict] = []

    async def _push(user_id, payload):
        pushed.append(payload)

    monkeypatch.setattr(manager, "push_to_client", _push)
    calls_and_pushes = type("G", (), {})()
    calls_and_pushes.calls = calls
    calls_and_pushes.pushed = pushed
    return calls_and_pushes


def _user(db, *, revoked=False) -> User:
    user = User(id="u1", email="a@t.co", api_token="tok_a", plan="PRO")
    db.add(user)
    db.add(MT5Account(user_id="u1", login=BRIDGE, server="MC-Live", source="bridge"))
    db.add(MT5Account(
        user_id="u1", login=GW, server="MC-Demo", source="gateway", equity=10000.0,
        revoked_at=datetime.now(timezone.utc) if revoked else None,
    ))
    db.commit()
    # 提交会把 user 作废；像鉴权那样先读一遍，后面数语句时不把这次算进去。
    # The commit expired the user; load it as auth would, before statements are counted.
    assert user.plan == "PRO"
    return user


def _open(db, user, login=GW, cid="co_open"):
    import app.routers.orders as orders

    return orders.place_order(
        request=None,
        req=orders.OrderRequest(clientOrderId=cid, symbol="XAUUSD", side="BUY", volume=0.01,
                                mt5Login=login, orderType="MARKET"),
        user=user, db=db,
    )


def _close(db, user, login=GW, cid="co_close"):
    import app.routers.orders as orders

    return orders.close_position(
        request=None,
        req=orders.ClosePositionRequest(clientOrderId=cid, symbol="XAUUSD", side="BUY",
                                        ticket=33, mt5Login=login),
        user=user, db=db,
    )


# ---------- 单笔：开仓 / single trades: open ----------

def test_open_costs_five_statements_and_two_commits(db_session, gateway):
    """开仓：查账号、查幂等、INSERT、读回原状态、UPDATE 结果——就这 5 条。
    没有 refresh、没有提交后的重读、没有单独的 delivered UPDATE、没有成交后的账号查询。"""
    user = _user(db_session)
    sql = _Sql(db_session.get_bind())
    commits: list[int] = []
    event.listen(db_session.get_bind(), "commit", lambda conn: commits.append(1))

    out = _open(db_session, user)

    assert out.status == "FILLED" and len(gateway.calls) == 1
    assert sql.count("SELECT", "FROM users") == 0
    assert sql.count("SELECT", "FROM mt5_accounts") == 1
    assert sql.count("INSERT", "INTO orders") == 1
    assert sql.count("UPDATE", "orders") == 1
    assert len(sql.stmts) == 5, sql.stmts
    assert len(commits) == 2


def test_gateway_order_is_stored_already_delivered(db_session, gateway):
    """gateway 指令落库即「已下发」：撤单接口从第一刻起就拦得住它。"""
    user = _user(db_session)
    sql = _Sql(db_session.get_bind())
    out = _open(db_session, user)

    # 标记是随 INSERT 写进去的，不是事后单独 UPDATE / written by the INSERT itself
    assert sql.count("UPDATE", "SET delivered=") == 0
    db_session.expire_all()
    row = db_session.query(Order).filter(Order.id == out.id).one()
    assert row.delivered is True and row.delivered_at is not None


def test_bridge_order_is_not_marked_delivered(db_session, gateway, monkeypatch):
    """桥接指令绝不能提前标：桥接轮询只下发「未下发」的指令，标了它就永远发不出去。"""
    user = _user(db_session)
    db_session.query(MT5Account).filter(MT5Account.login == BRIDGE).update(
        {MT5Account.last_heartbeat: datetime.now(timezone.utc)}
    )
    db_session.commit()
    assert user.plan == "PRO"

    out = _open(db_session, user, login=BRIDGE)

    assert out.status == "PENDING" and gateway.calls == []
    row = db_session.query(Order).filter(Order.id == out.id).one()
    assert not row.delivered and row.delivered_at is None


def test_response_timestamps_stay_naive(db_session, gateway):
    """响应里的时间必须和原来 refresh 之后一样不带时区：前端按 UTC 解析这种串，
    带上 +00:00 是另一种形状。成交单与只是收下的桥接单都要一致。"""
    user = _user(db_session)
    filled = _open(db_session, user)
    assert filled.createdAt.tzinfo is None and filled.updatedAt.tzinfo is None
    for frame in gateway.pushed:
        if frame.get("type") == "ORDER_UPDATE":
            assert "+" not in frame["data"]["createdAt"] and "+" not in frame["data"]["updatedAt"]

    queued = _open(db_session, user, login=BRIDGE, cid="co_bridge")
    assert queued.createdAt.tzinfo is None and queued.updatedAt.tzinfo is None


def test_placing_a_pending_order_reuses_the_account_list(db_session, gateway, monkeypatch):
    """挂单挂出后要重推一帧挂单快照，用的账号列表就是下单时查到的那一份，不再查第二次。"""
    import app.routers.orders as orders

    user = _user(db_session)
    seen: list[tuple] = []

    async def _snapshot(user_id, logins, **kw):
        seen.append((user_id, list(logins)))

    monkeypatch.setattr(orders, "push_gateway_pending_orders", _snapshot)
    sql = _Sql(db_session.get_bind())

    out = orders.place_order(
        request=None,
        req=orders.OrderRequest(clientOrderId="co_limit", symbol="XAUUSD", side="BUY", volume=0.01,
                                mt5Login=GW, orderType="LIMIT", price=3000.0),
        user=user, db=db_session,
    )

    assert out.status == "PLACED" and gateway.calls[0][0] == "/trade/pending"
    assert seen == [("u1", [GW])]
    assert sql.count("SELECT", "FROM mt5_accounts") == 1
    assert len(sql.stmts) == 5, sql.stmts


# ---------- 单笔：平仓 / 改单 / single trades: manage ----------

def test_close_loads_the_account_row_once_with_the_gate_on(db_session, gateway, monkeypatch):
    """休市闸门开着（生产就是这样）时，平仓原来查 3 次 mt5_accounts：归属、闸门、网关执行。"""
    user = _user(db_session)
    monkeypatch.setattr(settings, "MARKET_HOURS_GATE", True)
    monkeypatch.setattr(market_hours, "closed_for_manage", lambda symbol, login=None: None)
    sql = _Sql(db_session.get_bind())

    out = _close(db_session, user)

    assert out.status == "FILLED"
    assert gateway.calls[0][0] == "/trade/close"
    assert sql.count("SELECT", "FROM mt5_accounts") == 1
    assert sql.count("SELECT", "FROM users") == 0
    assert len(sql.stmts) == 5, sql.stmts


def test_close_on_a_bridge_account_still_queues_for_the_bridge(db_session, gateway):
    """把查到的账号行交给网关执行不能把桥接指令也发去网关。"""
    user = _user(db_session)
    out = _close(db_session, user, login=BRIDGE)

    assert out.status == "PENDING" and gateway.calls == []
    row = db_session.query(Order).filter(Order.id == out.id).one()
    assert not row.delivered


def test_local_rejection_clears_the_early_delivered_mark(db_session, gateway):
    """绑定已撤销：指令没发出去就被拒，落库时提前标的「已下发」必须撤回。"""
    user = _user(db_session, revoked=True)
    out = _close(db_session, user)

    assert out.status == "REJECTED" and gateway.calls == []
    row = db_session.query(Order).filter(Order.id == out.id).one()
    assert not row.delivered and row.delivered_at is None


# ---------- 成交后的持仓推送 / the post-fill positions push ----------

@pytest.fixture()
def main_loop(monkeypatch):
    """一条真在跑的事件循环，冒充服务进程的主循环。"""
    loop = asyncio.new_event_loop()
    thread = threading.Thread(target=loop.run_forever, daemon=True)
    thread.start()
    monkeypatch.setattr(gateway_client, "_main_loop", loop)
    yield loop
    loop.call_soon_threadsafe(loop.stop)
    thread.join(timeout=5)
    loop.close()


def _filled_close(user_id="u1") -> Order:
    return Order(id="o1", user_id=user_id, client_order_id="c1", action="CLOSE", symbol="XAUUSD",
                 side="BUY", volume=0.0, mt5_login=GW, status="FILLED")


def _rsp(positions=None) -> TradeRsp:
    return TradeRsp(ok=True, retcode="MT_RET_REQUEST_DONE", message="", deal=1, order=2,
                    price=1.0, positions=positions)


def test_post_fill_push_uses_the_logins_it_is_given(db_session, main_loop, monkeypatch):
    """调用方给了账号列表：不查库，直接推。"""
    from app.services import gateway_snapshot

    done = threading.Event()
    seen: list[tuple] = []

    async def _push(user_id, logins, known=None):
        seen.append((user_id, list(logins), known))
        done.set()

    monkeypatch.setattr(gateway_snapshot, "push_positions_now", _push)
    sql = _Sql(db_session.get_bind())

    gateway_execute._after_gateway_result(db_session, _filled_close(), _rsp([]), [GW])

    assert done.wait(5)
    assert seen == [("u1", [GW], {GW: []})]
    assert sql.stmts == []


def test_post_fill_push_with_no_gateway_logins_does_nothing(db_session, main_loop, monkeypatch):
    from app.services import gateway_snapshot

    async def _push(*a, **k):  # pragma: no cover —— 被调用就是失败 / must not run
        raise AssertionError("不该推 / must not push")

    monkeypatch.setattr(gateway_snapshot, "push_positions_now", _push)
    gateway_execute._after_gateway_result(db_session, _filled_close(), _rsp(), [])


def test_post_fill_push_looks_logins_up_off_the_request_session(tmp_path, main_loop, monkeypatch):
    """没给账号列表（平仓 / 改单）：在推送协程里另开会话查，下单请求的会话一条语句都不发。"""
    import app.core.database as database
    import app.models  # noqa: F401
    from app.core.database import Base
    from app.services import gateway_snapshot

    engine = create_engine(f"sqlite:///{tmp_path / 'p.db'}", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine, autocommit=False, autoflush=False)
    monkeypatch.setattr(database, "SessionLocal", Session)
    db = Session()
    _user(db)
    db.close()

    done = threading.Event()
    seen: list[tuple] = []

    async def _push(user_id, logins, known=None):
        seen.append((user_id, list(logins), known))
        done.set()

    monkeypatch.setattr(gateway_snapshot, "push_positions_now", _push)

    request_db = Session()
    request_thread = threading.get_ident()
    lookups: list[int] = []
    event.listen(engine, "before_cursor_execute",
                 lambda *a: lookups.append(threading.get_ident()))
    try:
        gateway_execute._after_gateway_result(request_db, _filled_close(), _rsp())
        assert done.wait(5)
    finally:
        request_db.close()
        engine.dispose()

    assert seen == [("u1", [GW], None)]
    # 查了一次，而且不在发起下单的这条线程上 / one lookup, not on the request's thread
    assert len(lookups) == 1 and lookups[0] != request_thread


# ---------- 一键平仓 / close-all ----------

def _pos(ticket, login=GW):
    return {"ticket": ticket, "symbol": "XAUUSD", "side": "BUY", "volume": 0.1, "profit": 1.0,
            "entryPrice": 3300.0, "currentPrice": 3301.0, "stopLoss": 0.0, "takeProfit": 0.0,
            "login": login}


def test_close_all_queue_does_not_reread_each_leg(db_session):
    """落库后原来每笔一条 SELECT（48 笔 0.28 秒，期间一笔都没发出去）。语句数不随笔数变。"""
    from app.services.order_payload import serialize_order

    _user(db_session)
    sql = _Sql(db_session.get_bind())
    _batch, created, skipped = close_all.queue(
        db_session, "u1", "co_q", None, [_pos(5000 + i) for i in range(12)]
    )

    assert (len(created), skipped) == (12, 0)
    assert sql.count("SELECT", "WHERE orders.id =") == 0
    assert sql.count("INSERT", "INTO orders") == 1
    after_commit = len(sql.stmts)
    # 组响应要读的字段都在内存里，时间不带时区 / everything the response reads is loaded
    for o in created:
        out = serialize_order(o)
        assert out.status == "PENDING" and out.createdAt.tzinfo is None
    assert len(sql.stmts) == after_commit


@pytest.fixture()
def file_db(tmp_path, monkeypatch):
    """后台批次每笔一条线程、各开会话：要用文件库，内存 SQLite 的连接不跨线程。"""
    import app.core.database as database
    import app.models  # noqa: F401
    from app.core.database import Base
    from app.services import shared_state

    engine = create_engine(
        f"sqlite:///{tmp_path / 'ca.db'}", connect_args={"check_same_thread": False, "timeout": 30}
    )
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine, autocommit=False, autoflush=False)
    monkeypatch.setattr(database, "SessionLocal", Session)
    monkeypatch.setattr("app.services.push_dispatch.dispatch_event_push", lambda *a, **k: None)
    shared_state.reset_for_tests()
    yield Session, engine
    shared_state.reset_for_tests()
    engine.dispose()


def _queue(Session, count):
    db = Session()
    _user(db)
    batch, created, _ = close_all.queue(db, "u1", "co_b", None, [_pos(7000 + i) for i in range(count)])
    ids = [o.id for o in created]
    db.close()
    return batch, ids


def test_gateway_batch_prepares_once_and_each_leg_only_writes_its_result(file_db, gateway):
    """整批：订单一次查完、账号一次查完、「已下发」一条 UPDATE 标完；每笔只剩「读原状态 +
    写结果」两条。原来每笔还要查订单、查账号、UPDATE delivered、再查一次账号列表。"""
    Session, engine = file_db
    batch, ids = _queue(Session, 6)
    sql = _Sql(engine)

    close_all.execute_gateway_batch("u1", batch, ids)

    assert len(gateway.calls) == 6 and {c[0] for c in gateway.calls} == {"/trade/close"}
    assert sql.count("SELECT", "FROM mt5_accounts") == 1
    assert sql.count("UPDATE", "SET delivered=") == 1
    assert sql.count("SELECT orders.status AS orders_status, orders.message", "") == 6
    assert sql.count("UPDATE", "SET status=") == 6
    # 整行读订单只有两次：准备阶段一次、汇总推送一次 / whole rows: preparation + summary
    assert sql.count("SELECT orders.id AS orders_id", "") == 2

    check = Session()
    rows = close_all.batch_orders(check, "u1", batch)
    check.close()
    assert all(o.status == "FILLED" and o.delivered and o.mt5_ticket == 22 for o in rows)
    # 每笔一帧 ORDER_UPDATE，时间不带时区 / one ORDER_UPDATE per leg, naive timestamps
    updates = [f for f in gateway.pushed if f.get("type") == "ORDER_UPDATE"]
    assert len(updates) == 6
    assert all("+" not in f["data"]["updatedAt"] for f in updates)


def test_gateway_batch_passes_the_gateway_logins_to_every_leg(file_db, gateway, monkeypatch):
    """成交后推持仓用的账号列表由批次准备阶段给出，每笔不再各查一次。"""
    Session, _engine = file_db
    batch, ids = _queue(Session, 3)
    seen: list[tuple] = []
    real = gateway_execute._try_gateway_execute

    def _spy(db, order, account, admitted, logins=None):
        seen.append((account.login if account is not None else None, logins))
        return real(db, order, account, admitted, logins)

    monkeypatch.setattr(gateway_execute, "_try_gateway_execute", _spy)
    close_all.execute_gateway_batch("u1", batch, ids)

    assert seen == [(GW, [GW])] * 3


def test_gateway_batch_skips_a_leg_that_is_no_longer_pending(file_db, gateway):
    """准备阶段只取仍是 PENDING 的指令：已经有结果的那笔不会再发一次。"""
    Session, _engine = file_db
    batch, ids = _queue(Session, 3)
    db = Session()
    db.query(Order).filter(Order.id == ids[1]).update({Order.status: "FILLED"})
    db.commit()
    db.close()

    close_all.execute_gateway_batch("u1", batch, ids)

    assert len(gateway.calls) == 2
    sent = {c[1]["ticket"] for c in gateway.calls}
    assert sent == {7000, 7002}


def test_gateway_batch_survives_a_failed_preparation(file_db, gateway, monkeypatch):
    """准备阶段出错（数据库一时连不上）不能让后台任务抛出去：指令留在 PENDING，交给超时兜底。"""
    Session, _engine = file_db
    batch, ids = _queue(Session, 2)

    def _boom(*a, **k):
        raise RuntimeError("db down")

    monkeypatch.setattr(close_all, "_prepare_gateway_legs", _boom)
    close_all.execute_gateway_batch("u1", batch, ids)

    assert gateway.calls == []
    check = Session()
    assert all(o.status == "PENDING" for o in close_all.batch_orders(check, "u1", batch))
    check.close()
