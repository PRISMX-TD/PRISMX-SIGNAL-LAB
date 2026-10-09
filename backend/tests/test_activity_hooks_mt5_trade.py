"""操作日志埋点（设计 2026-10-09 §4.2）第一组之二：一键平仓与结果更正。

  · close_all.queue → 每个账号一行 trade.close_all（ref_id = 批次号，data {count, skipped}，
    去重键 ca:<user>:<批次>:<login>）；什么都没排下去 / 同一 clientOrderId 重放不写；并发重放
    的输家照旧在子单唯一约束上失败，日志只留赢家那一行；业务提交失败日志一起作废。
  · trade.corrected（提交后单独写，系统事件，corrected_key 去重）：
      网关 try_gateway_execute —— 等回执期间订单被作废 / 撤回（FAILED / CANCELLED），结果却
      是成交 → 记一条；正常 PENDING → 成交、结果是拒绝、走异常分支都不写；日志写失败不能
      把成交改回 FAILED。
      桥接 _result_db_work —— 原状态在 UPDATE 之前取；抢占成功且原状态 FAILED / CANCELLED、
      新状态成交才记；重复回执、PENDING → 成交、FAILED → 拒绝都不写。
  · 稳态路径（正常成交）一条 activity_events 语句都不发。

文件库：record_after_commit 自己开连接，内存库每个连接都是空库。

Activity-log hooks, group 1b: close-all and result corrections.
"""
import logging

import pytest
from sqlalchemy import create_engine, event, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import sessionmaker

from app.core.database import Base
import app.models  # noqa: F401  —— 注册模型 / registers the tables
from app.models import MT5Account, Order, User
from app.routers.bridge import BridgeResultRequest, _result_db_work
from app.services import activity_log as al
from app.services import close_all
from app.services import gateway_client
from app.services import gateway_execute as gx
from app.services.order_payload import GATEWAY_STALE_ORDER_MESSAGE, STALE_ORDER_MESSAGE

BRIDGE_LOGIN = "80412337"
OTHER_LOGIN = "80412338"
GW_LOGIN = "601144"


@pytest.fixture()
def engine(tmp_path):
    url = "sqlite:///" + str(tmp_path / "hooks_trade.db").replace("\\", "/")
    eng = create_engine(url, connect_args={"check_same_thread": False})
    Base.metadata.create_all(eng)
    yield eng
    eng.dispose()


@pytest.fixture()
def Session(engine):
    return sessionmaker(bind=engine, autocommit=False, autoflush=False)


@pytest.fixture()
def db(Session):
    s = Session()
    yield s
    s.close()


def _events(engine, kind: str | None = None) -> list[dict]:
    sql = ("SELECT kind, actor_type, actor_id, user_id, mt5_login, ref_id, data, dedupe_key "
           "FROM activity_events")
    params = {}
    if kind:
        sql += " WHERE kind = :k"
        params["k"] = kind
    with engine.connect() as conn:
        rows = conn.execute(text(sql + " ORDER BY created_at, id"), params).mappings().all()
    out = []
    for r in rows:
        d = dict(r)
        d["data"] = al.decode_data(d["data"])
        out.append(d)
    return out


class _Stmts:
    def __init__(self, engine):
        self.stmts: list[str] = []
        self._engine = engine

        def _before(conn, cursor, statement, *a):
            self.stmts.append(statement)

        event.listen(engine, "before_cursor_execute", _before)
        self._fn = _before

    def activity(self) -> list[str]:
        return [s for s in self.stmts if "activity_events" in s]

    def close(self):
        event.remove(self._engine, "before_cursor_execute", self._fn)


def _user(db) -> User:
    u = User(id="u1", email="a@t.co", api_token="tok_a")
    db.add(u)
    db.add(MT5Account(user_id="u1", login=BRIDGE_LOGIN, server="MC-Live", source="bridge"))
    db.add(MT5Account(user_id="u1", login=OTHER_LOGIN, server="MC-Live", source="bridge"))
    db.add(MT5Account(user_id="u1", login=GW_LOGIN, server="", source="gateway", trade_mode=2))
    db.commit()
    return u


def _pos(ticket, *, login=BRIDGE_LOGIN, symbol="XAUUSD", side="BUY"):
    return {"ticket": ticket, "symbol": symbol, "side": side, "volume": 0.1, "login": login}


