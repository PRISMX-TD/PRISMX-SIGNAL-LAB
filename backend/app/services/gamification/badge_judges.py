"""勋章判定函数（设计 2026-09-07 勋章扩充 §3）。

只放"这个用户现在满足哪一档"的纯判定；注册表、授予、佩戴都在 badges.py。
判定函数签名统一为 (db, user, ctx) -> bool，ctx 由 badges.judge_and_award_badges
组装：{"stats": compute_comprehensive_stats(...), "lifetime": compute_account_lifetime_stats(...),
"data": load_trade_data(...)}。

Judging functions only: "which tier does this user satisfy right now". Registry,
awarding and equipping live in badges.py. Signature is (db, user, ctx) -> bool.
"""
from datetime import datetime, timedelta, timezone

from app.models import MT5Account, Order
from .stats import load_trade_data

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


def _has_real_fill(db, user_id) -> bool:
    """"首笔实盘成交"要求一笔真正的开仓（action=="ORDER"）。Gateway 的
    gateway_execute.apply_trade_result 对 CLOSE/MODIFY 动作同样会置 FILLED 并照样打
    trade_mode 快照，若不按 action 过滤，只改过止损或平掉一笔非本平台开的
    实盘仓位、从未真正开过仓的用户也会被判定"已实盘"——与 stats.py 的
    _filled_orders 同一道理，同样只认 ORDER。
    "first real trade" requires an actual open (action=="ORDER"). Gateway's
    gateway_execute.apply_trade_result marks CLOSE/MODIFY FILLED too and still stamps
    trade_mode, so without this filter a user who only ever modified a stop
    or closed a position this platform never opened — on a real account —
    would be judged as having a real trade. Mirrors stats.py's
    _filled_orders, which only counts ORDER for the same reason.
    """
    return (db.query(Order.id)
              .filter(Order.user_id == user_id, Order.status == "FILLED",
                      Order.action == "ORDER", Order.trade_mode == REAL)
              .first() is not None)


# ---- 起步 / starter ----

def _j_profile_complete(db, user, ctx):
    from app.services.gateway_binding import not_removed
    bound = db.query(MT5Account.id).filter(MT5Account.user_id == user.id, not_removed()).first()
    return bool(user.nickname) and bound is not None


def _j_first_close(db, user, ctx):
    return ctx["stats"]["trades_any"] >= 1


def _j_first_real_trade(db, user, ctx):
    return _has_real_fill(db, user.id)


# ---- 胜手 / winning hand（单账户考、按人戴）----

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


def _resolved_real_positions(db, user_id, cutoff=None, data: dict | None = None):
    """[(order, profit, last_close_at)]，实盘 + verified + 整仓。
    `data` 是 stats.load_trade_data 的结果；传了就不再查库（每小时循环里遍历
    整仓的判定共用一份），不传就自己查。"""
    from .stats import _orders_since, _resolve
    from app.services.trade_performance import position_id_of
    if data is None:
        data = load_trade_data(db, user_id)
    orders = [o for o in _orders_since(data["orders"], cutoff) if o.trade_mode == REAL]
    legs_map = data["legs"]
    out = []
    for o, p in _resolve(orders, legs_map):
        legs = legs_map[(o.mt5_login, position_id_of(o))]
        out.append((o, p, max(l.closed_at for l in legs)))
    return out


# ---- 常青 / evergreen ----

def _evergreen_months(db, user_id, data: dict | None = None) -> int:
    now = datetime.now(timezone.utc)
    cur_month = (now.year, now.month)
    monthly: dict[tuple[int, int], float] = {}
    for _o, p, closed in _resolved_real_positions(db, user_id, data=data):
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
    return lambda db, u, c: _evergreen_months(db, u.id, c.get("data")) >= n


def _j_profit_factor(db, user, ctx):
    from .stats import GAMIFICATION_WINDOW_DAYS
    cutoff = datetime.now(timezone.utc) - timedelta(days=GAMIFICATION_WINDOW_DAYS)
    res = _resolved_real_positions(db, user.id, cutoff, data=ctx.get("data"))
    if len(res) < 100:
        return False
    profits = [p for _o, p, _t in res]
    if sum(profits) <= 0:
        return False
    wins = [p for p in profits if p > 0]
    losses = [-p for p in profits if p < 0]   # 恰好 0 的仓位不进胜负任何一边——仍占样本量和总盈亏两道闸门，
                                               # 但不该拉低亏损仓的平均亏损（也不该算赢）。
                                               # exact-zero positions enter neither side: they still count
                                               # toward the sample-size and total-profit gates, but shouldn't
                                               # dilute avg-loss (nor count as a win).
    if not losses:
        return True
    if not wins:
        return False
    return (sum(wins) / len(wins)) / (sum(losses) / len(losses)) >= 2.0


# ---- 老兵 / veteran：实盘已核验整仓平仓笔数，全时段、多账户合计 ----
# Veteran: lifetime count of real, verified, fully-closed positions across all accounts.
VETERAN_THRESHOLDS = (100, 500, 2000)


def _j_veteran(n):
    return lambda db, u, c: sum(a["trades"] for a in c["lifetime"].values()) >= n
