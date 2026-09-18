"""管理页「交易员等级」卡的口径。

等级由 user_tasks 派生，所以这里的用例全部直接写 user_tasks 行——不走判定循环，
判定逻辑有它自己的测试，这里要钉的是"从完成记录推等级与达成时刻"这一段。

每条用例都放一个管理员，任何数字把他算进去都要红。
"""
from datetime import date, datetime, timedelta

import pytest

from app.core.config import settings
from app.models import User, UserTask
from app.services import admin_trader_levels as tl
from app.services.gamification import GROUPS
from app.services.stats_time import RangeSpec

TODAY = date(2026, 9, 16)
SPEC = RangeSpec(date(2026, 9, 1), TODAY, date(2026, 8, 16), date(2026, 8, 31))

GROUP1 = GROUPS[0][1]   # set_nickname / bind_account / first_trades_5 / streak_3
GROUP2 = GROUPS[1][1]   # trade_days_30 / trades_100 / lots_10 / winrate_35


@pytest.fixture(autouse=True)
def _beijing(monkeypatch):
    monkeypatch.setattr(settings, "STATS_TZ", "Asia/Shanghai")


def _user(db, email, *, created=datetime(2026, 8, 20, 3, 0), role="user", nickname=None) -> User:
    u = User(email=email, api_token="tok_" + email, role=role, created_at=created, nickname=nickname)
    db.add(u); db.commit(); return u


def _admin(db) -> User:
    return _user(db, "admin@t.co", role="admin")


def _done(db, user: User, conds, at: datetime):
    """把若干条件标成已完成，完成时刻都记在 `at`。"""
    for cond in conds:
        db.add(UserTask(user_id=user.id, task_id=cond, completed_at=at))
    db.commit()


# ── 等级与达成时刻的派生 / deriving level and moment ────────────────────────

def test_everyone_starts_at_level_one_reached_at_signup(db_session):
    created = datetime(2026, 9, 3, 5, 30)
    u = _user(db_session, "a@t.co", created=created)
    _admin(db_session)
    rows = tl.compute_levels(db_session)
    assert [r.user.id for r in rows] == [u.id]          # 管理员不在内
    assert (rows[0].level, rows[0].reached_at) == (1, created)


def test_finishing_group_one_gives_level_two_at_the_last_condition(db_session):
    u = _user(db_session, "a@t.co")
    _admin(db_session)
    _done(db_session, u, GROUP1[:3], datetime(2026, 9, 5, 1, 0))
    _done(db_session, u, GROUP1[3:], datetime(2026, 9, 7, 8, 42, 13))   # 最后一条
    row = tl.compute_levels(db_session)[0]
    assert (row.level, row.reached_at) == (2, datetime(2026, 9, 7, 8, 42, 13))
    # 1 级的时刻仍是注册时间，两级各记各的
    assert row.reached[1] == u.created_at


def test_a_later_group_alone_does_not_raise_the_level(db_session):
    """只完成第 2 组、第 1 组还缺一条 → 仍是 1 级，第 2 组的时刻不参与计算。"""
    u = _user(db_session, "a@t.co")
    _admin(db_session)
    _done(db_session, u, GROUP1[:-1], datetime(2026, 9, 5, 1, 0))       # 缺最后一条
    _done(db_session, u, GROUP2, datetime(2026, 9, 6, 1, 0))
    row = tl.compute_levels(db_session)[0]
    assert (row.level, row.reached_at) == (1, u.created_at)
    assert set(row.reached) == {1}


def test_finishing_two_groups_records_a_moment_for_each_level(db_session):
    u = _user(db_session, "a@t.co")
    _admin(db_session)
    _done(db_session, u, GROUP1, datetime(2026, 9, 5, 1, 0))
    _done(db_session, u, GROUP2, datetime(2026, 9, 9, 22, 15, 7))
    row = tl.compute_levels(db_session)[0]
    assert row.level == 3
    assert row.reached[2] == datetime(2026, 9, 5, 1, 0)
    assert row.reached[3] == datetime(2026, 9, 9, 22, 15, 7)


# ── 每级人数 / per-level counts ────────────────────────────────────────────

def test_level_rows_count_the_stock_per_level(db_session):
    a = _user(db_session, "a@t.co"); b = _user(db_session, "b@t.co")
    _user(db_session, "c@t.co")
    adm = _admin(db_session)
    _done(db_session, a, GROUP1, datetime(2026, 9, 5, 1, 0))            # → 2 级
    _done(db_session, b, GROUP1, datetime(2026, 9, 5, 1, 0))
    _done(db_session, b, GROUP2, datetime(2026, 9, 6, 1, 0))            # → 3 级
    _done(db_session, adm, GROUP1, datetime(2026, 9, 5, 1, 0))          # 管理员不算
    out = tl.level_rows(db_session, SPEC)
    counts = {r.level: r.total for r in out.levels}
    assert out.totalUsers == 3
    assert counts == {1: 1, 2: 1, 3: 1, 4: 0, 5: 0, 6: 0}
    assert [r.key for r in out.levels] == ["novice", "junior", "elite", "senior", "chief", "legend"]
    assert sum(r.total for r in out.levels) == out.totalUsers


