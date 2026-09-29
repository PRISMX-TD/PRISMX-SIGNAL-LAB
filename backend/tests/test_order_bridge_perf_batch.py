"""2026-09-29 下单/平仓链路与桥接接口优化批次的回归测试。

覆盖：/bridge/result 先 ack 再后台推送、长轮询唤醒后只取指令、/poll 的 mt5_accounts
只查一次 + 心跳节流、wantQuotes、挂单快照并行读与 fire-and-forget、网关下单复用账号行
且不再多余 SELECT、auto_manage 空持仓提前返回、winrate / closed-trades 缓存与失效、
网关单超时不再误导「请重新下单」。
"""
import asyncio
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import BackgroundTasks
from sqlalchemy import event

from app.models import ClosedTrade, MT5Account, Order, User
from app.routers import bridge as bridge_router
from app.routers.bridge import BridgeAccount, BridgePollRequest, BridgeResultRequest
from app.services import bridge_wake, gateway_client, pending_orders

LOGIN = "80412337"


@pytest.fixture(autouse=True)
def _setup(monkeypatch):
    monkeypatch.setattr(
        bridge_router, "get_broker_settings",
        lambda db: {"broker_lock_enabled": False, "broker_patterns": []},
    )

    async def _inline(fn, *a, **k):
        return fn(*a, **k)

    # 内存 SQLite 是按线程的连接：线程池里看不到测试建的表，所以让 run_in_threadpool 内联执行。
    monkeypatch.setattr(bridge_router, "run_in_threadpool", _inline)

    async def _noop(*a, **k):
        return None

    monkeypatch.setattr(bridge_router.manager, "push_to_client", _noop)
    monkeypatch.setattr(bridge_router, "_last_pushed_online", {})
    monkeypatch.setattr(bridge_router, "_last_pushed_balances", {})
    monkeypatch.setattr(bridge_router, "_backfill_cache", {})
    monkeypatch.setattr(bridge_router, "_roster_cache", None)


def _user(db, uid="u-perf") -> User:
    user = User(id=uid, email=f"{uid}@t.local", api_token=f"tok-{uid}", plan="PRO")
    db.add(user)
    db.add(MT5Account(user_id=uid, login=LOGIN, server=None, source="bridge"))
    db.commit()
    return user


def _pending(db, user, coid, login=LOGIN):
    db.add(Order(
        user_id=user.id, client_order_id=coid, action="ORDER", symbol="XAUUSD",
        side="BUY", volume=0.01, mt5_login=login, status="PENDING",
    ))
    db.commit()


class _Sql:
    """记录执行过的 SQL。"""

    def __init__(self, engine):
        self.stmts: list[str] = []
        self._engine = engine

        def _before(conn, cursor, statement, *a):
            self.stmts.append(statement)

        event.listen(engine, "before_cursor_execute", _before)
        self._fn = _before

    def count(self, kind: str, table: str = "mt5_accounts") -> int:
        kind = kind.upper()
        return sum(
            1 for s in self.stmts
            if s.lstrip().upper().startswith(kind) and table in s
        )

    def close(self):
        event.remove(self._engine, "before_cursor_execute", self._fn)


# ---- 条目 3：/poll 的 mt5_accounts 只查一次 + 心跳节流 ----

def test_poll_reads_mt5_accounts_once_and_throttles_heartbeat(db_session):
    user = _user(db_session)
    _pending(db_session, user, "c-1")
    req = BridgePollRequest(accounts=[BridgeAccount(login=LOGIN)])
    sql = _Sql(db_session.get_bind())
    try:
        out = bridge_router._poll_db_work(db_session, user, req)
        assert [c["clientOrderId"] for c in out[0]] == ["c-1"]
        # 以前是 3+N 次；现在一次取全（含网关名单、绑定名单、逐账号 upsert 的查找）
        assert sql.count("SELECT") == 1
        row = db_session.query(MT5Account).filter_by(login=LOGIN).one()
        hb1 = row.last_heartbeat
        assert row.online and hb1 is not None

        # 紧接着再来一拍：心跳很新 → 不再 UPDATE mt5_accounts
        sql.stmts.clear()
        bridge_router._poll_db_work(db_session, user, req)
        assert sql.count("UPDATE") == 0
        db_session.expire_all()
        assert db_session.query(MT5Account).filter_by(login=LOGIN).one().last_heartbeat == hb1
    finally:
        sql.close()


