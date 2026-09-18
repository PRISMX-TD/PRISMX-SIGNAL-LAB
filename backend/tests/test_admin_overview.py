"""看板每个数字的口径。

夹具约定：`_user()` 造非管理员用户；`_admin()` 造管理员——每条测试都同时放一个
管理员进去，任何数字把他算进去都要红。日期全用北京时间（STATS_TZ 固定为
Asia/Shanghai），`TODAY` 固定为 2026-09-16（周三）。
"""
from datetime import date, datetime, timedelta, timezone

import pytest

from app.core.config import settings
from app.models import MT5Account, Order, PageVisitorDay, User, UserStrategy
from app.services.stats_time import RangeSpec, day_start_utc
from app.services import admin_overview as ov
from app.services.admin_overview import POTENTIAL_WINDOW_DAYS as POTENTIAL_WINDOW

TODAY = date(2026, 9, 16)
# 本月 9/1..9/16，对比 8/16..8/31
SPEC = RangeSpec(date(2026, 9, 1), TODAY, date(2026, 8, 16), date(2026, 8, 31))


@pytest.fixture(autouse=True)
def _beijing(monkeypatch):
    monkeypatch.setattr(settings, "STATS_TZ", "Asia/Shanghai")


def _at(d: date, hour: int = 4) -> datetime:
    """北京时间 d 日 hour 点，转成库里存的 naive UTC。默认 04:00 避免贴日界。"""
    return day_start_utc(d) + timedelta(hours=hour)


def _user(db, email, *, created: date = date(2026, 9, 1), role="user", plan="FREE",
          trial=False, trial_used=False) -> User:
    u = User(email=email, api_token="tok_" + email, role=role, plan=plan,
             plan_is_trial=trial, created_at=_at(created),
             trial_used_at=_at(created) if trial_used else None)
    db.add(u); db.commit(); return u


def _admin(db) -> User:
    return _user(db, "admin@t.co", role="admin", created=date(2026, 9, 10))


def _visit(db, user: User, d: date, path="/dashboard"):
    db.add(PageVisitorDay(path=path, day=d, user_id=user.id)); db.commit()


def _bind(db, user: User, login="1001", trade_mode=None):
    # 唯一约束是 (user_id, login, server)，同一人两个账号要换 login
    db.add(MT5Account(user_id=user.id, login=login, trade_mode=trade_mode)); db.commit()


def _fill(db, user: User, d: date, status="FILLED"):
    db.add(Order(user_id=user.id, client_order_id=f"c-{user.id}-{d}-{status}", symbol="XAUUSD",
                 side="BUY", volume=0.1, status=status, created_at=_at(d)))
    db.commit()


# ── headline ───────────────────────────────────────────────────────────────

def test_total_users_excludes_admin(db_session):
    _user(db_session, "a@t.co"); _user(db_session, "b@t.co"); _admin(db_session)
    assert ov.headline(db_session, SPEC, TODAY).totalUsers == 2


def test_active_counts_come_from_page_visits_only(db_session):
    a = _user(db_session, "a@t.co"); b = _user(db_session, "b@t.co"); c = _user(db_session, "c@t.co")
    adm = _admin(db_session)
    # last_active_at 不算：c 有 last_active_at 但从没打开过页面
    c.last_active_at = datetime.now(timezone.utc); db_session.commit()
    _visit(db_session, a, TODAY); _visit(db_session, a, TODAY, path="/charts")   # 同一天两页算 1 人
    _visit(db_session, b, TODAY - timedelta(days=6))                             # 周内、非今日
    _visit(db_session, adm, TODAY)                                               # 管理员不算
    h = ov.headline(db_session, SPEC, TODAY)
    assert (h.activeToday, h.activeWeek, h.activeMonth) == (1, 2, 2)


def test_active_month_is_30_days_window(db_session):
    a = _user(db_session, "a@t.co"); b = _user(db_session, "b@t.co")
    _visit(db_session, a, TODAY - timedelta(days=29))   # 刚好在窗口内
    _visit(db_session, b, TODAY - timedelta(days=30))   # 刚好在窗口外
    h = ov.headline(db_session, SPEC, TODAY)
    assert (h.activeWeek, h.activeMonth) == (0, 1)


