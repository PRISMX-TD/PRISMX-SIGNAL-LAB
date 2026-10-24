"""用户登录 IP 的记录与 90 天清理（rev 48）。

record 由 deps._touch_last_active 在真正落库的那次调用（每用户每 5 分钟最多一次），
再加一层进程内缓存：同一 (用户, IP, UTC 日) 当天只碰一次数据库。任何异常只记日志、
吞掉——记 IP 是附带的，绝不能让鉴权失败。

record is called by deps._touch_last_active only on the write it actually performs
(at most once per user per 5 minutes), behind an in-process cache keyed by
(user, ip, UTC day). Every error is logged and swallowed: logging an IP must never
fail authentication.
"""
from __future__ import annotations

import logging
import threading
import uuid
from collections import OrderedDict
from datetime import datetime

from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.orm import Session

from app.models import User, UserIp
from app.services import ip_geo

logger = logging.getLogger("prismx.ip_log")

_CACHE_MAX = 5000
_seen: "OrderedDict[tuple[str, str, str], None]" = OrderedDict()
_seen_lock = threading.Lock()


def reset_cache() -> None:
    with _seen_lock:
        _seen.clear()


def _cache_hit(key: tuple[str, str, str]) -> bool:
    with _seen_lock:
        if key in _seen:
            _seen.move_to_end(key)
            return True
        return False


def _cache_add(key: tuple[str, str, str]) -> None:
    with _seen_lock:
        _seen[key] = None
        while len(_seen) > _CACHE_MAX:
            _seen.popitem(last=False)


def _upsert(db: Session, user_id: str, ip: str, geo: ip_geo.Geo | None, seen_at: datetime) -> None:
    """(user_id, ip) 已有就只更新 last_seen_at（地区查得到时也更新地区）。
    Insert, or on (user_id, ip) conflict bump last_seen_at (and the region when known)."""
    insert = pg_insert if db.get_bind().dialect.name == "postgresql" else sqlite_insert
    values = {"id": str(uuid.uuid4()), "user_id": user_id, "ip": ip,
              "first_seen_at": seen_at, "last_seen_at": seen_at}
    update = {"last_seen_at": seen_at}
    if geo is not None:
        region = {"country": geo.country, "country_code": geo.country_code,
                  "province": geo.province, "city": geo.city}
        values.update(region)
        update.update(region)
    stmt = insert(UserIp).values(**values)
    db.execute(stmt.on_conflict_do_update(index_elements=["user_id", "ip"], set_=update))


def record(db: Session, user: User, raw_ip: str | None, now: datetime) -> None:
    """记录一次 IP；从不抛异常。调用方负责 commit。
    Log one sighting; never raises. The caller commits."""
    try:
        ip = ip_geo.normalize_ip(raw_ip)
        if ip is None:
            return
        key = (user.id, ip, now.strftime("%Y-%m-%d"))
        if _cache_hit(key):
            return
        geo = ip_geo.lookup(ip)
        seen_at = now.replace(tzinfo=None)
        with db.begin_nested():
            _upsert(db, user.id, ip, geo, seen_at)
        if geo is not None:
            user.geo_country = geo.country
            user.geo_country_code = geo.country_code
            user.geo_province = geo.province
            user.geo_city = geo.city
            user.geo_at = seen_at
        _cache_add(key)
    except Exception:
        logger.warning("记录用户 IP 失败 user=%s", getattr(user, "id", None), exc_info=True)
