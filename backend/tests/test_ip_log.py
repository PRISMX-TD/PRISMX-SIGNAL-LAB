"""用户 IP 记录：模型约束、写入时机、缓存、清理。"""
from datetime import datetime, timedelta

import pytest
from sqlalchemy.exc import IntegrityError

from app.models import User, UserIp


def _user(db, email="u@t.co", role="user") -> User:
    u = User(email=email, api_token="tok_" + email, role=role)
    db.add(u); db.commit(); return u


def test_user_ip_unique_per_user_and_ip(db_session):
    u = _user(db_session)
    now = datetime(2026, 10, 25, 8, 0)
    db_session.add(UserIp(user_id=u.id, ip="1.2.3.4", first_seen_at=now, last_seen_at=now))
    db_session.commit()
    db_session.add(UserIp(user_id=u.id, ip="1.2.3.4", first_seen_at=now, last_seen_at=now))
    with pytest.raises(IntegrityError):
        db_session.commit()


def test_user_has_geo_columns(db_session):
    u = _user(db_session)
    u.geo_country, u.geo_country_code, u.geo_province, u.geo_city = "中国", "CN", "广东", "深圳"
    u.geo_at = datetime(2026, 10, 25)
    db_session.commit()
    assert db_session.get(User, u.id).geo_province == "广东"
