# 分享卡收益率接口：必须与收益榜同一口径（同一组 boards 函数、同一本金）。
# Share-card return endpoints: same definition as the return board (same functions, same capital).
from datetime import datetime, timedelta, timezone

from app.models import ClosedTrade, MT5Account, Order, PeriodBaseline, User
from app.services.gamification.boards import (_append_flow, _resolved_in_period, ensure_baselines,
                                              return_score)

UTC = timezone.utc
MK = "2026-09"
T0 = datetime(2026, 9, 1, 0, 0, tzinfo=UTC)


def _user(db, email):
    u = User(email=email, api_token="tok_" + email); db.add(u); db.commit(); return u


def _acct(db, u, login, balance):
    db.add(MT5Account(user_id=u.id, login=login, server="s", balance=balance, trade_mode=2)); db.commit()


def _pos(db, u, login, ticket, profit, opened_at, closed_at):
    db.add(Order(user_id=u.id, client_order_id=f"c{login}{ticket}", symbol="X", side="BUY", volume=0.1,
                 status="FILLED", mt5_login=login, mt5_ticket=ticket, trade_mode=2, created_at=opened_at))
    db.add(ClosedTrade(user_id=u.id, mt5_login=login, symbol="X", side="BUY", close_volume=0.1,
                       close_price=1, profit=profit, position_ticket=ticket, deal_ticket=ticket * 10,
                       closed_at=closed_at, verified=True))
    db.commit()


def _client(db_session, user):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from app.core.rate_limit import limiter
    from app.routers import gamification as g
    from app.services import deps

    db_session.connection()
    app = FastAPI()
    app.state.limiter = limiter
    app.include_router(g.router)
    app.dependency_overrides[deps.get_db] = lambda: db_session
    app.dependency_overrides[deps.get_current_user] = lambda: user
    return TestClient(app)


def test_share_month_matches_return_score(db_session):
    u = _user(db_session, "m@t.co"); _acct(db_session, u, "A", 1000.0)
    ensure_baselines(db_session, MK, T0)
    _pos(db_session, u, "A", 1, 100.0, T0 + timedelta(days=2), T0 + timedelta(days=2, hours=3))
    _pos(db_session, u, "A", 2, -40.0, T0 + timedelta(days=5), T0 + timedelta(days=5, hours=1))
    _pos(db_session, u, "A", 3, 999.0, T0 - timedelta(days=3), T0 - timedelta(days=2))   # August: not counted
    r = _client(db_session, u).get(f"/gamification/share/month?login=A&month={MK}")
    assert r.status_code == 200, r.text
    body = r.json()
    assert abs(body["returnPct"] - 6.0) < 1e-9          # (100 - 40) / 1000
    assert (body["total"], body["trades"], body["wins"]) == (60.0, 2, 1)
    # 与收益榜同一个数 / identical to the board's score
    b = db_session.query(PeriodBaseline).filter_by(user_id=u.id, mt5_login="A", period_key=MK).one()
    resolved = _resolved_in_period(db_session, u.id, {"A"}, MK, {"A": b.taken_at})["A"]
    assert abs(body["returnPct"] - return_score(b, resolved, 500.0)[0] * 100) < 1e-9


def test_share_month_no_baseline_and_bad_month(db_session):
    u = _user(db_session, "n@t.co"); _acct(db_session, u, "A", 1000.0)
    c = _client(db_session, u)
    assert c.get("/gamification/share/month?login=A&month=2026-09").json()["returnPct"] is None
    assert c.get("/gamification/share/month?login=A&month=2026-13").status_code == 422


def _leg(db, u, login, ticket, profit, opened_at, closed_at, verified=True, deal=None):
    db.add(ClosedTrade(user_id=u.id, mt5_login=login, symbol="X", side="BUY", close_volume=0.1,
                       close_price=1, profit=profit, position_ticket=ticket, deal_ticket=deal or ticket * 10,
                       closed_at=closed_at, open_time=opened_at, verified=verified))
    db.commit()


