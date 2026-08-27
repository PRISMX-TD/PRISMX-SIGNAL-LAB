"""纪律分 Discipline Score：给每个用户算一个 0-100 的"执行纪律"分数，回答
"你有没有按计划执行"，与赚不赚钱无关。纯只读统计，不产生任何交易指令，不碰下单链路。

三个维度（默认权重 D1 40% / D2 30% / D3 30%，权重与阈值见 settings_store.py 的
DISCIPLINE_DEFAULTS，管理后台可调）：
- D1 止损纪律：跟信号下的单是否保留了原始止损，有没有把止损往亏损方向恶意移动。
- D2 仓位纪律：这一单的**风险敞口**是否在同品种历史的正常区间内，防的是报复性
  加仓的突然放大。比的不是原始手数——同样是账户 1% 的风险，黄金算出来的手数
  和货币对能差一个数量级，止损放宽一倍手数也要减半，只看手数会把"风险其实
  一样"的正常下单判成违规。见 _score_volume。
- D3 出场纪律：有没有在**离止损还很远**的时候手动砍仓。判据是离计划的距离，
  不是这一单亏了多少钱。见 _score_exit。

已知数据局限（V1 有意为之，不是 bug）：
- 用户直接在 MT5 客户端手动平仓不产生本平台 CLOSE 指令，D3 检测不到——
  只检测经网页发起的平仓，没有 CLOSE 记录视为"交给 SL/TP 处理"，判合规。
- 信号可以不带止损（webhook 的 stopLoss 是可选字段）。这种单子 D1 不评分——
  没有"原始止损"可保留，判用户违纪是冤枉人；用户自己把信号的止损抹掉才算。
- D2 的风险敞口用 `手数 × |入场价 − 止损价|` 代理真实货币风险。跨品种不可比
  （每手合约规模不同，本平台没有券商合约规格数据），所以基准**按品种分桶**：
  同一品种的合约规模是常数，桶内比风险敞口就等价于比真实货币风险，常数被约掉。
- 信号单开仓时存的 orders.sl 是信号价刻度，Bridge 执行时按比例换算到券商
  真实价，后续 MODIFY 的 sl 是券商刻度——两者有小比例偏移，D1 因此设了容差，
  只惩罚明显的恶化移动。

Discipline Score: a 0-100 "did you follow the plan" score per user, independent
of whether the trade made money. Purely read-only statistics — no trading
commands are ever issued.

Three dimensions (default weights D1 40% / D2 30% / D3 30%; weights & thresholds
live in settings_store.DISCIPLINE_DEFAULTS, admin-tunable):
- D1 stop-loss discipline: whether the signal's original stop was kept, or
  moved adversely.
- D2 position-size discipline: whether this trade's *risk exposure* stays within
  the normal range for the same symbol, catching sudden revenge-sized positions.
  Raw lot size is not comparable: the same 1%-of-account risk yields wildly
  different lot sizes on gold vs a currency pair, and doubling the stop distance
  halves the lots.
- D3 exit discipline: whether the user bailed out while price was still far from
  the stop. The test is distance from the plan, not how much the trade lost.

Known data limitations (intentional in V1, not bugs):
- A manual close done directly in the MT5 terminal produces no CLOSE command
  on this platform, so D3 can't see it — only web-initiated closes are
  detected; no CLOSE record is treated as "left to SL/TP", scored compliant.
- D2 proxies money risk as `volume x |entry - stop|`. That is not comparable
  across symbols (contract sizes differ and this platform has no broker contract
  specs), so baselines are bucketed per symbol: contract size is constant within
  a symbol, so comparing the proxy inside one bucket is equivalent to comparing
  real money risk.
- orders.sl at open is stored at signal-price scale; the bridge converts it
  to the broker's real price scale on execution, so later MODIFY sl values
  are broker-scale — a small proportional offset exists between the two. D1
  has a tolerance for this, penalizing only clearly adverse moves.
"""
import asyncio
import json
import logging
import statistics
from datetime import datetime, timedelta, timezone

from sqlalchemy import distinct, or_

from app.core.database import SessionLocal
from app.models import ClosedTrade, DisciplineSnapshot, MT5Account, Order, Signal
from app.services.settings_store import get_discipline_settings
from app.services.trade_performance import position_id_of

logger = logging.getLogger("prismx.discipline")

# 手数浮点误差容忍度，与 trade_performance.py 的 _VOLUME_EPS 同一个值/用途，
# 复制而非 import——两个模块各自独立，谁先改都不用担心破坏对方。
# Float tolerance, same value/purpose as trade_performance._VOLUME_EPS,
# duplicated rather than imported — the two modules stay independent.
_VOLUME_EPS = 1e-6

# 自动仓管指令前缀（backend/app/services/auto_manage.py::AUTO_PREFIX 同一个值）：
# 系统替用户执行的操作不算用户行为，不参与纪律评分。
AUTO_PREFIX = "auto_"

