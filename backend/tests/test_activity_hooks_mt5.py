"""操作日志埋点（设计 2026-10-09 §4.2）第一组之一：MT5 绑定 / 解绑 / 授权失效。

  · 直连 gateway_verify：新建 → mt5.bind；删过的复活 → mt5.bind(revived)；改密失效后重新
    验证 → mt5.reverify；好好的绑定再验一次、验证失败、网关拒绝、账户数上限 403、并发
    重复 409 → 什么都不写。
  · 解绑（直连 + 桥接）→ mt5.unbind；404 / 桥接在线 409 不写。
  · gateway_binding.revoke → 系统事件 mt5.revoked，去重键；重复撤销 / 两个 worker 同时撤销
    只留一行；业务提交失败日志一起作废。
  · 桥接上报（_report_accounts_db_work）只在新建 / 复活时记 mt5.bind（去重键），稳态上报
    一条 activity_events 语句都不发；两条循环并发建同一个账号只留一行。
  · 每个埋点：日志组装出错只告警，业务照常完成。

文件库而不是 conftest 的内存库：并发用例要两个会话各自的连接。

Activity-log hooks, group 1a: MT5 bind / unbind / revocation. Each hook writes
exactly once, writes nothing on failure / replay / no-op paths, dedupes concurrent
duplicates, and never lets a composition error break the business call.
"""
import logging
from datetime import datetime, timezone

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine, event, text
from sqlalchemy.orm import sessionmaker

from app.core.database import Base
import app.models  # noqa: F401  —— 注册模型 / registers the tables
from app.models import MT5Account, User
from app.routers import bridge as bridge_mod
from app.routers import gateway as gw
from app.services import activity_log as al
from app.services import gateway_binding as gb
from app.services.gateway_client import VerifyRsp

REAL_GROUP = r"MCSA\I-STD-SLAB-USD"     # 默认 real_group_prefixes 命中 / ruled real
DEMO_GROUP = r"demo\forex-usd"          # 默认 demo_group_prefixes 命中 / ruled demo


@pytest.fixture()
def engine(tmp_path):
    url = "sqlite:///" + str(tmp_path / "hooks_mt5.db").replace("\\", "/")
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


@pytest.fixture(autouse=True)
def _no_limits(monkeypatch):
    from app.core import rate_limit

    monkeypatch.setattr(rate_limit.limiter, "enabled", False)
    monkeypatch.setattr(bridge_mod, "get_broker_settings",
                        lambda db: {"broker_lock_enabled": False, "broker_patterns": []})


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


def _user(db, email="m@t.co", plan="PRO") -> User:
    u = User(email=email, api_token="tok_" + email, plan=plan)
    db.add(u)
    db.commit()
    return u


def _account(db, u, login, *, source="bridge", server="s", **kw) -> MT5Account:
    a = MT5Account(user_id=u.id, login=login, server=server if source == "bridge" else "",
                   source=source, **kw)
    db.add(a)
    db.commit()
    return a


def _rsp(login, *, valid=True, ok=True, group=DEMO_GROUP, name="Alice", balance=1234.5,
         last_pass_change=1_800_000_000, status=200, error=""):
    return VerifyRsp(
        ok=ok, valid=valid, retcode="MT_RET_OK" if valid else "MT_RET_USR_INVALID_PASSWORD",
        login=int(login), name=name, group=group, leverage=100, balance=balance,
        equity=balance, last_pass_change=last_pass_change, status=status, error=error,
    )


def _verify(monkeypatch, db, user, login, **kw):
    """直接调 /gateway/verify 的实现函数，网关那一跳换成假的（同 test_gateway_binding_revoke）。
    Call the endpoint function directly with the gateway hop stubbed."""
    rsp = _rsp(login, **kw)
    monkeypatch.setattr(gw, "gw_verify", lambda *a, **k: None)
    monkeypatch.setattr(gw, "run_on_main_loop", lambda _c, timeout=None: rsp)
    return gw.gateway_verify(
        request=None, req=gw.GatewayVerifyRequest(login=int(login), password="Secret#1"),
        user=user, db=db,
    )


def _gw_row(db, login) -> MT5Account:
    db.expire_all()
    return db.query(MT5Account).filter_by(login=login, source="gateway").one()