def test_signups_by_stats_tz_day_with_compare(db_session):
    # UTC 8/31 20:00 = 北京 9/1 04:00 → 算本期；UTC 8/31 10:00 = 北京 8/31 → 算对比期
    u1 = User(email="x@t.co", api_token="t1", created_at=datetime(2026, 8, 31, 20, 0))
    u2 = User(email="y@t.co", api_token="t2", created_at=datetime(2026, 8, 31, 10, 0))
    db_session.add_all([u1, u2]); db_session.commit()
    _user(db_session, "z@t.co", created=date(2026, 9, 10))
    _admin(db_session)
    h = ov.headline(db_session, SPEC, TODAY)
    assert (h.signups.current, h.signups.previous) == (2, 1)


# ── activityDaily ──────────────────────────────────────────────────────────

def test_activity_daily_is_contiguous_and_zero_filled(db_session):
    a = _user(db_session, "a@t.co", created=date(2026, 9, 2)); adm = _admin(db_session)
    _visit(db_session, a, date(2026, 9, 2)); _visit(db_session, a, date(2026, 9, 2), path="/orders")
    _visit(db_session, a, date(2026, 9, 5))
    # 管理员访问应当被剔除，管理员注册也不计
    _visit(db_session, adm, date(2026, 9, 3))
    rows = ov.activity_daily(db_session, SPEC)
    assert len(rows) == 16
    by = {r.date: r for r in rows}
    assert (by["2026-09-02"].active, by["2026-09-02"].signups) == (1, 1)
    assert (by["2026-09-03"].active, by["2026-09-03"].signups) == (0, 0)  # admin visit and signup excluded
    assert by["2026-09-05"].active == 1
    assert by["2026-09-10"].signups == 0  # admin signup on 9/10 excluded


def test_signups_boundary_at_stats_tz_midnight(db_session):
    """注册时间恰好在北京零点的边界条件。

    UTC 8/31 16:00 = Beijing 9/1 00:00:00 → should count in current period (9/1..9/16)
    UTC 8/31 15:59:59 = Beijing 8/31 23:59:59 → should count in compare period (8/16..8/31)
    """
    u1 = User(email="at_midnight@t.co", api_token="t_midnight", created_at=datetime(2026, 8, 31, 16, 0))
    u2 = User(email="just_before@t.co", api_token="t_before", created_at=datetime(2026, 8, 31, 15, 59, 59))
    db_session.add_all([u1, u2]); db_session.commit()
    _admin(db_session)

    h = ov.headline(db_session, SPEC, TODAY)
    assert (h.signups.current, h.signups.previous) == (1, 1)

    rows = ov.activity_daily(db_session, SPEC)
    by = {r.date: r for r in rows}
    assert by["2026-09-01"].signups == 1  # u1 registered at exactly midnight, counts in 9/1


# ── funnel ─────────────────────────────────────────────────────────────────

def test_funnel_overall_steps_are_independent(db_session):
    a = _user(db_session, "a@t.co"); b = _user(db_session, "b@t.co"); _user(db_session, "c@t.co")
    adm = _admin(db_session)
    _bind(db_session, a); _bind(db_session, a, login="1002")   # 两个账号算 1 人
    _fill(db_session, a, date(2026, 9, 3))
    _fill(db_session, b, date(2026, 9, 3), status="REJECTED")   # 没成交不算
    _bind(db_session, adm); _fill(db_session, adm, TODAY)       # 管理员不算
    f = ov.funnel(db_session, TODAY).overall
    assert (f.registered, f.bound, f.traded) == (3, 1, 1)


def test_funnel_bound_splits_real_and_demo(db_session):
    from app.services.account_type import CONTEST, DEMO, REAL
    a = _user(db_session, "a@t.co"); b = _user(db_session, "b@t.co"); c = _user(db_session, "c@t.co")
    d = _user(db_session, "d@t.co"); adm = _admin(db_session)
    _bind(db_session, a, trade_mode=REAL)
    _bind(db_session, a, login="1002", trade_mode=DEMO)      # 两种都有 → 两边都算
    _bind(db_session, b, trade_mode=DEMO)
    _bind(db_session, c, trade_mode=CONTEST)                  # 比赛仓归模拟
    _bind(db_session, d)                                      # 未判定归模拟
    _bind(db_session, adm, trade_mode=REAL)                   # 管理员不算
    f = ov.funnel(db_session, TODAY).overall
    assert (f.bound, f.boundReal, f.boundDemo) == (4, 1, 4)
    week = ov.funnel(db_session, TODAY).byWeek[-3]            # 9/1 注册 → 8/31 那周
    assert (week.weekStart, week.boundReal, week.boundDemo) == ("2026-08-31", 1, 4)


