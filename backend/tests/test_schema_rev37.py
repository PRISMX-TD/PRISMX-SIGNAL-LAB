"""rev 37：invite_links.deleted_at（邀请链接软删）。

旧库造法同 test_schema_rev36：create_all 建全表再把本次新增的列删掉，在上面跑真正的
_migrate_columns。新列没有索引，SQLite 的 DROP COLUMN 不会被挡住。

Legacy DB built like test_schema_rev36: full schema minus the rev 37 column, then
the real _migrate_columns runs on it.
"""
import pytest
from sqlalchemy import create_engine, inspect, text

import app.core.database as db_mod


@pytest.fixture()
def legacy_engine(monkeypatch, tmp_path):
    from sqlalchemy.orm import sessionmaker

    from app.core.database import Base
    import app.models  # noqa: F401  —— 注册模型 / registers the tables

    url = "sqlite:///" + str(tmp_path / "legacy37.db").replace("\\", "/")
    eng = create_engine(url, connect_args={"check_same_thread": False})
    Base.metadata.create_all(eng)
    with eng.begin() as conn:
        conn.execute(text("ALTER TABLE invite_links DROP COLUMN deleted_at"))
        conn.execute(text(
            "INSERT INTO invite_links (id, code, label, clicks, is_active, grants_trial) "
            "VALUES ('l-old', 'old12345', '存量渠道', 3, 1, 0)"))

    monkeypatch.setattr(db_mod, "engine", eng)
    monkeypatch.setattr(
        db_mod, "SessionLocal", sessionmaker(bind=eng, autocommit=False, autoflush=False)
    )
    yield eng
    eng.dispose()


def _cols(eng, table):
    return {c["name"] for c in inspect(eng).get_columns(table)}


def test_schema_rev_bumped_to_37():
    assert db_mod.CURRENT_SCHEMA_REV == 37


def test_rev37_adds_deleted_at_without_backfill(legacy_engine):
    assert "deleted_at" not in _cols(legacy_engine, "invite_links")
    db_mod._migrate_columns()
    assert "deleted_at" in _cols(legacy_engine, "invite_links")
    with legacy_engine.connect() as conn:
        v = conn.execute(text("SELECT deleted_at FROM invite_links WHERE id = 'l-old'")).scalar_one()
    assert v is None
    assert db_mod._read_schema_rev() == db_mod.CURRENT_SCHEMA_REV


def test_rev37_forced_rerun_is_idempotent(legacy_engine):
    db_mod._migrate_columns()
    db_mod._write_schema_rev(db_mod.CURRENT_SCHEMA_REV - 1)
    db_mod._migrate_columns()   # 不该抛 / must not raise
    assert "deleted_at" in _cols(legacy_engine, "invite_links")


def test_rev37_model_default(db_session):
    from app.models import InviteLink

    link = InviteLink(code="abc12345", label="L")
    db_session.add(link)
    db_session.commit()
    assert link.deleted_at is None
