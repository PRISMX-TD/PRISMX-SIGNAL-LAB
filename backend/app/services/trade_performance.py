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
    if not orders:
        return {"wins": 0, "losses": 0, "totalResolved": 0, "winRate": None, "openPositions": 0}
    # 一个"仓位"用 (MT5 账号, 仓位编号) 唯一标识：MT5 的仓位编号只在单个交易
    # 账号内递增，同一用户绑定多个账号时编号可能撞车。只按编号聚合会漏算仓位
    # （字典键相撞覆盖），还会把 A 账号的平仓明细错算进 B 账号的仓位——胜率和
    # 平仓完成度都会偏。对齐 idx_closed_trades_position 的 (user, login, ticket)。
    # Key a "position" by (mt5_login, ticket): MT5 ticket numbers only increment
    # within a single account, so a user with several accounts can have colliding
    # tickets. Keying by ticket alone drops positions (dict-key collisions) and
    # mis-attributes one account's close-legs onto another's position, skewing
    # both the win rate and the volume-completion check. This matches the
    # idx_closed_trades_position (user, login, ticket) grouping.
    orders_by_pos = {(o.mt5_login, o.mt5_ticket): o for o in orders}

    # 2) 这些仓位目前为止上报过的所有平仓明细（可能只是部分平仓）/ every reported close-leg for those tickets so far
    legs = (
        db.query(ClosedTrade)
        .filter(
            ClosedTrade.user_id == user_id,
            ClosedTrade.position_ticket.in_(list({o.mt5_ticket for o in orders})),
        )
        .all()
    )
    legs_by_pos: dict[tuple, list[ClosedTrade]] = {}
    legs_by_ticket: dict[int, list[ClosedTrade]] = {}  # 兜底：账号未回填的历史订单 / fallback for legacy orders lacking a login
    for leg in legs:
        legs_by_pos.setdefault((leg.mt5_login, leg.position_ticket), []).append(leg)
        legs_by_ticket.setdefault(leg.position_ticket, []).append(leg)

    wins = losses = open_positions = 0
    for (login, ticket), order in orders_by_pos.items():
        # 正常情况按 (账号, 编号) 精确匹配；账号未知的历史订单退回只按编号匹配，
        # 避免把它误判成一直未平仓 / exact (login, ticket) match normally; legacy
        # orders with no backfilled login fall back to ticket-only matching so
        # they aren't wrongly counted as never-closed
        pos_legs = legs_by_pos.get((login, ticket)) if login is not None else legs_by_ticket.get(ticket)
        if not pos_legs:
            open_positions += 1  # 还没有任何平仓记录 / no close reported yet, still open
            continue
        closed_volume = sum(leg.close_volume for leg in pos_legs)
        if closed_volume + _VOLUME_EPS < order.volume:
            open_positions += 1  # 只是部分平仓，还没平完 / partially closed, not fully resolved yet
            continue
        total_profit = sum(leg.profit for leg in pos_legs)
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
