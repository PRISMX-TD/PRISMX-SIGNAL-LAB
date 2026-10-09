"""操作日志地基（设计 2026-10-09 §3 / §4.1 / §4.2 plan:auto_expire）：

  · activity_log.log_event —— 搭调用方的提交 / 回滚；带 dedupe_key 时同一件事只留一行、
    不抛异常；组装出错、kind 不认识、data 不合法都只告警跳过；去重 INSERT 失败不连累业务。
  · activity_log.record_after_commit —— 自己的短事务；失败只告警。
  · audit.log_change 的 op_id —— 同一会话共用一个，换会话换一个。
  · plan_expiry.downgrade_if_expired 改成条件 UPDATE —— 后到的一方什么都不做、不写审计。
  · 保留期清扫 —— 分批删、只删过期的、出错不连累 K 线清扫。

文件库而不是 conftest 的内存库：record_after_commit 自己开连接，内存库每个连接都是空库
（SingletonThreadPool 下还会与会话共用同一条连接，测不出「独立事务」）。

Foundation of the admin activity log: log_event / record_after_commit, audit
op_id grouping, the conditional auto-expire downgrade and the retention sweep.
A file database rather than conftest's in-memory one, because record_after_commit
opens its own connection.
"""
import json
import logging
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import sessionmaker

from app.core.database import Base
import app.models  # noqa: F401  —— 注册模型 / registers the tables
from app.models import ActivityEvent, AdminAuditLog, Order, User
from app.services import activity_log as al
from app.services import audit
from app.services import plan_expiry as pe


@pytest.fixture()
def engine(tmp_path):
    url = "sqlite:///" + str(tmp_path / "activity.db").replace("\\", "/")
    eng = create_engine(url, connect_args={"check_same_thread": False})
    Base.metadata.create_all(eng)
    yield eng
    eng.dispose()


@pytest.fixture()
def Session(engine):
    return sessionmaker(bind=engine, autocommit=False, autoflush=False)


def _user(db, email="a@t.co", **kw) -> User:
    u = User(email=email, api_token="tok_" + email, **kw)
    db.add(u)
    db.commit()
    return u


def _events(engine) -> list[dict]:
    with engine.connect() as conn:
        rows = conn.execute(text(
            "SELECT kind, actor_type, actor_id, user_id, mt5_login, ref_id, data, dedupe_key "
            "FROM activity_events ORDER BY created_at, id"
        )).mappings().all()
    return [dict(r) for r in rows]


# ── log_event：普通写入随调用方提交 / 回滚 ─────────────────────────────────────

def test_plain_event_rides_the_callers_commit(Session, engine):
    db = Session()
    u = _user(db)
    u.nickname = "新名字"
    al.log_event(db, al.USER_NICKNAME, user_id=u.id, actor_id=u.id,
                 data={"old": None, "new": "新名字"})
    assert _events(engine) == []          # 还没提交 / nothing before the commit
    db.commit()

    [ev] = _events(engine)
    assert ev["kind"] == "user.nickname"
    assert ev["actor_type"] == "user" and ev["actor_id"] == u.id and ev["user_id"] == u.id
    assert ev["dedupe_key"] is None
    # 紧凑 JSON、中文不转义 / compact JSON, non-ASCII kept as is
    assert ev["data"] == '{"old":null,"new":"新名字"}'
    row = db.query(ActivityEvent).one()
    assert row.created_at.tzinfo is None   # 不带时区的 UTC / naive UTC
    assert abs((datetime.now(timezone.utc).replace(tzinfo=None) - row.created_at).total_seconds()) < 60
    db.close()


def test_plain_event_rolls_back_with_the_business(Session, engine):
    db = Session()
    u = _user(db)
    al.log_event(db, al.USER_PHONE_SET, user_id=u.id, actor_id=u.id, data={})
    db.rollback()
    db.commit()
    assert _events(engine) == []
    db.close()


# ── log_event：带 dedupe_key ──────────────────────────────────────────────────