# D2 仓位基准取样：本仓位开仓前、**同品种**最近 N 笔信号单，算中位数
_VOLUME_BASELINE_SAMPLE = 20

# D2 每个账号一次捞回多少行历史。基准按品种分桶后，同样凑够 N 笔就需要更多原始
# 行——一个账号交易 K 个品种，最坏情况要 K 倍。取一个够宽又封了顶的常数：捞不
# 够的品种，该仓位的 D2 直接不评分（返回 None），不会因为样本少就误判。
# Rows fetched per account for D2. Bucketing per symbol means more raw rows are
# needed to fill each bucket; this is a generous but bounded cap. A bucket that
# still comes up short simply isn't scored, rather than being judged on thin data.
_VOLUME_HISTORY_FETCH = _VOLUME_BASELINE_SAMPLE * 20

# D3 把 CLOSE 指令匹配到平仓腿的时间窗：指令下发后桥接拉取并执行需要几秒到几十秒。
# 窗口取得比正常执行时延宽，但不至于宽到把后来触发的止损腿也吞进来。
# 另留一点时钟偏差容忍：指令时间来自服务端，成交时间来自 MT5 服务器。
# Window for attributing a close leg to a CLOSE command (bridge pickup + fill),
# wide enough for real latency but not so wide it swallows a later stop-out leg.
# The skew allowance covers server-vs-MT5 clock differences.
_CLOSE_MATCH_WINDOW = timedelta(minutes=10)
_CLOSE_CLOCK_SKEW = timedelta(seconds=60)

# 后台快照循环的运行间隔（秒）
SNAPSHOT_INTERVAL_SECONDS = 6 * 60 * 60

# 首轮快照延后再跑,别挡住 uvicorn bind 端口 / delay the first snapshot pass so it
# doesn't hold up uvicorn binding the port
SNAPSHOT_STARTUP_DELAY_SECONDS = 20


def _aware(dt: datetime | None) -> datetime | None:
    if dt is None:
        return None
    return dt if dt.tzinfo is not None else dt.replace(tzinfo=timezone.utc)


def _resolved_positions(
    db, user_id: str, login: str | None, bound_logins: list[str] | None, window_days: int
):
    """取样窗口内该用户已结束（累计平仓手数达到开仓手数）的信号单仓位。

    返回 dict[(login, ticket)] -> {"order": Order, "legs": list[ClosedTrade]}。
    账号过滤语义与 trade_performance.compute_personal_winrate **逐字一致**：
    传 login 时精确匹配单个账号；否则限定在 bound_logins（当前仍绑定的账号），
    并保留历史遗留、从未回填账号的订单（mt5_login IS NULL）在"全部账户"聚合
    里——这类订单没有账号信息，删不掉也确认不了归属，跟个人胜率的兜底策略
    一致，避免老用户战绩突然消失。只取"已结束"的仓位，未结束（仍持仓/无法
    归属）的不参与纪律评分——评分的是已经走完的行为。

    Resolved (fully closed) signal-order positions in the sampling window.
    Account-filter semantics **exactly mirror** compute_personal_winrate:
    an exact match when `login` is given; otherwise scoped to `bound_logins`
    (currently-bound accounts), keeping legacy orders with no backfilled
    login in the "all accounts" aggregate (same fallback as the personal win
    rate, so an existing user's track record doesn't vanish). Only
    fully-closed positions are scored — discipline needs a completed action.
    """
    cutoff = datetime.now(timezone.utc) - timedelta(days=window_days)
    query = db.query(Order).filter(
        Order.user_id == user_id,
        Order.signal_id.isnot(None),
        Order.action == "ORDER",
        Order.status == "FILLED",
        Order.mt5_ticket.isnot(None),
        Order.created_at >= cutoff,
    )
    if login is not None:
        query = query.filter(Order.mt5_login == login)
    elif bound_logins is not None:
        query = query.filter(or_(Order.mt5_login.in_(bound_logins), Order.mt5_login.is_(None)))
    orders = query.all()
    if not orders:
        return {}

    # 仓位编号统一走 position_id_of()（gateway 用 mt5_position、bridge 回落
    # mt5_ticket）——只按 mt5_ticket 匹配时 gateway 账号的仓位永远算不出胜负，
    # 纪律分对这批用户整体为空。详见 trade_performance.position_id_of。
    # Position ids go through position_id_of() so gateway positions resolve.
    tickets = list({position_id_of(o) for o in orders})
    legs = (
        db.query(ClosedTrade)
        .filter(ClosedTrade.user_id == user_id, ClosedTrade.position_ticket.in_(tickets))
        .all()
    )
    legs_by_pos: dict[tuple, list[ClosedTrade]] = {}
    for leg in legs:
        legs_by_pos.setdefault((leg.mt5_login, leg.position_ticket), []).append(leg)

    resolved: dict[tuple, dict] = {}
    for order in orders:
        key = (order.mt5_login, position_id_of(order))
        pos_legs = legs_by_pos.get(key)
        if not pos_legs:
            continue
        closed_volume = sum(leg.close_volume for leg in pos_legs)
        if closed_volume + _VOLUME_EPS >= order.volume:
            resolved[key] = {"order": order, "legs": pos_legs}
    return resolved