def test_heartbeat_written_again_once_older_than_interval(db_session):
    user = _user(db_session)
    req = BridgePollRequest(accounts=[BridgeAccount(login=LOGIN)], fetchCommands=False)
    bridge_router._poll_db_work(db_session, user, req)
    row = db_session.query(MT5Account).filter_by(login=LOGIN).one()
    old = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(
        seconds=bridge_router.HEARTBEAT_WRITE_MIN_INTERVAL + 0.5
    )
    row.last_heartbeat = old
    db_session.commit()
    bridge_router._poll_db_work(db_session, user, req)
    db_session.expire_all()
    assert db_session.query(MT5Account).filter_by(login=LOGIN).one().last_heartbeat > old


def test_heartbeat_interval_leaves_safe_margin_under_online_window():
    from app.services.deps import ONLINE_WINDOW
    # 状态循环 1.5 秒一拍：写入间隔 ≈ 3 秒，再容忍连丢两拍 = 6 秒，必须 < 判离线窗口。
    assert bridge_router.HEARTBEAT_WRITE_MIN_INTERVAL <= 2.5
    assert 2 * 1.5 + 2 * 1.5 < ONLINE_WINDOW


def test_offline_row_is_always_written(db_session):
    user = _user(db_session)
    row = db_session.query(MT5Account).filter_by(login=LOGIN).one()
    row.online = False
    row.last_heartbeat = datetime.now(timezone.utc).replace(tzinfo=None)  # 很新，但标记离线
    db_session.commit()
    bridge_router._poll_db_work(
        db_session, user, BridgePollRequest(accounts=[BridgeAccount(login=LOGIN)], fetchCommands=False)
    )
    db_session.expire_all()
    assert db_session.query(MT5Account).filter_by(login=LOGIN).one().online is True


# ---- 条目 2：长轮询唤醒后只取指令 ----

def test_woken_long_poll_only_fetches_commands(db_session, monkeypatch):
    # 生产里 bridge 的 user 是鉴权缓存里 expunge 过的游离实例（字段已加载）；这里关掉
    # commit 后作废，模拟同样的状态。
    db_session.expire_on_commit = False
    user = _user(db_session)
    req = BridgePollRequest(accounts=[BridgeAccount(login=LOGIN)], waitSeconds=1.0)
    sql = _Sql(db_session.get_bind())
    seen = {}

    async def fake_wait(uid, timeout):
        # 挂起期间指令落库，随后被叫醒
        _pending(db_session, user, "c-wake")
        seen["before"] = len(sql.stmts)
        return True

    monkeypatch.setattr(bridge_wake, "wait", fake_wait)
    try:
        out = asyncio.run(bridge_router.bridge_poll(req, user, db_session))
    finally:
        sql.close()
    assert [c["clientOrderId"] for c in out["commands"]] == ["c-wake"]
    after = sql.stmts[seen["before"]:]
    # 唤醒之后没有再碰 mt5_accounts（不重复 SELECT / upsert / 心跳 UPDATE）
    touched = [s for s in after if "mt5_accounts" in s and "closed_trades" not in s]
    assert touched == []
    assert "wantQuotes" in out


# ---- 条目 10：wantQuotes ----

def test_want_quotes_local_client_and_single_process(monkeypatch):
    monkeypatch.setattr(bridge_router.shared_state, "enabled", lambda: False)
    monkeypatch.setattr(bridge_router.manager, "_clients", {})
    assert asyncio.run(bridge_router._want_quotes("u1")) is False
    monkeypatch.setattr(bridge_router.manager, "_clients", {"u1": {object()}})
    assert asyncio.run(bridge_router._want_quotes("u1")) is True


def test_want_quotes_uses_shared_roster_cached_and_fails_open(monkeypatch):
    monkeypatch.setattr(bridge_router.shared_state, "enabled", lambda: True)
    monkeypatch.setattr(bridge_router.manager, "_clients", {})
    reads = []

    async def roster():
        reads.append(1)
        return ["u-remote"]

    monkeypatch.setattr(bridge_router.manager, "connected_user_ids_async", roster)
    assert asyncio.run(bridge_router._want_quotes("u-remote")) is True
    assert asyncio.run(bridge_router._want_quotes("u-nobody")) is False
    assert len(reads) == 1, "名单 3 秒内只读一次，不是每次 poll 一次"

    async def boom():
        raise RuntimeError("redis down")

    monkeypatch.setattr(bridge_router, "_roster_cache", None)
    monkeypatch.setattr(bridge_router.manager, "connected_user_ids_async", boom)
    assert asyncio.run(bridge_router._want_quotes("u-nobody")) is True


# ---- 条目 1：/result 先 ack，推送走后台 ----

