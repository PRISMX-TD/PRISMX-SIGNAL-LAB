"""rev 18 迁移：旧库的 users 表没有 public_id / stats_public 两列。跑真迁移后：
存量用户每人拿到唯一 public_id、stats_public 回填 false、唯一索引在；重跑一次
不改写已经发出去的 id。
rev 18 migration: a legacy users table without public_id / stats_public. After the
real migration every existing user has a unique public_id, stats_public is
backfilled to false and the unique index exists; a second run rewrites nothing.
"""
import pytest
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import sessionmaker

import app.core.database as db_mod


@pytest.fixture()
def legacy_engine(monkeypatch, tmp_path):
    url = "sqlite:///" + str(tmp_path / "legacy.db").replace("\\", "/")
    eng = create_engine(url, connect_args={"check_same_thread": False})
    from app.core.database import Base
    import app.models  # noqa: F401
    Base.metadata.create_all(eng)
    # 先走 ORM 建三行（users 的 NOT NULL 默认值都在 ORM 上），再把表重建成
    # rev 17 的样子：public_id 带唯一约束，SQLite 不允许 DROP 这种列，所以用
    # CREATE TABLE AS SELECT 去掉两列后换名——迁移只做 ADD COLUMN / UPDATE，
    # 不依赖被丢掉的约束。
    # Seed three rows via the ORM (users' NOT NULL defaults live there), then
    # rebuild the table as rev 17: SQLite refuses to DROP a column under a UNIQUE
    # constraint, so recreate it via CREATE TABLE AS SELECT minus the two columns.
    from app.models import User
    session = sessionmaker(bind=eng)()
    session.add_all([User(id=u, email=e, api_token="tok_" + u)
                     for u, e in (("u1", "a@t.co"), ("u2", "b@t.co"), ("u3", "c@t.co"))])
    session.commit(); session.close()
    keep = [c["name"] for c in inspect(eng).get_columns("users")
            if c["name"] not in ("public_id", "stats_public")]
    with eng.begin() as conn:
        conn.execute(text(f"CREATE TABLE users_legacy AS SELECT {', '.join(keep)} FROM users"))
        conn.execute(text("DROP TABLE users"))
        conn.execute(text("ALTER TABLE users_legacy RENAME TO users"))
        conn.execute(text("INSERT INTO platform_settings (id, key, value) VALUES ('ps-r', 'schema_rev', '17')"))
    monkeypatch.setattr(db_mod, "engine", eng)
    monkeypatch.setattr(db_mod, "SessionLocal", sessionmaker(bind=eng, autocommit=False, autoflush=False))
    return eng


def _snapshot(eng):
    with eng.connect() as conn:
        return {u: (p, s) for u, p, s in conn.execute(
            text("SELECT id, public_id, stats_public FROM users")).fetchall()}


def test_rev18_backfills_public_id_and_stats_public(legacy_engine):
    insp = inspect(legacy_engine)
    assert "public_id" not in {c["name"] for c in insp.get_columns("users")}

    db_mod._migrate_columns()

    insp = inspect(legacy_engine)
    cols = {c["name"] for c in insp.get_columns("users")}
    assert {"public_id", "stats_public"} <= cols
    rows = _snapshot(legacy_engine)
    ids = [p for p, _ in rows.values()]
    assert all(p and len(p) == 10 for p in ids) and len(set(ids)) == 3
    assert all(s in (0, False) for _, s in rows.values())
    assert any(i["name"] == "uq_users_public_id" and i["unique"] for i in insp.get_indexes("users"))
    assert db_mod._read_schema_rev() == db_mod.CURRENT_SCHEMA_REV


def test_rev18_second_run_keeps_existing_ids(legacy_engine):
    db_mod._migrate_columns()
    before = _snapshot(legacy_engine)
    db_mod._write_schema_rev(0)     # 强制再走一遍完整迁移
    db_mod._migrate_columns()
    assert _snapshot(legacy_engine) == before
