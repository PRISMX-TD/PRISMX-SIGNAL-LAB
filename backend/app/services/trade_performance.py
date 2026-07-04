"""个人跟单表现：基于真实平仓明细（ClosedTrade）聚合每个仓位的最终盈亏。

方案 B：同一个仓位可能被分好几次部分平仓，只有当累计平仓手数达到当初开仓
手数时，才把这个仓位算作"分出胜负"，赢/输按这个仓位所有分批平仓的盈亏
加总的正负号判断——不是按平仓次数算，是按"这一整笔仓位最终赚不赚"算。

Personal trading performance: aggregate each position's final P&L from real
closing-deal records (ClosedTrade).

Design B: a position may be closed via several partial closes. It only counts
as "resolved" once the cumulative closed volume reaches the original opening
volume; win/loss is decided by the sign of the sum of all its partial closes'
profit — not by how many individual closes happened, but by whether the whole
position ended up profitable.
"""
from app.models import ClosedTrade, Order

# 手数浮点误差容忍度 / float tolerance when comparing cumulative volumes
_VOLUME_EPS = 1e-6


def compute_personal_winrate(db, user_id: str) -> dict:
    """计算某用户的个人跟单胜率 / compute one user's personal win rate."""
    # 1) 该用户所有成功开仓、且已知 MT5 仓位编号的下单记录 / this user's filled opens with a known MT5 ticket
    orders = (
        db.query(Order)
        .filter(
            Order.user_id == user_id,
            Order.action == "ORDER",
            Order.status == "FILLED",
            Order.mt5_ticket.isnot(None),
        )
        .all()
    )
    order_by_ticket = {o.mt5_ticket: o for o in orders}
    if not order_by_ticket:
        return {"wins": 0, "losses": 0, "totalResolved": 0, "winRate": None, "openPositions": 0}

    # 2) 这些仓位目前为止上报过的所有平仓明细（可能只是部分平仓）/ every reported close-leg for those tickets so far
    legs = (
        db.query(ClosedTrade)
        .filter(
            ClosedTrade.user_id == user_id,
            ClosedTrade.position_ticket.in_(list(order_by_ticket.keys())),
        )
        .all()
    )
    legs_by_ticket: dict[int, list[ClosedTrade]] = {}
    for leg in legs:
        legs_by_ticket.setdefault(leg.position_ticket, []).append(leg)

    wins = losses = open_positions = 0
    for ticket, order in order_by_ticket.items():
        ticket_legs = legs_by_ticket.get(ticket)
        if not ticket_legs:
            open_positions += 1  # 还没有任何平仓记录 / no close reported yet, still open
            continue
        closed_volume = sum(leg.close_volume for leg in ticket_legs)
        if closed_volume + _VOLUME_EPS < order.volume:
            open_positions += 1  # 只是部分平仓，还没平完 / partially closed, not fully resolved yet
            continue
        total_profit = sum(leg.profit for leg in ticket_legs)
        if total_profit > 0:
            wins += 1
        else:
            losses += 1

    resolved = wins + losses
    return {
        "wins": wins,
        "losses": losses,
        "totalResolved": resolved,
        "winRate": wins / resolved if resolved > 0 else None,
        "openPositions": open_positions,
    }
