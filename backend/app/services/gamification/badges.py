"""勋章注册表与判定（设计 §3）。17 枚，稀有度金字塔；比赛类 Phase 3 终审授予。"""
from datetime import date, datetime, timedelta, timezone

from sqlalchemy.exc import IntegrityError

from app.models import DisciplineSnapshot, MT5Account, Order, Signal, User, UserBadge
from .stats import compute_account_lifetime_stats, compute_comprehensive_stats

FOUNDER_DEADLINE = datetime(2027, 1, 1, tzinfo=timezone.utc)
REAL = 2
# 手数阈值判定用浮点容差：lots 是反复 += volume 累加出来的（如 100 笔 0.2 手），
# 双精度浮点误差会让恰好等于阈值的累计和落到 19.99999999999996 这类值上，
# 与 stats.py 里 _resolve 的 _VOL_EPS 同一道理。
# Epsilon for lot-threshold judges: `lots` is summed via repeated += volume
# (e.g. 100 fills of 0.2 lots), and double-precision drift can land an exact
# threshold sum just under it (e.g. 19.99999999999996). Same rationale as
# stats.py's _resolve using _VOL_EPS.
_LOT_EPS = 1e-6


def award_badge(db, user_id, badge_id) -> bool:
    db.add(UserBadge(user_id=user_id, badge_id=badge_id))
    try:
        db.commit()
        return True
    except IntegrityError:
        db.rollback()
        return False


def _has_real_fill(db, user_id) -> bool:
    """"首笔实盘成交"要求一笔真正的开仓（action=="ORDER"）。Gateway 的
    _apply_trade_result 对 CLOSE/MODIFY 动作同样会置 FILLED 并照样打
    trade_mode 快照，若不按 action 过滤，只改过止损或平掉一笔非本平台开的
    实盘仓位、从未真正开过仓的用户也会被判定"已实盘"——与 stats.py 的
    _filled_orders 同一道理，同样只认 ORDER。
    "first real trade" requires an actual open (action=="ORDER"). Gateway's
    _apply_trade_result marks CLOSE/MODIFY FILLED too and still stamps
    trade_mode, so without this filter a user who only ever modified a stop
    or closed a position this platform never opened — on a real account —
    would be judged as having a real trade. Mirrors stats.py's
    _filled_orders, which only counts ORDER for the same reason.
    """
    return (db.query(Order.id)
              .filter(Order.user_id == user_id, Order.status == "FILLED",
                      Order.action == "ORDER", Order.trade_mode == REAL)
              .first() is not None)


def _j_profile_complete(db, user, ctx):
    bound = db.query(MT5Account.id).filter(MT5Account.user_id == user.id).first()
    return bool(user.nickname) and bound is not None


def _j_first_close(db, user, ctx):
    return ctx["stats"]["trades_any"] >= 1


def _j_first_real_trade(db, user, ctx):
    return _has_real_fill(db, user.id)


def _j_hundred_wins(db, user, ctx):
    return any(a["wins"] >= 100 and a["lots"] >= 20 - _LOT_EPS and a["profit"] > 0
               for a in ctx["lifetime"].values())


def _j_midas_touch(db, user, ctx):
    return any(a["trades"] >= 500 and a["lots"] >= 100 - _LOT_EPS and a["profit"] > 0
               and (a["win_rate"] or 0) > 0.60
               for a in ctx["lifetime"].values())


def _j_founder_2026(db, user, ctx):
    created = user.created_at
    if created is not None and created.tzinfo is None:
        created = created.replace(tzinfo=timezone.utc)
    return created is not None and created < FOUNDER_DEADLINE and _has_real_fill(db, user.id)


def _resolved_real_positions(db, user_id, cutoff=None):
    """[(order, profit, last_close_at)]，实盘 + verified + 整仓。"""
    from .stats import _filled_orders, _legs_by_position, _resolve
    from app.services.trade_performance import position_id_of
    orders = [o for o in _filled_orders(db, user_id, cutoff) if o.trade_mode == REAL]
    keys = {(o.mt5_login, position_id_of(o)) for o in orders if position_id_of(o)}
    legs_map = _legs_by_position(db, user_id, keys)
    out = []
    for o, p in _resolve(orders, legs_map):
        legs = legs_map[(o.mt5_login, position_id_of(o))]
        out.append((o, p, max(l.closed_at for l in legs)))
    return out