def test_bridge_result_acks_before_web_push(db_session, monkeypatch):
    user = _user(db_session)
    _pending(db_session, user, "c-res")
    pushed = []

    async def fake_event(uid, ev, title, body):
        pushed.append((uid, ev, title))

    monkeypatch.setattr(bridge_router, "dispatch_event_push_async", fake_event)
    ws = []

    async def fake_ws(uid, msg):
        ws.append(msg["type"])

    monkeypatch.setattr(bridge_router.manager, "push_to_client", fake_ws)

    bg = BackgroundTasks()
    req = BridgeResultRequest(clientOrderId="c-res", success=True, status="FILLED", mt5Ticket=5, filledPrice=1.0)
    out = asyncio.run(bridge_router.bridge_result(req, bg, user, db_session))
    assert out == {"ok": True}
    assert ws == ["ORDER_UPDATE"], "ORDER_UPDATE 的 WS 推送仍在响应之前"
    assert pushed == [], "Web Push 不能在 ack 之前发"
    assert len(bg.tasks) == 1

    asyncio.run(bg())
    assert len(pushed) == 1 and pushed[0][0] == user.id


def test_bridge_result_background_push_failure_is_swallowed(db_session, monkeypatch):
    user = _user(db_session)
    _pending(db_session, user, "c-res2")

    async def boom(*a, **k):
        raise RuntimeError("fcm down")

    monkeypatch.setattr(bridge_router, "dispatch_event_push_async", boom)
    bg = BackgroundTasks()
    req = BridgeResultRequest(clientOrderId="c-res2", success=False, status="REJECTED", message="x")
    asyncio.run(bridge_router.bridge_result(req, bg, user, db_session))
    asyncio.run(bg())  # 不抛


# ---- 条目 4：挂单快照并行读 / 任一失败整帧不推 / fire-and-forget ----

def test_push_gateway_pending_orders_reads_in_parallel_and_skips_on_failure(monkeypatch):
    running = {"now": 0, "max": 0}

    async def fake_read(login):
        running["now"] += 1
        running["max"] = max(running["max"], running["now"])
        await asyncio.sleep(0.05)
        running["now"] -= 1
        if login == "bad":
            return [], False
        return [{"ticket": int(login), "login": login}], True

    pushed = []

    async def fake_push(uid, rows, source):
        pushed.append(rows)

    monkeypatch.setattr(pending_orders, "read_gateway_pending_orders", fake_read)
    monkeypatch.setattr(pending_orders.manager, "push_pending_orders", fake_push)

    asyncio.run(pending_orders.push_gateway_pending_orders("u", ["1", "2", "3"]))
    assert running["max"] == 3, "多账号必须并行读"
    assert len(pushed) == 1 and len(pushed[0]) == 3

    pushed.clear()
    asyncio.run(pending_orders.push_gateway_pending_orders("u", ["1", "bad", "3"]))
    assert pushed == [], "任一失败整帧不推"

    async def raising(login):
        raise RuntimeError("boom")

    monkeypatch.setattr(pending_orders, "read_gateway_pending_orders", raising)
    asyncio.run(pending_orders.push_gateway_pending_orders("u", ["1", "2"]))
    assert pushed == [], "读取抛异常同样整帧不推、且不向外抛"


def test_submit_to_main_loop_returns_immediately_and_logs_failure(monkeypatch, caplog):
    import threading
    import time

    loop = asyncio.new_event_loop()
    t = threading.Thread(target=loop.run_forever, daemon=True)
    t.start()
    monkeypatch.setattr(gateway_client, "_main_loop", loop)
    gate = threading.Event()

    async def slow():
        await asyncio.sleep(0.3)
        gate.set()

    async def bad():
        raise RuntimeError("push exploded")

    try:
        t0 = time.monotonic()
        pending_orders.submit_to_main_loop(slow(), "slow")
        assert time.monotonic() - t0 < 0.2, "提交即返回，不等协程跑完"
        assert gate.wait(2)
        with caplog.at_level("ERROR", logger="prismx.gateway.router"):
            pending_orders.submit_to_main_loop(bad(), "bad-one")
            for _ in range(50):
                if any("bad-one" in r.getMessage() for r in caplog.records):
                    break
                time.sleep(0.05)
        assert any("bad-one" in r.getMessage() and "push exploded" in r.getMessage() for r in caplog.records)
    finally:
        loop.call_soon_threadsafe(loop.stop)
        t.join(2)
        loop.close()


# ---- 条目 5/6：网关执行复用账号行，成交后不再多余查询 ----