class _Stmts:
    """记录发往 activity_events 的语句 / records statements touching activity_events."""

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


# ─────────────────────────────────────────────────────────────────────────────
# 直连绑定 / gateway_verify
# ─────────────────────────────────────────────────────────────────────────────

def test_gateway_first_bind_writes_one_bind(monkeypatch, db, engine):
    u = _user(db)
    out = _verify(monkeypatch, db, u, "900001", group=DEMO_GROUP)
    assert out.valid is True

    row = _gw_row(db, "900001")
    [ev] = _events(engine)
    assert ev["kind"] == al.MT5_BIND
    assert (ev["actor_type"], ev["actor_id"], ev["user_id"]) == ("user", u.id, u.id)
    assert ev["mt5_login"] == "900001" and ev["ref_id"] == row.id
    assert ev["dedupe_key"] is None
    assert ev["data"] == {"ch": "gateway", "revived": False, "name": "Alice", "demo": True,
                          "bal": 1234.5, "server": None}


def test_gateway_real_account_marks_demo_false(monkeypatch, db, engine):
    u = _user(db)
    _verify(monkeypatch, db, u, "900002", group=REAL_GROUP)
    [ev] = _events(engine)
    assert ev["data"]["demo"] is False


def test_gateway_reverify_of_healthy_binding_writes_nothing(monkeypatch, db, engine):
    u = _user(db)
    _verify(monkeypatch, db, u, "900003")
    _verify(monkeypatch, db, u, "900003")          # 同一个账号再验一次，什么都没变
    assert [e["kind"] for e in _events(engine)] == [al.MT5_BIND]


def test_gateway_reverify_after_password_revocation(monkeypatch, db, engine):
    u = _user(db)
    _verify(monkeypatch, db, u, "900004", last_pass_change=111)
    row = _gw_row(db, "900004")
    assert gb.revoke(db, row, gb.REASON_PASSWORD_CHANGED) is True

    _verify(monkeypatch, db, u, "900004", last_pass_change=222)
    kinds = [e["kind"] for e in _events(engine)]
    assert kinds == [al.MT5_BIND, al.MT5_REVOKED, al.MT5_REVERIFY]
    reverify = _events(engine, al.MT5_REVERIFY)[0]
    assert reverify["data"] == {"ch": "gateway"}
    assert reverify["ref_id"] == row.id and reverify["actor_type"] == "user"


def test_gateway_rebind_after_unbind_is_revived(monkeypatch, db, engine):
    u = _user(db)
    _verify(monkeypatch, db, u, "900005", balance=10.0)
    assert gw.unbind_gateway_account("900005", user=u, db=db) == {"ok": True}
    _verify(monkeypatch, db, u, "900005", balance=20.0, name="Bob")

    evs = _events(engine)
    assert [e["kind"] for e in evs] == [al.MT5_BIND, al.MT5_UNBIND, al.MT5_BIND]
    assert evs[0]["data"]["revived"] is False
    assert evs[2]["data"]["revived"] is True
    assert evs[2]["data"]["bal"] == 20.0 and evs[2]["data"]["name"] == "Bob"
    # 同一行复活：三条的 ref_id 都是同一个账号行 / one row throughout
    assert len({e["ref_id"] for e in evs}) == 1


def test_gateway_invalid_password_writes_nothing(monkeypatch, db, engine):
    u = _user(db)
    out = _verify(monkeypatch, db, u, "900006", valid=False)
    assert out.valid is False
    assert _events(engine) == []


def test_gateway_not_found_and_refusal_write_nothing(monkeypatch, db, engine):
    u = _user(db)
    out = _verify(monkeypatch, db, u, "900007", ok=False, valid=False, status=404, error="not_found")
    assert out.valid is False
    with pytest.raises(HTTPException) as exc:
        _verify(monkeypatch, db, u, "900008", ok=False, valid=False, status=403,
                error="group_not_allowed")
    assert exc.value.status_code == 403
    assert _events(engine) == []


