"""rev 38（操作日志）的迁移：新表、四个新列、三条 (created_at, id) 索引、三类历史补录。

旧库造法同 test_schema_rev37：create_all 建全表，再把 rev 38 新增的东西拿掉（activity_events
整张表、四列、三条索引），塞一些历史数据，然后跑真正的 init_db（create_all 补出新表 +
_migrate_columns）。补录必须幂等：重跑迁移、两次调用补录函数都不能多出一行。

rev 38 migration: new table, four new columns, three (created_at, id) indexes and
the three-part backfill. The legacy database is built like test_schema_rev37 —
full schema minus everything rev 38 adds, seeded with history — and the real
init_db runs on it. The backfill must be idempotent across re-runs.
"""
import json
from datetime import datetime, timedelta

import pytest
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import sessionmaker

import app.core.database as db_mod
from app.services import activity_log as al

T0 = datetime(2026, 9, 1, 8, 0, 0, 123456)

_NEW_INDEXES = {
    "orders": ("idx_orders_created_id", ["created_at", "id"]),
    "closed_trades": ("idx_closed_trades_created_id", ["created_at", "id"]),
    "admin_audit_logs": ("idx_admin_audit_logs_created_id", ["created_at", "id"]),
}


def _ts(dt: datetime) -> str:
    """裸 SQL 参数里的时间写成 SQLAlchemy 在 SQLite 上的存储格式（sqlite3 的默认 datetime
    适配器在 3.12 起弃用，pytest 会把那条告警当错误）。
    Raw-SQL timestamps in SQLAlchemy's SQLite storage format (sqlite3's default
    datetime adapter is deprecated since 3.12 and warnings are errors here)."""
    return dt.isoformat(sep=" ", timespec="microseconds")


def _swap_engine(monkeypatch, eng):
    monkeypatch.setattr(db_mod, "engine", eng)
    monkeypatch.setattr(
        db_mod, "SessionLocal", sessionmaker(bind=eng, autocommit=False, autoflush=False)
    )


def _seed_history(conn):
    """两个用户；u1 两批一键平仓（第一批两个账号）+ 一条普通指令；u2 一批；u1 一个解绑的
    桥接账号、一个改密失效的直连账号、一个正常账号；u2 一个解绑账号但已有 mt5.* 事件
    （由各用例自己决定要不要插那条事件）。
    Two users with close-all batches, a plain order, and accounts in every state."""
    for uid in ("u1", "u2"):
        conn.execute(text(
            "INSERT INTO users (id, email, api_token, role, plan, plan_is_trial, token_version, "
            "nickname_public, leaderboard_opt_out, stats_public, phone_required) "
            f"VALUES ('{uid}', '{uid}@t.co', 'tok_{uid}', 'user', 'FREE', 0, 0, 0, 0, 0, 0)"))

    def order(oid, uid, cid, login, minutes):
        conn.execute(text(
            "INSERT INTO orders (id, user_id, client_order_id, action, symbol, side, volume, "
            "ticket, mt5_login, status, created_at) "
            "VALUES (:id, :u, :c, 'CLOSE', 'XAUUSD', 'BUY', 0, 1, :l, 'FILLED', :t)"),
            {"id": oid, "u": uid, "c": cid, "l": login, "t": _ts(T0 + timedelta(minutes=minutes))})

    order("o1", "u1", "ca_co_a#5001#11", "5001", 2)
    order("o2", "u1", "ca_co_a#5001#12", "5001", 1)      # 组内最早 / earliest in its group
    order("o3", "u1", "ca_co_a#6002#13", "6002", 3)
    order("o4", "u1", "ca_co_b#14", None, 10)            # 不带账号的旧子单 / login-less child
    order("o5", "u2", "ca_co_c#7003#15", "7003", 20)
    order("o6", "u1", "co_plain_1", "5001", 30)          # 不是一键平仓 / not a close-all child
    order("o7", "u1", "cax_not_prefix", "5001", 31)      # 下划线必须转义 / `_` is escaped

    def account(aid, uid, login, source, reason, revoked_minutes, pca=None, name=None):
        conn.execute(text(
            "INSERT INTO mt5_accounts (id, user_id, login, server, source, account_name, "
            "revoked_reason, revoked_at, pass_change_at, online) "
            "VALUES (:id, :u, :l, '', :s, :n, :r, :t, :p, 0)"),
            {"id": aid, "u": uid, "l": login, "s": source, "n": name, "r": reason,
             "t": None if revoked_minutes is None else _ts(T0 + timedelta(minutes=revoked_minutes)),
             "p": pca})

    account("acc-removed", "u1", "5001", "bridge", "user_removed", 40, name="Alice Demo")
    account("acc-revoked", "u1", "6002", "gateway", "password_changed", 50, pca=1700000000)
    account("acc-live", "u1", "8004", "gateway", None, None)
    account("acc-removed-2", "u2", "7003", "gateway", "user_removed", 60)