def _user_modify_close_map(
    db, user_id: str, action: str, keys: set[tuple], include_auto: bool = False
) -> dict[tuple, list]:
    """一次取回这一批仓位下所有**用户发起**（非 auto_ 前缀）的 MODIFY 或 CLOSE
    指令，按 (账号, 仓位编号) 分组、组内按时间升序。

    include_auto=True 时连同系统自动指令一起返回。MODIFY 就是这么取的：D1 只
    该看用户自己的改单（由 _user_initiated 在内存里筛一次），而 D3 判断"平仓时
    离止损多远"要的是**当时真正生效的止损**——自动保本、自动移动止损同样改变
    了计划，用原始止损算距离会把已经被自动抬到平仓价附近的止损当成还很远，凭空
    多判违规。两种口径共用这一次查询，不额外增加往返。

    With include_auto=True the system's own commands are included. MODIFY is
    fetched that way: D1 must only see the user's own edits (filtered in memory by
    _user_initiated), while D3's "how far from the stop" needs the stop that was
    *actually in force*, auto-breakeven and auto-trailing included — measuring
    against the original stop would report a distance that no longer exists and
    invent violations. One query serves both views.

    原来是每个仓位各查一次（`_user_modify_close`），配合 D1 和 D3 就是 2N 条查询，
    再加 D2 的手数历史一共 3N 条。生产库是远端 Supabase，每条都带一次网络往返，
    N 是这个用户窗口内的仓位数——一个活跃用户打开一次订单页就是几百次往返。
    改成按 ticket 集合一次拉回、在内存里分组，查询数从 3N 降到 3。

    分组键仍然是 (账号, 仓位编号) 而不是只用编号：ticket 只在单个账号内唯一，
    同一用户绑多个账号时会撞车，只按编号分组会把 A 账号的改单算进 B 账号的仓位
    （这正是原实现里那句「login 用 == 精确匹配、这个过滤条件不能省」在防的事，
    这里靠分组键把同一条约束延续下来）。

    Fetch every user-initiated (non-auto_) MODIFY or CLOSE command for a batch of
    positions in one query, grouped by (login, ticket) with each group oldest-first.

    This used to be one query per position (`_user_modify_close`), which with D1
    and D3 meant 2N queries, plus D2's volume history for 3N in total. Production
    talks to a remote Supabase, so every one of those carries a network round
    trip, and N is the user's position count in the window — opening the orders
    page as an active user meant hundreds of round trips. Fetching by ticket set
    once and grouping in memory takes it from 3N to 3.

    The grouping key stays (login, ticket) rather than ticket alone: tickets are
    only unique within an account, so a user with several accounts can collide,
    and grouping by ticket would credit account A's modifications to account B's
    position. (That is exactly what the original's "login is matched with == and
    this filter can't be skipped" was guarding; the grouping key carries the same
    constraint forward.)
    """
    if not keys:
        return {}
    tickets = {ticket for _login, ticket in keys}
    rows = (
        db.query(Order)
        .filter(
            Order.user_id == user_id,
            Order.action == action,
            Order.status == "FILLED",
            Order.ticket.in_(tickets),
            *(
                []
                if include_auto
                else [~Order.client_order_id.like(f"{AUTO_PREFIX}%")]
            ),
        )
        .order_by(Order.created_at.asc())
        .all()
    )
    out: dict[tuple, list] = {}
    for r in rows:
        key = (r.mt5_login, r.ticket)
        # 只保留调用方真正在问的那些 (账号, 编号)：ticket 集合过滤是宽的，可能带回
        # 同编号但属于另一个账号的行。
        # Keep only the (login, ticket) pairs the caller actually asked about: the
        # ticket-set filter is broad and can return same-numbered rows belonging to
        # a different account.
        if key in keys:
            out.setdefault(key, []).append(r)
    return out


def _user_initiated(rows: list) -> list:
    """从指令列表里筛掉系统自动下发的那些（auto_ 前缀）。
    Drop the system's own commands (auto_ prefix) from a command list."""
    return [r for r in rows if not (r.client_order_id or "").startswith(AUTO_PREFIX)]


def _entry_of(order: Order, plan_by_signal: dict) -> float | None:
    """这笔仓位的入场价：优先真实成交价，回落到信号给的入场价。
    The position's entry price: the real fill, falling back to the signal's entry."""
    if order.filled_price is not None:
        return order.filled_price
    plan = plan_by_signal.get(order.signal_id) if order.signal_id else None
    return plan.entry if plan is not None else None


