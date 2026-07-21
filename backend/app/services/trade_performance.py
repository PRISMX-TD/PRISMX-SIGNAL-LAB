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
from datetime import datetime, timedelta, timezone

from sqlalchemy import or_, tuple_

from app.models import ClosedTrade, Order

# 手数浮点误差容忍度 / float tolerance when comparing cumulative volumes
_VOLUME_EPS = 1e-6

# 实时持仓对账窗口：桥接约每 1.5 秒上报一次持仓，只要仓位还开着就会被不断刷新。
# 超过这个时长没被报为"仍持仓"、又没有完整平仓记录的仓位，判定为已在别处平掉
# （手动平仓/桥接离线时平掉，平仓明细没上报），不再计入"进行中"。窗口取得比上报
# 间隔宽很多，好容忍桥接重启和短暂断线；桥接长时间离线时，真实持仓也会暂时
# 退出"进行中"，等桥接恢复上报即自愈。
# Live-position reconciliation window: the bridge reports positions ~every 1.5s,
# refreshing any still-open position continuously. A position not seen open
# within this window and lacking a complete close record is treated as closed
# elsewhere (manual/offline close whose close-legs never arrived) and dropped
# from "进行中". The window is far wider than the report interval to tolerate
# bridge restarts and brief drops; during a long bridge outage genuinely-open
# positions also fall out of "进行中" and self-heal once reporting resumes.
_OPEN_FRESHNESS = timedelta(minutes=20)


def compute_personal_winrate(
    db, user_id: str, bound_logins: list[str] | None = None, login: str | None = None
) -> dict:
    """计算某用户的个人跟单胜率 / compute one user's personal win rate.

    bound_logins：该用户当前仍绑定的 MT5 账号（由调用方传入）。传了就把统计
    范围限定在这些账号内——用户删掉一个旧账号后，它的历史战绩不再计入"全部"，
    重新绑回后自动恢复（数据从不删除，只是这里不再选中它）。历史遗留、从未
    回填过账号的订单（login 为空）视为无法归属到任何单一账号，在"全部"里
    仍保留，避免老用户的战绩突然消失；但选中单个账号时不包含这类订单，因为
    没有账号信息就没法确认它属于这个账号。

    login：进一步限定到某一个账号（订单页的账号标签），此时不做上面的历史
    兜底——只看这个账号名下、账号信息明确的订单。

    bound_logins: the MT5 accounts this user still has bound (supplied by the
    caller). When given, scopes the stats to those accounts — deleting an old
    account drops its history from "all accounts"; re-binding it restores the
    view automatically (data is never deleted, just deselected here). Legacy
    orders that never got a login backfilled are kept in the "all accounts"
    view (they can't be attributed to a specific account, but dropping them
    would make an existing user's track record vanish); they're excluded once
    a single account is selected, since there's no account info to confirm
    they belong to it.

    login: further narrows to one specific account (the Orders page's account
    tab); the legacy-null fallback above doesn't apply here — only orders with
    a confirmed matching login count.
    """
    # 1) 该用户所有成功开仓、且已知 MT5 仓位编号的下单记录 / this user's filled opens with a known MT5 ticket
    query = db.query(Order).filter(
        Order.user_id == user_id,
        Order.action == "ORDER",
        Order.status == "FILLED",
        Order.mt5_ticket.isnot(None),
    )
    if login is not None:
        query = query.filter(Order.mt5_login == login)
    elif bound_logins is not None:
        query = query.filter(or_(Order.mt5_login.in_(bound_logins), Order.mt5_login.is_(None)))
    orders = query.all()
    if not orders:
        return {"wins": 0, "losses": 0, "totalResolved": 0, "winRate": None, "openPositions": 0, "bySymbol": []}
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

    open_cutoff = datetime.now(timezone.utc) - _OPEN_FRESHNESS

    wins = losses = open_positions = 0
    symbol_counts: dict[str, int] = {}
    for (login, ticket), order in orders_by_pos.items():
        # 正常情况按 (账号, 编号) 精确匹配；账号未知的历史订单退回只按编号匹配，
        # 避免把它误判成一直未平仓 / exact (login, ticket) match normally; legacy
        # orders with no backfilled login fall back to ticket-only matching so
        # they aren't wrongly counted as never-closed
        pos_legs = legs_by_pos.get((login, ticket)) if login is not None else legs_by_ticket.get(ticket)
        fully_closed = False
        if pos_legs:
            closed_volume = sum(leg.close_volume for leg in pos_legs)
            fully_closed = closed_volume + _VOLUME_EPS >= order.volume
        if fully_closed:
            total_profit = sum(leg.profit for leg in pos_legs)
            if total_profit > 0:
                wins += 1
            else:
                losses += 1
            symbol_counts[order.symbol] = symbol_counts.get(order.symbol, 0) + 1
        elif _is_live_open(order, open_cutoff):
            # 没有完整平仓记录，但 MT5 最近仍把它报为持仓 → 确实在进行中。
            # No complete close record, yet MT5 still reports it open → genuinely open.
            open_positions += 1
        # 否则：既没平仓记录、MT5 也不再报为持仓——多半是在别处平掉、平仓明细漏报，
        # 判定为已结束但无盈亏可归属，整笔从统计里剔除（不计胜负、也不计进行中）。
        # Else: no close record and no longer reported open — closed elsewhere with
        # its close-legs missed; drop the whole position from the stats (neither
        # win/loss nor open) since we have no P&L to attribute.

    resolved = wins + losses
    by_symbol = sorted(
        ({"symbol": sym, "count": cnt} for sym, cnt in symbol_counts.items()),
        key=lambda row: row["count"],
        reverse=True,
    )
    return {
        "wins": wins,
        "losses": losses,
        "totalResolved": resolved,
        "winRate": wins / resolved if resolved > 0 else None,
        "openPositions": open_positions,
        "bySymbol": by_symbol,
    }