@pytest.fixture()
def legacy_engine(monkeypatch, tmp_path):
    from app.core.database import Base
    import app.models  # noqa: F401  —— 注册模型 / registers the tables

    url = "sqlite:///" + str(tmp_path / "legacy38.db").replace("\\", "/")
    eng = create_engine(url, connect_args={"check_same_thread": False})
    Base.metadata.create_all(eng)
    with eng.begin() as conn:
        conn.execute(text("DROP TABLE activity_events"))
        for col in ("prev_sl", "prev_tp", "pos_volume"):
            conn.execute(text(f"ALTER TABLE orders DROP COLUMN {col}"))
        conn.execute(text("ALTER TABLE admin_audit_logs DROP COLUMN op_id"))
        for _table, (name, _cols) in _NEW_INDEXES.items():
            conn.execute(text(f"DROP INDEX IF EXISTS {name}"))
        _seed_history(conn)
    _swap_engine(monkeypatch, eng)
    db_mod._write_schema_rev(37)   # 旧库记的是 37 / the legacy database is at rev 37
    yield eng
    eng.dispose()


def _cols(eng, table):
    return {c["name"] for c in inspect(eng).get_columns(table)}


def _indexes(eng, table):
    return {i["name"]: (list(i["column_names"]), bool(i.get("unique"))) for i in inspect(eng).get_indexes(table)}


def _events(eng):
    with eng.connect() as conn:
        rows = conn.execute(text(
            "SELECT kind, actor_type, actor_id, user_id, mt5_login, ref_id, data, dedupe_key, "
            "created_at FROM activity_events ORDER BY dedupe_key")).mappings().all()
    return [dict(r) for r in rows]


def test_schema_rev_is_at_least_38():
    # 后续版本只会往上加（rev 39 游客预览漏斗表）；这里守的是「操作日志那一版已在」。
    # Later revs only add on top (rev 39: guest-preview funnel table).
    assert db_mod.CURRENT_SCHEMA_REV >= 38


def test_fresh_database_gets_table_columns_and_indexes(monkeypatch, tmp_path):
    from app.core.database import Base
    import app.models  # noqa: F401

    eng = create_engine("sqlite:///" + str(tmp_path / "fresh.db").replace("\\", "/"),
                        connect_args={"check_same_thread": False})
    _swap_engine(monkeypatch, eng)
    db_mod.init_db()

    assert {"prev_sl", "prev_tp", "pos_volume"} <= _cols(eng, "orders")
    assert "op_id" in _cols(eng, "admin_audit_logs")
    assert {"id", "created_at", "kind", "actor_type", "actor_id", "user_id", "mt5_login",
            "ref_id", "data", "dedupe_key"} == _cols(eng, "activity_events")
    ev_idx = _indexes(eng, "activity_events")
    assert ev_idx["idx_activity_events_created"] == (["created_at", "id"], False)
    assert ev_idx["idx_activity_events_user"] == (["user_id", "created_at"], False)
    assert ev_idx["uq_activity_events_dedupe"] == (["dedupe_key"], True)
    for table, (name, cols) in _NEW_INDEXES.items():
        assert _indexes(eng, table)[name] == (cols, False)
    assert db_mod._read_schema_rev() == db_mod.CURRENT_SCHEMA_REV
    assert _events(eng) == []          # 空库没什么可补 / nothing to backfill
    eng.dispose()


def test_rev37_database_is_upgraded_and_backfilled(legacy_engine):
    eng = legacy_engine
    assert "activity_events" not in inspect(eng).get_table_names()

    db_mod.init_db()

    assert {"prev_sl", "prev_tp", "pos_volume"} <= _cols(eng, "orders")
    assert "op_id" in _cols(eng, "admin_audit_logs")
    for table, (name, cols) in _NEW_INDEXES.items():
        assert _indexes(eng, table)[name] == (cols, False)
    with eng.connect() as conn:
        # 新列不回填 / new columns are not backfilled
        assert conn.execute(text(
            "SELECT COUNT(*) FROM orders WHERE prev_sl IS NOT NULL OR prev_tp IS NOT NULL "
            "OR pos_volume IS NOT NULL")).scalar_one() == 0
    assert db_mod._read_schema_rev() == db_mod.CURRENT_SCHEMA_REV

    evs = {e["dedupe_key"]: e for e in _events(eng)}
    assert set(evs) == {
        "ca:u1:ca_co_a:5001", "ca:u1:ca_co_a:6002", "ca:u1:ca_co_b:", "ca:u2:ca_co_c:7003",
        "bf:unbind:acc-removed:2026-09-01T08:40:00.123456Z",
        "bf:unbind:acc-removed-2:2026-09-01T09:00:00.123456Z",
        "revoke:acc-revoked:1700000000",
    }

    ca = evs["ca:u1:ca_co_a:5001"]
    assert (ca["kind"], ca["actor_type"], ca["actor_id"], ca["user_id"], ca["mt5_login"], ca["ref_id"]) \
        == ("trade.close_all", "user", "u1", "u1", "5001", "ca_co_a")
    assert json.loads(ca["data"]) == {"count": 2, "bf": 1}
    assert ca["created_at"].startswith("2026-09-01 08:01:00.123456")   # 组内最早 / earliest child
    assert json.loads(evs["ca:u1:ca_co_a:6002"]["data"]) == {"count": 1, "bf": 1}
    assert evs["ca:u1:ca_co_b:"]["mt5_login"] is None

    unbind = evs["bf:unbind:acc-removed:2026-09-01T08:40:00.123456Z"]
    assert (unbind["kind"], unbind["actor_type"], unbind["user_id"], unbind["mt5_login"], unbind["ref_id"]) \
        == ("mt5.unbind", "user", "u1", "5001", "acc-removed")
    assert json.loads(unbind["data"]) == {"ch": "bridge", "name": "Alice Demo", "bf": 1}
    assert unbind["created_at"].startswith("2026-09-01 08:40:00.123456")

    rev = evs["revoke:acc-revoked:1700000000"]
    assert (rev["kind"], rev["actor_type"], rev["actor_id"], rev["mt5_login"], rev["ref_id"]) \
        == ("mt5.revoked", "system", None, "6002", "acc-revoked")
    assert json.loads(rev["data"]) == {"reason": "password_changed", "bf": 1}