def _order(user_id, cid, login="5001"):
    return Order(user_id=user_id, client_order_id=cid, action="CLOSE", symbol="XAUUSD",
                 side="BUY", volume=0.0, ticket=11, mt5_login=login, status="PENDING")


def test_dedupe_double_write_leaves_one_row_and_never_raises(Session, engine):
    """同一件事被两条路径（两个请求 / 两个 worker）各记一次，库里只留一行，第二次不抛。
    The same event logged twice (two requests / workers) leaves one row; no raise."""
    db = Session()
    u = _user(db)
    key = al.close_all_key(u.id, "ca_co_1", "5001")
    db.add(_order(u.id, "ca_co_1#5001#11"))
    al.log_event(db, al.TRADE_CLOSE_ALL, user_id=u.id, actor_id=u.id, mt5_login="5001",
                 ref_id="ca_co_1", data={"count": 1, "skipped": 0}, dedupe_key=key)
    # 同一事务里再来一次 / again within the same transaction
    al.log_event(db, al.TRADE_CLOSE_ALL, user_id=u.id, actor_id=u.id, mt5_login="5001",
                 ref_id="ca_co_1", data={"count": 1, "skipped": 0}, dedupe_key=key)
    uid = u.id
    db.commit()
    db.close()

    # 另一个会话（另一个 worker）再来一次 / a second session (another worker)
    db2 = Session()
    db2.add(_order(uid, "ca_co_1#5001#12"))
    al.log_event(db2, al.TRADE_CLOSE_ALL, user_id=uid, actor_id=uid, mt5_login="5001",
                 ref_id="ca_co_1", data={"count": 1, "skipped": 0}, dedupe_key=key)
    db2.commit()
    db2.close()

    evs = _events(engine)
    assert len(evs) == 1
    assert evs[0]["dedupe_key"] == f"ca:{uid}:ca_co_1:5001"
    assert json.loads(evs[0]["data"]) == {"count": 1, "skipped": 0}
    # 业务行一行不少 / every business row committed
    with engine.connect() as conn:
        assert conn.execute(text("SELECT COUNT(*) FROM orders")).scalar_one() == 2


def test_dedupe_event_rolls_back_with_the_business(Session, engine):
    db = Session()
    u = _user(db)
    db.add(_order(u.id, "ca_co_2#5001#11"))
    al.log_event(db, al.TRADE_CLOSE_ALL, user_id=u.id, ref_id="ca_co_2", actor_id=u.id,
                 data={"count": 1, "skipped": 0},
                 dedupe_key=al.close_all_key(u.id, "ca_co_2", "5001"))
    db.rollback()
    db.close()
    assert _events(engine) == []
    with engine.connect() as conn:
        assert conn.execute(text("SELECT COUNT(*) FROM orders")).scalar_one() == 0


def test_dedupe_flush_reraises_the_business_error(Session, engine):
    """flush 抛的是业务自己的异常（commit 时本来就会抛），原样上抛——调用方原有的
    except IntegrityError 照样接得住（模块说明里要求把调用放进同一个 try）。
    The flush raises the business's own error unchanged."""
    db = Session()
    u = _user(db)
    db.add(_order(u.id, "dup"))
    db.commit()
    db.add(_order(u.id, "dup"))
    with pytest.raises(IntegrityError):
        al.log_event(db, al.TRADE_CLOSE_ALL, user_id=u.id, actor_id=u.id,
                     data={"count": 1, "skipped": 0}, dedupe_key="ca:x:y:z")
    db.rollback()
    db.close()
    assert _events(engine) == []