def test_gateway_plan_limit_403_writes_nothing(monkeypatch, db, engine):
    u = _user(db, plan="FREE")
    _account(db, u, "100001", trade_mode=2, balance=1.0)       # 已占用唯一名额（实盘桥接）
    with pytest.raises(HTTPException) as exc:
        _verify(monkeypatch, db, u, "900009", group=REAL_GROUP)
    assert exc.value.status_code == 403
    assert _events(engine) == []


def test_gateway_concurrent_duplicate_bind_409_leaves_one_event(monkeypatch, Session, engine):
    """两个请求同时绑同一个账号：输家在 flush 时撞唯一约束 → 409，它的日志随回滚作废。
    Two concurrent binds of one account: the loser hits the unique constraint at
    flush (409) and its log row goes with the rollback."""
    a, b = Session(), Session()
    u = _user(a)
    ub = b.get(User, u.id)
    real_settings = gw.get_account_type_settings
    state = {"raced": False}

    def _racing_settings(db):
        # B 已经查过「这个账号还没绑」，在它写入之前让 A 整个绑完、提交。
        # B has already seen "not bound yet"; let A bind and commit before B writes.
        if db is b and not state["raced"]:
            state["raced"] = True
            _verify(monkeypatch, a, u, "900010")
        return real_settings(db)

    monkeypatch.setattr(gw, "get_account_type_settings", _racing_settings)
    with pytest.raises(HTTPException) as exc:
        _verify(monkeypatch, b, ub, "900010")
    assert exc.value.status_code == 409
    assert state["raced"] is True
    assert [e["kind"] for e in _events(engine)] == [al.MT5_BIND]
    a.close()
    b.close()


def test_gateway_bind_survives_log_composition_error(monkeypatch, db, engine, caplog):
    u = _user(db)

    def _boom(_tm):
        raise RuntimeError("compose boom")

    monkeypatch.setattr(al, "demo_of", _boom)
    with caplog.at_level(logging.WARNING):
        out = _verify(monkeypatch, db, u, "900011")
    assert out.valid is True
    assert _gw_row(db, "900011").revoked_at is None              # 绑定照常落库
    assert _events(engine) == []
    assert "verify activity skipped" in caplog.text


# ─────────────────────────────────────────────────────────────────────────────
# 解绑 / unbind
# ─────────────────────────────────────────────────────────────────────────────

def test_gateway_unbind_writes_one_unbind(db, engine):
    u = _user(db)
    a = _account(db, u, "601144", source="gateway", account_name="Gw", balance=55.5)
    assert gw.unbind_gateway_account("601144", user=u, db=db) == {"ok": True}

    [ev] = _events(engine)
    assert ev["kind"] == al.MT5_UNBIND
    assert (ev["actor_type"], ev["actor_id"], ev["user_id"]) == ("user", u.id, u.id)
    assert ev["mt5_login"] == "601144" and ev["ref_id"] == a.id and ev["dedupe_key"] is None
    assert ev["data"] == {"ch": "gateway", "name": "Gw", "bal": 55.5}

    with pytest.raises(HTTPException) as exc:                    # 已解绑再解 → 404，不写
        gw.unbind_gateway_account("601144", user=u, db=db)
    assert exc.value.status_code == 404
    assert len(_events(engine)) == 1


def test_bridge_delete_writes_one_unbind(db, engine):
    u = _user(db)
    a = _account(db, u, "100001", account_name="Br", balance=9.0)
    assert bridge_mod.delete_account("100001", server="s", user=u, db=db) == {"ok": True}

    [ev] = _events(engine)
    assert ev["kind"] == al.MT5_UNBIND and ev["ref_id"] == a.id
    assert ev["data"] == {"ch": "bridge", "name": "Br", "bal": 9.0}


def test_bridge_delete_refused_while_online_writes_nothing(db, engine):
    u = _user(db)
    _account(db, u, "100002", online=True,
             last_heartbeat=datetime.now(timezone.utc).replace(tzinfo=None))
    with pytest.raises(HTTPException) as exc:
        bridge_mod.delete_account("100002", server="s", user=u, db=db)
    assert exc.value.status_code == 409
    with pytest.raises(HTTPException) as exc:
        bridge_mod.delete_account("999999", server="s", user=u, db=db)
    assert exc.value.status_code == 404
    assert _events(engine) == []


