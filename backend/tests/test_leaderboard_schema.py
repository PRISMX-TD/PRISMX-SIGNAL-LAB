import pytest
from sqlalchemy.exc import IntegrityError

from app.models import User, PeriodBaseline, LeaderboardSnapshot
from app.services.settings_store import (
    GAMIFICATION_DEFAULTS, get_gamification_settings, save_gamification_settings,
    invalidate_gamification_cache)


def _user(db, email="lb@t.co"):
    u = User(email=email, api_token="tok_" + email)
    db.add(u); db.commit(); return u


def test_baseline_unique_per_account_period(db_session):
    u = _user(db_session)
    db_session.add(PeriodBaseline(user_id=u.id, mt5_login="A", period_key="2026-W36",
                                  baseline=1000.0))
    db_session.commit()
    row = db_session.query(PeriodBaseline).first()
    assert row.adjust == 0.0 and row.taken_at is not None
    db_session.add(PeriodBaseline(user_id=u.id, mt5_login="A", period_key="2026-W36",
                                  baseline=999.0))
    with pytest.raises(IntegrityError):
        db_session.commit()
    db_session.rollback()


def test_snapshot_unique_row_per_account(db_session):
    u = _user(db_session)
    db_session.add(LeaderboardSnapshot(board="return_pct", period_key="2026-W36",
                                       user_id=u.id, mt5_login="A", rank=1, score=0.12,
                                       sample=6))
    db_session.commit()
    db_session.add(LeaderboardSnapshot(board="return_pct", period_key="2026-W36",
                                       user_id=u.id, mt5_login="A", rank=2, score=0.1,
                                       sample=6))
    with pytest.raises(IntegrityError):
        db_session.commit()
    db_session.rollback()


def test_settings_new_keys_and_typing(db_session):
    invalidate_gamification_cache()
    s = get_gamification_settings(db_session)
    assert s["leaderboard_visible"] is False and s["competitions_visible"] is False
    assert s["min_baseline_usd"] == 500.0
    # 数值键必须保持 float——loader 不能把它 bool() 掉；坏值回退默认
    save_gamification_settings(db_session, {"min_baseline_usd": 300,
                                            "leaderboard_visible": True})
    db_session.commit(); invalidate_gamification_cache()
    s = get_gamification_settings(db_session)
    assert s["min_baseline_usd"] == 300.0 and isinstance(s["min_baseline_usd"], float)
    assert s["leaderboard_visible"] is True
    save_gamification_settings(db_session, {"min_baseline_usd": "garbage"})
    db_session.commit(); invalidate_gamification_cache()
    assert get_gamification_settings(db_session)["min_baseline_usd"] == 500.0
