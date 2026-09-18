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
from datetime import date, datetime, timedelta

from sqlalchemy import func, or_
from sqlalchemy.orm import Query, Session

from app.models import MT5Account, Order, PageVisitorDay, User, UserStrategy
from app.services.account_type import REAL as TRADE_MODE_REAL
from app.schemas import (
    ActivityDayOut, AdminOverviewOut, AdminPotentialCustomersOut, CompareOut, FunnelOut,
    FunnelStepsOut, FunnelWeekOut, OverviewHeadlineOut, OverviewRangeOut, PotentialCustomerOut,
    RetentionOut, RetentionPointOut, StrategyUsageOut, TradingDayOut, TradingOut,
)
from app.services.stats_time import MAX_RANGE_DAYS, RangeSpec, day_start_utc, local_day, week_start

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


def _as_date(value) -> date | None:
    """同 _iso，但回 date 对象而不是字符串；None 原样传回。"""
    if value is None:
        return None
    if isinstance(value, date):
        return value
    return date.fromisoformat(str(value)[:10])


# ── 漏斗 / funnel ──────────────────────────────────────────────────────────
FUNNEL_WEEKS = 8

# 潜在转化客户：注册了、还没绑 MT5，但**本周**常来的人——后台最该主动联系的一批。
#
# 窗口是自然周（周一起到今天），不是滚动 7 天：后台按周盘点，"这周来了几天"
# 跟周报对得上，而滚动窗口每天都在悄悄换一批人。代价是周一、周二窗口本身还不够
# POTENTIAL_MIN_ACTIVE_DAYS 天，这两天名单必然为空——接口把 windowDays 一并回传，
# 前端照实显示"本周已过 N 天"，不让人误以为是坏了。
# The window is the calendar week (Monday to today), not a rolling 7 days: the
# back office reviews by week, so "days active this week" lines up with the weekly
# report, whereas a rolling window quietly swaps the cohort every day. The trade-off
# is that on Mon/Tue the window is shorter than the threshold and the list is
# necessarily empty — windowDays ships with the response so the UI can say so.
#
# **门槛是"活跃天数"而不是"打开次数"**，因为次数根本没存：page_visitor_days 每人
# 每天每页只有一条去重标记（刻意不记时刻与次数，见模型说明），page_view_stats 记了
# 次数却不含 user_id。要按次数筛就得先加一张带身份的明细表，那是另一个隐私决策。
# 活跃天数是现有数据能给的最接近口径，也是这类判断的常规代理指标。
#
# Warm leads: registered, no MT5 account yet, but frequently active this week.
# The threshold counts ACTIVE DAYS, not opens: per-user open counts are not
# stored anywhere (page_visitor_days keeps one dedup marker per user/page/day
# with no timestamps; page_view_stats counts views but carries no user_id).
# Counting opens would require a new identified table — a separate privacy call.
POTENTIAL_MIN_ACTIVE_DAYS = 3


def _bound_user_ids(db: Session) -> set[str]:
    """绑过 MT5 账号的非管理员 user_id。"""
    return {
        row[0]
        for row in db.query(MT5Account.user_id)
        .join(User, User.id == MT5Account.user_id)
        .filter(NOT_ADMIN)
        .distinct()
        .all()
    }


def _potential_window(today: date) -> date:
    """潜在客户判定窗口的起始日（含）= 本周周一。"""
    return week_start(today)


def _active_days_in_window(db: Session, today: date) -> dict[str, int]:
    """窗口内每个非管理员用户打开过平台的天数。"""
    rows = (
        db.query(PageVisitorDay.user_id, func.count(func.distinct(PageVisitorDay.day)))
        .join(User, User.id == PageVisitorDay.user_id)
        .filter(NOT_ADMIN, PageVisitorDay.day >= _potential_window(today))
        .group_by(PageVisitorDay.user_id)
        .all()
    )
    return {uid: int(n or 0) for uid, n in rows}


def _potential_ids(db: Session, today: date, bound: set[str]) -> tuple[set[str], dict[str, int]]:
    """（潜在客户 id 集合, 窗口内活跃天数表）。漏斗那一行与名单接口共用这一处，
    所以柱子上的人数和展开的名单人数不会对不上。
    Shared by the funnel row and the list endpoint so the two can never drift."""
    counts = _active_days_in_window(db, today)
    ids = {uid for uid, n in counts.items() if n >= POTENTIAL_MIN_ACTIVE_DAYS} - bound
    return ids, counts


