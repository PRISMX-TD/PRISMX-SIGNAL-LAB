"""管理页看板的全部数字。纯查询 + Python 归并，不写库。

三条全局口径（改任何一条先改设计文档 §3）：
- 按天一律用 stats_time 的 STATS_TZ；库里 datetime 列是 naive UTC，比较边界用
  day_start_utc()，归日用 local_day()。按天分组在 Python 侧做，跟 admin.page_stats
  一样，是为了 SQLite / Postgres 行为一致。
- 所有人数 role != 'admin'。
- 活跃 = page_visitor_days 里当天有行。不看 last_active_at（任何请求都会打它，
  App 后台刷数据也算），不看 user_active_days（那是游戏化的数据源，口径不同）。

All dashboard numbers. Day bucketing via STATS_TZ (Python-side for cross-DB
parity), admins excluded everywhere, "active" means a page_visitor_days row.
"""
from collections import defaultdict
from datetime import date, timedelta

from sqlalchemy import func
from sqlalchemy.orm import Query, Session

from app.models import MT5Account, Order, PageVisitorDay, Payment, User, UserStrategy
from app.schemas import (
    ActivityDayOut, AdminOverviewOut, CompareOut, FunnelOut, FunnelStepsOut, FunnelWeekOut,
    OverviewHeadlineOut, OverviewRangeOut, RetentionOut, RetentionPointOut, StrategyUsageOut,
    TradingDayOut, TradingOut,
)
from app.services.stats_time import MAX_RANGE_DAYS, RangeSpec, day_start_utc, local_day

NOT_ADMIN = User.role != "admin"


def _non_admin_users(db: Session) -> Query:
    return db.query(User).filter(NOT_ADMIN)


def _distinct_visitors_since(db: Session, since: date) -> int:
    """since（含）起打开过页面的去重人数，剔管理员。"""
    return int(
        db.query(func.count(func.distinct(PageVisitorDay.user_id)))
        .join(User, User.id == PageVisitorDay.user_id)
        .filter(NOT_ADMIN, PageVisitorDay.day >= since)
        .scalar()
        or 0
    )


def _signup_days(db: Session, first: date, last: date) -> list[date]:
    """[first, last] 内注册的非管理员，每人一个 STATS_TZ 注册日。"""
    rows = (
        _non_admin_users(db)
        .with_entities(User.created_at)
        .filter(User.created_at >= day_start_utc(first), User.created_at < day_start_utc(last + timedelta(days=1)))
        .all()
    )
    return [local_day(created) for (created,) in rows if created is not None]


def _count_in(days: list[date], first: date, last: date) -> int:
    return sum(1 for d in days if first <= d <= last)


def headline(db: Session, spec: RangeSpec, today: date) -> OverviewHeadlineOut:
    total = _non_admin_users(db).count()
    signup_days = _signup_days(db, spec.compare_start, spec.end)
    return OverviewHeadlineOut(
        totalUsers=total,
        activeToday=_distinct_visitors_since(db, today),
        activeWeek=_distinct_visitors_since(db, today - timedelta(days=6)),
        activeMonth=_distinct_visitors_since(db, today - timedelta(days=29)),
        signups=CompareOut(
            current=_count_in(signup_days, spec.start, spec.end),
            previous=_count_in(signup_days, spec.compare_start, spec.compare_end),
        ),
    )


def activity_daily(db: Session, spec: RangeSpec) -> list[ActivityDayOut]:
    active_rows = (
        db.query(PageVisitorDay.day, func.count(func.distinct(PageVisitorDay.user_id)))
        .join(User, User.id == PageVisitorDay.user_id)
        .filter(NOT_ADMIN, PageVisitorDay.day >= spec.start, PageVisitorDay.day <= spec.end)
        .group_by(PageVisitorDay.day)
        .all()
    )
    active = {_iso(day): int(n or 0) for day, n in active_rows}
    signups: dict[str, int] = defaultdict(int)
    for d in _signup_days(db, spec.start, spec.end):
        signups[d.isoformat()] += 1
    return [
        ActivityDayOut(date=key, active=active.get(key, 0), signups=signups.get(key, 0))
        for key in spec.day_keys()
    ]


def _iso(value) -> str:
    """Date 列在 SQLite 下可能回字符串，统一成 YYYY-MM-DD。"""
    return value.isoformat() if hasattr(value, "isoformat") else str(value)[:10]