def test_failed_dedupe_insert_does_not_break_the_business(Session, engine, monkeypatch, caplog):
    """去重 INSERT 在库里失败（比如唯一索引缺失）：只丢这一行日志，业务照常提交、不抛。
    SAVEPOINT 保证事务没被打坏。
    A failing dedupe INSERT only loses the log row; the business commits normally."""
    def broken(_dialect, _rows):
        return text("INSERT INTO no_such_table (x) VALUES (1)")

    monkeypatch.setattr(al, "_insert_ignore", broken)
    db = Session()
    u = _user(db)
    db.add(_order(u.id, "ca_co_3#5001#11"))
    with caplog.at_level(logging.WARNING, logger="prismx.activity_log"):
        al.log_event(db, al.TRADE_CLOSE_ALL, user_id=u.id, actor_id=u.id,
                     data={"count": 1, "skipped": 0}, dedupe_key="ca:k")
    db.commit()
    db.close()
    assert _events(engine) == []
    with engine.connect() as conn:
        assert conn.execute(text("SELECT COUNT(*) FROM orders")).scalar_one() == 1
    assert "去重写入失败" in caplog.text


# ── log_events：几条带键的一次写 / several keyed rows at once ────────────────

def _ca(uid, login, n=1, **extra):
    return {"kind": al.TRADE_CLOSE_ALL, "user_id": uid, "actor_id": uid, "mt5_login": login,
            "ref_id": "ca_co_9", "data": {"count": n, "skipped": 0},
            "dedupe_key": al.close_all_key(uid, "ca_co_9", login), **extra}


def test_log_events_writes_a_batch_in_one_insert_and_dedupes(Session, engine):
    """一个 SAVEPOINT 里一条多行 INSERT；批内重复的键、库里已有的键都只留一行；不带键的
    走普通 db.add；组装出错的那条跳过，其余照写。
    One multi-row INSERT in one SAVEPOINT; a key repeated in the batch or already
    stored keeps one row; unkeyed items are plain adds; a bad item is skipped alone."""
    from sqlalchemy import event as sa_event

    db = Session()
    u = _user(db)
    al.log_events(db, [_ca(u.id, "5003")])                     # 库里已有 / already stored
    db.commit()

    stmts: list[str] = []

    def _before(conn, cursor, statement, *a):
        stmts.append(statement)

    sa_event.listen(engine, "before_cursor_execute", _before)
    try:
        al.log_events(db, [
            _ca(u.id, "5001", 2),
            _ca(u.id, "5001", 9),                                  # 批内重复 / repeated in batch
            _ca(u.id, "5002"),
            _ca(u.id, "5003"),                                     # 库里已有 / already stored
            {"kind": "user.not_a_kind", "user_id": u.id, "dedupe_key": "bad"},   # 组装出错 / bad
            {**_ca(u.id, "5004"), "typo_field": 1},                # 不认识的键 / unknown field
            {"kind": al.USER_PHONE_SET, "user_id": u.id, "actor_id": u.id},      # 不带键 / unkeyed
        ])
        db.commit()
    finally:
        sa_event.remove(engine, "before_cursor_execute", _before)
    db.close()

    inserts = [s for s in stmts if "activity_events" in s and s.lstrip().upper().startswith("INSERT")]
    # 带键的一条多行 INSERT + 不带键那条随 commit 的普通 INSERT
    # one multi-row keyed INSERT + the unkeyed row's plain INSERT at commit
    assert len(inserts) == 2
    assert len([s for s in stmts if s.lstrip().upper().startswith("SAVEPOINT")]) == 1
    evs = _events(engine)
    by_login = {e["mt5_login"]: json.loads(e["data"]) for e in evs if e["kind"] == al.TRADE_CLOSE_ALL}
    assert by_login == {"5001": {"count": 2, "skipped": 0}, "5002": {"count": 1, "skipped": 0},
                        "5003": {"count": 1, "skipped": 0}}
    assert [e["kind"] for e in evs].count(al.USER_PHONE_SET) == 1


def test_log_events_failed_insert_does_not_break_the_business(Session, engine, monkeypatch, caplog):
    def broken(_dialect, _rows):
        return text("INSERT INTO no_such_table (x) VALUES (1)")

    monkeypatch.setattr(al, "_insert_ignore", broken)
    db = Session()
    u = _user(db)
    db.add(_order(u.id, "ca_co_9#5001#11"))
    with caplog.at_level(logging.WARNING, logger="prismx.activity_log"):
        al.log_events(db, [_ca(u.id, "5001"), _ca(u.id, "5002")])
    db.commit()
    db.close()
    assert _events(engine) == []
    with engine.connect() as conn:
        assert conn.execute(text("SELECT COUNT(*) FROM orders")).scalar_one() == 1
    assert "去重写入失败" in caplog.text


