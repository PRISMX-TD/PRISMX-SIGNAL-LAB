# backend/tests/test_lucky_schema.py
"""幸运轮盘建表（rev 46 结构）与 rev 45 → 46 的迁移。

迁移测试在一个「rev 45 时的库」上真跑 _migrate_columns：5 张 lucky 表是旧结构、里面有数据、
platform_settings 里有已废弃的全站开关、schema_rev = 45。跑完要求：5 张表是新结构、全空，开关行没了，
版本号写成 46。旧表定义手抄一份是故意的——它锚定 rev 45 线上的样子，不能跟着模型漂移。

Lucky-wheel schema (rev 46) and the rev 45 -> 46 migration, run for real against a rev-45 database:
old-structure tables holding rows, the retired site-wide switch row, schema_rev = 45. Afterwards the
5 tables have the new structure and are empty, the switch row is gone and the revision reads 46. The
legacy DDL is copied by hand on purpose: it pins what production looked like at rev 45.
"""
import json

import pytest
from sqlalchemy import create_engine, inspect, text

import app.core.database as db_mod
from app.models import LuckyDraw, LuckyPrize, LuckyRound, LuckyTicket, User
from app.services.lucky import common

LUCKY = ("lucky_wheel_rounds", "lucky_wheel_prizes", "lucky_ticket_batches", "lucky_tickets", "lucky_draws")


def test_schema_rev_is_46():
    assert db_mod.CURRENT_SCHEMA_REV == 46


def test_tables_exist_with_v2_columns(db_session):
    insp = inspect(db_session.get_bind())
    assert set(LUCKY) <= set(insp.get_table_names())
    cols = {t: {c["name"] for c in insp.get_columns(t)} for t in LUCKY}
    assert {"name", "mode", "visible"} <= cols["lucky_wheel_rounds"]
    assert "round_id" in cols["lucky_wheel_prizes"]
    assert not ({"per_user_limit", "on_sold_out"} & cols["lucky_wheel_prizes"])
    assert "sold_out_miss" in cols["lucky_draws"]


def test_round_defaults(db_session):
    u = User(email="a@t.co", password_hash="x", api_token="t-a")
    db_session.add(u)
    db_session.flush()
    r = LuckyRound(name="第一期", starts_at=common.utcnow(), ends_at=common.utcnow(), created_by=u.id)
    db_session.add(r)
    db_session.commit()
    assert r.visible is False and r.mode == "prob"


def test_draw_ticket_unique(db_session):
    from sqlalchemy.exc import IntegrityError
    u = User(email="a@t.co", password_hash="x", api_token="t-a")
    db_session.add(u)
    db_session.flush()
    r = LuckyRound(name="一期", starts_at=common.utcnow(), ends_at=common.utcnow(), created_by=u.id)
    db_session.add(r)
    db_session.flush()
    p = LuckyPrize(round_id=r.id, sort_order=0, name="谢谢参与", kind="none", prob_bp=10000)
    db_session.add(p)
    db_session.flush()
    t = LuckyTicket(user_id=u.id, round_id=r.id, source="manual", status="used")
    db_session.add(t)
    db_session.flush()
    db_session.add(LuckyDraw(user_id=u.id, round_id=r.id, ticket_id=t.id, prize_id=p.id,
                             prize_snapshot="{}", request_id="r1", fulfillment_status="auto_done"))
    db_session.flush()
    assert db_session.query(LuckyDraw).one().sold_out_miss is False
    db_session.add(LuckyDraw(user_id=u.id, round_id=r.id, ticket_id=t.id, prize_id=p.id,
                             prize_snapshot="{}", request_id="r2", fulfillment_status="auto_done"))
    with pytest.raises(IntegrityError):
        db_session.flush()


# ---- rev 45 → 46 迁移 / migration ----