# ─────────────────────────────────────────────────────────────────────────────
# 一键平仓 / close_all.queue
# ─────────────────────────────────────────────────────────────────────────────

def test_close_all_writes_one_row_per_account(db, engine):
    _user(db)
    # 4002 已有一条在途全平 → 跳过 1 笔 / one position already has a close in flight
    db.add(Order(user_id="u1", client_order_id="co_prev", action="CLOSE", symbol="XAUUSD",
                 side="BUY", volume=0.0, ticket=4002, mt5_login=OTHER_LOGIN, status="PENDING"))
    db.commit()
    batch, created, skipped = close_all.queue(
        db, "u1", "co_x1", None,
        [_pos(1001), _pos(1002), _pos(4001, login=OTHER_LOGIN), _pos(4002, login=OTHER_LOGIN)],
    )
    assert len(created) == 3 and skipped == 1

    evs = _events(engine)
    assert [e["kind"] for e in evs] == [al.TRADE_CLOSE_ALL] * 2
    by_login = {e["mt5_login"]: e for e in evs}
    assert set(by_login) == {BRIDGE_LOGIN, OTHER_LOGIN}
    for login, count in ((BRIDGE_LOGIN, 2), (OTHER_LOGIN, 1)):
        ev = by_login[login]
        assert (ev["actor_type"], ev["actor_id"], ev["user_id"]) == ("user", "u1", "u1")
        assert ev["ref_id"] == batch == "ca_co_x1"
        assert ev["data"] == {"count": count, "skipped": 1}
        assert ev["dedupe_key"] == f"ca:u1:ca_co_x1:{login}"


def test_close_all_written_in_login_order(monkeypatch, db, engine):
    _user(db)
    seen: list = []
    real = al.log_events

    def _spy(db_, events):
        seen.extend(ev["mt5_login"] for ev in events)
        return real(db_, events)

    monkeypatch.setattr(al, "log_events", _spy)
    close_all.queue(db, "u1", "co_x2", None,
                    [_pos(4001, login=OTHER_LOGIN), _pos(1001), _pos(7001, login=GW_LOGIN)])
    assert seen == sorted(seen) == [GW_LOGIN, BRIDGE_LOGIN, OTHER_LOGIN]
    assert sorted(e["mt5_login"] for e in _events(engine)) == seen


def test_close_all_logs_every_account_in_one_insert(db, engine):
    """几个账号的日志一次写完：一条 activity_events INSERT、一个 SAVEPOINT，不随账号数增加
    （原来每个账号各一遍 SAVEPOINT + INSERT + RELEASE，全排在放出平仓的那次 commit 前面）。
    All accounts in one statement: one activity_events INSERT and one SAVEPOINT,
    instead of SAVEPOINT + INSERT + RELEASE per account ahead of the commit."""
    _user(db)
    stmts = _Stmts(engine)
    try:
        close_all.queue(db, "u1", "co_x10", None,
                        [_pos(1001), _pos(1002), _pos(4001, login=OTHER_LOGIN)])
        inserts = [s for s in stmts.activity() if s.lstrip().upper().startswith("INSERT")]
        savepoints = [s for s in stmts.stmts if s.lstrip().upper().startswith("SAVEPOINT")]
    finally:
        stmts.close()
    assert len(inserts) == 1 and len(stmts.activity()) == 1
    assert len(savepoints) == 1
    evs = _events(engine)
    assert {e["mt5_login"]: e["data"]["count"] for e in evs} == {BRIDGE_LOGIN: 2, OTHER_LOGIN: 1}


def test_close_all_loginless_positions_use_empty_login_key(db, engine):
    _user(db)
    close_all.queue(db, "u1", "co_x3", None, [{"ticket": 9001, "symbol": "XAUUSD", "side": "BUY"}])
    [ev] = _events(engine)
    assert ev["mt5_login"] is None and ev["dedupe_key"] == "ca:u1:ca_co_x3:"


def test_close_all_nothing_queued_or_replay_writes_nothing(db, engine):
    _user(db)
    assert close_all.queue(db, "u1", "co_x4", None, [])[1] == []          # 没持仓
    close_all.queue(db, "u1", "co_x5", None, [_pos(1001)])
    assert len(_events(engine)) == 1
    _, created, skipped = close_all.queue(db, "u1", "co_x5", None, [_pos(1001)])   # 重放
    assert created == [] and skipped == 1
    assert len(_events(engine)) == 1


