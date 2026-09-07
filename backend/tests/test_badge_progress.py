"""勋章进度（成就页进度条）：只回答"离下一档差多少"，与判定分离。

要钉住的：有进度的五枚各三档都有 value/target/unit；事件型 / 名次型没有进度；
常青进度是"现在还活着的一段"而不是历史最长；胜手三档用各自的主指标；
me 载荷把它下发为 `progress`（无进度的勋章为 None）。
"""
from datetime import datetime, timedelta, timezone

from app.models import User, Order, ClosedTrade, UserActiveDay
from app.routers.gamification import build_me_payload
from app.services.gamification.badge_progress import PROGRESS, badge_progress, evergreen_current_run
from app.services.gamification.badges import BADGES
from app.services.gamification.stats import (
    compute_account_lifetime_stats, compute_comprehensive_stats, load_trade_data,
)

NOW = datetime.now(timezone.utc)


def _user(db, email="pg@t.co"):
    u = User(email=email, api_token="tok_" + email)
    db.add(u); db.commit(); return u


def _fill(db, u, ticket, login="1", profit=1.0, closed_at=None):
    ts = closed_at or NOW
    db.add(Order(user_id=u.id, client_order_id=f"pg{login}-{ticket}", symbol="X", side="BUY",
                 volume=0.1, status="FILLED", mt5_login=login, mt5_ticket=ticket,
                 trade_mode=2, created_at=ts - timedelta(hours=1)))
    db.add(ClosedTrade(user_id=u.id, mt5_login=login, symbol="X", side="BUY",
                       close_volume=0.1, close_price=1, profit=profit,
                       position_ticket=ticket, deal_ticket=ticket * 10 + int(login),
                       closed_at=ts, verified=True))


def _ctx(db, u):
    data = load_trade_data(db, u.id)
    return {"stats": compute_comprehensive_stats(db, u.id, data),
            "lifetime": compute_account_lifetime_stats(db, u.id, data), "data": data}


def _month(offset):
    y, m = NOW.year, NOW.month
    m -= offset
    while m <= 0:
        m += 12; y -= 1
    return datetime(y, m, 15, tzinfo=timezone.utc)


def test_progress_registry_matches_tiered_badges():
    for bid, tiers in PROGRESS.items():
        assert BADGES[bid]["max_tier"] == 3 and len(tiers) == 3, bid
        assert [t[1] for t in tiers] == sorted(t[1] for t in tiers) or bid == "winning_hand"
    for bid in ("starter", "arena", "board_return", "comp_back_to_back", "comeback", "founder_2026"):
        assert bid not in PROGRESS


def test_progress_values_for_counting_badges(db_session):
    u = _user(db_session)
    for i in range(1, 8):                                            # 7 笔实盘平仓，两账户
        _fill(db_session, u, i, login="1" if i % 2 else "2", profit=1.0 if i != 3 else -1.0)
    for i in range(5):                                               # 昨天起往回 5 天连续登录
        db_session.add(UserActiveDay(user_id=u.id, day=(NOW.date() - timedelta(days=1 + i)).isoformat()))
    db_session.commit()
    p = badge_progress(db_session, u, _ctx(db_session, u))
    assert p["veteran"][0] == {"value": 7, "target": 100, "unit": "trades"}
    assert [r["target"] for r in p["veteran"]] == [100, 500, 2000]
    assert p["regular"][0] == {"value": 5, "target": 7, "unit": "days"}
    assert p["campaigner"][0] == {"value": 0, "target": 3, "unit": "comps"}
    assert p["winning_hand"][0]["unit"] == "wins" and p["winning_hand"][0]["value"] == 3   # 单账户最多 3 笔盈利（login 1: 1,3(-),5,7 → 3 胜）
    assert p["winning_hand"][1] == {"value": 4, "target": 500, "unit": "trades"}        # 单账户最多 4 笔
    assert p["winning_hand"][2] == {"value": 7, "target": 100, "unit": "trades"}        # 近一年整仓 7 笔


def test_evergreen_current_run_counts_live_run_only():
    now = datetime(2026, 9, 7, tzinfo=timezone.utc)
    assert evergreen_current_run({(2026, 8): 5.0, (2026, 7): 5.0, (2026, 6): -1.0, (2026, 5): 5.0}, now) == 2
    assert evergreen_current_run({(2026, 7): 5.0, (2026, 6): 5.0}, now) == 0          # 8 月没交易：断了
    assert evergreen_current_run({(2026, 8): -2.0}, now) == 0
    assert evergreen_current_run({(2026, 8): 1.0, (2026, 7): 1.0, (2026, 6): 1.0}, now) == 3
    assert evergreen_current_run({(2026, 9): 9.0}, now) == 0                           # 当前月不算


def test_evergreen_progress_from_positions(db_session):
    u = _user(db_session, "pge@t.co")
    _fill(db_session, u, 1, profit=3.0, closed_at=_month(1))
    _fill(db_session, u, 2, profit=3.0, closed_at=_month(2))
    _fill(db_session, u, 3, profit=-9.0, closed_at=_month(3))
    db_session.commit()
    p = badge_progress(db_session, u, _ctx(db_session, u))
    assert p["evergreen"][0] == {"value": 2, "target": 3, "unit": "months"}


def test_me_payload_carries_progress(db_session):
    u = _user(db_session, "pgme@t.co")
    p = build_me_payload(db_session, u, judge=False)
    by_id = {b["id"]: b for b in p["badges"]}
    assert len(by_id["regular"]["progress"]) == 3
    assert by_id["regular"]["progress"][0] == {"value": 0, "target": 7, "unit": "days"}
    assert by_id["founder_2026"]["progress"] is None
    assert by_id["board_return"]["progress"] is None