def test_potential_is_unbound_and_frequent_this_week(db_session):
    """潜在客户 = 没绑 MT5 + 窗口内活跃天数达门槛。"""
    a = _user(db_session, "a@t.co")   # 3 天、没绑 → 算
    b = _user(db_session, "b@t.co")   # 只 2 天 → 不算
    c = _user(db_session, "c@t.co")   # 3 天但绑了 → 不算
    d = _user(db_session, "d@t.co")   # 3 天里有一天在窗口外 → 不算
    adm = _admin(db_session)
    for i in range(3):
        _visit(db_session, a, TODAY - timedelta(days=i))
        _visit(db_session, c, TODAY - timedelta(days=i))
        _visit(db_session, adm, TODAY - timedelta(days=i))
    _bind(db_session, c)
    for i in range(2):
        _visit(db_session, b, TODAY - timedelta(days=i))
    _visit(db_session, d, TODAY); _visit(db_session, d, TODAY - timedelta(days=1))
    _visit(db_session, d, TODAY - timedelta(days=7))            # 窗口是最近 7 天：第 8 天不算
    f = ov.funnel(db_session, TODAY).overall
    assert f.potential == 1


def test_potential_window_includes_the_seventh_day_back(db_session):
    a = _user(db_session, "a@t.co")
    for delta in (0, 3, POTENTIAL_WINDOW - 1):
        _visit(db_session, a, TODAY - timedelta(days=delta))
    assert ov.funnel(db_session, TODAY).overall.potential == 1


def test_potential_counts_one_day_once_even_across_pages(db_session):
    """同一天开好几个页面只算一天——门槛是活跃天数，不是页面数。"""
    a = _user(db_session, "a@t.co")
    for path in ("/dashboard", "/charts", "/orders"):
        _visit(db_session, a, TODAY, path=path)
    assert ov.funnel(db_session, TODAY).overall.potential == 0


def test_potential_customers_list_matches_the_funnel_number(db_session):
    a = _user(db_session, "a@t.co", created=date(2026, 9, 1))
    b = _user(db_session, "b@t.co", created=date(2026, 9, 2))
    _admin(db_session)
    for i in range(4):
        _visit(db_session, a, TODAY - timedelta(days=i))
    for i in range(3):
        _visit(db_session, b, TODAY - timedelta(days=i))
    out = ov.potential_customers(db_session, TODAY)
    assert out.total == ov.funnel(db_session, TODAY).overall.potential == 2
    assert (out.windowDays, out.minActiveDays, out.windowFrom) == (7, 3, "2026-09-10")
    assert [u.email for u in out.users] == ["a@t.co", "b@t.co"]   # 活跃天数降序
    assert (out.users[0].activeDays, out.users[0].lastActiveDay) == (4, "2026-09-16")


def test_potential_customers_reports_total_beyond_the_limit(db_session):
    for n in range(3):
        u = _user(db_session, f"u{n}@t.co")
        for i in range(3):
            _visit(db_session, u, TODAY - timedelta(days=i))
    out = ov.potential_customers(db_session, TODAY, limit=2)
    assert (out.total, len(out.users)) == (3, 2)


def test_potential_customers_route(db_session):
    """路由用真实的"今天"，所以用例的访问日也跟着真实今天走——写死日期会随时间失效。"""
    from app.services.stats_time import today as stats_today

    adm = _admin(db_session)
    u = _user(db_session, "lead@t.co")
    real_today = stats_today()
    for i in range(3):
        _visit(db_session, u, real_today - timedelta(days=i))
    res = _client(db_session, adm).get("/admin/potential-customers")
    assert res.status_code == 200, res.text
    body = res.json()
    assert (body["windowDays"], body["minActiveDays"], body["total"]) == (7, 3, 1)
    assert body["users"][0]["email"] == "lead@t.co" and body["users"][0]["activeDays"] == 3


