"""看板统计的时间口径，全项目只此一处。

三条规则：
1. 所有"按天"都按 STATS_TZ（默认北京时间）切，不按 UTC。库里的 datetime 列存的是
   naive UTC，比较前先把本地日的 00:00 换成 naive UTC（day_start_utc）。
2. 时间范围预设（本周/本月/上个月/本季度/今年）在这里解析，不在前端算：前端没有
   单测框架，"周一起算""上个月最后一天"这类边界要能被 pytest 钉住。
3. 对比期 = 紧邻本期之前、长度相同的一段。

Dashboard time semantics, defined once. All day bucketing uses STATS_TZ; range
presets are resolved server-side so pytest can pin the edge cases; the compare
period is the equal-length window immediately before.
"""
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

from app.core.config import settings
from app.utils.timeutil import aware

RANGE_PRESETS = ("week", "month", "last_month", "quarter", "year")
# 与 page_stats.VISITOR_RETENTION_DAYS 对齐：人数数据只留这么久，再长也查不出东西。
# Matches page_stats.VISITOR_RETENTION_DAYS; visitor data older than this is gone.
MAX_RANGE_DAYS = 400


class RangeError(ValueError):
    """时间范围不合法；路由层转成 422。"""


def week_start(d: date) -> date:
    """d 所在自然周的周一。看板里「本周」只此一解——范围预设、漏斗分批周、
    潜在客户窗口三处都引用它，免得哪天有人把某一处改成"最近 7 天"。
    Monday of d's week: the single definition of "this week" on the dashboard,
    shared by the range preset, the funnel's weekly cohorts and the lead window."""
    return d - timedelta(days=d.weekday())


def stats_tz() -> ZoneInfo:
    return ZoneInfo(settings.STATS_TZ)


def local_day(dt: datetime) -> date:
    """任意 datetime（naive 视为 UTC）→ STATS_TZ 日期。"""
    return aware(dt).astimezone(stats_tz()).date()


def today() -> date:
    return datetime.now(timezone.utc).astimezone(stats_tz()).date()


def day_start_utc(d: date) -> datetime:
    """本地日 d 的 00:00 对应的 naive UTC。库里的 DateTime 列都是 naive UTC，
    过滤 created_at / time_bucket 时用它做边界。"""
    return datetime.combine(d, time.min, tzinfo=stats_tz()).astimezone(timezone.utc).replace(tzinfo=None)


@dataclass(frozen=True)
class RangeSpec:
    start: date
    end: date
    compare_start: date
    compare_end: date

    @property
    def days(self) -> int:
        return (self.end - self.start).days + 1

    def day_keys(self) -> list[str]:
        return [(self.start + timedelta(days=i)).isoformat() for i in range(self.days)]


def _preset_bounds(preset: str, today_: date) -> tuple[date, date]:
    if preset not in RANGE_PRESETS:
        raise RangeError(f"unknown range preset: {preset}")
    if preset == "week":
        return week_start(today_), today_
    if preset == "month":
        return today_.replace(day=1), today_
    if preset == "last_month":
        last_day_prev = today_.replace(day=1) - timedelta(days=1)
        return last_day_prev.replace(day=1), last_day_prev
    if preset == "quarter":
        first_month = ((today_.month - 1) // 3) * 3 + 1
        return today_.replace(month=first_month, day=1), today_
    if preset == "year":
        return today_.replace(month=1, day=1), today_


def resolve_range(preset: str | None, start: date | None, end: date | None, today: date) -> RangeSpec:
    """解析范围。自定义 start/end 优先；否则按预设；都没给默认本月。"""
    if start is not None or end is not None:
        if start is None or end is None:
            raise RangeError("from and to must be given together")
    else:
        start, end = _preset_bounds(preset or "month", today)

    if start > end:
        raise RangeError("from must not be after to")
    if end > today:
        raise RangeError("to must not be in the future")
    days = (end - start).days + 1
    if days > MAX_RANGE_DAYS:
        raise RangeError(f"range must not exceed {MAX_RANGE_DAYS} days")

    compare_end = start - timedelta(days=1)
    compare_start = compare_end - timedelta(days=days - 1)
    return RangeSpec(start=start, end=end, compare_start=compare_start, compare_end=compare_end)
