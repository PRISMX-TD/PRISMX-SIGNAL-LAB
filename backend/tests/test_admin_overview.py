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
    a = _user(db_session, "a@t.co", created=date(2026, 9, 2)); _admin(db_session)
    _visit(db_session, a, date(2026, 9, 2)); _visit(db_session, a, date(2026, 9, 2), path="/orders")
    _visit(db_session, a, date(2026, 9, 5))
    rows = ov.activity_daily(db_session, SPEC)
    assert len(rows) == 16
    by = {r.date: r for r in rows}
    assert (by["2026-09-02"].active, by["2026-09-02"].signups) == (1, 1)
    assert (by["2026-09-03"].active, by["2026-09-03"].signups) == (0, 0)
    assert by["2026-09-05"].active == 1