def _step_user_ids(db: Session, today: date) -> dict[str, set[str]]:
    """每一步"至少做过一次"的非管理员 user_id 集合。

    用集合而不是逐步 COUNT：分批表要按注册周切同一批人，集合交一次就出来；
    用户量到万级时集合也只有几万个字符串，远比 8 周 × 4 步 = 32 次 JOIN 查询便宜。
    Sets rather than per-step COUNTs: the by-week table intersects the same sets
    with each cohort, and even at 10k users the sets stay cheap.
    """
    def ids(q) -> set[str]:
        return {row[0] for row in q.all()}

    bound = _bound_user_ids(db)
    return {
        "bound": bound,
        # 真仓 / 模拟仓拆分：真仓 = trade_mode 判定为 REAL；其余（模拟、比赛、未判定）都归模拟仓，
        # 与 account_type.is_real 的"未知按非实盘"一致。一个人两种账号都有就两边都算。
        # Real vs demo split: real = trade_mode REAL; everything else (demo, contest,
        # unclassified) counts as demo, matching account_type.is_real. A user with both
        # kinds appears in both.
        "bound_real": ids(
            db.query(MT5Account.user_id).join(User, User.id == MT5Account.user_id)
            .filter(NOT_ADMIN, MT5Account.trade_mode == TRADE_MODE_REAL).distinct()
        ),
        "bound_demo": ids(
            db.query(MT5Account.user_id).join(User, User.id == MT5Account.user_id)
            .filter(NOT_ADMIN, or_(MT5Account.trade_mode.is_(None), MT5Account.trade_mode != TRADE_MODE_REAL)).distinct()
        ),
        "traded": ids(db.query(Order.user_id).join(User, User.id == Order.user_id).filter(NOT_ADMIN, Order.status == "FILLED").distinct()),
        "potential": _potential_ids(db, today, bound)[0],
    }


def _steps_for(cohort: set[str], steps: dict[str, set[str]]) -> dict[str, int]:
    return {
        "registered": len(cohort),
        "potential": len(cohort & steps["potential"]),
        "bound": len(cohort & steps["bound"]),
        "boundReal": len(cohort & steps["bound_real"]),
        "boundDemo": len(cohort & steps["bound_demo"]),
        "traded": len(cohort & steps["traded"]),
    }


def funnel(db: Session, today: date) -> FunnelOut:
    steps = _step_user_ids(db, today)
    all_ids = {row[0] for row in _non_admin_users(db).with_entities(User.id).all()}

    this_monday = week_start(today)
    week_starts = [this_monday - timedelta(weeks=i) for i in range(FUNNEL_WEEKS - 1, -1, -1)]
    cohorts: dict[date, set[str]] = {ws: set() for ws in week_starts}
    rows = (
        _non_admin_users(db)
        .with_entities(User.id, User.created_at)
        .filter(User.created_at >= day_start_utc(week_starts[0]))
        .all()
    )
    for uid, created in rows:
        if created is None:
            continue
        d = local_day(created)
        ws = d - timedelta(days=d.weekday())
        if ws in cohorts:
            cohorts[ws].add(uid)

    return FunnelOut(
        overall=FunnelStepsOut(**_steps_for(all_ids, steps)),
        byWeek=[FunnelWeekOut(weekStart=ws.isoformat(), **_steps_for(cohorts[ws], steps)) for ws in week_starts],
    )


