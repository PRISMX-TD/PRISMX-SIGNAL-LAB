from datetime import datetime, timedelta, timezone
from app.models import User, Order, ClosedTrade, Signal
from app.services.gamification.badges import (
    judge_and_award_badges, _evergreen_months, _consecutive_clean_signal_positions)

NOW = datetime.now(timezone.utc)


def _user(db, email="ab@t.co"):
    u = User(email=email, api_token="tok_" + email); db.add(u); db.commit(); return u


def _pos(db, u, ticket, profit, closed_at, signal_id=None, sl=None, price=None):
    db.add(Order(user_id=u.id, client_order_id=f"p{ticket}", symbol="X", side="BUY",
                 volume=0.1, status="FILLED", mt5_login="1", mt5_ticket=ticket,
                 trade_mode=2, created_at=closed_at - timedelta(hours=1),
                 signal_id=signal_id, sl=sl, filled_price=price))
    db.add(ClosedTrade(user_id=u.id, mt5_login="1", symbol="X", side="BUY",
                       close_volume=0.1, close_price=1, profit=profit,
                       position_ticket=ticket, deal_ticket=ticket * 10,
                       closed_at=closed_at, verified=True))
    db.commit()


def _month(offset):
    y, m = NOW.year, NOW.month
    m -= offset
    while m <= 0:
        m += 12; y -= 1
    return datetime(y, m, 15, tzinfo=timezone.utc)


def test_evergreen_counts_completed_months_only(db_session):
    u = _user(db_session)
    for i in (1, 2, 3):                     # 最近 3 个完整月各一笔盈利
        _pos(db_session, u, 100 + i, 5.0, _month(i))
    _pos(db_session, u, 200, 5.0, _month(0))  # 当前月不算
    assert _evergreen_months(db_session, u.id) == 3
    assert "evergreen_3m" in judge_and_award_badges(db_session, u.id)


def test_evergreen_loss_month_breaks(db_session):
    u = _user(db_session, email="ev2@t.co")
    _pos(db_session, u, 1, 5.0, _month(1))
    _pos(db_session, u, 2, -9.0, _month(2))   # 亏损月断串
    _pos(db_session, u, 3, 5.0, _month(3))
    assert _evergreen_months(db_session, u.id) == 1


def test_profit_factor(db_session):
    u = _user(db_session, email="pf@t.co")
    for i in range(60):                        # 60 胜每笔 +4
        _pos(db_session, u, 300 + i, 4.0, NOW - timedelta(days=5))
    for i in range(40):                        # 40 负每笔 -2 → 平均盈亏比 2.0，总盈亏 +160
        _pos(db_session, u, 400 + i, -2.0, NOW - timedelta(days=5))
    assert "profit_factor_2" in judge_and_award_badges(db_session, u.id)


def test_clean_signal_streak_stops_at_violation(db_session):
    u = _user(db_session, email="sl@t.co")
    sig = Signal(symbol="X", side="BUY")       # 若 Signal 必填字段更多，按模型补齐
    db_session.add(sig); db_session.commit()
    for i in range(3):
        _pos(db_session, u, 500 + i, 1.0, NOW - timedelta(days=3 - i),
             signal_id=sig.id, sl=0.9, price=1.0)
    # 给最早的仓加一条恶意移损 MODIFY（清掉止损）
    db_session.add(Order(user_id=u.id, client_order_id="m1", symbol="X", side="BUY",
                         volume=0.1, status="FILLED", mt5_login="1", action="MODIFY",
                         ticket=500, sl=0, created_at=NOW - timedelta(days=3)))
    db_session.commit()
    assert _consecutive_clean_signal_positions(db_session, u.id) == 2  # 到违规仓即停
