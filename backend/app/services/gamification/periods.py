"""周期 key 与窗口（设计 §4.1：UTC 自然周/自然月；§1.6：结束后 48h 重算窗）。

**本模块是游戏化日历的唯一出处。** 整条游戏化链路——周/月 key、`UserActiveDay.day`、
连续活跃天、成就页的「交易天数」——都按 **UTC 自然日**切天，与后台看板的
`services/stats_time.py`（按 `STATS_TZ`=Asia/Shanghai 切天）是两把**刻意不同**的尺：
看板回答运营的「本地的今天有多少人」，游戏化回答用户的「我闯到第几关」，两者没有
必须一致的理由，但各自内部必须一致。所以切天动作集中在这里的 `day_key` / `today`，
不要再在别处写第二遍 `strftime("%Y-%m-%d")`——那正是两把尺悄悄长出第三把的方式。
（口径差异与为什么不统一，见 `stats.trade_days` 处的长注释。）

This module is the single source of the gamification calendar: everything in
that chain — week/month keys, UserActiveDay.day, activity streaks, the
achievements page's "trading days" — cuts days on the **UTC** calendar, while the
admin dashboard (services/stats_time.py) deliberately cuts on STATS_TZ. The two
answer different questions and need not agree with each other, but each must be
internally consistent, so the day cut lives in day_key/today here rather than
being re-spelled as strftime("%Y-%m-%d") elsewhere.
"""
import re
from datetime import date, datetime, timedelta, timezone

from fastapi import HTTPException

RECOMPUTE_GRACE_HOURS = 48

# 自然周 / 自然月 key 的形状（2026-W07、2026-02）。/ Shape of a calendar week / month key.
PERIOD_KEY_RE = re.compile(r"^\d{4}-W\d{2}$|^\d{4}-\d{2}$")


def _utc(dt: datetime) -> datetime:
    return dt.astimezone(timezone.utc) if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def day_key(dt: datetime) -> str:
    """游戏化的「哪一天」：UTC 自然日的 `YYYY-MM-DD`。

    naive 值按 UTC 解读（库里的 DateTime 全是 naive UTC），aware 值先换算到 UTC，
    所以同一个时刻无论以什么形式传进来都落在同一天——直接 `dt.strftime` 做不到
    这一点：一个带 +08:00 的值会被原样格式化成本地日期。
    The gamification "which day": a UTC calendar date. Naive values are read as
    UTC (every DateTime column is naive UTC) and aware ones are converted, so one
    instant lands on one day whichever form it arrives in — plain `dt.strftime`
    would format an aware +08:00 value on its own local date.
    """
    return _utc(dt).strftime("%Y-%m-%d")


def today(now: datetime | None = None) -> date:
    """游戏化日历里的「今天」（UTC 自然日）。/ Today on the gamification (UTC) calendar."""
    return _utc(now or datetime.now(timezone.utc)).date()


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


def resolve_period_key(period: str) -> str:
    """"week"/"month" → 以当前 UTC 时间算出的进行中周期 key；显式 key 校验格式与存在性
    （已封存历史周期只能这样访问，快照只读）。坏值 400。
    正则只校验形状：2026-13、2026-00、2026-W60 形状合法但不是真实周期，下游
    period_bounds 会抛 ValueError（→500），这里提前转成 400。
    "week"/"month" → the running period key (from the current UTC time); an explicit key is
    checked for shape and existence. Bad input → 400. The regex only checks shape, so
    2026-13 / 2026-00 / 2026-W60 would pass it and make period_bounds raise (→500)."""
    if period == "week":
        return week_key(datetime.now(timezone.utc))
    if period == "month":
        return month_key(datetime.now(timezone.utc))
    if not PERIOD_KEY_RE.match(period or ""):
        raise HTTPException(400, "周期格式错误 / Invalid period")
    try:
        period_bounds(period)
    except (ValueError, TypeError):
        raise HTTPException(400, "周期不存在 / Invalid period") from None
    return period