def test_share_trade_uses_capital_at_time(db_session):
    u = _user(db_session, "t@t.co"); _acct(db_session, u, "A", 1000.0)
    ensure_baselines(db_session, MK, T0)
    b = db_session.query(PeriodBaseline).filter_by(user_id=u.id, mt5_login="A", period_key=MK).one()
    _append_flow(b, T0 + timedelta(days=10), 1000.0); b.adjust = 1000.0; db_session.commit()   # 月中入金
    _leg(db_session, u, "A", 11, 100.0, datetime(2026, 9, 3, 1), datetime(2026, 9, 3, 5))
    _leg(db_session, u, "A", 12, 60.0, datetime(2026, 9, 12, 1), datetime(2026, 9, 12, 3))
    _leg(db_session, u, "A", 12, 40.0, datetime(2026, 9, 12, 1), datetime(2026, 9, 12, 5), deal=999)  # 分批平仓
    c = _client(db_session, u)
    before = c.get("/gamification/share/trade", params={"login": "A", "position": 11}).json()
    after = c.get("/gamification/share/trade", params={"login": "A", "position": 12}).json()
    assert abs(before["returnPct"] - 10.0) < 1e-9       # 100 / 1000
    assert abs(after["returnPct"] - 5.0) < 1e-9         # (60 + 40) / 2000


def test_share_trade_ignores_client_profit(db_session):
    """客户端传来的 profit 一律忽略：以前随便填个盈利就能拿到官方口径的高收益率。"""
    u = _user(db_session, "cp@t.co"); _acct(db_session, u, "A", 1000.0)
    ensure_baselines(db_session, MK, T0)
    _leg(db_session, u, "A", 11, 100.0, datetime(2026, 9, 3, 1), datetime(2026, 9, 3, 5))
    c = _client(db_session, u)
    r = c.get("/gamification/share/trade", params={
        "login": "A", "position": 11, "profit": 1e6,
        "opened_at": "2026-09-03T01:00:00", "closed_at": "2026-09-03T05:00:00"}).json()
    assert abs(r["returnPct"] - 10.0) < 1e-9
    # 旧版前端（不带 position）：不再按客户端数字算，返回 null
    legacy = c.get("/gamification/share/trade", params={
        "login": "A", "profit": 1e6, "opened_at": "2026-09-03T01:00:00", "closed_at": "2026-09-03T05:00:00"})
    assert legacy.status_code == 200 and legacy.json()["returnPct"] is None


def test_share_trade_rejects_unknown_or_foreign_position(db_session):
    u = _user(db_session, "own@t.co"); _acct(db_session, u, "A", 1000.0)
    other = _user(db_session, "oth@t.co"); _acct(db_session, other, "B", 1000.0)
    ensure_baselines(db_session, MK, T0)
    _leg(db_session, other, "B", 77, 500.0, datetime(2026, 9, 3, 1), datetime(2026, 9, 3, 5))
    # 只有未核验的腿：不给百分比 / unverified legs only: no percentage
    _leg(db_session, u, "A", 88, 50.0, datetime(2026, 9, 3, 1), datetime(2026, 9, 3, 5), verified=False)
    c = _client(db_session, u)
    assert c.get("/gamification/share/trade", params={"login": "B", "position": 77}).status_code == 404
    assert c.get("/gamification/share/trade", params={"login": "A", "position": 77}).status_code == 404
    assert c.get("/gamification/share/trade", params={"login": "A", "position": 88}).json()["returnPct"] is None


def test_share_trade_floor_and_missing_baseline(db_session):
    u = _user(db_session, "f@t.co"); _acct(db_session, u, "A", 100.0)       # 低于 500 门槛
    ensure_baselines(db_session, MK, T0)
    _leg(db_session, u, "A", 11, 10.0, datetime(2026, 9, 3, 1), datetime(2026, 9, 3, 5))
    _leg(db_session, u, "A", 12, 10.0, datetime(2026, 7, 3, 1), datetime(2026, 7, 3, 5))      # 七月：无基线
    c = _client(db_session, u)
    assert c.get("/gamification/share/trade", params={"login": "A", "position": 11}).json()["returnPct"] is None
    assert c.get("/gamification/share/trade", params={"login": "A", "position": 12}).json()["returnPct"] is None
