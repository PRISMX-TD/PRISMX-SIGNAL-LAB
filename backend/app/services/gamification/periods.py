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


def previous_period_key(key: str) -> str | None:
    """给定一个自然周/月 key，返回上一个同类型周期的 key；比赛 key
    （`comp:<id>`）或任何其它不认识的格式返回 None——领奖台的"上期冠军"
    只对周期榜有意义，比赛详情页复用 `build_board_rows_payload` 时不能因为
    解析不了 `comp:<id>` 而炸掉。

    Given a natural week/month key, returns the previous key of the same
    kind; a competition key (`comp:<id>`) or anything else unrecognized
    returns None — "previous winner" only makes sense for the standing
    boards, and the competition detail page (which reuses
    `build_board_rows_payload`) must not crash trying to parse `comp:<id>`.
    """
    if "-W" in key:
        try:
            start, _end = period_bounds(key)
        except (ValueError, TypeError):
            return None
        return week_key(start - timedelta(days=7))
    if len(key) == 7 and key[4] == "-" and key[:4].isdigit() and key[5:].isdigit():
        y, m = int(key[:4]), int(key[5:])
        return f"{y - 1}-12" if m == 1 else f"{y}-{m - 1:02d}"
    return None


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