def test_backfill_is_idempotent(legacy_engine):
    db_mod.init_db()
    before = _events(legacy_engine)
    assert len(before) == 7

    # 强制重跑整段迁移 + 直接再调两次补录 / forced re-run plus two direct calls
    db_mod._write_schema_rev(37)
    db_mod._migrate_columns()
    assert al.backfill_activity_events(legacy_engine) == {"close_all": 0, "unbind": 0, "revoked": 0}
    assert al.backfill_activity_events(legacy_engine) == {"close_all": 0, "unbind": 0, "revoked": 0}
    after = _events(legacy_engine)
    assert [e["dedupe_key"] for e in after] == [e["dedupe_key"] for e in before]
    assert db_mod._read_schema_rev() == db_mod.CURRENT_SCHEMA_REV


def test_backfill_matches_runtime_keys_and_skips_known_accounts(legacy_engine):
    """运行时已经记过的一键平仓 / 授权失效不再补第二行（键同格式）；已有 mt5.* 事件的
    (用户, 账号) 不补「最后一次解绑」。
    Events already recorded at runtime are not backfilled twice (same key format), and
    a (user, login) with any mt5.* event gets no backfilled unbind."""
    from app.core.database import Base

    Base.metadata.tables["activity_events"].create(legacy_engine)
    Session = sessionmaker(bind=legacy_engine, autocommit=False, autoflush=False)
    db = Session()
    db.execute(text("UPDATE orders SET status = status"))   # 开事务（SQLite 的 SAVEPOINT 需要）
    al.log_event(db, al.TRADE_CLOSE_ALL, user_id="u1", actor_id="u1", mt5_login="5001",
                 ref_id="ca_co_a", data={"count": 2, "skipped": 0},
                 dedupe_key=al.close_all_key("u1", "ca_co_a", "5001"))
    al.log_event(db, al.MT5_REVOKED, user_id="u1", mt5_login="6002", actor_type=al.ACTOR_SYSTEM,
                 ref_id="acc-revoked", data={"reason": "password_changed"},
                 dedupe_key=al.revoke_key("acc-revoked", 1700000000))
    al.log_event(db, al.MT5_BIND, user_id="u2", actor_id="u2", mt5_login="7003",
                 ref_id="acc-removed-2", data={"ch": "gateway", "revived": False})
    db.commit()
    db.close()

    db_mod.init_db()

    evs = {e["dedupe_key"]: e for e in _events(legacy_engine) if e["dedupe_key"]}
    # 运行时那两行原样保留（没有 bf 标记），没有补出第二行 / runtime rows kept, no twins
    assert json.loads(evs["ca:u1:ca_co_a:5001"]["data"]) == {"count": 2, "skipped": 0}
    assert json.loads(evs["revoke:acc-revoked:1700000000"]["data"]) == {"reason": "password_changed"}
    # u2/7003 已有 mt5.bind → 不补解绑；u1/5001 没有 mt5.* → 补 / skip vs backfill
    assert not any(k.startswith("bf:unbind:acc-removed-2:") for k in evs)
    assert any(k.startswith("bf:unbind:acc-removed:") for k in evs)
    with legacy_engine.connect() as conn:
        assert conn.execute(text("SELECT COUNT(*) FROM activity_events")).scalar_one() == 7


def test_backfill_failure_does_not_block_startup(legacy_engine, monkeypatch, caplog):
    import logging

    def boom(_engine):
        raise RuntimeError("backfill exploded")

    monkeypatch.setattr(al, "backfill_activity_events", boom)
    with caplog.at_level(logging.WARNING, logger="prismx.database"):
        db_mod.init_db()                      # 不抛 / no raise
    assert db_mod._read_schema_rev() == db_mod.CURRENT_SCHEMA_REV
    assert "操作日志历史补录失败" in caplog.text
