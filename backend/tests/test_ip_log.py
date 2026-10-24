"""用户 IP 记录：模型约束、写入时机、缓存、清理。"""
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from fastapi.dependencies.utils import get_dependant
from sqlalchemy.exc import IntegrityError

from app.models import User, UserIp
from app.services import deps, ip_geo, ip_log
from app.services.ip_geo import Geo


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

SZ = Geo("中国", "CN", "广东", "深圳")
NOW = datetime(2026, 10, 25, 8, 0, tzinfo=timezone.utc)


def _req(ip):
    return SimpleNamespace(client=SimpleNamespace(host=ip))


@pytest.fixture(autouse=True)
def _fresh_cache():
    ip_log.reset_cache()
    yield
    ip_log.reset_cache()


@pytest.fixture()
def geo(monkeypatch):
    table = {"8.8.8.8": SZ, "9.9.9.9": Geo("马来西亚", "MY", None, "Kuala Lumpur")}
    monkeypatch.setattr(ip_geo, "lookup", lambda ip: table.get(ip))
    return table


def _rows(db, user):
    return db.query(UserIp).filter(UserIp.user_id == user.id).order_by(UserIp.ip).all()


def test_record_inserts_row_and_updates_user_geo(db_session, geo):
    u = _user(db_session)
    ip_log.record(db_session, u, "8.8.8.8", NOW)
    db_session.commit()
    [row] = _rows(db_session, u)
    assert (row.ip, row.country, row.country_code, row.province, row.city) == ("8.8.8.8", "中国", "CN", "广东", "深圳")
    assert (u.geo_country, u.geo_country_code, u.geo_province, u.geo_city) == ("中国", "CN", "广东", "深圳")
    assert u.geo_at is not None


def test_private_ip_not_recorded(db_session, geo):
    u = _user(db_session)
    ip_log.record(db_session, u, "127.0.0.1", NOW)
    ip_log.record(db_session, u, "10.0.0.8", NOW)
    db_session.commit()
    assert _rows(db_session, u) == []
    assert u.geo_country is None


def test_same_ip_again_updates_last_seen_no_duplicate(db_session, geo):
    u = _user(db_session)
    ip_log.record(db_session, u, "8.8.8.8", NOW)
    ip_log.record(db_session, u, "9.9.9.9", NOW + timedelta(hours=1))
    ip_log.reset_cache()                       # 模拟第二天 / simulate a later day
    later = NOW + timedelta(days=1)
    ip_log.record(db_session, u, "8.8.8.8", later)
    db_session.commit()
    rows = _rows(db_session, u)
    assert [r.ip for r in rows] == ["8.8.8.8", "9.9.9.9"]
    assert rows[0].last_seen_at == later.replace(tzinfo=None)
    assert rows[0].first_seen_at == NOW.replace(tzinfo=None)
    assert u.geo_city == "深圳"                 # 最后一次是深圳那个 IP / last seen IP wins


def test_cache_hit_skips_db(db_session, geo, monkeypatch):
    u = _user(db_session)
    ip_log.record(db_session, u, "8.8.8.8", NOW)
    db_session.commit()
    calls = []
    monkeypatch.setattr(ip_log, "_upsert", lambda *a, **k: calls.append(a))
    ip_log.record(db_session, u, "8.8.8.8", NOW + timedelta(hours=3))   # 同一 UTC 日 / same UTC day
    assert calls == []


def test_unknown_region_keeps_ip_and_previous_geo(db_session, geo):
    u = _user(db_session)
    ip_log.record(db_session, u, "8.8.8.8", NOW)
    ip_log.record(db_session, u, "1.1.1.1", NOW + timedelta(minutes=10))   # geo 表里没有 → None
    db_session.commit()
    assert {r.ip for r in _rows(db_session, u)} == {"8.8.8.8", "1.1.1.1"}
    assert u.geo_city == "深圳"


def test_touch_last_active_records_only_when_it_writes(db_session, geo):
    u = _user(db_session)
    deps._touch_last_active(db_session, u, _req("8.8.8.8"))
    deps._touch_last_active(db_session, u, _req("9.9.9.9"))   # 5 分钟节流内 / throttled
    assert [r.ip for r in _rows(db_session, u)] == ["8.8.8.8"]


def test_touch_last_active_without_request_still_works(db_session, geo):
    u = _user(db_session)
    deps._touch_last_active(db_session, u)
    assert u.last_active_at is not None
    assert _rows(db_session, u) == []


def test_record_failure_never_breaks_auth(db_session, geo, monkeypatch):
    u = _user(db_session)

    def boom(*a, **k):
        raise RuntimeError("db down")

    monkeypatch.setattr(ip_log, "_upsert", boom)
    deps._touch_last_active(db_session, u, _req("8.8.8.8"))
    db_session.expire_all()
    assert db_session.get(User, u.id).last_active_at is not None


def test_get_current_user_asks_fastapi_for_request():
    assert get_dependant(path="/", call=deps.get_current_user).request_param_name == "request"