def test_close_all_top_up_of_same_batch_adds_no_row(db, engine):
    """同一批次后来又补排了一笔（重放时多出来一张仓位）：同一账号不会多出第二行。"""
    _user(db)
    close_all.queue(db, "u1", "co_x6", None, [_pos(1001)])
    _, created, _ = close_all.queue(db, "u1", "co_x6", None, [_pos(1001), _pos(1002)])
    assert [o.ticket for o in created] == [1002]
    [ev] = _events(engine)
    assert ev["data"]["count"] == 1


def test_close_all_concurrent_replay_loses_on_orders_and_logs_once(monkeypatch, Session, engine):
    """同一 clientOrderId 的两个请求同时到：输家照旧在子单唯一约束上失败（异常类型不变），
    日志只留赢家那一行。
    Two concurrent requests with one clientOrderId: the loser still fails on the
    children's unique constraint (same exception type) and only the winner's row stays."""
    a, b = Session(), Session()
    _user(a)
    real = close_all.batch_orders
    state = {"raced": False}

    def _racing(db_, user_id, batch):
        rows = real(db_, user_id, batch)
        if db_ is b and not state["raced"]:
            # B 已经查过「这一批还没有子单」，在它写入前让 A 整批落库。
            state["raced"] = True
            close_all.queue(a, "u1", "co_x7", None, [_pos(1001), _pos(1002)])
        return rows

    monkeypatch.setattr(close_all, "batch_orders", _racing)
    with pytest.raises(IntegrityError):
        close_all.queue(b, "u1", "co_x7", None, [_pos(1001), _pos(1002)])
    b.rollback()
    assert state["raced"] is True
    [ev] = _events(engine)
    assert ev["data"] == {"count": 2, "skipped": 0}
    assert a.query(Order).filter(Order.client_order_id.like("ca_co_x7#%")).count() == 2
    a.close()
    b.close()


def test_close_all_rolled_back_with_the_business(monkeypatch, db, engine):
    _user(db)
    real_commit = db.commit

    def _failing_commit():
        raise RuntimeError("commit failed")

    monkeypatch.setattr(db, "commit", _failing_commit)
    with pytest.raises(RuntimeError):
        close_all.queue(db, "u1", "co_x8", None, [_pos(1001)])
    db.rollback()
    monkeypatch.setattr(db, "commit", real_commit)
    assert _events(engine) == []
    assert db.query(Order).filter(Order.client_order_id.like("ca_co_x8#%")).count() == 0


def test_close_all_survives_log_composition_error(monkeypatch, db, engine, caplog):
    _user(db)

    def _boom(*a, **k):
        raise RuntimeError("key boom")

    monkeypatch.setattr(al, "close_all_key", _boom)
    with caplog.at_level(logging.WARNING):
        _, created, _ = close_all.queue(db, "u1", "co_x9", None, [_pos(1001)])
    assert len(created) == 1 and created[0].id
    assert db.query(Order).filter(Order.client_order_id.like("ca_co_x9#%")).count() == 1
    assert _events(engine) == []
    assert "close-all activity skipped" in caplog.text


# ─────────────────────────────────────────────────────────────────────────────
# 结果更正：网关 / gateway (try_gateway_execute)
# ─────────────────────────────────────────────────────────────────────────────

OK = {"ok": True, "retcode": "MT_RET_REQUEST_DONE", "deal": 11, "order": 22, "position": 22,
      "price": 2000.0}
REJECT = {"ok": False, "retcode": "MT_RET_REQUEST_REJECT", "message": "rejected"}


def _gw_order(db) -> Order:
    _user(db)
    o = Order(user_id="u1", mt5_login=GW_LOGIN, action="ORDER", symbol="XAUUSD", side="BUY",
              volume=0.1, status="PENDING", client_order_id="co_gw")
    db.add(o)
    db.commit()
    return o