def test_log_events_flush_reraises_the_business_error(Session, engine):
    db = Session()
    u = _user(db)
    db.add(_order(u.id, "dup2"))
    db.commit()
    db.add(_order(u.id, "dup2"))
    with pytest.raises(IntegrityError):
        al.log_events(db, [_ca(u.id, "5001")])
    db.rollback()
    db.close()
    assert _events(engine) == []


# ── log_event：组装出错只告警 / assembly errors only warn ─────────────────────

@pytest.mark.parametrize("kwargs", [
    {"kind": "user.not_a_kind"},                              # kind 不认识 / unknown kind
    {"kind": al.USER_LOGIN, "data": ["not", "a", "dict"]},   # data 不是对象 / data not a dict
    {"kind": al.USER_LOGIN, "data": "oops"},
    {"kind": al.USER_LOGIN, "actor_type": "robot"},          # actor_type 不认识
])
def test_bad_input_is_skipped_with_a_warning(Session, engine, caplog, kwargs):
    db = Session()
    u = _user(db)
    kind = kwargs.pop("kind")
    with caplog.at_level(logging.WARNING, logger="prismx.activity_log"):
        al.log_event(db, kind, user_id=u.id, **kwargs)                  # 不抛 / no raise
        al.log_event(db, kind, user_id=u.id, dedupe_key="k1", **kwargs)
    db.commit()
    db.close()
    assert _events(engine) == []
    assert "已跳过" in caplog.text


def test_data_edge_cases_are_normalised(Session, engine, caplog):
    db = Session()
    u = _user(db)
    when = datetime(2026, 10, 9, 6, 3, 21, 123456, tzinfo=timezone.utc)
    with caplog.at_level(logging.WARNING, logger="prismx.activity_log"):
        al.log_event(db, al.USER_LOGIN, user_id=u.id, actor_id=u.id, data={
            "method": "password", "new_source": True,
            "password": "hunter2", "IP": "1.2.3.4", "nested": {"token": "x", "ok": 1},
            "nan": float("nan"), "at": when, "obj": object.__name__,
        })
        al.log_event(db, al.AUTO_SETTINGS, user_id=u.id, actor_id=u.id,
                     data={"changes": [{"field": "f%d" % i, "old": "x" * 300, "new": "y" * 300}
                                       for i in range(40)]})
    db.commit()
    db.close()
    login, settings_ev = sorted(_events(engine), key=lambda e: e["kind"], reverse=True)
    d = json.loads(login["data"])
    assert "password" not in d and "IP" not in d and d["nested"] == {"ok": 1}
    assert d["nan"] is None
    assert d["at"] == "2026-10-09T06:03:21.123456Z"
    assert "敏感键名" in caplog.text
    # 超长：仍是合法 JSON、不超过上限 / oversize: still valid JSON within the cap
    assert len(settings_ev["data"]) <= al.DATA_MAX_CHARS
    assert isinstance(json.loads(settings_ev["data"]), dict)


def test_encode_data_shrinks_before_giving_up():
    text_ = al.encode_data({"changes": [{"field": "a", "old": "x" * 1200, "new": "y"}]})
    d = json.loads(text_)
    assert d["changes"][0]["old"].endswith("…") and len(d["changes"][0]["old"]) == 101
    huge = al.encode_data({f"k{i}": "v" * 90 for i in range(50)})
    assert json.loads(huge) == {"_truncated": True}
    assert al.encode_data(None) is None
    assert al.decode_data(None) == {} and al.decode_data("[1]") == {} and al.decode_data("{bad") == {}
    assert al.decode_data('{"a":1}') == {"a": 1}


# ── record_after_commit ───────────────────────────────────────────────────────