def _risk_exposure(volume: float | None, entry: float | None, sl: float | None) -> float | None:
    """风险敞口代理值 `手数 × |入场价 − 止损价|`，算不出来时返回 None。

    这是"这一单打到止损会亏多少钱"去掉合约规模常数之后的部分。合约规模只跟品种
    有关，所以**同品种内**比较这个值，与比较真实货币金额完全等价；跨品种则不可
    比，调用方必须按品种分桶（见 _score_volume）。

    Money risk with the per-symbol contract-size constant factored out. Comparable
    within one symbol, never across symbols — callers must bucket by symbol.
    """
    if not volume or volume <= 0:
        return None
    if entry is None or sl in (None, 0):
        return None
    span = abs(entry - sl)
    if span <= 0:
        return None
    return volume * span


def _effective_sl(order: Order, modifies: list, at: datetime | None) -> float | None:
    """`at` 时刻真正生效的止损：开仓止损，被此前每一次改单依次覆盖。

    modifies 需按时间升序且**包含**自动指令。某次改单把止损清空（0/None）则返回
    None——此刻没有止损可作参照，调用方应放弃判定而不是硬算。

    The stop actually in force at `at`: the opening stop, overwritten by each
    earlier modification (auto ones included). A modification that clears the stop
    yields None — there is no reference left, so the caller must abstain.
    """
    sl = order.sl if order.sl not in (None, 0) else None
    for m in modifies:
        m_at = _aware(m.created_at)
        if m_at is None:
            continue
        if at is not None and m_at > at:
            break  # 升序，之后的都发生在 at 之后 / ascending: the rest are later
        sl = m.sl if m.sl not in (None, 0) else None
    return sl


def _manual_close_legs(manual_closes: list, legs: list[ClosedTrade]) -> list[ClosedTrade]:
    """把每条用户发起的 CLOSE 指令匹配到它实际平掉的那一腿平仓成交。

    存在的理由：一个仓位的平仓腿可能既有用户手动平的、也有后来止损打掉的。整仓
    盈亏加总会把"止损那一腿的亏损"算到用户手动平仓头上——用户手动平的那半仓
    明明是赚的，剩下的被止损打掉，结果判他违规。只有把腿归属清楚，D3 才是在评价
    用户的那次操作本身。

    匹配规则：按时间升序，每条指令认领它之后 _CLOSE_MATCH_WINDOW 内第一条尚未被
    认领的平仓腿。认领不到就跳过（回执丢失、或该平仓其实是在 MT5 端完成的）。

    Attribute each user-initiated CLOSE command to the closing deal it produced.
    A position can mix user-closed legs with a later stop-out leg, and summing the
    whole position's P&L would blame the user's (possibly profitable) manual close
    for the stop-out's loss. Each command claims the first unclaimed leg filled
    within _CLOSE_MATCH_WINDOW after it; unmatched commands are skipped.
    """
    ordered = sorted(
        (leg for leg in legs if leg.closed_at is not None),
        key=lambda leg: _aware(leg.closed_at),
    )
    claimed: set[int] = set()
    out: list[ClosedTrade] = []
    for cmd in manual_closes:
        cmd_at = _aware(cmd.created_at)
        if cmd_at is None:
            continue
        for idx, leg in enumerate(ordered):
            if idx in claimed:
                continue
            leg_at = _aware(leg.closed_at)
            if leg_at < cmd_at - _CLOSE_CLOCK_SKEW:
                continue  # 指令之前就成交的，不可能是它平的 / filled before the command
            if leg_at > cmd_at + _CLOSE_MATCH_WINDOW:
                break  # 升序，再往后只会更晚 / ascending: everything after is later still
            claimed.add(idx)
            out.append(leg)
            break
    return out


