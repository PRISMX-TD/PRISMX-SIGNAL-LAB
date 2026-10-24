"""管理后台「用户分布」与「登录 IP」侧栏的数据（rev 48）。

口径（spec §5.1）：
- all：全部注册用户（含已停用，看的是分布不是在用人数），按 users.geo_* 分组。
- 7d / 30d：user_ips.last_seen_at 落在窗口内的去重用户，每人取窗口内最新一行的地区。
- 一律排除管理员（与 admin_overview.NOT_ADMIN 一致）。
- cnProvinces 只含中国大陆；台湾 / 香港 / 澳门在 countries 里各自单列，只写名字。
结果按 scope 进程内缓存 5 分钟。
"""
from __future__ import annotations

import threading
import time
from collections import Counter
from datetime import datetime, timedelta, timezone
from typing import Literal

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models import User, UserIp
from app.services.ip_geo import country_names

Scope = Literal["all", "7d", "30d"]
_WINDOW_DAYS = {"7d": 7, "30d": 30}
CACHE_SECONDS = 300
CITY_LIMIT = 50
NOT_ADMIN = User.role != "admin"

_cache: dict[str, tuple[float, dict]] = {}
_cache_lock = threading.Lock()


def reset_cache() -> None:
    with _cache_lock:
        _cache.clear()


def _iso(dt: datetime | None) -> str | None:
    return dt.replace(tzinfo=timezone.utc).isoformat() if dt else None


def _aggregate(scope: str, total: int, rows: list[tuple]) -> dict:
    """rows: (country, country_code, province, city)，每个已定位用户一行。"""
    countries: Counter = Counter()
    provinces: Counter = Counter()
    cities: Counter = Counter()
    for country, code, province, city in rows:
        countries[(code, country)] += 1
        if code == "CN" and province:
            provinces[province] += 1
        if city:
            cities[(code, country, province, city)] += 1
    out_countries = []
    for (code, name), count in sorted(countries.items(), key=lambda kv: (-kv[1], kv[0][0] or "", kv[0][1] or "")):
        _zh, en, numeric = country_names(code)
        out_countries.append({"code": code, "numeric": numeric, "name": name,
                              "nameEn": en or name, "count": count})
    return {
        "scope": scope,
        "total": total,
        "located": len(rows),
        "countries": out_countries,
        "cnProvinces": [{"name": n, "count": c} for n, c in sorted(provinces.items(), key=lambda kv: (-kv[1], kv[0]))],
        "cities": [{"countryCode": k[0], "country": k[1], "province": k[2], "city": k[3], "count": c}
                   for k, c in sorted(cities.items(), key=lambda kv: (-kv[1], tuple(x or "" for x in kv[0])))[:CITY_LIMIT]],
    }


def _compute(db: Session, scope: Scope, now: datetime) -> dict:
    if scope == "all":
        total = db.query(func.count(User.id)).filter(NOT_ADMIN).scalar() or 0
        rows = (db.query(User.geo_country, User.geo_country_code, User.geo_province, User.geo_city)
                .filter(NOT_ADMIN, User.geo_country.isnot(None)).all())
        return _aggregate(scope, total, [tuple(r) for r in rows])
    cutoff = now.replace(tzinfo=None) - timedelta(days=_WINDOW_DAYS[scope])
    rn = func.row_number().over(partition_by=UserIp.user_id, order_by=UserIp.last_seen_at.desc()).label("rn")
    latest = (db.query(UserIp.user_id, UserIp.country, UserIp.country_code, UserIp.province, UserIp.city, rn)
              .join(User, User.id == UserIp.user_id)
              .filter(NOT_ADMIN, UserIp.last_seen_at >= cutoff)
              .subquery())
    picked = db.query(latest.c.country, latest.c.country_code, latest.c.province, latest.c.city) \
               .filter(latest.c.rn == 1).all()
    located = [tuple(r) for r in picked if r[0] is not None]
    return _aggregate(scope, len(picked), located)


def distribution(db: Session, scope: Scope, now: datetime | None = None) -> dict:
    with _cache_lock:
        hit = _cache.get(scope)
        if hit and hit[0] > time.monotonic():
            return hit[1]
    result = _compute(db, scope, now or datetime.now(timezone.utc))
    with _cache_lock:
        _cache[scope] = (time.monotonic() + CACHE_SECONDS, result)
    return result


def user_ips(db: Session, user_id: str, limit: int = 10) -> list[dict]:
    """这个用户最近的 IP；otherUsers = 表内（即近 90 天）用过同一 IP 的其他用户数。"""
    rows = (db.query(UserIp).filter(UserIp.user_id == user_id)
            .order_by(UserIp.last_seen_at.desc()).limit(limit).all())
    ips = [r.ip for r in rows]
    others = dict(
        db.query(UserIp.ip, func.count(func.distinct(UserIp.user_id)))
        .filter(UserIp.ip.in_(ips), UserIp.user_id != user_id)
        .group_by(UserIp.ip).all()
    ) if ips else {}
    return [{"ip": r.ip, "country": r.country, "countryCode": r.country_code,
             "province": r.province, "city": r.city,
             "firstSeenAt": _iso(r.first_seen_at), "lastSeenAt": _iso(r.last_seen_at),
             "otherUsers": int(others.get(r.ip, 0))} for r in rows]


def ip_users(db: Session, ip: str, limit: int = 50) -> list[dict]:
    """用过这个 IP 的账户，最近出现的在前。"""
    rows = (db.query(User.id, User.email, User.nickname, UserIp.last_seen_at)
            .join(UserIp, UserIp.user_id == User.id)
            .filter(UserIp.ip == ip)
            .order_by(UserIp.last_seen_at.desc()).limit(limit).all())
    return [{"userId": r[0], "email": r[1], "nickname": r[2], "lastSeenAt": _iso(r[3])} for r in rows]
