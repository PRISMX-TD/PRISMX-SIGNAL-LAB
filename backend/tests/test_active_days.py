from datetime import datetime, timedelta, timezone

from app.models import User, UserActiveDay
from app.services.deps import _touch_last_active


def test_first_touch_of_day_inserts_row(db_session):
    u = User(email="a@t.co", api_token="tok_a")
    db_session.add(u); db_session.commit()
    _touch_last_active(db_session, u)
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    rows = db_session.query(UserActiveDay).filter_by(user_id=u.id).all()
    assert [r.day for r in rows] == [today]


def test_same_day_touch_is_idempotent(db_session):
    u = User(email="b@t.co", api_token="tok_b")
    db_session.add(u); db_session.commit()
    _touch_last_active(db_session, u)
    # 绕过 300 秒节流：把 last_active_at 拨回 10 分钟前（仍是今天）
    u.last_active_at = datetime.now(timezone.utc) - timedelta(minutes=10)
    db_session.commit()
    _touch_last_active(db_session, u)
    assert db_session.query(UserActiveDay).filter_by(user_id=u.id).count() == 1
