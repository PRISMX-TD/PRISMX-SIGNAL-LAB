"""rev 35：比赛推广链接 / 公开比赛页的列与新表（设计 2026-10-08 §2）。

旧库造法同 test_invite_links.legacy_invite_engine：create_all 建全表再把本次新增的列删掉，
在上面跑真正的 _migrate_columns。新列都没有 index=True（索引只在统一索引块里建），
所以 SQLite 的 DROP COLUMN 不会被索引挡住。

Legacy DB built like test_invite_links.legacy_invite_engine: full schema minus the
rev 35 columns, then the real _migrate_columns runs on it.
"""
from datetime import datetime, timezone

import pytest
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.exc import IntegrityError

import app.core.database as db_mod

_DROPPED = [
    ("invite_links", "competition_id"),
    ("invite_links", "channel"),
    ("competitions", "public_view"),
    ("competitions", "open_account_url"),
    ("competition_participants", "public_name"),
    ("competition_participants", "name_hidden"),
]


@pytest.fixture()
def legacy_engine(monkeypatch, tmp_path):
    from sqlalchemy.orm import sessionmaker

    from app.core.database import Base
    import app.models  # noqa: F401  —— 注册模型 / registers the tables

    url = "sqlite:///" + str(tmp_path / "legacy35.db").replace("\\", "/")
    eng = create_engine(url, connect_args={"check_same_thread": False})
    Base.metadata.create_all(eng)
    with eng.begin() as conn:
        conn.execute(text("DROP INDEX IF EXISTS idx_invite_links_competition"))
        for table, column in _DROPPED:
            conn.execute(text(f"ALTER TABLE {table} DROP COLUMN {column}"))
        conn.execute(text(
            "INSERT INTO competitions (id, name, track, metric, enrollment, status, starts_at, ends_at) "
            "VALUES ('c-old', 'Old', 'demo', 'return_pct', 'signup', 'running', "
            "'2026-09-01 00:00:00', '2026-09-08 00:00:00')"))
        conn.execute(text(
            "INSERT INTO competition_participants (id, competition_id, user_id, mt5_login, disqualified) "
            "VALUES ('p-old', 'c-old', 'u1', '5001', 0)"))
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


def test_schema_rev_bumped_to_35():
    assert db_mod.CURRENT_SCHEMA_REV == 35


def test_rev35_adds_columns_backfills_and_indexes(legacy_engine):
    for table, column in _DROPPED:
        assert column not in _cols(legacy_engine, table), f"fixture 没删掉 {table}.{column}"

    db_mod._migrate_columns()

    for table, column in _DROPPED:
        assert column in _cols(legacy_engine, table), f"迁移没有补上 {table}.{column}"
    with legacy_engine.connect() as conn:
        pv, url = conn.execute(text(
            "SELECT public_view, open_account_url FROM competitions WHERE id = 'c-old'")).one()
        pn, nh = conn.execute(text(
            "SELECT public_name, name_hidden FROM competition_participants WHERE id = 'p-old'")).one()
        cid, ch = conn.execute(text(
            "SELECT competition_id, channel FROM invite_links WHERE id = 'l-old'")).one()
    assert pv in (0, False), f"public_view 没回填 FALSE：{pv!r}"
    assert url is None
    assert nh in (0, False), f"name_hidden 没回填 FALSE：{nh!r}"
    assert pn is None, "public_name 不回填：NULL = 未表态（公开页匿名）"
    assert cid is None and ch is None
    idx = {i["name"]: list(i["column_names"]) for i in inspect(legacy_engine).get_indexes("invite_links")}
    assert idx.get("idx_invite_links_competition") == ["competition_id"]
    assert db_mod._read_schema_rev() == db_mod.CURRENT_SCHEMA_REV


def test_rev35_forced_rerun_is_idempotent(legacy_engine):
    db_mod._migrate_columns()
    db_mod._write_schema_rev(db_mod.CURRENT_SCHEMA_REV - 1)
    db_mod._migrate_columns()   # 不该抛 / must not raise
    assert "public_view" in _cols(legacy_engine, "competitions")
    assert "name_hidden" in _cols(legacy_engine, "competition_participants")


def test_rev35_model_defaults(db_session):
    from app.models import Competition, CompetitionParticipant, InviteLink

    now = datetime.now(timezone.utc)
    c = Competition(name="C", starts_at=now, ends_at=now)
    db_session.add(c)
    db_session.commit()
    p = CompetitionParticipant(competition_id=c.id, user_id="u1", mt5_login="1")
    link = InviteLink(code="abc12345", label="L")
    db_session.add_all([p, link])
    db_session.commit()

    assert c.public_view is False and c.open_account_url is None
    assert p.public_name is None and p.name_hidden is False
    assert link.competition_id is None and link.channel is None


def test_promo_funnel_daily_unique_per_day_comp_code_step(db_session):
    from app.models import PromoFunnelDaily

    db_session.add(PromoFunnelDaily(day="2026-10-08", competition_id="c1", code="", step="view", count=1))
    db_session.commit()
    # 不同码 / 不同步骤各占一行 / different code or step: separate rows
    db_session.add(PromoFunnelDaily(day="2026-10-08", competition_id="c1", code="ab12cd34", step="view", count=1))
    db_session.add(PromoFunnelDaily(day="2026-10-08", competition_id="c1", code="", step="cta"))
    db_session.commit()
    assert db_session.query(PromoFunnelDaily).filter_by(step="cta").one().count == 0

    db_session.add(PromoFunnelDaily(day="2026-10-08", competition_id="c1", code="", step="view", count=1))
    with pytest.raises(IntegrityError):
        db_session.commit()
    db_session.rollback()