def _score_stop_loss(
    order: Order,
    modifies: list,
    entry: float | None,
    signal_sl: float | None,
    tolerance_pct: float,
) -> float | None:
    """D1：止损纪律。把止损往亏损方向挪得明显超出容差，或者干脆删掉，判违规。

    比较基准始终是**信号给的那个原始止损**，不是上一次改单后的值。基准跟着改单
    滚动会漏掉一条真实的规避路径：先把止损拉到保本价（此时"入场价到止损"的距离
    变成 0，容差也随之变成 0，那段代码只好用 `dist > 0` 跳过判定），再一路放宽，
    全程不触发；而同一个终点一步到位反而判违规。以原始止损为准之后，"最终把风险
    放到了计划之外"这件事无论分几步都成立，而在原始止损以内的来回收紧放松——
    仍然是按计划执行——不会被误判。

    modifies 只含**用户发起**的改单（调用方用 _user_initiated 筛过）：系统自动
    保本/移动止损不是用户行为，不该记在他头上。entry 由调用方算好（见 _entry_of）。

    D1: flag a stop moved adversely beyond tolerance, or removed outright.

    The reference is always the *signal's original* stop, never the running value
    after each edit. A rolling reference misses a real evasion path: move the stop
    to breakeven first (entry-to-stop distance becomes 0, so the tolerance does
    too and the check had to skip via `dist > 0`), then widen it freely — while
    the same destination in one step is a violation. Anchored to the original,
    "ended up with more risk than planned" holds however many steps it took, and
    tightening/loosening within the original stop is still following the plan.
    """
    plan_sl = order.sl
    if plan_sl in (None, 0):
        # 开仓就没有止损——但要先分清是谁的责任。信号本身没给止损时（webhook 的
        # stopLoss 是可选字段，Signal.stop_loss 可为空），用户根本没有"原始止损"
        # 可保留，把这算成他违纪是冤枉人：不评分。信号给了、订单上却没有，才是
        # 下单时被主动抹掉，那是实打实的违纪。
        # No stop at entry — but whose doing? The webhook's stopLoss is optional,
        # so a signal can legitimately arrive without one, and there is then no
        # original stop for the user to have kept: abstain rather than blame them.
        # A signal that did carry a stop, on an order that doesn't, means the user
        # cleared it — that is a real violation.
        if signal_sl in (None, 0):
            return None
        return 0.0
    if entry is None:
        return None  # 无法算距离容差，宁缺勿错 / no distance scale, so abstain

    side = order.side
    dist = abs(entry - plan_sl)
    for m in modifies:
        new_sl = m.sl
        if new_sl in (None, 0):
            return 0.0  # 删除止损 / stop removed
        adverse = (new_sl < plan_sl) if side == "BUY" else (new_sl > plan_sl)
        if adverse and dist > 0 and abs(new_sl - plan_sl) > dist * tolerance_pct:
            return 0.0
    return 100.0


def _volume_history_map(db, user_id: str, logins: set[str | None]) -> dict:
    """按 (账号, 品种) 取回仓位基准所需的信号单历史，一次查完这一批账号。

    原来是每个仓位各查一次「本仓位开仓前最近 N 笔」。改成按账号一次性拉回该账号
    的信号单 (created_at, volume) 列表（按时间降序），再由调用方对每个仓位在内存
    里切出「开仓前最近 N 笔」——同一个账号下的多个仓位共用同一份历史，不必反复
    向数据库要几乎相同的数据。

    分桶键带上品种：基准要在同品种内比（见 _risk_exposure / _score_volume），
    黄金的敞口和欧美的敞口混进同一个中位数就没有意义了。每个账号最多取
    _VOLUME_HISTORY_FETCH 行——基准只要 N 笔，但每个仓位的截止时间点不同、且要
    分摊到多个品种，所以留出足够余量让较早的仓位也能凑够 N 笔。

    Per-account signal-order history for the volume baseline, fetched once for the
    whole batch of accounts.

    This used to be one query per position ("the N most recent before this one
    opened"). Now each account's (created_at, volume) list is pulled once in
    descending time order and the caller slices "the N most recent before this
    position" in memory — several positions on the same account share one history
    instead of asking the database for near-identical data over and over.

    Each account fetches at most _VOLUME_BASELINE_SAMPLE + the number of positions
    in the window: the baseline needs N rows, but every position has a different
    cut-off, so there has to be enough slack for the earliest one to still find N.
    """
    out: dict = {}
    for lg in logins:
        rows = (
            db.query(Order.created_at, Order.volume, Order.symbol, Order.sl, Order.filled_price)
            .filter(
                Order.user_id == user_id,
                Order.signal_id.isnot(None),
                Order.action == "ORDER",
                Order.status == "FILLED",
                Order.mt5_login == lg,
            )
            .order_by(Order.created_at.desc())
            .limit(_VOLUME_HISTORY_FETCH)
            .all()
        )
        for r in rows:
            out.setdefault((lg, r.symbol), []).append(r)
    return out


