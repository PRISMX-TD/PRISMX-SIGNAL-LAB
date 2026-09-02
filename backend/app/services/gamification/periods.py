"""周期 key 与窗口（设计 §4.1：UTC 自然周/自然月；§1.6：结束后 48h 重算窗）。"""
from datetime import datetime, timedelta, timezone

RECOMPUTE_GRACE_HOURS = 48


def _utc(dt: datetime) -> datetime:
    return dt.astimezone(timezone.utc) if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def week_key(dt: datetime) -> str:
    iso = _utc(dt).isocalendar()
    return f"{iso.year}-W{iso.week:02d}"


def month_key(dt: datetime) -> str:
    d = _utc(dt)
    return f"{d.year}-{d.month:02d}"


def period_bounds(key: str) -> tuple[datetime, datetime]:
    if "-W" in key:
        y, w = key.split("-W")
        start = datetime.fromisocalendar(int(y), int(w), 1).replace(tzinfo=timezone.utc)
        return start, start + timedelta(days=7)
    y, m = key.split("-")
    start = datetime(int(y), int(m), 1, tzinfo=timezone.utc)
    end = datetime(int(y) + 1, 1, 1, tzinfo=timezone.utc) if int(m) == 12 \
        else datetime(int(y), int(m) + 1, 1, tzinfo=timezone.utc)
    return start, end


def active_period_keys(now: datetime) -> list[str]:
    now = _utc(now)
    keys = [week_key(now), month_key(now)]
    grace = timedelta(hours=RECOMPUTE_GRACE_HOURS)
    prev_week = week_key(now - timedelta(days=7))
    prev_month = month_key((now.replace(day=1) - timedelta(days=1)))
    for k in (prev_week, prev_month):
        _s, end = period_bounds(k)
        if end <= now < end + grace:
            keys.append(k)
    return keys