def test_reached_in_range_is_flow_not_stock(db_session):
    """本期升到 2 级、现在已经是 3 级的人，算进 2 级的"本期达成"但不在 2 级的"现有"。"""
    u = _user(db_session, "a@t.co")
    _admin(db_session)
    _done(db_session, u, GROUP1, datetime(2026, 9, 5, 1, 0))
    _done(db_session, u, GROUP2, datetime(2026, 9, 6, 1, 0))
    by_level = {r.level: r for r in tl.level_rows(db_session, SPEC).levels}
    assert (by_level[2].total, by_level[2].reachedInRange) == (0, 1)
    assert (by_level[3].total, by_level[3].reachedInRange) == (1, 1)


def test_reached_in_range_filters_by_stats_tz_day(db_session):
    """UTC 8/31 16:00 = 北京 9/1 00:00 → 落在本期；早一分钟就落在对比期之外。"""
    a = _user(db_session, "a@t.co"); b = _user(db_session, "b@t.co")
    _admin(db_session)
    _done(db_session, a, GROUP1, datetime(2026, 8, 31, 16, 0))          # 北京 9/1
    _done(db_session, b, GROUP1, datetime(2026, 8, 31, 15, 59))         # 北京 8/31
    by_level = {r.level: r for r in tl.level_rows(db_session, SPEC).levels}
    assert by_level[2].reachedInRange == 1
    assert by_level[2].total == 2                                       # 两人现在都是 2 级


# ── 名单 / the list ────────────────────────────────────────────────────────

def test_level_users_scope_all_lists_who_is_there_now(db_session):
    a = _user(db_session, "a@t.co", nickname="Ann")
    b = _user(db_session, "b@t.co")
    _admin(db_session)
    _done(db_session, a, GROUP1, datetime(2026, 9, 5, 1, 0))
    _done(db_session, b, GROUP1, datetime(2026, 9, 8, 9, 30, 45))
    out = tl.level_users(db_session, 2, SPEC, scope="all")
    assert (out.level, out.key, out.scope, out.total) == (2, "junior", "all", 2)
    # 达成时间倒序：晚升的排前面
    assert [u.email for u in out.users] == ["b@t.co", "a@t.co"]
    assert out.users[1].reachedAt == datetime(2026, 9, 5, 1, 0)
    assert (out.users[1].nickname, out.users[1].currentLevel) == ("Ann", 2)


def test_level_users_scope_range_includes_those_who_moved_on(db_session):
    u = _user(db_session, "a@t.co")
    _admin(db_session)
    _done(db_session, u, GROUP1, datetime(2026, 9, 5, 1, 0))
    _done(db_session, u, GROUP2, datetime(2026, 9, 6, 1, 0))            # 已升到 3 级
    all_at_2 = tl.level_users(db_session, 2, SPEC, scope="all")
    in_range_2 = tl.level_users(db_session, 2, SPEC, scope="range")
    assert all_at_2.total == 0                                          # 现在不在 2 级
    assert in_range_2.total == 1 and in_range_2.users[0].currentLevel == 3
    assert in_range_2.users[0].reachedAt == datetime(2026, 9, 5, 1, 0)


def test_level_users_scope_range_respects_the_window(db_session):
    a = _user(db_session, "a@t.co"); b = _user(db_session, "b@t.co")
    _admin(db_session)
    _done(db_session, a, GROUP1, datetime(2026, 9, 5, 1, 0))            # 本期
    _done(db_session, b, GROUP1, datetime(2026, 8, 20, 1, 0))           # 本期之前
    assert tl.level_users(db_session, 2, SPEC, scope="range").total == 1
    assert tl.level_users(db_session, 2, SPEC, scope="all").total == 2


def test_level_users_reports_total_beyond_the_limit(db_session):
    _admin(db_session)
    for n in range(3):
        u = _user(db_session, f"u{n}@t.co")
        _done(db_session, u, GROUP1, datetime(2026, 9, 5, 1, n))
    out = tl.level_users(db_session, 2, SPEC, scope="all", limit=2)
    assert (out.total, len(out.users)) == (3, 2)