# rev 45 上线时的 5 张表（手抄，见模块说明）/ the 5 tables as shipped in rev 45 (copied by hand)
_LEGACY_DDL = [
    """CREATE TABLE lucky_wheel_rounds (
        id VARCHAR NOT NULL PRIMARY KEY,
        starts_at DATETIME NOT NULL,
        ends_at DATETIME NOT NULL,
        ended_at DATETIME,
        reminder_sent_at DATETIME,
        created_by VARCHAR NOT NULL REFERENCES users (id),
        created_at DATETIME
    )""",
    "CREATE INDEX idx_lucky_rounds_ended_ends ON lucky_wheel_rounds (ended_at, ends_at)",
    """CREATE TABLE lucky_wheel_prizes (
        id VARCHAR NOT NULL PRIMARY KEY,
        sort_order INTEGER NOT NULL,
        name VARCHAR NOT NULL,
        description TEXT,
        image_url VARCHAR,
        color VARCHAR,
        kind VARCHAR NOT NULL,
        pro_days INTEGER,
        prob_bp INTEGER NOT NULL,
        stock INTEGER,
        stock_used INTEGER NOT NULL,
        per_user_limit INTEGER,
        on_sold_out VARCHAR NOT NULL,
        claim_mode VARCHAR,
        claim_hint VARCHAR,
        archived BOOLEAN NOT NULL,
        updated_at DATETIME
    )""",
    """CREATE TABLE lucky_ticket_batches (
        id VARCHAR NOT NULL PRIMARY KEY,
        round_id VARCHAR NOT NULL REFERENCES lucky_wheel_rounds (id),
        reason VARCHAR NOT NULL,
        created_by VARCHAR NOT NULL REFERENCES users (id),
        created_at DATETIME,
        user_count INTEGER NOT NULL,
        ticket_count INTEGER NOT NULL,
        notified_at DATETIME,
        request_id VARCHAR NOT NULL UNIQUE
    )""",
    "CREATE INDEX ix_lucky_ticket_batches_round_id ON lucky_ticket_batches (round_id)",
    """CREATE TABLE lucky_tickets (
        id VARCHAR NOT NULL PRIMARY KEY,
        user_id VARCHAR NOT NULL REFERENCES users (id),
        round_id VARCHAR NOT NULL REFERENCES lucky_wheel_rounds (id),
        batch_id VARCHAR REFERENCES lucky_ticket_batches (id),
        source VARCHAR NOT NULL,
        source_ref VARCHAR,
        rank INTEGER,
        status VARCHAR NOT NULL,
        issued_at DATETIME,
        used_at DATETIME,
        voided_at DATETIME
    )""",
    "CREATE INDEX idx_lucky_tickets_user_round_status ON lucky_tickets (user_id, round_id, status)",
    """CREATE TABLE lucky_draws (
        id VARCHAR NOT NULL PRIMARY KEY,
        user_id VARCHAR NOT NULL REFERENCES users (id),
        round_id VARCHAR NOT NULL REFERENCES lucky_wheel_rounds (id),
        ticket_id VARCHAR NOT NULL UNIQUE REFERENCES lucky_tickets (id),
        prize_id VARCHAR NOT NULL REFERENCES lucky_wheel_prizes (id),
        prize_snapshot TEXT NOT NULL,
        request_id VARCHAR NOT NULL,
        created_at DATETIME,
        fulfillment_status VARCHAR NOT NULL,
        claim_info TEXT,
        support_ticket_id VARCHAR REFERENCES tickets (id) ON DELETE SET NULL,
        handled_by VARCHAR REFERENCES users (id),
        handled_at DATETIME,
        admin_note VARCHAR,
        CONSTRAINT uq_lucky_draw_request UNIQUE (user_id, request_id)
    )""",
]

_LEGACY_ROWS = [
    "INSERT INTO lucky_wheel_rounds (id, starts_at, ends_at, created_by) "
    "VALUES ('r1', '2026-10-22 00:00:00', '2026-10-30 00:00:00', 'u1')",
    "INSERT INTO lucky_wheel_prizes (id, sort_order, name, kind, prob_bp, stock_used, on_sold_out, archived) "
    "VALUES ('p1', 0, '谢谢参与', 'none', 10000, 1, 'to_fallback', 0)",
    "INSERT INTO lucky_ticket_batches (id, round_id, reason, created_by, user_count, ticket_count, request_id) "
    "VALUES ('b1', 'r1', '测试', 'u1', 1, 1, 'req-b1')",
    "INSERT INTO lucky_tickets (id, user_id, round_id, batch_id, source, status) "
    "VALUES ('t1', 'u1', 'r1', 'b1', 'manual', 'used')",
    "INSERT INTO lucky_draws (id, user_id, round_id, ticket_id, prize_id, prize_snapshot, request_id, "
    "fulfillment_status) VALUES ('d1', 'u1', 'r1', 't1', 'p1', '{}', 'req-d1', 'auto_done')",
]


