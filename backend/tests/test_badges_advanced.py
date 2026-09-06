from datetime import datetime, timedelta, timezone
from app.models import User, Order, ClosedTrade
from app.services.gamification.badges import judge_and_award_badges, _evergreen_months

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
    assert "evergreen:1" in judge_and_award_badges(db_session, u.id)


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
    assert "winning_hand:3" in judge_and_award_badges(db_session, u.id)


def test_profit_factor_excludes_exact_zero_positions(db_session):
    """恰好 0 盈亏的仓位不进胜负任何一边，只占样本量和总盈亏两道闸门——
    否则会拉低亏损仓的平均亏损，把本该够不着 2.0 的盈亏比错误撑过线。"""
    u = _user(db_session, email="pf2@t.co")
    for i in range(60):                        # 60 胜每笔 +3 → 均盈利 3
        _pos(db_session, u, 800 + i, 3.0, NOW - timedelta(days=5))
    for i in range(40):                        # 40 负每笔 -2 → 均亏损 2，盈亏比 1.5，本不该达标
        _pos(db_session, u, 900 + i, -2.0, NOW - timedelta(days=5))
    for i in range(40):                        # 40 笔恰好 0——若被算进「亏损」会把均亏损拉到 1.0，误判达标
        _pos(db_session, u, 1000 + i, 0.0, NOW - timedelta(days=5))
    assert "winning_hand:3" not in judge_and_award_badges(db_session, u.id)


def test_evergreen_dec_to_jan_adjacency(db_session):
    """跨年 12 月→1 月要接得上（_next 用 (y+1, 1)），不是巧合刚好过了年就断串。"""
    u = _user(db_session, email="ev3@t.co")
    _pos(db_session, u, 601, 5.0, datetime(2025, 11, 15, tzinfo=timezone.utc))
    _pos(db_session, u, 602, 5.0, datetime(2025, 12, 15, tzinfo=timezone.utc))
    _pos(db_session, u, 603, 5.0, datetime(2026, 1, 15, tzinfo=timezone.utc))
    assert _evergreen_months(db_session, u.id) == 3