def _gw_env(db, monkeypatch):
    class _Stub:
        async def post(self, path, body, timeout=None):
            return {"ok": True, "retcode": "MT_RET_REQUEST_DONE", "deal": 11, "order": 22,
                    "position": 22, "price": 2000.0}

    monkeypatch.setattr(gateway_client, "_post", _Stub().post)
    monkeypatch.setattr(gateway_client, "_main_loop", None)
    db.add(User(id="ug", email="g@t.co", api_token="tok_g"))
    acc = MT5Account(user_id="ug", login="601144", server="", source="gateway", trade_mode=2)
    db.add(acc)
    o = Order(user_id="ug", mt5_login="601144", action="ORDER", symbol="XAUUSD", side="BUY",
              volume=0.1, status="PENDING", client_order_id="co_g")
    db.add(o)
    db.commit()
    return acc, o


def test_gateway_execute_with_supplied_account_skips_lookup_and_refresh(db_session, monkeypatch):
    from app.services import gateway_execute as gx

    _gw_env(db_session, monkeypatch)
    # 模拟调用方（place_order）已加载好的行
    acc = db_session.query(MT5Account).filter_by(login="601144").one()
    o = db_session.query(Order).filter_by(client_order_id="co_g").one()
    sql = _Sql(db_session.get_bind())
    try:
        payload = gx.try_gateway_execute(db_session, o, account=acc)
    finally:
        sql.close()
    assert payload["data"]["status"] == "FILLED"
    assert sql.count("SELECT") == 0, "带账号行时不再查 mt5_accounts，成交后也不再 refresh / 查 trade_mode"
    assert o.trade_mode == 2, "trade_mode 章取自已加载的账号行"
    # 没有 refresh 也是最终态，updated_at 保持不带时区的形状
    assert o.updated_at.tzinfo is None
    db_session.expire_all()
    assert db_session.query(Order).filter_by(client_order_id="co_g").one().status == "FILLED"


def test_gateway_execute_rechecks_supplied_account(db_session, monkeypatch):
    from app.services import gateway_execute as gx

    _, o = _gw_env(db_session, monkeypatch)
    bridge_acc = MT5Account(user_id="ug", login="601144", server="x", source="bridge")
    assert gx.try_gateway_execute(db_session, o, account=bridge_acc) is None
    other = MT5Account(user_id="someone-else", login="601144", server="", source="gateway")
    assert gx.try_gateway_execute(db_session, o, account=other) is None
    wrong_login = MT5Account(user_id="ug", login="999", server="", source="gateway")
    assert gx.try_gateway_execute(db_session, o, account=wrong_login) is None


# ---- 条目 7：auto_manage 空持仓提前返回 ----

def test_evaluate_positions_empty_table_touches_nothing(db_session, monkeypatch):
    from app.services import auto_manage

    def boom(*a, **k):
        raise AssertionError("空持仓不该抢锁/查用户")

    monkeypatch.setattr(auto_manage.shared_state, "try_lock", boom)
    monkeypatch.setattr(auto_manage, "_is_eligible", boom)
    assert auto_manage.evaluate_positions(db_session, "u1", []) == 0


# ---- 条目 8：winrate / closed-trades 缓存 ----

def _orders_user(db):
    u = User(id="uw", email="w@t.co", api_token="tok_w", plan="PRO")
    db.add(u)
    db.add(MT5Account(user_id="uw", login=LOGIN, server=None, source="bridge"))
    db.commit()
    return u


def test_closed_trades_and_winrate_cached_and_invalidated(db_session):
    from app.routers import orders as orders_router
    from app.services.trade_performance import invalidate_trade_caches

    db_session.expire_on_commit = False
    u = _orders_user(db_session)
    first = orders_router.list_closed_trades(user=u, db=db_session)
    assert first["trades"] == []
    w1 = orders_router.order_winrate(login=None, user=u, db=db_session)

    db_session.add(ClosedTrade(
        user_id="uw", mt5_login=LOGIN, symbol="XAUUSD", side="BUY", close_volume=0.1,
        close_price=1.0, profit=5.0, position_ticket=1, deal_ticket=1,
        closed_at=datetime.now(timezone.utc).replace(tzinfo=None),
    ))
    db_session.commit()

    sql = _Sql(db_session.get_bind())
    try:
        again = orders_router.list_closed_trades(user=u, db=db_session)
        assert again == first, "缓存命中：60 秒内看不到新行"
        assert orders_router.order_winrate(login=None, user=u, db=db_session) == w1
        assert sql.stmts == [], "命中缓存时零 DB 查询"
    finally:
        sql.close()

    invalidate_trade_caches("uw", [LOGIN])  # 新平仓落库会调用
    fresh = orders_router.list_closed_trades(user=u, db=db_session)
    assert len(fresh["trades"]) == 1 and fresh["trades"][0]["dealTicket"] == 1