def _score_volume(
    history_rows: list,
    order: Order,
    entry: float | None,
    multiple: float,
    history_min: int,
) -> float | None:
    """D2：仓位纪律。跟**同品种**历史仓位的**风险敞口**中位数比较，超过 N 倍判违规。

    为什么不比原始手数：手数是风险除以止损距离再除以合约规模的结果，不是风险本身。
    同样按账户 1% 下单，黄金和货币对算出来的手数能差一个数量级；同一个品种里，
    止损放宽一倍手数也要减半。拿手数当基准，等于把"风险其实完全一样"的正常下单
    判成违规，而这恰恰是按固定风险比例下单的用户——纪律最好的那批人——最容易踩到的。

    改比 `手数 × |入场价 − 止损价|`（_risk_exposure）：合约规模这个常数只跟品种
    有关，所以只要**桶内同品种**，比它就等价于比真实货币风险，常数被约掉。
    history_rows 就是该 (账号, 品种) 桶按时间降序的历史（_volume_history_map 批量
    取回），这里只负责切出本仓位开仓之前的最近 N 笔。

    降级路径：本单或历史缺止损/入场价（算不出敞口）时，回落到同品种的原始手数
    比较——同品种下合约规模相同，至少不会再有黄金对货币对那种量级错配。仍然
    凑不够 N 笔样本就返回 None，不评分好过误判。

    D2: compare this position's *risk exposure* against the median of the same
    symbol's history, flagging anything beyond N times it.

    Lot size is risk divided by stop distance and contract size, not risk itself:
    the same 1%-of-account risk produces order-of-magnitude different lots on gold
    vs a currency pair, and within one symbol a stop twice as wide halves the lots.
    Judging raw lots therefore flags correctly-sized trades — precisely for the
    users who size by a fixed risk fraction, i.e. the most disciplined ones.
    `volume x |entry - stop|` factors out contract size, which is constant per
    symbol, so comparing inside a symbol bucket equals comparing real money risk.
    Falls back to same-symbol raw lots when a stop or entry is missing, and
    abstains (None) rather than judging on fewer than `history_min` samples.
    """
    prior = [
        r for r in history_rows
        if r.created_at is not None and order.created_at is not None and r.created_at < order.created_at
    ][:_VOLUME_BASELINE_SAMPLE]
    if len(prior) < history_min:
        return None

    current = _risk_exposure(order.volume, entry, order.sl)
    history = [
        x for x in (_risk_exposure(r.volume, r.filled_price, r.sl) for r in prior) if x is not None
    ]
    if current is None or len(history) < history_min:
        # 降级到同品种手数口径 / fall back to same-symbol raw lots
        current = order.volume
        history = [r.volume for r in prior if r.volume]
    if len(history) < history_min:
        return None

    baseline = statistics.median(history)
    if baseline <= 0:
        return None
    if current > baseline * multiple:
        return 0.0
    return 100.0


def _score_exit(
    order: Order,
    manual_closes: list,
    legs: list[ClosedTrade],
    modifies: list,
    entry: float | None,
    distance_pct: float,
) -> float | None:
    """D3：出场纪律。用户在**离止损还很远**的时候手动砍掉亏损仓位，判违规。

    判据是"离计划还有多远"，不是"亏了多少钱"。旧实现是 `整仓盈亏 < 0 即违规`，
    副作用有三，都在真实使用里出现过：

    1. 亏 0.01 和亏 500 同样一票否决，没有任何阈值；
    2. 价格已经贴着止损、理性认输平掉 —— 判违规；反过来离止盈还很远就提前
       落袋跑掉（同样是不按计划执行）—— 判合规。规则实际在奖励"早赚早跑"、
       惩罚"认亏"；
    3. 手动部分平仓明明是赚的、剩余仓位随后被止损打掉，整仓合计为负，这笔
       手动操作照样被判违规（归因归错了腿）。

    现在：只看归属到用户那几条 CLOSE 指令的平仓腿（_manual_close_legs），净亏才
    继续判断；再看平仓时价格走到止损的百分之多少——还剩 distance_pct 以上的距离
    才算"提前砍"。已经走到止损附近（乃至穿过）的，是在执行计划，判合规。

    没有 CLOSE 指令 → 出场交给 SL/TP（或在 MT5 端手动平仓，本平台看不到），合规。
    参照缺失（匹配不到平仓腿、没有入场价、当时没有生效止损）→ 返回 None 不评分，
    与 D1/D2 一致：宁可样本少，不可误判。

    两点口径说明：
    - 从未改过止损时，距离用的是 orders.sl（信号价刻度）配 filled_price（券商价
      刻度），两者有模块文档里说的那点比例偏移；这里算的是比值、偏移基本约掉，
      而且改过止损之后两边都是券商刻度，更准。
    - remaining > 1 表示平仓价还在入场价的盈利一侧却仍是净亏（点差/手续费吃掉了）
      ——那也是一次离计划很远的提前离场，照判违规。

    D3: flag a manual close only when the user bailed while price was still far
    from the stop. The old rule was "position P&L < 0", which (1) treated a 0.01
    loss like a 500 loss, (2) flagged a rational give-up right at the stop while
    clearing an early profit-take that equally abandoned the plan — rewarding
    running from winners and punishing accepting losses — and (3) blamed a
    profitable partial close for a later stop-out on the remainder. Now only the
    legs attributed to the user's own CLOSE commands count, and only if price had
    at least `distance_pct` of the stop distance still to travel. Missing
    references yield None (not scored) rather than a guess.
    """
    if not manual_closes:
        return 100.0  # 出场交给 SL/TP（或 MT5 端手动平仓，检测不到，算合规）

    claimed = _manual_close_legs(manual_closes, legs)
    if not claimed:
        return None  # 指令没有对应的成交回执，无从判定

    if sum(leg.profit for leg in claimed) >= 0:
        return 100.0  # 盈利落袋，不算违规（与用户端帮助文案一致）

    if entry is None:
        return None
    last_at = max(_aware(leg.closed_at) for leg in claimed)
    sl = _effective_sl(order, modifies, last_at)
    if sl in (None, 0):
        return None
    span = abs(entry - sl)
    if span <= 0:
        return None

    # 成交量加权的实际离场价：一条指令可能拆成几笔成交
    # Volume-weighted exit price: one command can fill in several deals
    total_volume = sum(leg.close_volume for leg in claimed)
    if total_volume > 0:
        exit_price = sum(leg.close_price * leg.close_volume for leg in claimed) / total_volume
    else:
        exit_price = claimed[-1].close_price

    # 走完了止损距离的百分之多少（1.0 = 正好到止损，>1 = 已穿过）
    # How far of the way to the stop price had actually been travelled
    travelled = (entry - exit_price) if order.side == "BUY" else (exit_price - entry)
    remaining = 1.0 - travelled / span
    return 0.0 if remaining > distance_pct else 100.0