def _gateway(monkeypatch, Session, order_id, response, *, flip_to=None, flip_message=None):
    """_post 替身：可选在「等回执」期间用另一个会话把订单改成 flip_to（超时作废 / 撤回），
    flip_message 是作废时一起写的 message。
    A _post stub that can flip the order's status (and message) from another
    session mid-wait."""

    async def post(path, body, timeout=None):
        if flip_to is not None:
            other = Session()
            try:
                values = {"status": flip_to}
                if flip_message is not None:
                    values["message"] = flip_message
                other.query(Order).filter(Order.id == order_id).update(
                    values, synchronize_session=False)
                other.commit()
            finally:
                other.close()
        return dict(response)

    monkeypatch.setattr(gateway_client, "_post", post)
    monkeypatch.setattr(gateway_client, "_main_loop", None)


@pytest.mark.parametrize("was", ["FAILED", "CANCELLED"])
def test_gateway_fill_after_void_records_correction(monkeypatch, Session, db, engine, was):
    o = _gw_order(db)
    _gateway(monkeypatch, Session, o.id, OK, flip_to=was)
    payload = gx.try_gateway_execute(db, o)
    assert o.status == "FILLED" and payload is not None

    [ev] = _events(engine)
    assert ev["kind"] == al.TRADE_CORRECTED
    assert ev["actor_type"] == "system" and ev["actor_id"] is None
    assert ev["user_id"] == "u1" and ev["mt5_login"] == GW_LOGIN and ev["ref_id"] == o.id
    assert ev["dedupe_key"] == f"corrected:{o.id}"
    assert ev["data"] == {"was": was, "note": None, "action": "ORDER", "sym": "XAUUSD",
                          "side": "BUY", "vol": 0.1, "px": 2000.0, "at": al.iso_utc(o.created_at)}


@pytest.mark.parametrize("message, note", [
    (GATEWAY_STALE_ORDER_MESSAGE, "timeout_unknown"),   # 直连超时作废：告诉用户「结果未知」
    (STALE_ORDER_MESSAGE, "timeout"),                   # 桥接文案：告诉用户「已自动取消」
    ("broker said no", None),
])
def test_gateway_correction_note_comes_from_the_voided_message(monkeypatch, Session, db, engine,
                                                               message, note):
    """note 取作废时写进库里的 message（同一条状态 SELECT 顺带读出），不是 apply_trade_result
    覆写之后内存里的那句。
    The note comes from the message the void stored (read by the same status
    SELECT), not the one apply_trade_result has overwritten in memory."""
    o = _gw_order(db)
    _gateway(monkeypatch, Session, o.id, OK, flip_to="FAILED", flip_message=message)
    stmts = _Stmts(engine)
    try:
        gx.try_gateway_execute(db, o)
        status_reads = [s for s in stmts.stmts
                        if " ".join(s.split()).startswith("SELECT orders.status AS orders_status")]
    finally:
        stmts.close()
    assert o.status == "FILLED"
    # 还是原来那一条状态 SELECT，顺带取 message / still the one status SELECT, plus message
    assert len(status_reads) == 1 and "orders.message" in status_reads[0]
    [ev] = _events(engine)
    assert ev["data"]["was"] == "FAILED" and ev["data"]["note"] == note


def test_gateway_normal_fill_issues_no_activity_statement(monkeypatch, Session, db, engine):
    o = _gw_order(db)
    _gateway(monkeypatch, Session, o.id, OK)
    stmts = _Stmts(engine)
    try:
        gx.try_gateway_execute(db, o)
    finally:
        stmts.close()
    assert o.status == "FILLED"
    assert stmts.activity() == []
    assert _events(engine) == []


def test_gateway_reject_after_void_is_not_a_correction(monkeypatch, Session, db, engine):
    o = _gw_order(db)
    _gateway(monkeypatch, Session, o.id, REJECT, flip_to="FAILED")
    gx.try_gateway_execute(db, o)
    assert o.status == "REJECTED"
    assert _events(engine) == []


def test_gateway_exception_branch_writes_nothing(monkeypatch, Session, db, engine):
    o = _gw_order(db)
    _gateway(monkeypatch, Session, o.id, OK, flip_to="FAILED")

    def _boom(order, rsp):
        raise RuntimeError("apply boom")

    monkeypatch.setattr(gx, "apply_trade_result", _boom)
    gx.try_gateway_execute(db, o)
    assert o.status == "FAILED"
    assert _events(engine) == []