def test_record_after_commit_uses_its_own_transaction(Session, engine):
    db = Session()
    u = _user(db)
    al.record_after_commit(al.TRADE_CORRECTED, user_id=u.id, mt5_login="5001", ref_id="o1",
                           data={"was": "FAILED", "action": "ORDER", "sym": "XAUUSD",
                                 "side": "BUY", "vol": 0.1, "px": 2400.5,
                                 "at": al.iso_utc(datetime(2026, 10, 9, 1, 2, 3))},
                           dedupe_key=al.corrected_key("o1"), bind=db)
    # 调用方随后回滚也不影响它：它不在调用方的事务里 / independent of the caller
    db.rollback()
    al.record_after_commit(al.TRADE_CORRECTED, user_id=u.id, ref_id="o1", data={"was": "FAILED"},
                           dedupe_key=al.corrected_key("o1"), bind=engine)
    db.close()
    [ev] = _events(engine)
    assert ev["kind"] == "trade.corrected" and ev["actor_type"] == "system" and ev["actor_id"] is None
    assert ev["dedupe_key"] == "corrected:o1"
    assert json.loads(ev["data"])["at"] == "2026-10-09T01:02:03.000000Z"


def test_record_after_commit_never_raises(engine, tmp_path, caplog):
    bare = create_engine("sqlite:///" + str(tmp_path / "bare.db").replace("\\", "/"))
    with caplog.at_level(logging.WARNING, logger="prismx.activity_log"):
        al.record_after_commit(al.TRADE_CORRECTED, data={"was": "FAILED"}, bind=bare)  # 没有这张表
        al.record_after_commit("bogus.kind", bind=engine)
    bare.dispose()
    assert _events(engine) == []
    assert caplog.text.count("已跳过") == 2


# ── 去重键 / dedupe keys ──────────────────────────────────────────────────────

def test_dedupe_key_formats_are_stable():
    aware = datetime(2026, 10, 9, 6, 3, 21, 5, tzinfo=timezone.utc)
    naive = aware.replace(tzinfo=None)
    assert al.close_all_key("u", "ca_co_1", "5001") == "ca:u:ca_co_1:5001"
    assert al.close_all_key("u", "ca_co_1", None) == "ca:u:ca_co_1:"
    assert al.revoke_key("acc", 1700000000) == "revoke:acc:1700000000"
    assert al.revoke_key("acc", None) == "revoke:acc:"
    assert al.bridge_bind_new_key("u", "5001", None) == "mt5bind:u:5001::new"
    assert al.bridge_bind_new_key("u", 5001, "Srv-Live") == "mt5bind:u:5001:Srv-Live:new"
    # 带不带时区、从库里读还是刚在内存里设的，键都一样 / aware or naive, same key
    assert al.bridge_bind_revived_key("acc", aware) == al.bridge_bind_revived_key("acc", naive) \
        == "mt5bind:acc:2026-10-09T06:03:21.000005Z"
    assert al.backfill_unbind_key("acc", naive) == "bf:unbind:acc:2026-10-09T06:03:21.000005Z"
    assert al.corrected_key("o1") == "corrected:o1"
    assert al.demo_of(None) is None and al.demo_of(-1) is None
    assert al.demo_of(0) is True and al.demo_of(1) is True and al.demo_of(2) is False


def test_kinds_and_categories_cover_each_other():
    assert len(al.KINDS) == 15
    assert set(al.KIND_CATEGORY) == set(al.KINDS)
    assert al.ABNORMAL_KINDS <= al.KINDS and al.MT5_KINDS <= al.KINDS


def test_login_quota_allows_three_per_hour(monkeypatch):
    from app.core.config import settings
    from app.services import shared_state

    monkeypatch.setattr(settings, "REDIS_URL", "")
    monkeypatch.setattr(settings, "RATE_LIMIT_STORAGE_URI", "")
    shared_state.reset_for_tests()
    try:
        assert [al.login_event_allowed("u-quota") for _ in range(4)] == [True, True, True, False]
        assert al.login_event_allowed("someone-else") is True
    finally:
        shared_state.reset_for_tests()


# ── audit.log_change 的 op_id / op_id grouping ───────────────────────────────