def _evergreen_months(db, user_id) -> int:
    now = datetime.now(timezone.utc)
    cur_month = (now.year, now.month)
    monthly: dict[tuple[int, int], float] = {}
    for _o, p, closed in _resolved_real_positions(db, user_id):
        ts = closed if closed.tzinfo else closed.replace(tzinfo=timezone.utc)
        key = (ts.year, ts.month)
        if key != cur_month:                       # 未结束的当前月不计
            monthly[key] = monthly.get(key, 0.0) + p
    def _next(k):
        y, m = k
        return (y + 1, 1) if m == 12 else (y, m + 1)
    best = run = 0
    prev = None
    for key in sorted(monthly):
        ok = monthly[key] > 0
        run = (run + 1 if ok and prev is not None and _next(prev) == key
               else (1 if ok else 0))
        best = max(best, run)
        prev = key
    return best


def _j_evergreen(n):
    return lambda db, u, c: _evergreen_months(db, u.id) >= n


def _j_profit_factor(db, user, ctx):
    from .stats import GAMIFICATION_WINDOW_DAYS
    cutoff = datetime.now(timezone.utc) - timedelta(days=GAMIFICATION_WINDOW_DAYS)
    res = _resolved_real_positions(db, user.id, cutoff)
    if len(res) < 100:
        return False
    profits = [p for _o, p, _t in res]
    if sum(profits) <= 0:
        return False
    wins = [p for p in profits if p > 0]
    losses = [-p for p in profits if p <= 0]
    if not losses:
        return True
    if not wins:
        return False
    return (sum(wins) / len(wins)) / (sum(losses) / len(losses)) >= 2.0


def _consecutive_clean_signal_positions(db, user_id) -> int:
    """按平仓时间倒序数「无恶意移损」的信号整仓连续串（对照 discipline.py D1 口径）。"""
    from app.services.settings_store import get_discipline_settings
    from app.services.trade_performance import position_id_of
    tol = float(get_discipline_settings(db).get("sl_tolerance_pct", 0.10))
    sig_pos = [(o, t) for o, _p, t in _resolved_real_positions(db, user_id)
               if o.signal_id is not None]
    sig_pos.sort(key=lambda x: x[1], reverse=True)
    # 批量取信号原始止损——判定"订单没止损"是弃权还是违规，要看信号本身有没有
    # 给止损（discipline.py D1：信号无止损→弃权；信号有止损但订单上没有→违规，
    # 是下单时被主动抹掉）。一次查完，不在循环里逐仓查。
    # Batch-load each signal's original stop loss: whether an order with no SL
    # is an abstain or a violation depends on whether the signal itself carried
    # one (discipline.py D1: no signal stop -> abstain; signal had a stop but
    # the order doesn't -> violation, cleared at entry). Fetched once, not
    # per-position inside the walk.
    sig_ids = {o.signal_id for o, _t in sig_pos}
    sig_sl_map: dict[str, float | None] = dict(
        db.query(Signal.id, Signal.stop_loss).filter(Signal.id.in_(sig_ids)).all()
    ) if sig_ids else {}
    mods = (db.query(Order)
              .filter(Order.user_id == user_id, Order.action == "MODIFY",
                      Order.status == "FILLED").all())
    mods = [m for m in mods if not (m.client_order_id or "").startswith("auto_")]
    by_ticket: dict[int, list] = {}
    for m in mods:
        if m.ticket is not None:
            by_ticket.setdefault(m.ticket, []).append(m)
    run = 0
    for o, _t in sig_pos:
        orig_sl, entry = o.sl, o.filled_price
        if orig_sl in (None, 0):
            sig_sl = sig_sl_map.get(o.signal_id)
            if sig_sl in (None, 0):
                continue                               # 信号本就没给止损：弃权，不计入序列
            break                                       # 信号给了、订单上却没有：下单时被抹掉，违规断串
        dist = abs((entry or 0) - orig_sl)
        violated = False
        for m in by_ticket.get(position_id_of(o), []):
            new_sl = m.sl
            if new_sl in (None, 0):
                violated = True; break                 # 清掉止损
            if dist <= 0:
                continue                                # 距离为 0（entry==sl）无法判容差，宁缺勿错，对照 discipline.py 的 dist>0 判定
            if o.side == "BUY" and new_sl < orig_sl - dist * tol:
                violated = True; break
            if o.side == "SELL" and new_sl > orig_sl + dist * tol:
                violated = True; break
        if violated:
            break
        run += 1
    return run