def _is_live_open(order: Order, cutoff: datetime) -> bool:
    """该仓位是否在对账窗口内被 MT5 报为仍持仓。
    Whether the position was reported still-open within the reconciliation window."""
    ts = order.position_last_seen_open
    if ts is None:
        return False
    # SQLite / Postgres 读回来是 naive，按 UTC 补齐再比较 / stored naive, treat as UTC
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    return ts >= cutoff


def mark_positions_seen(db, user_id: str, positions: list) -> int:
    """桥接每次上报持仓时，把其中"本平台开的、仍持仓"的仓位打上最新时间戳。

    这就是拿 MT5 实时持仓对账个人胜率的写入侧：只要仓位还开着，这个时间戳就被
    持续刷新；一旦仓位在别处平掉、不再出现在上报里，时间戳就停在最后一次，超过
    _OPEN_FRESHNESS 后 compute_personal_winrate 便不再把它算作"进行中"。返回刷新的行数。

    On every bridge position report, stamp the platform-opened positions that are
    still open. This is the write side of reconciling win-rate against MT5's live
    positions: an open position keeps getting refreshed; once it's closed
    elsewhere and stops appearing, the stamp freezes and, past _OPEN_FRESHNESS,
    compute_personal_winrate stops counting it as open. Returns rows refreshed.
    """
    # 按 (账号, 仓位编号) 精确匹配：仓位编号只在单个账号内唯一，只按编号刷新会把
    # 另一账号同号的已平仓位错误地续成"仍持仓"。/ match by (login, ticket): tickets
    # are only unique within an account, so ticket-only refresh would wrongly keep
    # a same-numbered, already-closed position on another account looking open.
    pairs = {
        (str(p["login"]), int(p["ticket"]))
        for p in positions
        if p.get("login") is not None and p.get("ticket")
    }
    if not pairs:
        return 0
    updated = (
        db.query(Order)
        .filter(
            Order.user_id == user_id,
            Order.action == "ORDER",
            Order.status == "FILLED",
            tuple_(Order.mt5_login, Order.mt5_ticket).in_(list(pairs)),
        )
        .update({Order.position_last_seen_open: datetime.now(timezone.utc)}, synchronize_session=False)
    )
    db.commit()
    return updated