def test_winrate_unknown_login_still_404_and_not_cached(db_session):
    from fastapi import HTTPException
    from app.routers import orders as orders_router

    u = _orders_user(db_session)
    for _ in range(2):
        with pytest.raises(HTTPException) as e:
            orders_router.order_winrate(login="000", user=u, db=db_session)
        assert e.value.status_code == 404


# ---- 条目 9：网关单超时不再说「已自动取消，请重下」 ----

def test_stale_gateway_order_gets_outcome_unknown_message(db_session):
    from app.services.order_payload import GATEWAY_STALE_ORDER_MESSAGE, STALE_ORDER_MESSAGE, void_stale_order
    from app.routers.orders import _gateway_login_pairs

    db_session.add(User(id="us", email="s@t.co", api_token="tok_s"))
    db_session.add(MT5Account(user_id="us", login="601144", server="", source="gateway"))
    db_session.add(MT5Account(user_id="us", login=LOGIN, server="", source="bridge"))
    old = datetime.now(timezone.utc) - timedelta(hours=1)
    og = Order(user_id="us", mt5_login="601144", action="ORDER", symbol="XAUUSD", side="BUY",
               volume=0.1, status="PENDING", client_order_id="a", created_at=old)
    ob = Order(user_id="us", mt5_login=LOGIN, action="ORDER", symbol="XAUUSD", side="BUY",
               volume=0.1, status="PENDING", client_order_id="b", created_at=old)
    db_session.add_all([og, ob])
    db_session.commit()
    pairs = _gateway_login_pairs(db_session, [og, ob])
    for o in (og, ob):
        void_stale_order(o, gateway=(o.user_id, o.mt5_login) in pairs)
    assert og.status == "FAILED" and og.message == GATEWAY_STALE_ORDER_MESSAGE
    assert "核对持仓" in og.message and "已自动取消" not in og.message
    assert ob.status == "FAILED" and ob.message == STALE_ORDER_MESSAGE
    assert _gateway_login_pairs(db_session, []) == set()


# ---- 条目 6：一笔下单只查一次 mt5_accounts（幂等预查保留） ----

def test_place_order_queries_accounts_once_for_gateway_order(db_session, monkeypatch):
    from app.routers import orders as orders_router
    from app.schemas import OrderRequest

    class _Stub:
        async def post(self, path, body, timeout=None):
            return {"ok": True, "retcode": "MT_RET_REQUEST_DONE", "deal": 11, "order": 22,
                    "position": 22, "price": 2000.0}

    monkeypatch.setattr(gateway_client, "_post", _Stub().post)
    monkeypatch.setattr(gateway_client, "_main_loop", None)
    monkeypatch.setattr(orders_router.manager, "push_to_client", lambda *a, **k: asyncio.sleep(0))
    monkeypatch.setattr("app.services.gateway_client.is_gateway_online", lambda: True)
    db_session.expire_on_commit = False
    db_session.add(User(id="up", email="p@t.co", api_token="tok_p", plan="PRO"))
    db_session.add(MT5Account(user_id="up", login="601144", server="", source="gateway", trade_mode=2))
    db_session.commit()
    user = db_session.query(User).filter_by(id="up").one()

    place = orders_router.place_order.__wrapped__
    sql = _Sql(db_session.get_bind())
    try:
        out = place(None, OrderRequest(symbol="XAUUSD", side="BUY", volume=0.01,
                                       clientOrderId="co-once", mt5Login="601144"), user, db_session)
    finally:
        sql.close()
    assert out.status == "FILLED"
    assert sql.count("SELECT") == 1, "归属校验 / 网关行 / trade_mode 都复用同一次账号查询"
    # 幂等预查仍在：同一 clientOrderId 重发直接返回已有订单
    again = place(None, OrderRequest(symbol="XAUUSD", side="BUY", volume=0.01,
                                     clientOrderId="co-once", mt5Login="601144"), user, db_session)
    assert again.id == out.id


def test_place_order_rejects_foreign_login_with_404(db_session):
    from fastapi import HTTPException
    from app.routers import orders as orders_router
    from app.schemas import OrderRequest

    db_session.add(User(id="up2", email="p2@t.co", api_token="tok_p2", plan="PRO"))
    db_session.commit()
    user = db_session.query(User).filter_by(id="up2").one()
    with pytest.raises(HTTPException) as e:
        orders_router.place_order.__wrapped__(
            None, OrderRequest(symbol="XAUUSD", side="BUY", volume=0.01,
                               clientOrderId="co-x", mt5Login="999999"), user, db_session)
    assert e.value.status_code == 404
