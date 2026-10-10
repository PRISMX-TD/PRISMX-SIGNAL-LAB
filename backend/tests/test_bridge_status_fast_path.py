"""桥接状态上报快路径（2026-10-10 压测后加）：内容没变、心跳还新就不碰数据库。

约定：
1. 同样的上报在 STATUS_FAST_MAX_AGE 内再来一次：一条 SQL 都不发，在线名单照旧；
2. 浮动净值 / 保证金变化不算「内容变了」，余额、账号、版本变化算；
3. 心跳写入超过 STATUS_FAST_MAX_AGE 就回到完整路径（并按节流写心跳），在线判定不受影响；
4. 领指令那一拍走快路径时仍然取指令，只跳过账号上报；
5. 改后缀会作废缓存，下一拍按新后缀拼品种名；
6. 一个账号都没被接受时不进快路径。

The bridge status fast path: unchanged content with a fresh heartbeat never touches the
database; equity/margin don't count as a change; a stale heartbeat goes back to the full
path; a command beat still fetches commands; a suffix change invalidates; nothing
accepted means no fast path.
"""
import asyncio
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import event

from app.models import MT5Account, Order, User
from app.routers import bridge as bridge_router
from app.routers.bridge import BridgeAccount, BridgePollRequest

LOGIN = "80555001"


@pytest.fixture(autouse=True)
def _setup(monkeypatch):
    monkeypatch.setattr(
        bridge_router, "get_broker_settings",
        lambda db: {"broker_lock_enabled": False, "broker_patterns": []},
    )

    async def _inline(fn, *a, **k):
        return fn(*a, **k)

    # 内存 SQLite 是按线程的连接：让 run_in_threadpool 内联执行 / in-memory SQLite is per thread
    monkeypatch.setattr(bridge_router, "run_in_threadpool", _inline)

    async def _noop(*a, **k):
        return None

    monkeypatch.setattr(bridge_router.manager, "push_to_client", _noop)
    monkeypatch.setattr(bridge_router, "_last_pushed_online", {})
    monkeypatch.setattr(bridge_router, "_last_pushed_balances", {})
    monkeypatch.setattr(bridge_router, "_backfill_cache", {})
    monkeypatch.setattr(bridge_router, "_roster_cache", None)


class _Sql:
    def __init__(self, engine):
        self.engine = engine
        self.stmts: list[str] = []
        event.listen(engine, "before_cursor_execute", self._on)

    def _on(self, conn, cursor, statement, params, context, executemany):
        self.stmts.append(statement)

    def close(self):
        event.remove(self.engine, "before_cursor_execute", self._on)


def _user(db, uid="u-fast") -> User:
    user = User(id=uid, email=f"{uid}@t.local", api_token=f"tok-{uid}", plan="PRO")
    db.add(user)
    db.commit()
    return user


def _acc(**kw) -> BridgeAccount:
    base = dict(login=LOGIN, server="MakeCapital-Live", balance=1000.0, equity=1000.0, margin=0.0)
    base.update(kw)
    return BridgeAccount(**base)


def _poll(db, user, accounts, **kw):
    return asyncio.run(bridge_router.bridge_poll(BridgePollRequest(accounts=accounts, **kw), user, db))


def test_identical_report_within_window_runs_no_sql(db_session):
    db_session.expire_on_commit = False
    user = _user(db_session)
    first = _poll(db_session, user, [_acc()], fetchCommands=False)
    assert first["accountLimitExceeded"] == [] and first["brokerRejected"] == []
    sql = _Sql(db_session.get_bind())
    try:
        out = _poll(db_session, user, [_acc()], fetchCommands=False)
    finally:
        sql.close()
    assert sql.stmts == [], f"快路径不该发 SQL：{sql.stmts}"
    assert out["commands"] == [] and out["accountLimitExceeded"] == []


def test_equity_and_margin_changes_stay_on_the_fast_path(db_session):
    db_session.expire_on_commit = False
    user = _user(db_session)
    _poll(db_session, user, [_acc()], fetchCommands=False)
    sql = _Sql(db_session.get_bind())
    try:
        _poll(db_session, user, [_acc(equity=987.65, margin=12.5)], fetchCommands=False)
    finally:
        sql.close()
    assert sql.stmts == [], "浮动净值每拍都变，不能让它把快路径废掉"


