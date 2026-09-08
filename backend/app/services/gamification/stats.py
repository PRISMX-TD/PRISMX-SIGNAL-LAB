"""综合数据统计源（设计 §2.4）：按人全量、近 365 天、实盘 + verified、整仓判定。
不动 compute_personal_winrate（仪表盘旧口径）——这是并行的新路径。"""
from collections import defaultdict
from datetime import datetime, timedelta, timezone

from app.models import ClosedTrade, Order
from app.services.symbol_aliases import symbol_match_set
from app.services.trade_performance import position_id_of
from app.utils.timeutil import aware

GAMIFICATION_WINDOW_DAYS = 365
_VOL_EPS = 1e-6
REAL = 2

# 手数折算权重，键是平台规范品种名（去券商后缀、并别名）。
#
# 合作券商 Make Capital 的原油是 **100 桶/手的小合约**（MT4 symbols.raw 实测，
# 2026-09-08），而行业标准 CL 合约是 1000 桶——1 手 WTI 名义只有约 6 千美元，
# 是外汇一手的 1/15、黄金一手的 1/50。等级条件 lots_10…lots_10000 与胜手勋章的
# 手数门槛如果原样累加，原油就成了刷手数最便宜的口子。平台现有品种里只有它规格
# 反常（黄金 100 oz、白银 5000 oz、BTC 1 枚都与惯例一致），所以这里是一张按品种
# 的小表，不是通用的名义额换算；将来再有反常品种往表里加一行即可。
#
# Lot weights keyed by the platform's canonical symbol (suffix stripped, aliases
# folded). Make Capital's crude is a **100-barrel mini contract** (read from the
# MT4 symbols.raw, 2026-09-08) against the industry-standard 1000-barrel CL, so
# one WTI lot is ~$6k notional — 1/15 of an FX lot, 1/50 of a gold lot. Summed
# raw, crude would be the cheapest way to farm the lots_* level conditions and
# the winning-hand thresholds. It is the only anomalous spec among the platform's
# symbols (gold 100 oz, silver 5000 oz, BTC 1 all match convention), hence a
# per-symbol table rather than a general notional conversion.
LOT_WEIGHTS = {"WTI": 0.1}


def lot_weight(symbol: str | None) -> float:
    """该品种 1 手折算成多少手。无记录的品种为 1。/ Lots-per-lot for a symbol; 1 if unlisted."""
    root = (symbol or "").split(".")[0].strip().upper()
    if not root:
        return 1.0
    for canon, w in LOT_WEIGHTS.items():
        if root in symbol_match_set(canon):
            return w
    return 1.0


def weighted_lots(order) -> float:
    return (order.volume or 0) * lot_weight(order.symbol)


def _now():
    return datetime.now(timezone.utc)


def _filled_orders(db, user_id, cutoff=None):
    q = (db.query(Order)
           .filter(Order.user_id == user_id, Order.action == "ORDER",
                   Order.status == "FILLED", Order.mt5_ticket.isnot(None)))
    if cutoff is not None:
        q = q.filter(Order.created_at >= cutoff)
    return q.all()


def _legs_by_position(db, user_id, keys):
    """keys: set[(login, position_id)] -> dict[key, list[ClosedTrade]]，只取 verified。"""
    out = defaultdict(list)
    if not keys:
        return out
    tickets = list({k[1] for k in keys})
    legs = (db.query(ClosedTrade)
              .filter(ClosedTrade.user_id == user_id,
                      ClosedTrade.verified.is_(True),
                      ClosedTrade.position_ticket.in_(tickets)).all())
    for leg in legs:
        k = (leg.mt5_login, leg.position_ticket)
        if k in keys:
            out[k].append(leg)
    return out


def _resolve(orders, legs_map):
    """整仓判定：返回 list[(order, profit)]（仅完整平仓的仓位）。"""
    resolved = []
    for o in orders:
        pid = position_id_of(o)
        if not pid:
            continue
        legs = legs_map.get((o.mt5_login, pid), [])
        if not legs:
            continue
        if sum(l.close_volume or 0 for l in legs) + _VOL_EPS >= (o.volume or 0):
            resolved.append((o, sum(l.profit or 0 for l in legs)))
    return resolved


