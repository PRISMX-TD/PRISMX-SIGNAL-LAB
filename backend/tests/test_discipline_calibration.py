"""两枚纪律勋章的规则（2026-09-06 定案）+ 校准脚本的纯函数。

  · 纪律标兵：≥95 分连续 7 天，且最新快照的评分仓位数 ≥100；
  · 纪律大师：满分 100 连续 30 天，且 ≥300 单。
钉住：分数线、仓位门槛（看最新一天、NULL 不算）、缺日 / NULL 断连、脚本摘要。
Rules for the two discipline badges after calibration, plus the script helpers.
"""
from datetime import date, timedelta

from app.models import DisciplineSnapshot, User
from app.services.gamification.badges import DISCIPLINE_BADGE_RULES, _discipline_streak, judge_and_award_badges
from scripts.calibrate_discipline_badges import percentiles, summarize_scores


def _user(db, email="d@t.co"):
    u = User(email=email, api_token="tok_" + email); db.add(u); db.commit(); return u


def _days(db, uid, start: date, totals, positions=None):
    for i, t in enumerate(totals):
        db.add(DisciplineSnapshot(user_id=uid, login="", date=(start + timedelta(days=i)).isoformat(),
                                  total=t, positions=positions))
    db.commit()


def test_rules_are_the_calibrated_ones():
    assert DISCIPLINE_BADGE_RULES["discipline_90_7"] == {"days": 7, "threshold": 95.0, "min_positions": 100}
    assert DISCIPLINE_BADGE_RULES["discipline_90_30"] == {"days": 30, "threshold": 100.0, "min_positions": 300}


def test_score_line_per_badge(db_session):
    u = _user(db_session)
    _days(db_session, u.id, date(2026, 9, 1), [96.0] * 30, positions=400)
    got = judge_and_award_badges(db_session, u.id)
    assert "discipline_90_7" in got            # 96 ≥ 95，7 天够
    assert "discipline_90_30" not in got       # 96 < 100，大师要满分


def test_position_gate_reads_latest_snapshot_and_null_is_ineligible(db_session):
    u = _user(db_session, "g@t.co")
    start = date(2026, 9, 1)
    _days(db_session, u.id, start, [100.0] * 6, positions=None)     # rev 14 前的历史行
    _days(db_session, u.id, start + timedelta(days=6), [100.0], positions=150)  # 最新一天
    assert _discipline_streak(db_session, u.id, 7, 95.0, 100) is True   # 连续串不被 NULL 掐断，门槛看最新
    assert _discipline_streak(db_session, u.id, 7, 95.0, 300) is False  # 单数不够
    db_session.query(DisciplineSnapshot).filter_by(user_id=u.id).update({"positions": None})
    db_session.commit()
    assert _discipline_streak(db_session, u.id, 7, 95.0, 100) is False  # 最新一天 NULL → 不算
    assert _discipline_streak(db_session, u.id, 7, 95.0, 0) is True     # 不设门槛照旧


def test_gap_and_null_break_the_run_regardless_of_threshold(db_session):
    u = _user(db_session, "gap@t.co")
    start = date(2026, 9, 1)
    _days(db_session, u.id, start, [95.0, 95.0, 95.0], positions=999)
    _days(db_session, u.id, start + timedelta(days=4), [95.0, 95.0, 95.0, None, 95.0], positions=999)
    assert _discipline_streak(db_session, u.id, 4, 80.0, 0) is False
    assert _discipline_streak(db_session, u.id, 3, 80.0, 0) is True
    assert _discipline_streak(db_session, u.id, 3, 80.0) is True        # 默认不设仓位门槛


def test_summary_helpers():
    assert percentiles([]) == {}
    p = percentiles([10.0, 20.0, 30.0, 40.0, 50.0])
    assert p["min"] == 10.0 and p["p50"] == 30.0 and p["max"] == 50.0
    s = summarize_scores([89.0, 95.0, 100.0, 100.0])
    assert s["n"] == 4
    assert s["share_at_or_above"] == {90.0: 0.75, 95.0: 0.75, 100.0: 0.5}
    assert summarize_scores([])["share_at_or_above"][95.0] == 0.0


# ---- rev 14 迁移 / migration --------------------------------------------------------

def test_rev14_adds_positions_column_null_for_existing_rows(monkeypatch, tmp_path):
    """旧库上真跑一遍迁移：列补上、历史行为 NULL（不回填，NULL = 不满足门槛）、版本号 bump。"""
    import app.core.database as db_mod
    from sqlalchemy import create_engine, inspect, text
    from sqlalchemy.orm import sessionmaker
    from app.core.database import Base
    import app.models  # noqa: F401

    url = "sqlite:///" + str(tmp_path / "legacy.db").replace("\\", "/")
    eng = create_engine(url, connect_args={"check_same_thread": False})
    Base.metadata.create_all(eng)
    with eng.begin() as conn:
        conn.execute(text("DROP TABLE discipline_snapshots"))
        conn.execute(text(
            "CREATE TABLE discipline_snapshots (id VARCHAR NOT NULL, user_id VARCHAR NOT NULL, "
            "login VARCHAR NOT NULL, date VARCHAR NOT NULL, total FLOAT, dimensions TEXT, "
            "created_at DATETIME, PRIMARY KEY (id))"
        ))
        conn.execute(text("INSERT INTO discipline_snapshots (id, user_id, login, date, total) "
                          "VALUES ('a', 'u1', '', '2026-09-01', 100.0)"))
    monkeypatch.setattr(db_mod, "engine", eng)
    monkeypatch.setattr(db_mod, "SessionLocal", sessionmaker(bind=eng, autocommit=False, autoflush=False))
    try:
        db_mod._migrate_columns()
        cols = {c["name"] for c in inspect(eng).get_columns("discipline_snapshots")}
        assert "positions" in cols
        with eng.connect() as conn:
            assert conn.execute(text("SELECT total, positions FROM discipline_snapshots")).all() == [(100.0, None)]
        assert db_mod._read_schema_rev() == db_mod.CURRENT_SCHEMA_REV >= 14
    finally:
        eng.dispose()