@pytest.mark.parametrize("changed", [
    {"balance": 1001.0},
    {"accountName": "renamed"},
    {"leverage": 500},
])
def test_material_change_takes_the_full_path(db_session, changed):
    db_session.expire_on_commit = False
    user = _user(db_session)
    _poll(db_session, user, [_acc()], fetchCommands=False)
    sql = _Sql(db_session.get_bind())
    try:
        _poll(db_session, user, [_acc(**changed)], fetchCommands=False)
    finally:
        sql.close()
    assert any("mt5_accounts" in s for s in sql.stmts), f"{changed} 变了必须走完整路径"
    if "balance" in changed:
        row = db_session.query(MT5Account).filter_by(login=LOGIN).one()
        assert row.balance == 1001.0


def test_new_bridge_version_takes_the_full_path(db_session):
    db_session.expire_on_commit = False
    user = _user(db_session)
    _poll(db_session, user, [_acc()], fetchCommands=False, bridgeVersion="1.4.9")
    sql = _Sql(db_session.get_bind())
    try:
        _poll(db_session, user, [_acc()], fetchCommands=False, bridgeVersion="1.5.0")
    finally:
        sql.close()
    assert sql.stmts, "版本号变了要记下来，不能走快路径"


def test_stale_heartbeat_goes_back_to_the_full_path_and_writes_it(db_session, monkeypatch):
    db_session.expire_on_commit = False
    user = _user(db_session)
    _poll(db_session, user, [_acc()], fetchCommands=False)
    # 把库里的心跳拨回 STATUS_FAST_MAX_AGE 之前，并让缓存里记的也是那个时刻
    old = datetime.now(timezone.utc) - timedelta(seconds=bridge_router.STATUS_FAST_MAX_AGE + 0.5)
    row = db_session.query(MT5Account).filter_by(login=LOGIN).one()
    row.last_heartbeat = old
    db_session.commit()
    hb, fp, result = bridge_router._status_cache[user.id]
    bridge_router._status_cache[user.id] = (old.timestamp(), fp, result)

    sql = _Sql(db_session.get_bind())
    try:
        _poll(db_session, user, [_acc()], fetchCommands=False)
    finally:
        sql.close()
    assert any("mt5_accounts" in s for s in sql.stmts)
    db_session.refresh(row)
    hb_now = row.last_heartbeat.replace(tzinfo=timezone.utc) if row.last_heartbeat.tzinfo is None else row.last_heartbeat
    assert (datetime.now(timezone.utc) - hb_now).total_seconds() < 2, "完整路径要把心跳写新"


def test_command_beat_on_fast_path_still_fetches_commands(db_session):
    db_session.expire_on_commit = False
    user = _user(db_session)
    _poll(db_session, user, [_acc()], fetchCommands=False)
    db_session.add(Order(
        user_id=user.id, client_order_id="c-fast", action="ORDER", symbol="XAUUSD",
        side="BUY", volume=0.01, mt5_login=LOGIN, status="PENDING",
    ))
    db_session.commit()
    sql = _Sql(db_session.get_bind())
    try:
        out = _poll(db_session, user, [_acc()], fetchCommands=True, waitSeconds=0)
    finally:
        sql.close()
    assert [c["clientOrderId"] for c in out["commands"]] == ["c-fast"]
    assert not any("FROM mt5_accounts" in s for s in sql.stmts), "快路径只取指令，不重跑账号上报"


def test_suffix_change_invalidates_the_cache(db_session):
    db_session.expire_on_commit = False
    user = _user(db_session)
    _poll(db_session, user, [_acc()], fetchCommands=False)
    assert user.id in bridge_router._status_cache
    from app.schemas import AccountSuffixRequest
    bridge_router.set_account_suffix(AccountSuffixRequest(login=LOGIN, symbolSuffix=".s"), user, db_session)
    assert user.id not in bridge_router._status_cache
    db_session.add(Order(
        user_id=user.id, client_order_id="c-suffix", action="ORDER", symbol="XAUUSD",
        side="BUY", volume=0.01, mt5_login=LOGIN, status="PENDING",
    ))
    db_session.commit()
    out = _poll(db_session, user, [_acc()], fetchCommands=True, waitSeconds=0)
    assert [c["symbol"] for c in out["commands"]] == ["XAUUSD.s"]


def test_nothing_accepted_never_fast_paths(db_session, monkeypatch):
    monkeypatch.setattr(
        bridge_router, "get_broker_settings",
        lambda db: {"broker_lock_enabled": True, "broker_patterns": ["SomeOtherBroker"]},
    )
    db_session.expire_on_commit = False
    user = _user(db_session)
    out = _poll(db_session, user, [_acc()], fetchCommands=False)
    assert out["brokerRejected"] == [LOGIN]
    assert user.id not in bridge_router._status_cache
