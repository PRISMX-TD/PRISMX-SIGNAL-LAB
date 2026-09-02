from datetime import datetime, timedelta, timezone
from app.models import User, Order, ClosedTrade
from app.services.gamification.stats import (
    compute_comprehensive_stats, compute_account_lifetime_stats)

NOW = datetime.now(timezone.utc)


def _user(db):
    u = User(email="c@t.co", api_token="tok_c"); db.add(u); db.commit()
    return u


def _fill(db, u, login, ticket, vol=0.1, tm=2, days_ago=1, cid=None):
    o = Order(user_id=u.id, client_order_id=cid or f"c{ticket}", symbol="XAUUSD",
              side="BUY", volume=vol, status="FILLED", mt5_login=login,
              mt5_ticket=ticket, trade_mode=tm,
              created_at=NOW - timedelta(days=days_ago))
    db.add(o); db.commit()
    return o


def _close(db, u, login, ticket, profit, vol=0.1, verified=True, days_ago=1):
    db.add(ClosedTrade(user_id=u.id, mt5_login=login, symbol="XAUUSD", side="BUY",
                       close_volume=vol, close_price=1.0, profit=profit,
                       position_ticket=ticket, deal_ticket=ticket * 10,
                       closed_at=NOW - timedelta(days=days_ago), verified=verified))
    db.commit()


def test_real_whole_position_win(db_session):
    u = _user(db_session)
    _fill(db_session, u, "500123", 1); _close(db_session, u, "500123", 1, 5.0)
    s = compute_comprehensive_stats(db_session, u.id)
    assert s["trades"] == 1 and s["wins"] == 1 and s["win_rate"] == 1.0
    assert s["lots"] == 0.1 and s["trade_days"] == 1 and s["profit"] == 5.0


def test_demo_and_unverified_and_window_excluded(db_session):
    u = _user(db_session)
    _fill(db_session, u, "500123", 1, tm=0); _close(db_session, u, "500123", 1, 5.0)     # demo
    _fill(db_session, u, "500123", 2); _close(db_session, u, "500123", 2, 5.0, verified=False)  # 未核验
    _fill(db_session, u, "500123", 3, days_ago=400); _close(db_session, u, "500123", 3, 5.0, days_ago=400)  # 出窗
    s = compute_comprehensive_stats(db_session, u.id)
    assert s["trades"] == 0 and s["lots"] == 0.1  # lots 只数窗内实盘（ticket2）
    assert s["trades_any"] == 1                    # demo 整仓计入 trades_any


def test_partial_close_not_resolved(db_session):
    u = _user(db_session)
    _fill(db_session, u, "500123", 1, vol=0.2)
    _close(db_session, u, "500123", 1, 3.0, vol=0.1)   # 只平一半
    s = compute_comprehensive_stats(db_session, u.id)
    assert s["trades"] == 0


def test_ever_bound_account_counts(db_session):
    u = _user(db_session)  # 无任何 MT5Account 行（已解绑），照算
    _fill(db_session, u, "999", 7); _close(db_session, u, "999", 7, -2.0)
    s = compute_comprehensive_stats(db_session, u.id)
    assert s["trades"] == 1 and s["losses"] == 1


def test_lifetime_per_account(db_session):
    u = _user(db_session)
    _fill(db_session, u, "A", 1, days_ago=500); _close(db_session, u, "A", 1, 9.0, days_ago=500)
    _fill(db_session, u, "A", 2); _close(db_session, u, "A", 2, -1.0)
    life = compute_account_lifetime_stats(db_session, u.id)
    assert life["A"]["trades"] == 2 and life["A"]["wins"] == 1 and life["A"]["profit"] == 8.0