def load_trade_data(db, user_id) -> dict:
    """一次把该用户全部 FILLED 开仓单和对应的 verified 平仓腿读进来。

    **为什么有它**：每小时循环里，综合统计、终身统计、常青 ×3、盈亏比、铁律如山
    各自调一遍 _filled_orders + _legs_by_position，一个用户每小时要把 365 天的
    订单加载 7 次以上，用户数一上百这条循环就跑不完。现在循环只读一次，把这份
    数据传给所有判定函数；不传（data=None）时各函数照旧自己读，行为不变。

    Loads every FILLED opening order and its verified closing legs once. The
    hourly pass used to reload the same rows 7+ times per user (comprehensive
    stats, lifetime stats, evergreen ×3, profit factor, no_bad_sl); with a hundred
    users the pass no longer fits in its hour. Every judge now accepts this dict;
    when omitted (data=None) they load for themselves exactly as before.
    """
    orders = _filled_orders(db, user_id)
    keys = {(o.mt5_login, position_id_of(o)) for o in orders if position_id_of(o)}
    return {"orders": orders, "legs": _legs_by_position(db, user_id, keys)}


def _orders_since(orders, cutoff):
    """按 created_at >= cutoff 过滤（与 _filled_orders 的 SQL 条件同义）。"""
    if cutoff is None:
        return list(orders)
    return [o for o in orders if o.created_at is not None and aware(o.created_at) >= cutoff]


def compute_comprehensive_stats(db, user_id, data: dict | None = None) -> dict:
    cutoff = _now() - timedelta(days=GAMIFICATION_WINDOW_DAYS)
    if data is None:
        orders = _filled_orders(db, user_id, cutoff)
        keys = {(o.mt5_login, position_id_of(o)) for o in orders if position_id_of(o)}
        legs_map = _legs_by_position(db, user_id, keys)
    else:
        orders = _orders_since(data["orders"], cutoff)
        legs_map = data["legs"]
    real = [o for o in orders if o.trade_mode == REAL]

    res_all = _resolve(orders, legs_map)
    res_real = [(o, p) for o, p in res_all if o.trade_mode == REAL]
    wins = sum(1 for _, p in res_real if p > 0)
    per_login = defaultdict(lambda: {"trades": 0, "wins": 0})
    for o, p in res_real:
        d = per_login[o.mt5_login]
        d["trades"] += 1
        d["wins"] += 1 if p > 0 else 0
    # excluded：该账号在窗口内被剔出统计范围的下单数（非实盘，含 NULL 与 -1
    # 哨兵）。喂给成就页"构成展开"——告诉用户这个账号有多少条未核验 / 模式未定
    # 的记录没进胜率口径。**只列有实盘下单的账号**（2026-09-07 用户定案：构成只显示
    # 实盘）——纯模拟盘 / 竞赛账号不进 per_login，页面上标注「仅实盘账户」。
    # excluded: how many of this login's window orders were excluded from the
    # scope (non-real, including NULL and the -1 sentinel). Feeds the
    # achievement page's breakdown. **Only logins with at least one real order**
    # are listed (2026-09-07: the breakdown shows live accounts only); demo /
    # contest-only logins are dropped and the page says so.
    real_logins = {o.mt5_login for o in real}
    excluded_counts = defaultdict(int)
    for o in orders:
        if o.trade_mode != REAL and o.mt5_login in real_logins:
            excluded_counts[o.mt5_login] += 1
    for login, cnt in excluded_counts.items():
        per_login[login]["excluded"] = cnt
    for d in per_login.values():
        d.setdefault("excluded", 0)
        d["winRate"] = d["wins"] / d["trades"] if d["trades"] else None

    n = len(res_real)
    return {
        "trades": n, "wins": wins, "losses": n - wins,
        "win_rate": (wins / n) if n else None,
        "lots": sum(weighted_lots(o) for o in real),
        "trade_days": len({o.created_at.strftime("%Y-%m-%d") for o in real if o.created_at}),
        "profit": sum(p for _, p in res_real),
        "trades_any": len(res_all),
        "per_login": dict(per_login),
        "window_days": GAMIFICATION_WINDOW_DAYS,
    }


def compute_account_lifetime_stats(db, user_id, data: dict | None = None) -> dict:
    """两枚表现勋章的口径：单账号、累计全时段、实盘 + verified、整仓。"""
    if data is None:
        data = load_trade_data(db, user_id)
    orders = data["orders"]
    real = [o for o in orders if o.trade_mode == REAL]
    legs_map = data["legs"]
    out = defaultdict(lambda: {"trades": 0, "wins": 0, "lots": 0.0, "profit": 0.0})
    for o in real:
        out[o.mt5_login]["lots"] += weighted_lots(o)
    for o, p in _resolve(real, legs_map):
        d = out[o.mt5_login]
        d["trades"] += 1
        d["wins"] += 1 if p > 0 else 0
        d["profit"] += p
    for d in out.values():
        d["win_rate"] = d["wins"] / d["trades"] if d["trades"] else None
    return dict(out)