def test_funnel_by_week_is_8_monday_weeks_ascending(db_session):
    # TODAY 9/16 周三 → 本周 9/14；8 周 = 7/27..9/14
    a = _user(db_session, "a@t.co", created=date(2026, 9, 14))   # 本周
    b = _user(db_session, "b@t.co", created=date(2026, 9, 13))   # 上周日 → 9/7 那周
    _user(db_session, "old@t.co", created=date(2026, 7, 26))     # 8 周之前，不在表里
    _bind(db_session, a)
    weeks = ov.funnel(db_session, TODAY).byWeek
    assert [w.weekStart for w in weeks][-2:] == ["2026-09-07", "2026-09-14"]
    assert weeks[0].weekStart == "2026-07-27" and len(weeks) == 8
    last, prev = weeks[-1], weeks[-2]
    assert (last.registered, last.bound) == (1, 1)
    assert (prev.registered, prev.bound) == (1, 0)
    assert sum(w.registered for w in weeks) == 2


# ── retention ──────────────────────────────────────────────────────────────

def test_retention_d2_counts_exact_next_day_only(db_session):
    a = _user(db_session, "a@t.co", created=date(2026, 9, 10))
    b = _user(db_session, "b@t.co", created=date(2026, 9, 10))
    c = _user(db_session, "c@t.co", created=date(2026, 9, 10))
    _visit(db_session, a, date(2026, 9, 11))   # 第 2 天 → 留存
    _visit(db_session, b, date(2026, 9, 12))   # 第 3 天 → 不算 d2
    _visit(db_session, c, date(2026, 9, 10))   # 注册当天 → 不算
    r = ov.retention(db_session, TODAY).d2
    assert (r.cohortSize, r.rate) == (3, pytest.approx(1 / 3))
    assert (r.cohortFrom, r.cohortTo) == ("2026-09-10", "2026-09-10")


def test_retention_cohort_only_includes_users_whose_day_n_has_passed(db_session):
    # d7：第 7 天 = 注册日 + 6，必须 <= 昨天(9/15) → 注册日 <= 9/9
    in_user = _user(db_session, "in@t.co", created=date(2026, 9, 9))
    _user(db_session, "out@t.co", created=date(2026, 9, 10))
    _admin(db_session)
    # 最早访问标记要落在 in_user 注册日或更早，否则新的 cohort 下限（F1）会把他
    # 排除在外；标记打在注册当天本身，不影响 d7 要看的第 7 天（9/15）判定。
    _visit(db_session, in_user, date(2026, 9, 9))
    r = ov.retention(db_session, TODAY).d7
    assert (r.cohortSize, r.rate) == (1, 0.0)


def test_retention_empty_cohort_is_null(db_session):
    _user(db_session, "new@t.co", created=date(2026, 9, 15))
    r = ov.retention(db_session, TODAY).d30
    assert (r.cohortSize, r.rate, r.cohortFrom, r.cohortTo) == (0, None, None, None)


def test_retention_ignores_users_older_than_retention_window(db_session):
    _user(db_session, "ancient@t.co", created=TODAY - timedelta(days=401))
    ok = _user(db_session, "ok@t.co", created=TODAY - timedelta(days=400))
    # 最早访问标记要落在 ok 的注册日或更早，否则 F1 的 cohort 下限会以"最早标记"
    # 收紧到今天，把两人都挡在外面；打在注册当天本身，不影响 d2 判定（注册日+1）。
    _visit(db_session, ok, TODAY - timedelta(days=400))
    assert ov.retention(db_session, TODAY).d2.cohortSize == 1


def test_retention_cohort_starts_at_first_visitor_marker(db_session):
    # 访问标记从 9/1 开始；8/20 注册的人分子必为 0，不该进 cohort
    old = _user(db_session, "old@t.co", created=date(2026, 8, 20))
    new = _user(db_session, "new@t.co", created=date(2026, 9, 2))
    _visit(db_session, new, date(2026, 9, 1))          # 最早标记 = 9/1
    _visit(db_session, new, date(2026, 9, 3))          # 第 2 天回来
    r = ov.retention(db_session, TODAY).d2
    assert (r.cohortSize, r.rate, r.cohortFrom) == (1, 1.0, "2026-09-02")
    assert ov.build_overview(db_session, SPEC, TODAY).visitorDataSince == "2026-09-01"


def test_retention_with_no_markers_is_all_null(db_session):
    _user(db_session, "a@t.co", created=date(2026, 8, 1))
    out = ov.build_overview(db_session, SPEC, TODAY)
    assert out.visitorDataSince is None
    assert out.retention.d2.rate is None and out.retention.d2.cohortSize == 0


# ── plans / strategies / trading / build ───────────────────────────────────

