"""个人跟单胜率聚合的单测，重点覆盖多账号仓位编号撞车这一准确性修复。
Unit tests for personal win-rate aggregation, focused on the multi-account
ticket-collision accuracy fix.
"""
from datetime import datetime, timezone

from app.models import ClosedTrade, Order
from app.services.trade_performance import compute_personal_winrate


def _order(db, user, ticket, login, volume=1.0):
    o = Order(
        user_id=user.id,
        client_order_id=f"co-{login}-{ticket}",
        action="ORDER",
        status="FILLED",
        symbol="XAUUSD",
        side="BUY",
        volume=volume,
        mt5_login=login,
        mt5_ticket=ticket,
    )
    db.add(o)
    db.commit()
    return o


def _leg(db, user, ticket, login, profit, volume=1.0, deal=None):
    row = ClosedTrade(
        user_id=user.id,
        mt5_login=login,
        symbol="XAUUSD",
        side="BUY",
        close_volume=volume,
        close_price=2360.0,
        profit=profit,
        position_ticket=ticket,
        deal_ticket=deal if deal is not None else int(f"{ticket}{int(profit)%100:02d}"),
        closed_at=datetime.now(timezone.utc),
    )
    db.add(row)
    db.commit()
    return row


def test_no_orders_returns_empty(db, user):
    assert compute_personal_winrate(db, user.id) == {
        "wins": 0, "losses": 0, "totalResolved": 0, "winRate": None, "openPositions": 0
    }


def test_single_account_win_loss_open(db, user):
    _order(db, user, ticket=100, login="10001")
    _leg(db, user, ticket=100, login="10001", profit=12.5)   # 全平且盈利 → win
    _order(db, user, ticket=101, login="10001")
    _leg(db, user, ticket=101, login="10001", profit=-8.0)   # 全平且亏损 → loss
    _order(db, user, ticket=102, login="10001")              # 无平仓明细 → open

    r = compute_personal_winrate(db, user.id)
    assert (r["wins"], r["losses"], r["totalResolved"], r["openPositions"]) == (1, 1, 2, 1)
    assert r["winRate"] == 0.5


def test_partial_close_still_open(db, user):
    _order(db, user, ticket=200, login="10001", volume=1.0)
    _leg(db, user, ticket=200, login="10001", profit=5.0, volume=0.4)  # 只平了 0.4/1.0
    r = compute_personal_winrate(db, user.id)
    assert r["openPositions"] == 1
    assert r["totalResolved"] == 0


def test_multi_account_ticket_collision(db, user):
    # 两个账号各有一个仓位编号 500 的仓位——必须算成两个独立仓位，
    # 且各自的平仓明细不能串到对方头上。
    # Same ticket 500 on two different logins: must count as two distinct
    # positions, and each account's close-legs must not bleed into the other.
    _order(db, user, ticket=500, login="10001", volume=1.0)
    _order(db, user, ticket=500, login="20002", volume=1.0)
    _leg(db, user, ticket=500, login="10001", profit=30.0, deal=90001)   # 账号 A 盈利
    _leg(db, user, ticket=500, login="20002", profit=-15.0, deal=90002)  # 账号 B 亏损

    r = compute_personal_winrate(db, user.id)
    # 修复前：字典键相撞只剩一个仓位、两条明细相加(30-15=15>0)误判成单个 win。
    # Before the fix: dict-key collision left one position and summed both
    # legs (30-15>0) into a single false "win".
    assert (r["wins"], r["losses"], r["totalResolved"], r["openPositions"]) == (1, 1, 2, 0)


def test_legacy_order_without_login_falls_back_to_ticket(db, user):
    # 历史订单账号未回填(None)时，退回按编号匹配，避免误判为一直未平仓。
    # Legacy order with no backfilled login falls back to ticket-only matching.
    _order(db, user, ticket=600, login=None, volume=1.0)
    _leg(db, user, ticket=600, login="10001", profit=7.0)
    r = compute_personal_winrate(db, user.id)
    assert (r["wins"], r["losses"], r["openPositions"]) == (1, 0, 0)