class _OrmStmts:
    """记录会话发出的 ORM 语句（按 Postgres 编译成字符串；SQLite 不渲染 FOR UPDATE）。
    Records the session's ORM statements compiled for Postgres (SQLite drops FOR UPDATE)."""

    def __init__(self, session):
        from sqlalchemy.dialects import postgresql

        self.sql: list[str] = []
        self._session = session
        self._pg = postgresql.dialect()
        event.listen(session, "do_orm_execute", self._on)

    def _on(self, state):
        self.sql.append(str(state.statement.compile(dialect=self._pg)))

    def account_selects(self) -> list[str]:
        return [s for s in self.sql if s.lstrip().upper().startswith("SELECT") and "FROM mt5_accounts" in s]

    def close(self):
        event.remove(self._session, "do_orm_execute", self._on)


@pytest.mark.parametrize("channel", ["gateway", "bridge"])
def test_unbind_reads_the_row_for_update(db, engine, channel):
    """双击解绑 / 两个标签页同时删：读账号行时 FOR UPDATE，后到的请求等先到的提交、按新行
    重判 not_removed() 拿到 404，不会各记一条 mt5.unbind（同一条语句，不加往返）。
    Unbind reads the row FOR UPDATE, so a concurrent duplicate waits, re-checks
    not_removed() and gets the 404 instead of logging a second mt5.unbind."""
    u = _user(db)
    if channel == "gateway":
        _account(db, u, "601150", source="gateway")
        call = lambda: gw.unbind_gateway_account("601150", user=u, db=db)   # noqa: E731
    else:
        _account(db, u, "100030")
        call = lambda: bridge_mod.delete_account("100030", server="s", user=u, db=db)   # noqa: E731
    rec = _OrmStmts(db)
    try:
        assert call() == {"ok": True}
        with pytest.raises(HTTPException) as exc:                # 后到的那个 / the late one
            call()
        assert exc.value.status_code == 404
    finally:
        rec.close()
    selects = rec.account_selects()
    assert len(selects) == 2 and all(s.rstrip().endswith("FOR UPDATE") for s in selects)
    assert len(_events(engine, al.MT5_UNBIND)) == 1


def test_gateway_reverify_reads_the_row_for_update_and_rereads_it(monkeypatch, Session, engine):
    """两个并发的重新验证：存在的行 FOR UPDATE + populate_existing 读，后到的（会话里还留着
    「改密失效」的旧状态）在锁后看到已恢复的行，什么都不记。
    Two concurrent re-verifies: the existing row is read FOR UPDATE with
    populate_existing, so the late one (its session still holding the revoked
    state) sees the restored row after the lock and logs nothing."""
    a, b = Session(), Session()
    u = _user(a)
    _account(a, u, "601151", source="gateway", pass_change_at=1_700_000_000)
    gb.revoke(a, a.query(MT5Account).filter_by(login="601151").one(), gb.REASON_PASSWORD_CHANGED)
    ub = b.get(User, u.id)
    stale = b.query(MT5Account).filter_by(login="601151").one()       # B 读到「失效」/ B saw it revoked
    assert stale.revoked_reason == gb.REASON_PASSWORD_CHANGED

    _verify(monkeypatch, a, u, "601151")                               # A 先完成 / A wins
    rec = _OrmStmts(b)
    try:
        _verify(monkeypatch, b, ub, "601151")
    finally:
        rec.close()
    assert stale.revoked_reason is None
    assert [e["kind"] for e in _events(engine) if e["kind"] != al.MT5_REVOKED] == [al.MT5_REVERIFY]
    assert rec.account_selects()[0].rstrip().endswith("FOR UPDATE")
    a.close()
    b.close()


def test_unbind_survives_log_composition_error(monkeypatch, db, engine):
    u = _user(db)
    _account(db, u, "100003")

    def _boom(*a, **k):
        raise RuntimeError("log boom")

    monkeypatch.setattr(al, "log_event", _boom)
    assert bridge_mod.delete_account("100003", server="s", user=u, db=db) == {"ok": True}
    db.expire_all()
    assert gb.is_removed(db.query(MT5Account).filter_by(login="100003").one())
    assert _events(engine) == []