def test_plans_split_pro_into_paid_and_trial(db_session):
    _user(db_session, "f@t.co")
    _user(db_session, "p@t.co", plan="PRO")
    _user(db_session, "t@t.co", plan="PRO", trial=True)
    _admin(db_session)
    assert ov.plans(db_session) == {"FREE": 1, "PRO_PAID": 1, "PRO_TRIAL": 1}


def test_strategies_group_by_template_and_enabled(db_session):
    a = _user(db_session, "a@t.co"); b = _user(db_session, "b@t.co"); adm = _admin(db_session)
    db_session.add_all([
        UserStrategy(user_id=a.id, template="ma_trend", symbol="XAUUSD", interval="15m", enabled=True),
        UserStrategy(user_id=a.id, template="ma_trend", symbol="EURUSD", interval="1h", enabled=True),   # 同人两条算 1
        UserStrategy(user_id=b.id, template="ma_trend", symbol="XAUUSD", interval="15m", enabled=False),
        UserStrategy(user_id=b.id, template=None, symbol="XAUUSD", interval="15m", enabled=True),        # 无模板 → custom
        UserStrategy(user_id=adm.id, template="rsi_reversal", symbol="XAUUSD", interval="15m", enabled=True),
    ])
    db_session.commit()
    rows = {r.template: r for r in ov.strategies(db_session)}
    assert set(rows) == {"ma_trend", "custom"}
    assert (rows["ma_trend"].users, rows["ma_trend"].enabledUsers) == (2, 1)
    assert (rows["custom"].users, rows["custom"].enabledUsers) == (1, 1)
    assert [r.template for r in ov.strategies(db_session)] == ["ma_trend", "custom"]  # users 降序


def test_trading_counts_fills_in_range_with_compare_and_daily(db_session):
    a = _user(db_session, "a@t.co"); b = _user(db_session, "b@t.co"); adm = _admin(db_session)
    _fill(db_session, a, date(2026, 9, 2)); _fill(db_session, a, date(2026, 9, 2), status="FAILED")
    db_session.add(Order(user_id=a.id, client_order_id="c2", symbol="XAUUSD", side="SELL", volume=0.1,
                         status="FILLED", created_at=_at(date(2026, 9, 2), hour=9)))
    db_session.commit()
    _fill(db_session, b, date(2026, 9, 16))
    _fill(db_session, b, date(2026, 8, 20))      # 对比期
    _fill(db_session, adm, date(2026, 9, 5))     # 管理员不算
    t = ov.trading(db_session, SPEC)
    assert (t.traders.current, t.traders.previous) == (2, 1)
    assert (t.fills.current, t.fills.previous) == (3, 1)
    by = {d.date: d.fills for d in t.daily}
    assert len(t.daily) == 16 and by["2026-09-02"] == 2 and by["2026-09-03"] == 0 and by["2026-09-16"] == 1


def test_build_overview_assembles_everything(db_session):
    a = _user(db_session, "a@t.co", plan="PRO", trial=True)
    b = _user(db_session, "b@t.co")
    _admin(db_session)
    _visit(db_session, a, TODAY)
    _bind(db_session, a)
    _fill(db_session, a, date(2026, 9, 5))
    db_session.add(UserStrategy(user_id=b.id, template="ma_trend", symbol="XAUUSD", interval="15m", enabled=True))
    db_session.commit()

    out = ov.build_overview(db_session, SPEC, TODAY)
    assert out.range.start == "2026-09-01" and out.range.compareEnd == "2026-08-31" and out.range.days == 16
    assert out.headline.totalUsers == 2 and out.headline.activeToday == 1
    assert len(out.activityDaily) == 16 and out.activityDaily[-1].active == 1
    assert out.funnel.overall.bound == 1 and out.funnel.overall.traded == 1 and len(out.funnel.byWeek) == 8
    assert out.retention.d30.rate is None
    assert out.plans == {"FREE": 1, "PRO_TRIAL": 1}
    assert [(s.template, s.users, s.enabledUsers) for s in out.strategies] == [("ma_trend", 1, 1)]
    assert out.trading.fills.current == 1 and out.trading.traders.current == 1
    assert {d.date: d.fills for d in out.trading.daily}["2026-09-05"] == 1


# ── 路由 / routes ──────────────────────────────────────────────────────────