def compute_discipline(
    db, user_id: str, bound_logins: list[str] | None = None, login: str | None = None
) -> dict:
    """计算某用户的纪律分 / compute one user's discipline score.

    参数语义逐字对齐 compute_personal_winrate：login 只看这一个账号；不传时
    限定在 bound_logins（当前仍绑定的账号）；bound_logins 为 None 时（内部
    快照循环场景）不做账号过滤。

    Parameter semantics mirror compute_personal_winrate: `login` narrows to
    one account; omitted scopes to `bound_logins` (currently-bound accounts);
    `bound_logins=None` (internal snapshot-loop use) applies no account filter.
    """
    cfg = get_discipline_settings(db)
    window_days = int(cfg["window_days"])
    weight_stop = float(cfg["weight_stop"])
    weight_volume = float(cfg["weight_volume"])
    weight_exit = float(cfg["weight_exit"])
    tolerance_pct = float(cfg["sl_tolerance_pct"])
    volume_multiple = float(cfg["volume_multiple"])
    volume_history_min = int(cfg["volume_history_min"])
    exit_distance_pct = float(cfg["exit_sl_distance_pct"])

    positions = _resolved_positions(db, user_id, login, bound_logins, window_days)

    # 三次批量预取，取代原先在循环里每个仓位各发 3 条查询（D1 的 MODIFY、
    # D3 的 CLOSE、D2 的手数历史）。生产库是远端 Supabase，每条查询都带一次
    # 网络往返，而仓位数随用户交易量增长——这是本函数唯一会随规模恶化的部分。
    # 顺带把 D1 里那条「filled_price 为空时回查 Signal.entry」也一次取完。
    # Three bulk prefetches replacing the three per-position queries the loop used
    # to issue (D1's MODIFYs, D3's CLOSEs, D2's volume history). Production talks
    # to a remote Supabase where every query is a network round trip, and the
    # position count grows with how much the user trades — this was the only part
    # of this function that degraded with scale. The "look up Signal.entry when
    # filled_price is missing" fallback inside D1 is prefetched here too.
    keys = set(positions.keys())
    # MODIFY 连自动指令一起取：D1 只认用户自己的改单，D3 要的是当时真正生效的
    # 止损（自动保本/移动止损也算数）。两种口径共用这一次查询。
    # MODIFY is fetched with auto commands included: D1 looks at user edits only,
    # D3 needs the stop actually in force. One query, two views.
    modifies_map = _user_modify_close_map(db, user_id, "MODIFY", keys, include_auto=True)
    closes_map = _user_modify_close_map(db, user_id, "CLOSE", keys)
    volume_history = _volume_history_map(db, user_id, {lg for lg, _t in keys})

    # 信号的"原始计划"：入场价（filled_price 缺失时的回落）和原始止损（D1 用它
    # 分辨"信号本来就没止损"与"用户把止损抹了"）。取全部仓位而不只是缺成交价的
    # 那些——原始止损每一笔都要用到。仍然是一条查询。
    # The signal's original plan: entry (fallback when filled_price is missing) and
    # the original stop (D1 uses it to tell "the signal never had one" apart from
    # "the user cleared it"). Fetched for every position, still in one query.
    signal_ids = {p["order"].signal_id for p in positions.values() if p["order"].signal_id}
    plan_by_signal: dict = {}
    if signal_ids:
        plan_by_signal = {
            row.id: row
            for row in db.query(Signal.id, Signal.entry, Signal.stop_loss)
            .filter(Signal.id.in_(signal_ids))
            .all()
        }

    stop_scores: list[float] = []
    volume_scores: list[float] = []
    exit_scores: list[float] = []

    for key, payload in positions.items():
        pos_login = key[0]
        order = payload["order"]
        legs = payload["legs"]
        entry = _entry_of(order, plan_by_signal)
        modifies = modifies_map.get(key, [])
        plan = plan_by_signal.get(order.signal_id) if order.signal_id else None

        s1 = _score_stop_loss(
            order, _user_initiated(modifies), entry,
            plan.stop_loss if plan is not None else None,
            tolerance_pct,
        )
        if s1 is not None:
            stop_scores.append(s1)

        s2 = _score_volume(
            volume_history.get((pos_login, order.symbol), []),
            order, entry, volume_multiple, volume_history_min,
        )
        if s2 is not None:
            volume_scores.append(s2)

        s3 = _score_exit(order, closes_map.get(key, []), legs, modifies, entry, exit_distance_pct)
        if s3 is not None:
            exit_scores.append(s3)

    def _dim(scores: list[float]) -> dict:
        if not scores:
            return {"score": None, "violations": 0, "samples": 0}
        violations = sum(1 for s in scores if s < 100.0)
        return {"score": sum(scores) / len(scores), "violations": violations, "samples": len(scores)}

    dims = {
        "stopLoss": _dim(stop_scores),
        "volume": _dim(volume_scores),
        "exit": _dim(exit_scores),
    }

    weighted_sum = 0.0
    weight_total = 0.0
    for key, weight in (("stopLoss", weight_stop), ("volume", weight_volume), ("exit", weight_exit)):
        if dims[key]["score"] is not None:
            weighted_sum += dims[key]["score"] * weight
            weight_total += weight
    total = weighted_sum / weight_total if weight_total > 0 else None

    return {
        "total": total,
        "windowDays": window_days,
        "positions": len(positions),
        "dimensions": dims,
    }


