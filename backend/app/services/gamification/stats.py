"""综合数据统计源（设计 §2.4）：按人全量、近 365 天、实盘 + verified、整仓判定。
不动 compute_personal_winrate（仪表盘旧口径）——这是并行的新路径。"""
from collections import defaultdict
from datetime import datetime, timedelta, timezone

from app.models import ClosedTrade, Order
from app.services.symbol_aliases import symbol_match_set
# 相对导入而不是 `from app.services.gamification import periods`：本模块由包的
# __init__ 在 periods 之前导入，走包属性那条路会撞上"包还没初始化完"。
# Relative import: __init__ imports this module before periods, so going through
# the package attribute would hit a partially-initialised package.
from . import periods
from app.services.order_payload import OPENED_POSITION
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


def _filled_orders(db, user_id, cutoff=None, logins=None, modes=None, before=None):
    """该用户的开仓单：已成交的市价单，加上已挂到券商那边的挂单
    （`order_payload.OPENED_POSITION`，与平仓归属、个人胜率同一条判据）。

    挂单是 2026-09-24 才并进来的。此前这里只认 (ORDER, FILLED)，限价 / 止损单
    触发出来的仓位整仓平掉了也不算一笔交易——只用挂单的用户「小试牛刀」永远 0/5，
    后面的笔数、手数、胜率、勋章、榜单全都漏算。挂单行的状态挂出后就停在 PLACED，
    看不出有没有触发过；没触发的挂单没有平仓腿，走 `_resolve` 的统计自然剔掉，
    不走 `_resolve` 的（手数、交易日）由 `_drop_untriggered` 剔掉。

    可选的三个过滤条件都是**下推到 SQL 的筛子**，
    不是新语义——调用方原本就在 Python 侧用同样的条件过滤，只是那样要先把这个
    用户全生命周期的订单整张读进内存。

    `logins`：只要这几个账户的单（周期榜/比赛榜按账户计分，其余账户的单本来就
              会被丢掉）。
    `modes`：`orders.trade_mode` 白名单。NULL（尚未盖章）两侧都不收——SQL 的
              `IN` 与 Python 的 `in` 对 None 行为一致。
    `before`：只要 `created_at` 早于这一刻的单。榜单只认「最后一腿落在期末之前」
              的仓位，而仓位不可能先平后开，所以开仓晚于期末的单必然出不了行。
              **注意只有上界能下推，下界不能**：仓位锚定 lifetime，一笔 2024 年
              开的单 2026 年才平，照样算进 2026 年这个周期（见
              `boards._resolved_in_period` 的 docstring）——按期初截 created_at
              会把这类长持仓静默地从榜上抹掉。`created_at` 为 NULL 的行一并保留，
              保证下推前后结果逐行相同。

    The three optional filters are SQL push-downs of conditions the callers
    already applied in Python; they change nothing but the amount of data read.
    Only an *upper* bound on created_at can be pushed down: a position cannot
    close before it opens, so one opened after the period's end can never land in
    it — but the lower bound cannot, because positions anchor to their lifetime
    and one opened long before the period still counts when it closes inside it.
    NULL created_at rows are kept so the push-down is row-for-row equivalent.

    Placed pending orders are included since 2026-09-24 (OPENED_POSITION, the
    same rule closed-leg attribution and personal win rate use): a position a
    limit/stop order opened used to count as no trade at all, so pending-only
    users sat at 0/5 on "First Steps" and every later count missed them. A
    pending row stays PLACED whether or not it ever triggered; untriggered ones
    have no closing legs, so `_resolve` drops them and `_drop_untriggered` drops
    them from the counts that don't go through `_resolve` (lots, trading days).
    """
    q = (db.query(Order)
           .filter(Order.user_id == user_id, OPENED_POSITION,
                   Order.mt5_ticket.isnot(None)))
    if cutoff is not None:
        q = q.filter(Order.created_at >= cutoff)
    if logins is not None:
        q = q.filter(Order.mt5_login.in_(list(logins)))
    if modes is not None:
        q = q.filter(Order.trade_mode.in_(list(modes)))
    if before is not None:
        from sqlalchemy import or_
        q = q.filter(or_(Order.created_at < before, Order.created_at.is_(None)))
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


def _drop_untriggered(orders, legs_map):
    """去掉没有平仓腿的挂单——看不出它触发过，就不算一笔交易。
    市价单照旧开仓即算（手数、交易日不等平仓）；挂单要等第一条平仓腿落地才算，
    还持着没平的那段时间里它的手数晚一步进账，但绝不会把挂了又撤、从未成交的单
    算成交易。
    Drop pending orders that have no closing leg: with no sign they ever
    triggered, they are not trades. Market orders still count from the fill;
    a triggered pending order starts counting (lots, trading days) once its first
    leg lands — a little late while still open, but a placed-then-cancelled order
    is never counted as a trade."""
    return [o for o in orders
            if o.action != "PENDING" or legs_map.get((o.mt5_login, position_id_of(o)))]


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
    legs = _legs_by_position(db, user_id, keys)
    return {"orders": _drop_untriggered(orders, legs), "legs": legs}


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
        orders = _drop_untriggered(orders, legs_map)
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
        # 切天走 `periods.day_key`（UTC 自然日），**不**走 `services/stats_time.py`
        # 的 STATS_TZ。这是刻意的，不是漏改，2026-09-20 复核后维持：
        #
        #   · 整个游戏化链路的日历都在 UTC 上——`periods.py` 的周/月 key、
        #     `UserActiveDay.day`（由 `services/deps._touch_last_active` 按 UTC 写）、
        #     `longest_active_streak` / `current_active_streak` 的连续日。trade_days
        #     必须和 streak_3 同一把尺，否则同一个用户「交易了 30 天」和「活跃了
        #     30 天」按两套日历各算各的。
        #   · 只把这一个指标改成 STATS_TZ，等于在游戏化内部再劈一道口径（判定用
        #     UTC 的活跃日 + 上海时区的交易日），比现在更糟。要改就得连
        #     `deps._touch_last_active` 的写入口径一起改，那是跨模块的产品决策，
        #     还要连带决定存量 `user_active_days` 是否回填、已发勋章与已判等级是否
        #     复核——不是这一行能承担的。
        #   · 后台看板用 STATS_TZ 是另一回事：那边回答运营的「本地的今天有多少人」，
        #     与用户闯关进度不是同一个问题。两把尺并存是设计，不是缺陷。
        #
        # 切天动作本身收到 `periods.day_key` 里，全链路只此一处实现（原来这里是
        # 就地 `strftime`，日历规则散落两处、改一处漏一处是迟早的事）。
        #
        # Days are cut with periods.day_key (UTC calendar), deliberately *not*
        # through services/stats_time.py's STATS_TZ; re-reviewed 2026-09-20 and
        # kept. The whole gamification calendar is UTC — periods.py's week/month
        # keys, UserActiveDay.day (written in UTC by deps._touch_last_active) and
        # the streak runs — so trade_days must share that ruler with streak_3.
        # Moving only this metric to STATS_TZ would split the calendar *inside*
        # gamification (UTC active days judged against Shanghai trading days),
        # which is worse than the present state; moving the whole chain means
        # changing deps._touch_last_active too and deciding whether to backfill
        # user_active_days and re-check already-awarded badges and levels — a
        # cross-module product call, not a one-line fix. The dashboard's STATS_TZ
        # answers a different question (an operator's local "today"). Two rulers
        # on purpose. The cut itself now lives in periods.day_key so the calendar
        # rule has exactly one implementation.
        "trade_days": len({periods.day_key(o.created_at) for o in real if o.created_at}),
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