def test_log_change_groups_one_session_under_one_op_id(Session, engine):
    db = Session()
    admin_id = _user(db, "admin@t.co", role="admin").id
    target_id = _user(db, "t@t.co").id
    audit.log_change(db, admin_id, target_id, "plan", "FREE", "PRO")
    audit.log_change(db, admin_id, target_id, "plan_expires_at", None, "2026-11-01")
    audit.log_change(db, admin_id, target_id, "plan_note", "x", "x")    # 没变，不写 / unchanged
    db.commit()
    audit.log_change(db, admin_id, target_id, "role", "user", "admin")  # 同一会话 / same session
    db.commit()
    db.close()

    db2 = Session()
    audit.log_change(db2, admin_id, target_id, "role", "admin", "user")
    db2.commit()
    db2.close()

    with engine.connect() as conn:
        rows = conn.execute(text(
            "SELECT field, op_id FROM admin_audit_logs ORDER BY created_at, id")).all()
    ops = {f: op for f, op in rows if f != "role"}
    assert set(ops) == {"plan", "plan_expires_at"}
    first = ops["plan"]
    assert first and len(first) == 12 and int(first, 16) >= 0
    role_ops = [op for f, op in rows if f == "role"]
    assert role_ops[0] == first           # 同一会话 = 同一次操作 / same session, same op
    assert role_ops[1] != first           # 新会话换编号 / new session, new op
    assert len(rows) == 4


# ── plan_expiry：条件 UPDATE / conditional downgrade ──────────────────────────

NOW = datetime.now(timezone.utc)


def _expired_user(Session):
    db = Session()
    u = _user(db, "exp@t.co", plan="PRO", plan_is_trial=True,
              plan_expires_at=(NOW - timedelta(days=1)).replace(tzinfo=None))
    uid = u.id
    db.close()
    return uid


def _auto_expire_rows(engine):
    with engine.connect() as conn:
        return conn.execute(text(
            "SELECT target_user_id, old_value, new_value, op_id FROM admin_audit_logs "
            "WHERE field = 'plan:auto_expire'")).all()


def test_downgrade_second_caller_does_nothing_and_writes_no_audit(Session, engine):
    """请求路径和后台扫描各拿着一份「已过期的 PRO」：只有先改到那一行的一方写审计，后到的
    一方返回 False、不写任何东西，内存值被刷新成库里的 FREE。
    Two holders of a stale "expired PRO": only the one whose UPDATE hits writes the
    audit row; the other returns False, writes nothing and sees FREE afterwards."""
    uid = _expired_user(Session)
    a, b = Session(), Session()
    ua, ub = a.get(User, uid), b.get(User, uid)
    assert ub.plan == "PRO"               # b 手里是旧值 / b holds the stale copy

    assert pe.downgrade_if_expired(a, ua) is True
    # 内存值已同步、对象不脏，提交不会再发一遍 UPDATE / synced, not dirty
    assert (ua.plan, ua.plan_expires_at, ua.plan_is_trial) == ("FREE", None, False)
    assert ua not in a.dirty
    a.commit()

    assert pe.downgrade_if_expired(b, ub) is False
    assert (ub.plan, ub.plan_expires_at) == ("FREE", None)   # 刷新成库里的值 / refreshed
    b.commit()
    a.close(); b.close()

    assert _auto_expire_rows(engine) == [(uid, "PRO", "FREE", None)]   # 直接写的系统行 op_id 为空
    c = Session()
    row = c.get(User, uid)
    assert (row.plan, row.plan_expires_at, row.plan_is_trial) == ("FREE", None, False)
    c.close()


def test_downgrade_does_not_undo_a_concurrent_renewal(Session, engine):
    """内存里看着过期了，但管理员刚在另一个会话续了期：条件 UPDATE 改不到行，等级不动、
    不写审计，内存值刷成新的到期时间。
    An admin renewed in another session: the stale copy must not undo it."""
    uid = _expired_user(Session)
    stale = Session()
    u = stale.get(User, uid)
    admin = Session()
    renewed = (NOW + timedelta(days=30)).replace(tzinfo=None, microsecond=0)
    admin.get(User, uid).plan_expires_at = renewed
    admin.commit()
    admin.close()

    assert pe.downgrade_if_expired(stale, u) is False
    assert u.plan == "PRO" and u.plan_expires_at == renewed
    stale.commit()
    stale.close()
    assert _auto_expire_rows(engine) == []