def _client(db_session, admin: User):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from app.core.database import get_db
    from app.routers import admin as admin_router
    from app.services.deps import require_admin

    # TestClient 的同步路由经 anyio 线程池在另一个线程执行；db_session 的引擎是
    # SQLite 内存库 + SingletonThreadPool（conftest.py 没配 StaticPool），换线程会
    # 拿到全新的空库。这里先把连接签出、开一个不提交的事务钉住，后续跨线程查询
    # 复用同一个 Connection 对象，不再按线程向池子要新连接。
    # TestClient runs sync routes on a worker thread via anyio's threadpool;
    # db_session's engine is in-memory SQLite with SingletonThreadPool (no
    # StaticPool in conftest.py), so a different thread gets a brand new, empty
    # database. Pin the session to an already-checked-out connection so later
    # cross-thread queries reuse that same Connection instead of asking the pool
    # for a per-thread one.
    db_session.connection()

    app = FastAPI()
    app.include_router(admin_router.router)
    app.dependency_overrides[get_db] = lambda: db_session
    app.dependency_overrides[require_admin] = lambda: admin
    return TestClient(app)


def test_overview_route_resolves_preset_and_returns_shape(db_session):
    adm = _admin(db_session); _user(db_session, "a@t.co")
    res = _client(db_session, adm).get("/admin/overview?range=month")
    assert res.status_code == 200, res.text
    body = res.json()
    assert set(body) == {
        "range", "headline", "activityDaily", "funnel", "retention", "plans", "strategies", "trading",
        "visitorDataSince",
    }
    assert body["range"]["start"].endswith("-01")
    assert body["headline"]["totalUsers"] == 1


@pytest.mark.parametrize("qs", [
    "from=2026-09-12&to=2026-09-10",
    "from=2025-01-01&to=2026-09-16",
    "range=fortnight",
    "from=2026-09-10",
    "from=2099-01-01&to=2099-01-02",
])
def test_overview_route_rejects_bad_ranges_with_422(db_session, qs):
    adm = _admin(db_session)
    assert _client(db_session, adm).get(f"/admin/overview?{qs}").status_code == 422


def test_metrics_route_is_gone(db_session):
    adm = _admin(db_session)
    assert _client(db_session, adm).get("/admin/metrics").status_code == 404


def test_page_stats_route_uses_same_range_params_and_stats_tz_days(db_session):
    from app.models import PageViewStat
    adm = _admin(db_session); u = _user(db_session, "a@t.co")
    # UTC 9/15 20:00 桶 = 北京 9/16 04:00 → 归到 9/16
    db_session.add(PageViewStat(path="/dashboard", time_bucket=datetime(2026, 9, 15, 20, 0), views=3, total_seconds=90.0))
    _visit(db_session, u, date(2026, 9, 16))
    db_session.commit()
    res = _client(db_session, adm).get("/admin/page-stats?from=2026-09-16&to=2026-09-16")
    assert res.status_code == 200, res.text
    body = res.json()
    assert (body["start"], body["end"], body["days"]) == ("2026-09-16", "2026-09-16", 1)
    page = body["pages"][0]
    assert (page["path"], page["views"], page["visitors"], page["avgSeconds"]) == ("/dashboard", 3, 1, 30.0)
    assert body["dates"] == ["2026-09-16"]
    # 老参数不再接受 / legacy param no longer accepted
    assert _client(db_session, adm).get("/admin/page-stats?days=7").status_code == 200  # 未知参数被忽略，走默认本月


def test_funnel_week_assignment_uses_stats_tz_day(db_session):
    # UTC 周日 9/13 16:30 = 北京周一 9/14 00:30 → 落在 9/14 那周
    u = User(email="wk@t.co", api_token="tok_wk", created_at=datetime(2026, 9, 13, 16, 30))
    db_session.add(u); db_session.commit()
    weeks = {w.weekStart: w.registered for w in ov.funnel(db_session, TODAY).byWeek}
    assert weeks["2026-09-14"] == 1 and weeks["2026-09-07"] == 0


def test_page_stats_excludes_bucket_that_falls_on_next_stats_tz_day(db_session):
    from app.models import PageViewStat
    adm = _admin(db_session)
    # UTC 9/16 16:00 桶 = 北京 9/17 00:00 → 不属于 9/16
    db_session.add(PageViewStat(path="/dashboard", time_bucket=datetime(2026, 9, 16, 16, 0), views=1, total_seconds=10.0))
    db_session.commit()
    body = _client(db_session, adm).get("/admin/page-stats?from=2026-09-16&to=2026-09-16").json()
    assert body["pages"] == []