async def discipline_snapshot_loop(
    startup_delay: float = SNAPSHOT_STARTUP_DELAY_SECONDS,
) -> None:
    """定时给每个近期有信号单成交的用户计算并落库当日纪律分快照
    （启动即先跑一次，再按 SNAPSHOT_INTERVAL_SECONDS 循环）。

    Periodically compute and persist each active user's discipline-score
    snapshot for today (runs once on startup, then loops at the fixed interval).

    首轮延后一点:这里整段是同步 DB 操作,直接跑在事件循环上,生产实测首轮阻塞
    1.3 秒,顶在 uvicorn bind 端口之前。快照不紧急,让端口先起来。
    (只推迟首轮时机,不动计算逻辑——本轮只处理启动阻塞。)
    The first pass is delayed: this body is all synchronous DB work running on the
    event loop, measured blocking 1.3s before uvicorn binds the port. Snapshots
    aren't urgent, so let the port come up first. (Timing only; the computation is
    untouched, since this change is scoped to the startup stall.)

    startup_delay 可覆盖,便于测试里立即跑首轮。
    startup_delay is overridable so tests can run the first pass immediately.
    """
    if startup_delay:
        await asyncio.sleep(startup_delay)
    while True:
        try:
            db = SessionLocal()
            try:
                cfg = get_discipline_settings(db)
                window_days = int(cfg["window_days"])
                cutoff = datetime.now(timezone.utc) - timedelta(days=window_days)
                user_ids = [
                    row[0]
                    for row in db.query(distinct(Order.user_id))
                    .filter(
                        Order.signal_id.isnot(None),
                        Order.action == "ORDER",
                        Order.status == "FILLED",
                        Order.created_at >= cutoff,
                    )
                    .all()
                ]
                today = datetime.now(timezone.utc).date().isoformat()
                count = 0
                for user_id in user_ids:
                    bound = [
                        row[0]
                        for row in db.query(MT5Account.login).filter(MT5Account.user_id == user_id).all()
                    ]
                    # "全部账号"聚合行（login=""）+ 每个绑定账号各一行
                    targets: list[str | None] = [None] + bound
                    for target_login in targets:
                        snapshot_login = "" if target_login is None else target_login
                        result = compute_discipline(
                            db, user_id,
                            bound_logins=bound if target_login is None else None,
                            login=target_login,
                        )
                        row = (
                            db.query(DisciplineSnapshot)
                            .filter(
                                DisciplineSnapshot.user_id == user_id,
                                DisciplineSnapshot.login == snapshot_login,
                                DisciplineSnapshot.date == today,
                            )
                            .first()
                        )
                        if row is None:
                            db.add(
                                DisciplineSnapshot(
                                    user_id=user_id,
                                    login=snapshot_login,
                                    date=today,
                                    total=result["total"],
                                    dimensions=json.dumps(result["dimensions"]),
                                )
                            )
                        else:
                            row.total = result["total"]
                            row.dimensions = json.dumps(result["dimensions"])
                        count += 1
                if count:
                    db.commit()
                    logger.info("discipline_snapshot_loop: upserted %d snapshot row(s)", count)
            finally:
                db.close()
        except Exception:
            logger.exception("discipline_snapshot_loop error")
        await asyncio.sleep(SNAPSHOT_INTERVAL_SECONDS)