def test_downgrade_noop_for_unexpired_or_free(Session, engine):
    db = Session()
    alive = _user(db, "ok@t.co", plan="PRO", plan_expires_at=(NOW + timedelta(days=3)).replace(tzinfo=None))
    free = _user(db, "free@t.co")
    assert pe.downgrade_if_expired(db, alive) is False
    assert pe.downgrade_if_expired(db, free) is False
    db.close()
    assert _auto_expire_rows(engine) == []


def test_sweep_and_request_path_together_write_one_audit_row(Session, engine, monkeypatch):
    """后台扫描先降、请求路径（拿着扫描前读出的旧对象）后到：仍然只有一行审计。
    The sweep downgrades first, then the request path with its pre-sweep copy: one row."""
    uid = _expired_user(Session)
    request_db = Session()
    request_user = request_db.get(User, uid)
    monkeypatch.setattr(pe, "SessionLocal", Session)
    assert pe.sweep_expired_plans(NOW) == 1
    assert pe.downgrade_if_expired(request_db, request_user) is False
    request_db.close()
    assert pe.sweep_expired_plans(NOW) == 0
    assert len(_auto_expire_rows(engine)) == 1


# ── 保留期清扫 / retention sweep ─────────────────────────────────────────────

def _seed_events(engine, ages_days: list[int]) -> None:
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    with engine.begin() as conn:
        for i, age in enumerate(ages_days):
            conn.execute(ActivityEvent.__table__.insert().values(
                id=f"e{i:03d}", created_at=now - timedelta(days=age), kind=al.USER_LOGIN,
                actor_type="user", user_id="u", data="{}",
            ))


def _event_ids(engine) -> set[str]:
    with engine.connect() as conn:
        return {r[0] for r in conn.execute(text("SELECT id FROM activity_events"))}


def test_prune_deletes_only_expired_rows_in_batches(Session, engine):
    _seed_events(engine, [800] * 7 + [729, 10, 0])
    db = Session()
    assert al.prune_expired(db, retention_days=730, batch_size=3) == 7   # 3 + 3 + 1 批
    assert _event_ids(engine) == {"e007", "e008", "e009"}
    assert al.prune_expired(db, retention_days=730, batch_size=3) == 0
    assert al.prune_expired(db, retention_days=0) == 0                   # 0 = 不清理 / disabled
    db.close()


def test_prune_defaults_to_the_setting(Session, engine, monkeypatch):
    from app.core.config import settings

    assert settings.ACTIVITY_RETENTION_DAYS == 730
    monkeypatch.setattr(settings, "ACTIVITY_RETENTION_DAYS", 5)
    _seed_events(engine, [6, 4])
    db = Session()
    assert al.prune_expired(db) == 1
    db.close()
    assert _event_ids(engine) == {"e001"}


def test_daily_candle_sweep_also_prunes_activity_events(Session, engine, monkeypatch):
    import app.services.candle_store as cs

    _seed_events(engine, [900, 1])
    monkeypatch.setattr(cs, "SessionLocal", Session)
    cs._run_retention_sweep()
    assert _event_ids(engine) == {"e001"}


def test_activity_prune_failure_does_not_fail_the_candle_sweep(Session, engine, monkeypatch, caplog):
    import app.services.candle_store as cs

    def boom(_db):
        raise RuntimeError("db down")

    monkeypatch.setattr(cs, "SessionLocal", Session)
    monkeypatch.setattr(cs, "prune_expired_activity", boom)
    with caplog.at_level(logging.WARNING, logger="prismx.candle_store"):
        cs._run_retention_sweep()          # 不抛 / no raise
    assert "activity_events 清理失败" in caplog.text
