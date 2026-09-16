"""看板每个数字的口径。

夹具约定：`_user()` 造非管理员用户；`_admin()` 造管理员——每条测试都同时放一个
管理员进去，任何数字把他算进去都要红。日期全用北京时间（STATS_TZ 固定为
Asia/Shanghai），`TODAY` 固定为 2026-09-16（周三）。
"""
from datetime import date, datetime, timedelta, timezone

import pytest

from app.core.config import settings
from app.models import MT5Account, Order, PageVisitorDay, Payment, User, UserStrategy
from app.services.stats_time import RangeSpec, day_start_utc
from app.services import admin_overview as ov

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


def _bind(db, user: User, login="1001"):
    # 唯一约束是 (user_id, login, server)，同一人两个账号要换 login
    db.add(MT5Account(user_id=user.id, login=login)); db.commit()


def _fill(db, user: User, d: date, status="FILLED"):
    db.add(Order(user_id=user.id, client_order_id=f"c-{user.id}-{d}-{status}", symbol="XAUUSD",
                 side="BUY", volume=0.1, status=status, created_at=_at(d)))
    db.commit()


def _pay(db, user: User, status="FINISHED"):
    db.add(Payment(user_id=user.id, nowpayments_payment_id=f"np-{user.id}-{status}", plan="pro_monthly",
                   amount_usd=29.0, pay_currency="usdttrc20", status=status))
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
    a = _user(db_session, "a@t.co"); b = _user(db_session, "b@t.co"); c = _user(db_session, "c@t.co")
    adm = _admin(db_session)
    _bind(db_session, a); _bind(db_session, a, login="1002")   # 两个账号算 1 人
    _fill(db_session, a, date(2026, 9, 3))
    _fill(db_session, b, date(2026, 9, 3), status="REJECTED")   # 没成交不算
    _pay(db_session, c)                                  # 跳过试用直接付费
    _pay(db_session, b, status="EXPIRED")                # 没付成不算
    _bind(db_session, adm); _fill(db_session, adm, TODAY); _pay(db_session, adm)
    f = ov.funnel(db_session, TODAY).overall
    assert (f.registered, f.bound, f.traded, f.trialed, f.paid) == (3, 1, 1, 0, 1)


def test_funnel_trialed_uses_trial_used_at(db_session):
    _user(db_session, "a@t.co", trial_used=True); _user(db_session, "b@t.co")
    assert ov.funnel(db_session, TODAY).overall.trialed == 1


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
    _user(db_session, "in@t.co", created=date(2026, 9, 9))
    _user(db_session, "out@t.co", created=date(2026, 9, 10))
    _admin(db_session)
    r = ov.retention(db_session, TODAY).d7
    assert (r.cohortSize, r.rate) == (1, 0.0)


def test_retention_empty_cohort_is_null(db_session):
    _user(db_session, "new@t.co", created=date(2026, 9, 15))
    r = ov.retention(db_session, TODAY).d30
    assert (r.cohortSize, r.rate, r.cohortFrom, r.cohortTo) == (0, None, None, None)


def test_retention_ignores_users_older_than_retention_window(db_session):
    _user(db_session, "ancient@t.co", created=TODAY - timedelta(days=401))
    _user(db_session, "ok@t.co", created=TODAY - timedelta(days=400))
    assert ov.retention(db_session, TODAY).d2.cohortSize == 1


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