def test_gateway_correction_log_failure_keeps_the_fill(monkeypatch, Session, db, engine, caplog):
    """日志写失败绝不能落进异常分支、把刚提交的成交改回 FAILED。
    A failing log write must never reach the except branch and undo the fill."""
    o = _gw_order(db)
    _gateway(monkeypatch, Session, o.id, OK, flip_to="FAILED")

    def _boom(*a, **k):
        raise RuntimeError("log boom")

    monkeypatch.setattr(al, "record_after_commit", _boom)
    with caplog.at_level(logging.WARNING):
        payload = gx.try_gateway_execute(db, o)
    assert o.status == "FILLED" and payload["data"]["status"] == "FILLED"
    db.expire_all()
    assert db.get(Order, o.id).status == "FILLED"
    assert _events(engine) == []
    assert "correction activity skipped" in caplog.text


def test_gateway_correction_dedupes_with_other_paths(monkeypatch, Session, db, engine):
    o = _gw_order(db)
    al.record_after_commit(al.TRADE_CORRECTED, user_id="u1", mt5_login=GW_LOGIN, ref_id=o.id,
                           data={"was": "FAILED"}, dedupe_key=al.corrected_key(o.id), bind=db)
    _gateway(monkeypatch, Session, o.id, OK, flip_to="FAILED")
    gx.try_gateway_execute(db, o)
    assert len(_events(engine, al.TRADE_CORRECTED)) == 1


# ─────────────────────────────────────────────────────────────────────────────
# 结果更正：桥接 / bridge (_result_db_work)
# ─────────────────────────────────────────────────────────────────────────────

def _br_order(db, status, coid="c-1") -> Order:
    if db.get(User, "u1") is None:
        _user(db)
    o = Order(user_id="u1", client_order_id=coid, action="CLOSE", symbol="EURUSD", side="SELL",
              volume=0.0, ticket=5001, mt5_login=BRIDGE_LOGIN, status=status)
    db.add(o)
    db.commit()
    return o


def _result(coid="c-1", *, status="FILLED", volume=None, login=None, price=1.2345):
    return BridgeResultRequest(clientOrderId=coid, success=status == "FILLED", status=status,
                               mt5Ticket=777, filledPrice=price, volume=volume, login=login,
                               message="done")


@pytest.mark.parametrize("was", ["FAILED", "CANCELLED"])
def test_bridge_late_fill_records_correction(db, engine, was):
    o = _br_order(db, was)
    created_at = o.created_at
    got, duplicate = _result_db_work(db, "u1", _result(volume=0.05))
    assert duplicate is False and got.status == "FILLED"

    [ev] = _events(engine)
    assert ev["kind"] == al.TRADE_CORRECTED and ev["actor_type"] == "system"
    assert ev["ref_id"] == o.id and ev["user_id"] == "u1" and ev["mt5_login"] == BRIDGE_LOGIN
    assert ev["dedupe_key"] == f"corrected:{o.id}"
    # 手数 / 价格是这次回执写进去的新值，at 是原指令的下单时间
    assert ev["data"] == {"was": was, "note": None, "action": "CLOSE", "sym": "EURUSD",
                          "side": "SELL", "vol": 0.05, "px": 1.2345, "at": al.iso_utc(created_at)}


@pytest.mark.parametrize("message, note", [
    (STALE_ORDER_MESSAGE, "timeout"),                   # 桥接超时作废：当时说「已自动取消，请重新下单」
    (GATEWAY_STALE_ORDER_MESSAGE, "timeout_unknown"),
    ("bridge reported failure", None),
])
def test_bridge_correction_note_says_what_the_user_was_told(db, engine, message, note):
    """桥接超时作废后真实回执迟到成交：更正行带 note，页面才能说「原记为已自动取消」而不是
    「结果未知」。note 按 UPDATE 覆写 message 之前的那句判。
    A bridge timeout void later filled: the correction carries the note so the page
    can say "was auto-cancelled" rather than "outcome unknown", judged from the
    message before the UPDATE overwrote it."""
    o = _br_order(db, "FAILED")
    o.message = message
    db.commit()
    got, _ = _result_db_work(db, "u1", _result())
    assert got.status == "FILLED" and got.message == "done"
    [ev] = _events(engine)
    assert ev["data"]["was"] == "FAILED" and ev["data"]["note"] == note


