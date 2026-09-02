from datetime import datetime, timezone
import pytest
from sqlalchemy.exc import IntegrityError
from app.models import User, Order, UserTask, UserBadge, UserActiveDay


def _mk_user(db, email="g1@t.co"):
    u = User(email=email, api_token="tok_" + email)
    db.add(u); db.commit(); db.refresh(u)
    return u


def test_new_tables_and_columns(db_session):
    u = _mk_user(db_session)
    assert u.nickname is None and u.nickname_public is False
    assert u.leaderboard_opt_out is False and u.equipped_badge is None
    o = Order(user_id=u.id, client_order_id="c1", symbol="XAUUSD",
              side="BUY", volume=0.1, status="FILLED")
    db_session.add(o); db_session.commit()
    assert o.trade_mode is None


def test_unique_constraints(db_session):
    u = _mk_user(db_session)
    db_session.add(UserTask(user_id=u.id, task_id="set_nickname")); db_session.commit()
    db_session.add(UserTask(user_id=u.id, task_id="set_nickname"))
    with pytest.raises(IntegrityError):
        db_session.commit()
    db_session.rollback()
    db_session.add(UserBadge(user_id=u.id, badge_id="first_close")); db_session.commit()
    db_session.add(UserBadge(user_id=u.id, badge_id="first_close"))
    with pytest.raises(IntegrityError):
        db_session.commit()
    db_session.rollback()
    db_session.add(UserActiveDay(user_id=u.id, day="2026-09-02")); db_session.commit()
    db_session.add(UserActiveDay(user_id=u.id, day="2026-09-02"))
    with pytest.raises(IntegrityError):
        db_session.commit()
    db_session.rollback()