# ─────────────────────────────────────────────────────────────────────────────
# 授权失效 / revoke
# ─────────────────────────────────────────────────────────────────────────────

def test_revoke_writes_one_system_event(db, engine):
    u = _user(db)
    row = _account(db, u, "601145", source="gateway", pass_change_at=1_700_000_000)
    assert gb.revoke(db, row, gb.REASON_PASSWORD_CHANGED) is True
    assert gb.revoke(db, row, gb.REASON_PASSWORD_CHANGED) is False     # 已撤销：不再写

    [ev] = _events(engine)
    assert ev["kind"] == al.MT5_REVOKED
    assert ev["actor_type"] == "system" and ev["actor_id"] is None
    assert ev["user_id"] == u.id and ev["mt5_login"] == "601145" and ev["ref_id"] == row.id
    assert ev["data"] == {"reason": "password_changed"}
    assert ev["dedupe_key"] == f"revoke:{row.id}:1700000000"


def test_enforce_revocation_logs_once_across_ticks(db, engine):
    u = _user(db)
    row = _account(db, u, "601146", source="gateway", pass_change_at=111)
    for _ in range(3):                                   # 轮询每拍都会再比一次
        assert gb.enforce(db, row, 222) is False
    assert [e["kind"] for e in _events(engine)] == [al.MT5_REVOKED]


def test_concurrent_revocations_leave_one_event(Session, engine):
    """两个 worker 同一拍各自读到未撤销、各自撤销同一行：去重键相同，只留一行。
    Two workers revoke the same row from stale reads: same key, one row."""
    a, b = Session(), Session()
    u = _user(a)
    row_a = _account(a, u, "601147", source="gateway", pass_change_at=5)
    row_b = b.get(MT5Account, row_a.id)
    assert row_b.revoked_at is None                      # B 读到的还是未撤销

    assert gb.revoke(a, row_a, gb.REASON_PASSWORD_CHANGED) is True
    assert gb.revoke(b, row_b, gb.REASON_PASSWORD_CHANGED) is True   # 业务照常完成
    assert len(_events(engine, al.MT5_REVOKED)) == 1
    a.close()
    b.close()


def test_new_revocation_episode_gets_its_own_event(monkeypatch, db, engine):
    u = _user(db)
    _verify(monkeypatch, db, u, "601148", last_pass_change=100)
    row = _gw_row(db, "601148")
    gb.revoke(db, row, gb.REASON_PASSWORD_CHANGED)
    _verify(monkeypatch, db, u, "601148", last_pass_change=200)   # 重新验证 → 新基线
    row = _gw_row(db, "601148")
    gb.revoke(db, row, gb.REASON_PASSWORD_CHANGED)

    keys = [e["dedupe_key"] for e in _events(engine, al.MT5_REVOKED)]
    assert keys == [f"revoke:{row.id}:100", f"revoke:{row.id}:200"]


def test_revoke_matches_backfilled_key(db, engine):
    """上线时补录过的同一次失效，运行时再撤销不会多一行（键与补录同格式）。
    A revocation already backfilled at rev 38 isn't recorded twice."""
    u = _user(db)
    row = _account(db, u, "601149", source="gateway", pass_change_at=77)
    row.online = False                                   # 先有业务写入 / a business write first
    al.log_event(db, al.MT5_REVOKED, user_id=u.id, mt5_login="601149",
                 actor_type=al.ACTOR_SYSTEM, ref_id=row.id,
                 data={"reason": "password_changed", "bf": 1},
                 dedupe_key=al.revoke_key(row.id, 77))
    db.commit()
    assert gb.revoke(db, row, gb.REASON_PASSWORD_CHANGED) is True
    [ev] = _events(engine, al.MT5_REVOKED)
    assert ev["data"].get("bf") == 1


def test_revoke_rolled_back_with_the_business(monkeypatch, db, engine):
    u = _user(db)
    row = _account(db, u, "601150", source="gateway", pass_change_at=1)
    real_commit = db.commit

    def _failing_commit():
        raise RuntimeError("commit failed")

    monkeypatch.setattr(db, "commit", _failing_commit)
    with pytest.raises(RuntimeError):
        gb.revoke(db, row, gb.REASON_PASSWORD_CHANGED)
    db.rollback()
    monkeypatch.setattr(db, "commit", real_commit)
    assert _events(engine) == []
    db.expire_all()
    assert db.get(MT5Account, row.id).revoked_at is None