def potential_customers(db: Session, today: date, limit: int = 200) -> AdminPotentialCustomersOut:
    """潜在转化客户名单。人数与漏斗那一行同源（`_potential_ids`）。

    `total` 是符合条件的全部人数，`users` 只到 limit——名单是给人打电话用的，
    一次给几百行已经够，剩下的下次再看；两个数字都回传，前端才能照实说明截断。
    Warm-lead list, sharing its definition with the funnel row. `total` counts
    everyone matching; `users` is capped at `limit` and the UI says so.
    """
    ids, counts = _potential_ids(db, today, _bound_user_ids(db))
    window_from = _potential_window(today)
    window_days = (today - window_from).days + 1  # 本周已过的天数（含今天）
    if not ids:
        return AdminPotentialCustomersOut(
            windowDays=window_days,
            minActiveDays=POTENTIAL_MIN_ACTIVE_DAYS,
            windowFrom=window_from.isoformat(),
            total=0,
            users=[],
        )

    id_list = list(ids)
    last_seen = {
        uid: _as_date(day)
        for uid, day in db.query(PageVisitorDay.user_id, func.max(PageVisitorDay.day))
        .filter(PageVisitorDay.user_id.in_(id_list), PageVisitorDay.day >= window_from)
        .group_by(PageVisitorDay.user_id)
        .all()
    }
    rows = _non_admin_users(db).filter(User.id.in_(id_list)).all()
    users = [
        PotentialCustomerOut(
            id=u.id,
            email=u.email,
            nickname=u.nickname,
            phone=u.phone,
            createdAt=u.created_at,
            activeDays=counts.get(u.id, 0),
            lastActiveDay=last_seen[u.id].isoformat() if last_seen.get(u.id) else None,
        )
        for u in rows
    ]
    # 两次稳定排序：先注册时间倒序，再活跃天数倒序——最终是「活跃天数多的在前，
    # 同样活跃的里新注册的在前」。一次 key 里混升降序要靠取负数，注册时间是
    # datetime 取不了负，分两趟更直白。
    # Two stable sorts: newest-first within each active-day bucket.
    users.sort(key=lambda r: r.createdAt or datetime.min, reverse=True)
    users.sort(key=lambda r: r.activeDays, reverse=True)
    return AdminPotentialCustomersOut(
        windowDays=window_days,
        minActiveDays=POTENTIAL_MIN_ACTIVE_DAYS,
        windowFrom=window_from.isoformat(),
        total=len(ids),
        users=users[:limit],
    )


# ── 留存 / retention ───────────────────────────────────────────────────────
RETENTION_DAYS = (2, 7, 30)


def retention(db: Session, today: date, data_since: date | None = None) -> RetentionOut:
    """dN 留存 = 注册日 + (N-1) 那天打开过页面的比例。

    cohort 只收"第 N 天已经完整过去"的人（注册日 + N - 1 <= 昨天），否则最近
    注册的人还没机会回来就被算成流失，比例假低。cohort 下限取两者中较晚的一个：
    MAX_RANGE_DAYS 之前（更早的访问标记已被保留期清掉，算出来必然是 0）、以及
    page_visitor_days 里最早的一条访问标记——这张表只从访问统计上线那天才开始
    有数据，再早注册的人分子永远是 0，会把留存率拉假低。data_since 为 None 时
    这里现查一次最早标记；build_overview 已经查过一次，会把结果传进来避免
    重复查询。

    Only users whose day N has fully elapsed enter the cohort. The cohort floor
    is whichever is LATER: MAX_RANGE_DAYS ago (older markers are pruned, so an
    older cohort is guaranteed 0 retention), or the earliest page_visitor_days
    row (rows only exist since telemetry went live, so anyone who signed up
    before that can never have a marker and would show a falsely-low rate).
    data_since is looked up here when omitted; build_overview passes its own
    lookup so the table isn't scanned twice per request.
    """
    if data_since is None:
        data_since = _as_date(db.query(func.min(PageVisitorDay.day)).scalar())

    if data_since is None:
        earliest = today  # 没有任何访问标记 → cohort 必空 / no markers at all → cohort stays empty
    else:
        earliest = max(today - timedelta(days=MAX_RANGE_DAYS), data_since)

    rows = (
        _non_admin_users(db)
        .with_entities(User.id, User.created_at)
        .filter(User.created_at >= day_start_utc(earliest))
        .all()
    )
    signup_day = {uid: local_day(created) for uid, created in rows if created is not None}
    if signup_day:
        visits = {
            (uid, _iso(day))
            for uid, day in db.query(PageVisitorDay.user_id, PageVisitorDay.day)
            .filter(PageVisitorDay.user_id.in_(list(signup_day)), PageVisitorDay.day >= earliest)
            .distinct()
            .all()
        }
    else:
        visits = set()

    def point(n: int) -> RetentionPointOut:
        offset = n - 1
        cohort = {uid: d for uid, d in signup_day.items() if d + timedelta(days=offset) <= today - timedelta(days=1)}
        if not cohort:
            return RetentionPointOut(rate=None, cohortSize=0, cohortFrom=None, cohortTo=None)
        retained = sum(1 for uid, d in cohort.items() if (uid, (d + timedelta(days=offset)).isoformat()) in visits)
        return RetentionPointOut(
            rate=retained / len(cohort),
            cohortSize=len(cohort),
            cohortFrom=min(cohort.values()).isoformat(),
            cohortTo=max(cohort.values()).isoformat(),
        )

    d2, d7, d30 = (point(n) for n in RETENTION_DAYS)
    return RetentionOut(d2=d2, d7=d7, d30=d30)