def test_bridge_correction_carries_reported_login(db, engine):
    o = _br_order(db, "FAILED")
    o.mt5_login = None                                   # 兜底路由的单 / fallback-routed
    db.commit()
    _result_db_work(db, "u1", _result(login=OTHER_LOGIN))
    [ev] = _events(engine)
    assert ev["mt5_login"] == OTHER_LOGIN and ev["data"]["vol"] == 0.0


def test_bridge_pending_fill_issues_no_activity_statement(db, engine):
    _br_order(db, "PENDING")
    stmts = _Stmts(engine)
    try:
        got, duplicate = _result_db_work(db, "u1", _result())
    finally:
        stmts.close()
    assert got.status == "FILLED" and duplicate is False
    assert stmts.activity() == []
    assert _events(engine) == []


def test_bridge_failed_then_rejected_is_not_a_correction(db, engine):
    _br_order(db, "FAILED")
    got, _ = _result_db_work(db, "u1", _result(status="REJECTED"))
    assert got.status == "REJECTED"
    assert _events(engine) == []


def test_bridge_replayed_result_writes_once(db, engine):
    _br_order(db, "FAILED")
    _result_db_work(db, "u1", _result())
    got, duplicate = _result_db_work(db, "u1", _result())      # 重复回执 / duplicate ack
    assert duplicate is True
    assert len(_events(engine)) == 1


def test_bridge_terminal_order_is_not_claimed_and_writes_nothing(db, engine):
    _br_order(db, "REJECTED")
    _, duplicate = _result_db_work(db, "u1", _result())
    assert duplicate is True
    assert _events(engine) == []


def test_bridge_correction_dedupes_with_other_paths(db, engine):
    o = _br_order(db, "FAILED")
    al.record_after_commit(al.TRADE_CORRECTED, user_id="u1", mt5_login=BRIDGE_LOGIN, ref_id=o.id,
                           data={"was": "FAILED"}, dedupe_key=al.corrected_key(o.id), bind=db)
    _result_db_work(db, "u1", _result())
    assert len(_events(engine, al.TRADE_CORRECTED)) == 1


def test_bridge_correction_log_failure_keeps_the_result(monkeypatch, db, engine, caplog):
    _br_order(db, "FAILED")

    def _boom(*a, **k):
        raise RuntimeError("log boom")

    monkeypatch.setattr(al, "record_after_commit", _boom)
    with caplog.at_level(logging.WARNING):
        got, duplicate = _result_db_work(db, "u1", _result())
    assert got.status == "FILLED" and duplicate is False
    assert _events(engine) == []
    assert "correction activity skipped" in caplog.text


def test_bridge_correction_data_error_keeps_the_result(monkeypatch, db, engine):
    """data 组装出错（这里让时间转换抛）：record_correction 自己吞掉，回执照常落库。
    A data-composition error is swallowed by record_correction; the result stands."""
    _br_order(db, "FAILED")

    def _boom(dt):
        raise RuntimeError("iso boom")

    monkeypatch.setattr(al, "iso_utc", _boom)
    got, duplicate = _result_db_work(db, "u1", _result())
    assert got.status == "FILLED" and duplicate is False
    assert _events(engine) == []


def test_correction_helpers_never_raise(db, engine):
    """快照拿不到字段返回 None；None 快照、不可更正的状态都什么都不做。
    A snapshot of a broken object is None; None snapshots and non-correctable
    statuses are no-ops."""
    assert gx.correction_snapshot(object()) is None
    assert gx.correction_note(None) is None and gx.correction_note("") is None
    gx.record_correction(None, was="FAILED", now="FILLED", bind=db)
    snap = {"id": "x", "user_id": "u1", "mt5_login": "1", "action": "ORDER", "sym": "X",
            "side": "BUY", "vol": 1.0, "px": 1.0, "created_at": None}
    gx.record_correction(snap, was="PENDING", now="FILLED", bind=db)
    gx.record_correction(snap, was="FAILED", now="FAILED", bind=db)
    gx.record_correction(snap, was="CANCELLED", now="REJECTED", bind=db)
    assert _events(engine) == []
    gx.record_correction(snap, was="FAILED", now="PLACED", bind=db)     # 挂单挂出也算成功
    [ev] = _events(engine)
    assert ev["data"]["at"] is None and ev["data"]["was"] == "FAILED"
