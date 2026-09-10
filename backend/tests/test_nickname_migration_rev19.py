"""rev 19 迁移：旧库的 users 表没有 nickname_key。跑真迁移后：已有昵称的行拿到
归一 key、同名组只有注册最早的那个留住昵称（其余两列一起清空）、唯一索引在。
重跑一次不再动任何人。

rev 19 migration: a legacy users table without nickname_key. After the real
migration every nicknamed row has its normalized key, each collision group keeps
only the earliest registration (the rest have both columns cleared), and the
unique index exists. A second run changes nothing further.
"""
import pytest
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import sessionmaker

import app.core.database as db_mod


# (id, email, nickname) —— u2/u3/u4 是同一个名字的三种写法，u5 全是空白，
# u6 没设过。id 的字典序即"注册先后"（迁移按 id 排序取最小）。
SEED = [
    ("u1", "a@t.co", "Alice"),
    ("u2", "b@t.co", "Trader Joe"),
    ("u3", "c@t.co", "trader joe"),
    ("u4", "d@t.co", "TRADERJOE"),
    ("u5", "e@t.co", "   "),
    ("u6", "f@t.co", None),
]


@pytest.fixture()
def legacy_engine(monkeypatch, tmp_path):
    url = "sqlite:///" + str(tmp_path / "legacy.db").replace("\\", "/")
    eng = create_engine(url, connect_args={"check_same_thread": False})
    from app.core.database import Base
    import app.models  # noqa: F401
    Base.metadata.create_all(eng)
    from app.models import User
    session = sessionmaker(bind=eng)()
    session.add_all([User(id=u, email=e, api_token="tok_" + u, nickname=n) for u, e, n in SEED])
    session.commit(); session.close()
    # 重建成 rev 18 的样子：去掉 nickname_key 列。同时要丢掉它的唯一索引，
    # 否则 CREATE TABLE AS SELECT 换名后索引还指着旧表名。
    # Rebuild as rev 18 by dropping nickname_key (and its index, which would
    # otherwise dangle after the rename).
    keep = [c["name"] for c in inspect(eng).get_columns("users") if c["name"] != "nickname_key"]
    with eng.begin() as conn:
        conn.execute(text("DROP INDEX IF EXISTS uq_users_nickname_key"))
        conn.execute(text(f"CREATE TABLE users_legacy AS SELECT {', '.join(keep)} FROM users"))
        conn.execute(text("DROP TABLE users"))
        conn.execute(text("ALTER TABLE users_legacy RENAME TO users"))
        conn.execute(text("INSERT INTO platform_settings (id, key, value) VALUES ('ps-r', 'schema_rev', '18')"))
    monkeypatch.setattr(db_mod, "engine", eng)
    monkeypatch.setattr(db_mod, "SessionLocal", sessionmaker(bind=eng, autocommit=False, autoflush=False))
    return eng


def _snapshot(eng):
    with eng.connect() as conn:
        return {u: (n, k) for u, n, k in conn.execute(
            text("SELECT id, nickname, nickname_key FROM users")).fetchall()}


def test_rev19_keys_backfilled_and_duplicates_cleared(legacy_engine):
    assert "nickname_key" not in {c["name"] for c in inspect(legacy_engine).get_columns("users")}

    db_mod._migrate_columns()

    rows = _snapshot(legacy_engine)
    assert rows["u1"] == ("Alice", "alice")
    # 同名三人只有 u2（id 最小 = 注册最早）留住名字，另两个被清空待重设。
    assert rows["u2"] == ("Trader Joe", "traderjoe")
    assert rows["u3"] == (None, None)
    assert rows["u4"] == (None, None)
    # 全空白的昵称没有可比的 key，当成没设过。
    assert rows["u5"] == (None, None)
    assert rows["u6"] == (None, None)

    insp = inspect(legacy_engine)
    assert any(i["name"] == "uq_users_nickname_key" and i["unique"] for i in insp.get_indexes("users"))
    assert db_mod._read_schema_rev() == db_mod.CURRENT_SCHEMA_REV


def test_rev19_unique_index_actually_rejects_a_duplicate(legacy_engine):
    db_mod._migrate_columns()
    with pytest.raises(Exception):
        with legacy_engine.begin() as conn:
            conn.execute(text("UPDATE users SET nickname_key = 'traderjoe' WHERE id = 'u3'"))


def test_rev19_second_run_is_a_no_op(legacy_engine):
    db_mod._migrate_columns()
    before = _snapshot(legacy_engine)
    db_mod._write_schema_rev(0)     # 强制再走一遍完整迁移
    db_mod._migrate_columns()
    assert _snapshot(legacy_engine) == before
