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


def test_yesterday_to_today_transition_inserts_row(db_session):
    """真正跨日：prev_day 是昨天的日期字符串（非 None），今天首次触发应插入一行。"""
    u = User(email="d@t.co", api_token="tok_d")
    db_session.add(u); db_session.commit()
    u.last_active_at = datetime.now(timezone.utc) - timedelta(days=1)
    db_session.commit()
    _touch_last_active(db_session, u)
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    rows = db_session.query(UserActiveDay).filter_by(user_id=u.id).all()
    assert [r.day for r in rows] == [today]


def test_day_boundary_collision_does_not_raise(db_session):
    """并发会话已抢先写入今天的行：撞唯一约束时 _touch_last_active 绝不抛异常，
    也不会重复插入。"""
    u = User(email="e@t.co", api_token="tok_e")
    db_session.add(u); db_session.commit()
    u.last_active_at = datetime.now(timezone.utc) - timedelta(days=1)
    db_session.commit()
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    # 模拟另一个并发会话已经先一步插入了今天的行
    db_session.add(UserActiveDay(user_id=u.id, day=today))
    db_session.commit()

    _touch_last_active(db_session, u)  # 不应抛出 IntegrityError 或任何异常

    assert db_session.query(UserActiveDay).filter_by(user_id=u.id).count() == 1