def _discipline_streak(db, user_id, n) -> bool:
    """login="" 聚合行；total<90 或 NULL 或缺日均断连（设计 §3.2：宁严勿松）。"""
    rows = (db.query(DisciplineSnapshot.date, DisciplineSnapshot.total)
              .filter(DisciplineSnapshot.user_id == user_id,
                      DisciplineSnapshot.login == "").all())
    ok_days = sorted(date.fromisoformat(d) for d, t in rows if t is not None and t >= 90)
    run = 1
    for a, b in zip(ok_days, ok_days[1:]):
        run = run + 1 if b - a == timedelta(days=1) else 1
        if run >= n:
            return True
    return n <= 1 and bool(ok_days)


BADGES: dict[str, dict] = {
    "profile_complete": {"rarity": "common", "category": "growth", "judge": _j_profile_complete},
    "first_close":      {"rarity": "common", "category": "growth", "judge": _j_first_close},
    "first_real_trade": {"rarity": "common", "category": "growth", "judge": _j_first_real_trade},
    "comp_finisher":    {"rarity": "common", "category": "competition", "judge": None},
    "evergreen_3m":     {"rarity": "rare", "category": "performance", "judge": _j_evergreen(3)},
    "discipline_90_7":  {"rarity": "rare", "category": "discipline",
                         "judge": lambda db, u, c: _discipline_streak(db, u.id, 7)},
    "hundred_wins":     {"rarity": "rare", "category": "performance", "judge": _j_hundred_wins},
    "midas_touch":      {"rarity": "epic", "category": "performance", "judge": _j_midas_touch},
    "profit_factor_2":  {"rarity": "epic", "category": "performance", "judge": _j_profit_factor},
    "evergreen_6m":     {"rarity": "epic", "category": "performance", "judge": _j_evergreen(6)},
    "discipline_90_30": {"rarity": "epic", "category": "discipline",
                         "judge": lambda db, u, c: _discipline_streak(db, u.id, 30)},
    "no_bad_sl_50":     {"rarity": "epic", "category": "discipline",
                         "judge": lambda db, u, c: _consecutive_clean_signal_positions(db, u.id) >= 50},
    "comp_podium":      {"rarity": "epic", "category": "competition", "judge": None},
    "evergreen_12m":    {"rarity": "legendary", "category": "performance", "judge": _j_evergreen(12)},
    "comp_winner":      {"rarity": "legendary", "category": "competition", "judge": None},
    "comp_back_to_back": {"rarity": "legendary", "category": "competition", "judge": None},
    "founder_2026":     {"rarity": "limited", "category": "limited", "judge": _j_founder_2026},
}


def judge_and_award_badges(db, user_id) -> list[str]:
    user = db.get(User, user_id)
    if user is None:
        return []
    owned = {b.badge_id for b in db.query(UserBadge).filter(UserBadge.user_id == user_id)}
    ctx = {"stats": compute_comprehensive_stats(db, user_id),
           "lifetime": compute_account_lifetime_stats(db, user_id)}
    newly = []
    for bid, meta in BADGES.items():
        if bid in owned or meta["judge"] is None:
            continue
        if meta["judge"](db, user, ctx) and award_badge(db, user_id, bid):
            newly.append(bid)
    return newly
