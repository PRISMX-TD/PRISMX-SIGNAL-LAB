from datetime import datetime, timedelta, timezone
from app.models import User, Order, ClosedTrade, MT5Account, UserBadge, DisciplineSnapshot
from app.services.gamification.badges import judge_and_award_badges, BADGES

NOW = datetime.now(timezone.utc)


def _user(db, **kw):
    u = User(email=kw.pop("email", "b@t.co"), api_token=kw.pop("tok", "tok_b"), **kw)
    db.add(u); db.commit(); return u


def test_registry_shape():
    assert len(BADGES) == 17
    assert BADGES["comp_winner"]["judge"] is None          # Phase 3 才发
    assert BADGES["founder_2026"]["rarity"] == "limited"


def test_growth_badges(db_session):
    u = _user(db_session, nickname="T")
    db_session.add(MT5Account(user_id=u.id, login="1", server="s")); db_session.commit()
    got = judge_and_award_badges(db_session, u.id)
    assert "profile_complete" in got and "first_close" not in got
    # 加一笔完整平仓（demo 也算 first_close）
    db_session.add(Order(user_id=u.id, client_order_id="c1", symbol="X", side="BUY",
                         volume=0.1, status="FILLED", mt5_login="1", mt5_ticket=9,
                         trade_mode=0, created_at=NOW))
    db_session.add(ClosedTrade(user_id=u.id, mt5_login="1", symbol="X", side="BUY",
                               close_volume=0.1, close_price=1, profit=1.0,
                               position_ticket=9, deal_ticket=90, closed_at=NOW,
                               verified=True))
    db_session.commit()
    got = judge_and_award_badges(db_session, u.id)
    assert "first_close" in got and "first_real_trade" not in got  # demo 不算实盘首单
    assert judge_and_award_badges(db_session, u.id) == []          # 幂等


def test_hundred_wins_single_account(db_session):
    u = _user(db_session)
    # A 账号 60 胜、B 账号 60 胜（每笔 0.2 手、盈利 1）——跨账号拼凑不得发
    t = 0
    for login, n in (("A", 60), ("B", 60)):
        for _ in range(n):
            t += 1
            db_session.add(Order(user_id=u.id, client_order_id=f"c{t}", symbol="X",
                                 side="BUY", volume=0.2, status="FILLED", mt5_login=login,
                                 mt5_ticket=t, trade_mode=2, created_at=NOW))
            db_session.add(ClosedTrade(user_id=u.id, mt5_login=login, symbol="X",
                                       side="BUY", close_volume=0.2, close_price=1,
                                       profit=1.0, position_ticket=t, deal_ticket=t * 10,
                                       closed_at=NOW, verified=True))
    db_session.commit()
    assert "hundred_wins" not in judge_and_award_badges(db_session, u.id)
    # A 账号补到 100 胜（累计 ≥20 手、盈利为正）→ 发
    for _ in range(40):
        t += 1
        db_session.add(Order(user_id=u.id, client_order_id=f"c{t}", symbol="X",
                             side="BUY", volume=0.2, status="FILLED", mt5_login="A",
                             mt5_ticket=t, trade_mode=2, created_at=NOW))
        db_session.add(ClosedTrade(user_id=u.id, mt5_login="A", symbol="X", side="BUY",
                                   close_volume=0.2, close_price=1, profit=1.0,
                                   position_ticket=t, deal_ticket=t * 10,
                                   closed_at=NOW, verified=True))
    db_session.commit()
    assert "hundred_wins" in judge_and_award_badges(db_session, u.id)


def test_founder_window(db_session):
    u = _user(db_session)
    u.created_at = datetime(2026, 5, 1, tzinfo=timezone.utc)
    db_session.add(Order(user_id=u.id, client_order_id="r1", symbol="X", side="BUY",
                         volume=0.1, status="FILLED", mt5_login="1", mt5_ticket=1,
                         trade_mode=2, created_at=NOW))
    db_session.commit()
    assert "founder_2026" in judge_and_award_badges(db_session, u.id)
    u2 = _user(db_session, email="l@t.co", tok="tok_l")
    u2.created_at = datetime(2027, 1, 2, tzinfo=timezone.utc)
    db_session.add(Order(user_id=u2.id, client_order_id="r2", symbol="X", side="BUY",
                         volume=0.1, status="FILLED", mt5_login="2", mt5_ticket=2,
                         trade_mode=2, created_at=NOW))
    db_session.commit()
    assert "founder_2026" not in judge_and_award_badges(db_session, u2.id)


def test_discipline_streak_null_breaks(db_session):
    u = _user(db_session)
    base = NOW.date()
    for i in range(7):
        d = (base - timedelta(days=i)).isoformat()
        total = None if i == 3 else 95.0     # 中间一天 NULL → 断连
        db_session.add(DisciplineSnapshot(user_id=u.id, login="", date=d, total=total))
    db_session.commit()
    assert "discipline_90_7" not in judge_and_award_badges(db_session, u.id)
    db_session.query(DisciplineSnapshot).filter_by(user_id=u.id).update({"total": 95.0})
    db_session.commit()
    assert "discipline_90_7" in judge_and_award_badges(db_session, u.id)