def test_revoke_survives_log_composition_error(monkeypatch, db, engine, caplog):
    u = _user(db)
    row = _account(db, u, "601151", source="gateway", pass_change_at=1)

    def _boom(*a, **k):
        raise RuntimeError("key boom")

    monkeypatch.setattr(al, "revoke_key", _boom)
    with caplog.at_level(logging.WARNING):
        assert gb.revoke(db, row, gb.REASON_PASSWORD_CHANGED) is True
    db.expire_all()
    assert db.get(MT5Account, row.id).revoked_reason == gb.REASON_PASSWORD_CHANGED
    assert _events(engine) == []
    assert "revoke activity skipped" in caplog.text


# ─────────────────────────────────────────────────────────────────────────────
# 桥接上报 / bridge report (_report_accounts_db_work)
# ─────────────────────────────────────────────────────────────────────────────

def _report(db, user, *accounts):
    req = bridge_mod.BridgePollRequest(accounts=list(accounts), fetchCommands=False)
    return bridge_mod._report_accounts_db_work(db, user, req)


def _acc(login, server="s", **kw):
    kw.setdefault("balance", 5.0)
    return bridge_mod.BridgeAccount(login=login, server=server, **kw)


def test_bridge_new_account_writes_one_bind(db, engine):
    u = _user(db)
    online, *_ = _report(db, u, _acc("100010", accountName="New", tradeMode=0))
    assert "100010" in online

    row = db.query(MT5Account).filter_by(login="100010").one()
    [ev] = _events(engine)
    assert ev["kind"] == al.MT5_BIND
    assert (ev["actor_type"], ev["actor_id"], ev["user_id"]) == ("user", u.id, u.id)
    assert ev["mt5_login"] == "100010" and ev["ref_id"] == row.id
    assert ev["dedupe_key"] == f"mt5bind:{u.id}:100010:s:new"
    assert ev["data"] == {"ch": "bridge", "revived": False, "name": "New", "demo": True,
                          "bal": 5.0, "server": "s"}


def test_bridge_steady_reports_issue_no_activity_statements(db, engine):
    u = _user(db)
    _report(db, u, _acc("100011"))
    stmts = _Stmts(engine)
    try:
        for _ in range(3):
            _report(db, u, _acc("100011", balance=6.0))
        assert stmts.activity() == []
    finally:
        stmts.close()
    assert len(_events(engine)) == 1


def test_bridge_revival_writes_revived_bind(db, engine):
    u = _user(db)
    a = _account(db, u, "100012", account_name="Old")
    gb.mark_removed(db, a)
    db.expire_all()
    removed_at = db.get(MT5Account, a.id).revoked_at

    _report(db, u, _acc("100012"))
    [ev] = _events(engine)
    assert ev["kind"] == al.MT5_BIND and ev["ref_id"] == a.id
    assert ev["data"]["revived"] is True
    assert ev["dedupe_key"] == al.bridge_bind_revived_key(a.id, removed_at)
    db.expire_all()
    assert not gb.is_removed(db.get(MT5Account, a.id))


def test_bridge_rejected_accounts_write_nothing(monkeypatch, db, engine):
    u = _user(db, plan="FREE")
    _account(db, u, "100013")                            # 唯一名额已占 / the one slot is taken
    _, _, _, rejected, _, _ = _report(db, u, _acc("100014"))
    assert rejected == ["100014"]

    monkeypatch.setattr(bridge_mod, "get_broker_settings",
                        lambda db: {"broker_lock_enabled": True, "broker_patterns": ["nomatch"]})
    _, _, _, _, broker_rejected, _ = _report(db, u, _acc("100015"))
    assert broker_rejected == ["100015"]
    assert _events(engine) == []


