"""用户分布与同 IP 查询的口径。每条测试都放一个管理员，任何数字把他算进去都要红。"""
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException

from app.models import User, UserIp
from app.routers import admin_geo
from app.services import geo_distribution as gd
from app.services.deps import require_admin

NOW = datetime(2026, 10, 25, 8, 0, tzinfo=timezone.utc)
N = NOW.replace(tzinfo=None)


@pytest.fixture(autouse=True)
def _fresh():
    gd.reset_cache()
    yield
    gd.reset_cache()


def _user(db, email, geo=None, role="user", disabled=False) -> User:
    u = User(email=email, api_token="tok_" + email, role=role,
             disabled_at=N if disabled else None)
    if geo:
        u.geo_country, u.geo_country_code, u.geo_province, u.geo_city = geo
    db.add(u); db.commit(); return u


def _ip(db, u, ip, days_ago, geo=(None, None, None, None)):
    t = N - timedelta(days=days_ago)
    c, cc, p, city = geo
    db.add(UserIp(user_id=u.id, ip=ip, country=c, country_code=cc, province=p, city=city,
                  first_seen_at=t, last_seen_at=t))
    db.commit()


SZ = ("中国", "CN", "广东", "深圳")
GZ = ("中国", "CN", "广东", "广州")
TW = ("台湾", "TW", None, None)
HK = ("香港", "HK", None, None)
MY = ("马来西亚", "MY", None, "Kuala Lumpur")


@pytest.fixture()
def world(db_session):
    db = db_session
    _user(db, "admin@t.co", geo=SZ, role="admin")
    a = _user(db, "a@t.co", geo=SZ)
    b = _user(db, "b@t.co", geo=GZ, disabled=True)
    c = _user(db, "c@t.co", geo=TW)
    d = _user(db, "d@t.co", geo=MY)
    _user(db, "e@t.co")                                  # 没有地区 / unlocated
    _ip(db, a, "1.1.1.1", 2, SZ)
    _ip(db, a, "1.1.1.2", 20, GZ)                       # 更早 / older
    _ip(db, c, "2.2.2.2", 10, TW)
    _ip(db, d, "3.3.3.3", 40, MY)                        # 超出 30 天 / outside 30d
    return db


def test_all_scope_counts_registered_users_including_disabled(world):
    r = gd.distribution(world, "all", now=NOW)
    assert (r["total"], r["located"]) == (5, 4)
    assert r["countries"][0] == {"code": "CN", "numeric": "156", "name": "中国", "nameEn": "China", "count": 2}
    assert {c["code"] for c in r["countries"]} == {"CN", "TW", "MY"}
    assert r["cnProvinces"] == [{"name": "广东", "count": 2}]


def test_distribution_excludes_admins(world):
    r = gd.distribution(world, "all", now=NOW)
    assert sum(c["count"] for c in r["countries"]) == r["located"] == 4


def test_cn_provinces_exclude_tw_hk_mo(db_session):
    _user(db_session, "t@t.co", geo=TW)
    _user(db_session, "h@t.co", geo=HK)
    r = gd.distribution(db_session, "all", now=NOW)
    assert r["cnProvinces"] == []
    assert {c["name"] for c in r["countries"]} == {"台湾", "香港"}
    assert all("中国" not in c["name"] for c in r["countries"])


def test_7d_uses_latest_ip_row_in_window(world):
    r = gd.distribution(world, "7d", now=NOW)
    assert (r["total"], r["located"]) == (1, 1)
    assert r["cities"] == [{"countryCode": "CN", "country": "中国", "province": "广东", "city": "深圳", "count": 1}]


def test_30d_window(world):
    r = gd.distribution(world, "30d", now=NOW)
    assert (r["total"], r["located"]) == (2, 2)        # a（取 2 天前那行，深圳）、c
    assert {c["code"] for c in r["countries"]} == {"CN", "TW"}
    assert r["cnProvinces"] == [{"name": "广东", "count": 1}]


def test_window_counts_unlocated_ip_rows_as_unknown(db_session):
    u = _user(db_session, "v6@t.co")
    _ip(db_session, u, "2408:8256::1", 1)
    r = gd.distribution(db_session, "7d", now=NOW)
    assert (r["total"], r["located"]) == (1, 0)


def test_distribution_is_cached(world):
    first = gd.distribution(world, "all", now=NOW)
    _user(world, "late@t.co", geo=SZ)
    assert gd.distribution(world, "all", now=NOW) == first
    gd.reset_cache()
    assert gd.distribution(world, "all", now=NOW)["total"] == 6


def test_user_ips_with_other_users(db_session):
    a = _user(db_session, "a@t.co")
    b = _user(db_session, "b@t.co")
    c = _user(db_session, "c@t.co")
    _ip(db_session, a, "5.5.5.5", 1, SZ)
    _ip(db_session, a, "6.6.6.6", 3, GZ)
    _ip(db_session, b, "5.5.5.5", 2, SZ)
    _ip(db_session, c, "5.5.5.5", 5, SZ)
    rows = gd.user_ips(db_session, a.id)
    assert [(r["ip"], r["otherUsers"]) for r in rows] == [("5.5.5.5", 2), ("6.6.6.6", 0)]
    assert rows[0]["province"] == "广东" and rows[0]["lastSeenAt"]


def test_ip_users_lists_latest_first(db_session):
    a = _user(db_session, "a@t.co")
    b = _user(db_session, "b@t.co")
    _ip(db_session, a, "5.5.5.5", 3)
    _ip(db_session, b, "5.5.5.5", 1)
    assert [r["email"] for r in gd.ip_users(db_session, "5.5.5.5")] == ["b@t.co", "a@t.co"]


def test_ip_users_rejects_bad_ip(db_session):
    with pytest.raises(HTTPException) as e:
        admin_geo.ip_users_endpoint("not-an-ip", db=db_session)
    assert e.value.status_code == 400


def test_support_role_gets_403(db_session):
    s = _user(db_session, "s@t.co", role="support")
    with pytest.raises(HTTPException) as e:
        require_admin(s)
    assert e.value.status_code == 403