@pytest.fixture()
def rev45_engine(monkeypatch, tmp_path):
    """一个 rev 45 时的库：全表结构，但 5 张 lucky 表换成旧定义并带数据，schema_rev = 45。
    A rev-45 database: full schema, the 5 lucky tables swapped for the old ones with rows, schema_rev = 45."""
    from sqlalchemy.orm import sessionmaker

    from app.core.database import Base
    import app.models  # noqa: F401  —— 注册模型 / registers the tables

    url = "sqlite:///" + str(tmp_path / "rev45.db").replace("\\", "/")
    eng = create_engine(url, connect_args={"check_same_thread": False})
    Base.metadata.create_all(eng)
    with sessionmaker(bind=eng)() as s:
        s.add(User(id="u1", email="u1@t.co", password_hash="x", api_token="tok-u1"))
        s.commit()
    with eng.begin() as conn:
        for t in LUCKY:
            conn.execute(text(f"DROP TABLE {t}"))
        for ddl in _LEGACY_DDL:
            conn.execute(text(ddl))
        for sql in _LEGACY_ROWS:
            conn.execute(text(sql))
        conn.execute(text("INSERT INTO platform_settings (id, key, value) VALUES ('s1', 'schema_rev', '45')"))
        conn.execute(text("INSERT INTO platform_settings (id, key, value) VALUES ('s2', 'lucky_wheel_visible', 'true')"))
    monkeypatch.setattr(db_mod, "engine", eng)
    monkeypatch.setattr(db_mod, "SessionLocal", sessionmaker(bind=eng, autocommit=False, autoflush=False))
    try:
        yield eng
    finally:
        eng.dispose()


def test_rev46_rebuilds_lucky_tables_empty_and_drops_the_switch(rev45_engine):
    # 迁移前：确实是旧结构、有数据 / before: old structure, with rows
    insp = inspect(rev45_engine)
    assert "per_user_limit" in {c["name"] for c in insp.get_columns("lucky_wheel_prizes")}

    # 照 init_db 的顺序：create_all 在前（旧表在，跳过），迁移在后 / init_db's order: create_all, then migrate
    from app.core.database import Base
    Base.metadata.create_all(rev45_engine)
    db_mod._migrate_columns()

    insp = inspect(rev45_engine)
    cols = {t: {c["name"] for c in insp.get_columns(t)} for t in LUCKY}
    assert {"name", "mode", "visible"} <= cols["lucky_wheel_rounds"]
    assert "round_id" in cols["lucky_wheel_prizes"]
    assert not ({"per_user_limit", "on_sold_out"} & cols["lucky_wheel_prizes"])
    assert "sold_out_miss" in cols["lucky_draws"]
    with rev45_engine.connect() as conn:
        for t in LUCKY:
            assert conn.execute(text(f"SELECT COUNT(*) FROM {t}")).scalar() == 0, f"{t} 没清空"
        keys = {k: v for k, v in conn.execute(text("SELECT key, value FROM platform_settings"))}
        assert conn.execute(text("SELECT COUNT(*) FROM users")).scalar() == 1   # 别的表不受影响 / others untouched
    assert "lucky_wheel_visible" not in keys
    assert json.loads(keys["schema_rev"]) == 46
    # 新结构能直接用：索引齐、可以写入 / the new tables work: indexes rebuilt, rows insert
    idx = {i["name"] for i in insp.get_indexes("lucky_tickets")}
    assert "idx_lucky_tickets_user_round_status" in idx
    assert "ix_lucky_wheel_prizes_round_id" in {i["name"] for i in insp.get_indexes("lucky_wheel_prizes")}
    with rev45_engine.begin() as conn:
        conn.execute(text("INSERT INTO lucky_wheel_rounds (id, name, mode, visible, starts_at, ends_at, created_by) "
                          "VALUES ('n1', '新一期', 'qty', 0, '2026-10-22 00:00:00', '2026-10-30 00:00:00', 'u1')"))


def test_rev46_reset_runs_only_once(rev45_engine):
    """版本号已是 46（或读不到但结构已是新的）时绝不清表——那是 v2 的正式数据。
    Once at 46 (or unreadable with the new structure) the tables are never wiped: that is real v2 data."""
    from app.core.database import Base
    db_mod._migrate_columns()                              # 45 → 46，清空重建 / wipe + rebuild
    with rev45_engine.begin() as conn:
        conn.execute(text("INSERT INTO lucky_wheel_rounds (id, name, mode, visible, starts_at, ends_at, created_by) "
                          "VALUES ('n1', '正式一期', 'prob', 1, '2026-10-22 00:00:00', '2026-10-30 00:00:00', 'u1')"))
    Base.metadata.create_all(rev45_engine)
    db_mod._migrate_columns()                              # 快速通道 / fast path
    db_mod._reset_lucky_wheel_rev46(46, False)
    db_mod._reset_lucky_wheel_rev46(None, False)
    with rev45_engine.connect() as conn:
        assert conn.execute(text("SELECT COUNT(*) FROM lucky_wheel_rounds")).scalar() == 1