def test_level_one_list_is_ordered_by_signup(db_session):
    """1 级没有升级条件，达成时刻就是注册时间——名单照样按它倒序。"""
    _user(db_session, "old@t.co", created=datetime(2026, 9, 1, 0, 0))
    _user(db_session, "new@t.co", created=datetime(2026, 9, 10, 0, 0))
    _admin(db_session)
    out = tl.level_users(db_session, 1, SPEC, scope="all")
    assert [u.email for u in out.users] == ["new@t.co", "old@t.co"]
    assert out.users[0].reachedAt == datetime(2026, 9, 10, 0, 0)


# ── 路由 / routes ──────────────────────────────────────────────────────────

def _client(db_session, admin: User):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from app.core.database import get_db
    from app.routers import admin as admin_router
    from app.services.deps import require_admin

    # TestClient 在工作线程里跑，而 conftest 的内存 SQLite 引擎没配 StaticPool：
    # 先取一次连接把它钉在这个 Session 上，否则工作线程会另开一个空库。
    db_session.connection()
    app = FastAPI()
    app.include_router(admin_router.router)
    app.dependency_overrides[get_db] = lambda: db_session
    app.dependency_overrides[require_admin] = lambda: admin
    return TestClient(app)


def test_trader_levels_route(db_session):
    adm = _admin(db_session)
    u = _user(db_session, "a@t.co")
    _done(db_session, u, GROUP1, datetime(2026, 9, 5, 1, 0))
    res = _client(db_session, adm).get("/admin/trader-levels?from=2026-09-01&to=2026-09-16")
    assert res.status_code == 200, res.text
    body = res.json()
    assert (body["rangeStart"], body["rangeEnd"], body["totalUsers"]) == ("2026-09-01", "2026-09-16", 1)
    assert len(body["levels"]) == 6
    assert body["levels"][1] == {"level": 2, "key": "junior", "total": 1, "reachedInRange": 1}


def test_trader_level_users_route_returns_seconds(db_session):
    adm = _admin(db_session)
    u = _user(db_session, "a@t.co")
    _done(db_session, u, GROUP1, datetime(2026, 9, 7, 8, 42, 13))
    res = _client(db_session, adm).get("/admin/trader-levels/2/users?from=2026-09-01&to=2026-09-16")
    assert res.status_code == 200, res.text
    body = res.json()
    assert (body["level"], body["key"], body["scope"], body["total"]) == (2, "junior", "all", 1)
    assert body["users"][0]["reachedAt"].startswith("2026-09-07T08:42:13")
    assert body["users"][0]["currentLevel"] == 2


@pytest.mark.parametrize("path", [
    "/admin/trader-levels/0/users",
    "/admin/trader-levels/7/users",
    "/admin/trader-levels/2/users?scope=whatever",
    "/admin/trader-levels?from=2026-09-12&to=2026-09-10",
])
def test_trader_level_routes_reject_bad_input(db_session, path):
    assert _client(db_session, _admin(db_session)).get(path).status_code == 422


def test_trader_level_users_route_scope_range(db_session):
    adm = _admin(db_session)
    a = _user(db_session, "a@t.co"); b = _user(db_session, "b@t.co")
    _done(db_session, a, GROUP1, datetime(2026, 9, 5, 1, 0))            # 本期
    _done(db_session, b, GROUP1, datetime(2026, 8, 1, 1, 0))            # 本期之前
    client = _client(db_session, adm)
    in_range = client.get("/admin/trader-levels/2/users?scope=range&from=2026-09-01&to=2026-09-16").json()
    every = client.get("/admin/trader-levels/2/users?scope=all&from=2026-09-01&to=2026-09-16").json()
    assert (in_range["scope"], in_range["total"]) == ("range", 1)
    assert (every["scope"], every["total"]) == ("all", 2)


def test_trader_levels_default_range_is_this_month(db_session):
    """不传范围参数时走默认（本月），与看板其它接口一致。"""
    adm = _admin(db_session)
    _user(db_session, "a@t.co")
    body = _client(db_session, adm).get("/admin/trader-levels").json()
    assert body["rangeStart"].endswith("-01") and body["totalUsers"] == 1


def test_signup_time_outside_the_window_is_not_counted_as_reaching_level_one(db_session):
    """1 级的达成时刻是注册时间，所以"本期达成 1 级"= 本期注册的人。"""
    _user(db_session, "old@t.co", created=datetime(2026, 8, 1, 0, 0))
    _user(db_session, "new@t.co", created=datetime(2026, 9, 3, 0, 0))
    _admin(db_session)
    by_level = {r.level: r for r in tl.level_rows(db_session, SPEC).levels}
    assert (by_level[1].total, by_level[1].reachedInRange) == (2, 1)