# ── 等级 / plans ───────────────────────────────────────────────────────────

def plans(db: Session) -> dict[str, int]:
    out: dict[str, int] = {}
    rows = (
        _non_admin_users(db)
        .with_entities(User.plan, User.plan_is_trial, func.count(User.id))
        .group_by(User.plan, User.plan_is_trial)
        .all()
    )
    for plan, is_trial, n in rows:
        plan = plan or "FREE"
        key = ("PRO_TRIAL" if is_trial else "PRO_PAID") if plan == "PRO" else plan
        out[key] = out.get(key, 0) + int(n or 0)
    return out


# ── 策略 / strategies ──────────────────────────────────────────────────────

def strategies(db: Session) -> list[StrategyUsageOut]:
    rows = (
        db.query(UserStrategy.template, UserStrategy.enabled, UserStrategy.user_id)
        .join(User, User.id == UserStrategy.user_id)
        .filter(NOT_ADMIN)
        .all()
    )
    users: dict[str, set[str]] = defaultdict(set)
    enabled: dict[str, set[str]] = defaultdict(set)
    for template, is_enabled, uid in rows:
        key = template or "custom"
        users[key].add(uid)
        if is_enabled:
            enabled[key].add(uid)
    out = [StrategyUsageOut(template=k, users=len(v), enabledUsers=len(enabled[k])) for k, v in users.items()]
    out.sort(key=lambda r: (-r.users, r.template))
    return out


# ── 交易 / trading ─────────────────────────────────────────────────────────

def trading(db: Session, spec: RangeSpec) -> TradingOut:
    rows = (
        db.query(Order.user_id, Order.created_at)
        .join(User, User.id == Order.user_id)
        .filter(
            NOT_ADMIN,
            Order.status == "FILLED",
            Order.created_at >= day_start_utc(spec.compare_start),
            Order.created_at < day_start_utc(spec.end + timedelta(days=1)),
        )
        .all()
    )
    fills_by_day: dict[str, int] = defaultdict(int)
    traders_cur: set[str] = set()
    traders_prev: set[str] = set()
    fills_cur = fills_prev = 0
    for uid, created in rows:
        if created is None:
            continue
        d = local_day(created)
        if spec.start <= d <= spec.end:
            fills_cur += 1
            traders_cur.add(uid)
            fills_by_day[d.isoformat()] += 1
        elif spec.compare_start <= d <= spec.compare_end:
            fills_prev += 1
            traders_prev.add(uid)
    return TradingOut(
        traders=CompareOut(current=len(traders_cur), previous=len(traders_prev)),
        fills=CompareOut(current=fills_cur, previous=fills_prev),
        daily=[TradingDayOut(date=key, fills=fills_by_day.get(key, 0)) for key in spec.day_keys()],
    )


# ── 总装 / assembly ────────────────────────────────────────────────────────

def build_overview(db: Session, spec: RangeSpec, today: date) -> AdminOverviewOut:
    first_marker = _as_date(db.query(func.min(PageVisitorDay.day)).scalar())
    return AdminOverviewOut(
        range=OverviewRangeOut(
            start=spec.start.isoformat(),
            end=spec.end.isoformat(),
            days=spec.days,
            compareStart=spec.compare_start.isoformat(),
            compareEnd=spec.compare_end.isoformat(),
        ),
        headline=headline(db, spec, today),
        activityDaily=activity_daily(db, spec),
        funnel=funnel(db, today),
        retention=retention(db, today, first_marker),
        plans=plans(db),
        strategies=strategies(db),
        trading=trading(db, spec),
        visitorDataSince=first_marker.isoformat() if first_marker else None,
    )