def test_bridge_several_new_accounts_logged_in_login_order(monkeypatch, db, engine):
    """一次上报多个新账号：各记一行，按 login 顺序写（两个事务不以相反顺序抢键）。"""
    u = _user(db)
    seen: list[str] = []
    real = al.log_events

    def _spy(db_, events):
        seen.extend(ev["mt5_login"] for ev in events)
        return real(db_, events)

    monkeypatch.setattr(al, "log_events", _spy)
    stmts = _Stmts(engine)
    try:
        _report(db, u, _acc("300003"), _acc("100016"), _acc("200002"))
        activity = stmts.activity()
    finally:
        stmts.close()
    assert seen == ["100016", "200002", "300003"]
    assert sorted(e["mt5_login"] for e in _events(engine, al.MT5_BIND)) == seen
    # 三个账号一条多行 INSERT / three accounts, one multi-row INSERT
    assert len(activity) == 1 and activity[0].lstrip().upper().startswith("INSERT")


def test_bridge_two_loops_creating_one_account_leave_one_event(monkeypatch, Session, engine):
    """状态循环与指令循环同时上报同一个新账号（server 为空，唯一约束挡不住）：两条请求都
    建了行，日志按账号身份去重只留一行。
    Both bridge loops report the same new account at once (NULL server escapes the
    unique constraint): both create a row, the identity-keyed log keeps one."""
    a, b = Session(), Session()
    u = _user(a)
    ub = b.get(User, u.id)
    real = bridge_mod.plan_slot_rows
    state = {"raced": False}

    def _racing(plan, rows):
        # B 已经读完「这个用户有哪些账号」，在它写入前让 A 整个上报完、提交。
        if not state["raced"] and rows == []:
            state["raced"] = True
            _report(a, u, _acc("100017", server=None))
        return real(plan, rows)

    monkeypatch.setattr(bridge_mod, "plan_slot_rows", _racing)
    _report(b, ub, _acc("100017", server=None))
    assert state["raced"] is True
    assert a.query(MT5Account).filter_by(login="100017").count() == 2   # 两边都建了行
    [ev] = _events(engine)
    assert ev["dedupe_key"] == f"mt5bind:{u.id}:100017::new"
    a.close()
    b.close()


def test_bridge_two_loops_reviving_one_account_leave_one_event(monkeypatch, Session, engine):
    a, b = Session(), Session()
    u = _user(a)
    row = _account(a, u, "100018")
    gb.mark_removed(a, row)
    ub = b.get(User, u.id)
    real = bridge_mod.plan_slot_rows
    state = {"raced": False}

    def _racing(plan, rows):
        if not state["raced"]:
            state["raced"] = True
            _report(a, u, _acc("100018"))
        return real(plan, rows)

    keys: list[str] = []
    real_log = al.log_events

    def _spy(db_, events):
        keys.extend(ev["dedupe_key"] for ev in events)
        return real_log(db_, events)

    monkeypatch.setattr(bridge_mod, "plan_slot_rows", _racing)
    monkeypatch.setattr(al, "log_events", _spy)
    _report(b, ub, _acc("100018"))
    assert state["raced"] is True
    # 两边都按「复活」记了、键相同，库里只留一行 / both logged the same key, one row kept
    assert len(keys) == 2 and keys[0] == keys[1]
    [ev] = _events(engine)
    assert ev["data"]["revived"] is True
    a.close()
    b.close()


def test_bridge_bind_survives_log_composition_error(monkeypatch, db, engine, caplog):
    u = _user(db)

    def _boom(*a, **k):
        raise RuntimeError("key boom")

    monkeypatch.setattr(al, "bridge_bind_new_key", _boom)
    with caplog.at_level(logging.WARNING):
        online, *_ = _report(db, u, _acc("100019"))
    assert "100019" in online
    assert db.query(MT5Account).filter_by(login="100019").count() == 1
    assert _events(engine) == []
    assert "bridge bind activity skipped" in caplog.text


def test_bridge_bind_rolled_back_with_the_business(monkeypatch, db, engine):
    u = _user(db)

    def _failing_commit():
        raise RuntimeError("commit failed")

    real_commit = db.commit
    monkeypatch.setattr(db, "commit", _failing_commit)
    with pytest.raises(RuntimeError):
        _report(db, u, _acc("100020"))
    db.rollback()
    monkeypatch.setattr(db, "commit", real_commit)
    assert _events(engine) == []
    assert db.query(MT5Account).filter_by(login="100020").count() == 0
