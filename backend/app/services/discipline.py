"""纪律分 Discipline Score：给每个用户算一个 0-100 的"执行纪律"分数，回答
"你有没有按计划执行"，与赚不赚钱无关。纯只读统计，不产生任何交易指令，不碰下单链路。

三个维度（默认权重 D1 40% / D2 30% / D3 30%，权重与阈值见 settings_store.py 的
DISCIPLINE_DEFAULTS，管理后台可调）：
- D1 止损纪律：跟信号下的单是否保留了原始止损，有没有把止损往亏损方向恶意移动。
- D2 仓位纪律：手数是否在历史正常区间内，防的是报复性加仓的突然放大。
- D3 出场纪律：有没有在没到止损止盈时手动恐慌平仓。

已知数据局限（V1 有意为之，不是 bug）：
- 用户直接在 MT5 客户端手动平仓不产生本平台 CLOSE 指令，D3 检测不到——
  只检测经网页发起的平仓，没有 CLOSE 记录视为"交给 SL/TP 处理"，判合规。
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
- D2 position-size discipline: whether volume stays within the historical
  normal range, catching sudden revenge-sized positions.
- D3 exit discipline: whether the user panic-closed before hitting SL/TP.

Known data limitations (intentional in V1, not bugs):
- A manual close done directly in the MT5 terminal produces no CLOSE command
  on this platform, so D3 can't see it — only web-initiated closes are
  detected; no CLOSE record is treated as "left to SL/TP", scored compliant.
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

logger = logging.getLogger("prismx.discipline")

# 手数浮点误差容忍度，与 trade_performance.py 的 _VOLUME_EPS 同一个值/用途，
# 复制而非 import——两个模块各自独立，谁先改都不用担心破坏对方。
# Float tolerance, same value/purpose as trade_performance._VOLUME_EPS,
# duplicated rather than imported — the two modules stay independent.
_VOLUME_EPS = 1e-6

# 自动仓管指令前缀（backend/app/services/auto_manage.py::AUTO_PREFIX 同一个值）：
# 系统替用户执行的操作不算用户行为，不参与纪律评分。
AUTO_PREFIX = "auto_"

# D2 仓位基准取样：本仓位开仓前最近 N 笔信号单的手数，算中位数
_VOLUME_BASELINE_SAMPLE = 20

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

    tickets = list({o.mt5_ticket for o in orders})
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
        key = (order.mt5_login, order.mt5_ticket)
        pos_legs = legs_by_pos.get(key)
        if not pos_legs:
            continue
        closed_volume = sum(leg.close_volume for leg in pos_legs)
        if closed_volume + _VOLUME_EPS >= order.volume:
            resolved[key] = {"order": order, "legs": pos_legs}
    return resolved


def _user_modify_close_map(
    db, user_id: str, action: str, keys: set[tuple]
) -> dict[tuple, list]:
    """一次取回这一批仓位下所有**用户发起**（非 auto_ 前缀）的 MODIFY 或 CLOSE
    指令，按 (账号, 仓位编号) 分组、组内按时间升序。

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
            ~Order.client_order_id.like(f"{AUTO_PREFIX}%"),
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


def _score_stop_loss(
    db, order: Order, modifies: list, entry_by_signal: dict[str, float | None], tolerance_pct: float
) -> float | None:
    """D1：止损纪律。逐条用户发起的 MODIFY 比对，任何一次明显恶化即判违规。

    modifies 由调用方批量取好后传入（见 _user_modify_close_map），
    entry_by_signal 同理——原来这两处各自在循环里发查询。
    Both `modifies` and `entry_by_signal` are prefetched in bulk by the caller
    (see _user_modify_close_map); each used to issue its own query inside the loop.
    """
    ref_sl = order.sl
    if ref_sl in (None, 0):
        # 信号单必然带止损；开仓时就没有止损本身就是最大的违纪
        return 0.0
    side = order.side
    price_ref = order.filled_price
    if price_ref is None:
        price_ref = entry_by_signal.get(order.signal_id)
    if price_ref is None:
        return None  # 无法算距离容差，宁缺勿错

    for m in modifies:
        new_sl = m.sl
        if new_sl in (None, 0):
            return 0.0  # 删除止损
        if ref_sl not in (None, 0):
            dist = abs(price_ref - ref_sl)
            adverse = (new_sl < ref_sl) if side == "BUY" else (new_sl > ref_sl)
            if adverse and dist > 0 and abs(new_sl - ref_sl) > dist * tolerance_pct:
                return 0.0
        ref_sl = new_sl
    return 100.0


def _volume_history_map(db, user_id: str, logins: set[str | None]) -> dict:
    """按账号取回手数基准所需的信号单历史，一次查完这一批账号。

    原来是每个仓位各查一次「本仓位开仓前最近 N 笔」。改成按账号一次性拉回该账号
    的信号单 (created_at, volume) 列表（按时间降序），再由调用方对每个仓位在内存
    里切出「开仓前最近 N 笔」——同一个账号下的多个仓位共用同一份历史，不必反复
    向数据库要几乎相同的数据。

    每个账号最多取 _VOLUME_BASELINE_SAMPLE + 窗口内仓位数 行：基准只要 N 笔，
    但每个仓位的截止时间点不同，所以要留出足够的余量让最早那个仓位也能凑够 N 笔。

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
            db.query(Order.created_at, Order.volume)
            .filter(
                Order.user_id == user_id,
                Order.signal_id.isnot(None),
                Order.action == "ORDER",
                Order.status == "FILLED",
                Order.mt5_login == lg,
            )
            .order_by(Order.created_at.desc())
            .limit(_VOLUME_BASELINE_SAMPLE * 4)
            .all()
        )
        out[lg] = rows
    return out


def _score_volume(history_rows: list, order: Order, multiple: float, history_min: int) -> float | None:
    """D2：仓位纪律。跟该账号下本仓位开仓前最近 N 笔信号单的手数中位数比较。

    history_rows 是该账号按时间降序的 (created_at, volume) 列表（由
    _volume_history_map 批量取回），这里只负责切出本仓位开仓之前的最近 N 笔。
    按账号切分这一点没变——不切分会把另一账号的手数历史混进基准里。

    history_rows is that account's (created_at, volume) list in descending time
    order, prefetched by _volume_history_map; this only slices the N most recent
    entries predating this position. Still scoped per account: mixing another
    account's sizing into the baseline would corrupt it.
    """
    history = [
        v for (created, v) in history_rows
        if created is not None and order.created_at is not None and created < order.created_at
    ][:_VOLUME_BASELINE_SAMPLE]
    if len(history) < history_min:
        return None
    baseline = statistics.median(history)
    if baseline <= 0:
        return None
    if order.volume > baseline * multiple:
        return 0.0
    return 100.0


def _score_exit(manual_closes: list, legs: list[ClosedTrade]) -> float:
    """D3：出场纪律。有用户发起的 CLOSE 指令、且该仓位最终亏损，判违规。
    manual_closes 由调用方批量取好后传入（见 _user_modify_close_map）。
    manual_closes is prefetched in bulk by the caller (see _user_modify_close_map)."""
    if not manual_closes:
        return 100.0  # 出场交给 SL/TP（或 MT5 端手动平仓，检测不到，算合规）
    total_profit = sum(leg.profit for leg in legs)
    return 0.0 if total_profit < 0 else 100.0


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
    modifies_map = _user_modify_close_map(db, user_id, "MODIFY", keys)
    closes_map = _user_modify_close_map(db, user_id, "CLOSE", keys)
    volume_history = _volume_history_map(db, user_id, {lg for lg, _t in keys})

    signal_ids = {
        p["order"].signal_id
        for p in positions.values()
        if p["order"].filled_price is None and p["order"].signal_id
    }
    entry_by_signal: dict[str, float | None] = {}
    if signal_ids:
        entry_by_signal = {
            sid: entry
            for sid, entry in db.query(Signal.id, Signal.entry).filter(Signal.id.in_(signal_ids)).all()
        }

    stop_scores: list[float] = []
    volume_scores: list[float] = []
    exit_scores: list[float] = []

    for key, payload in positions.items():
        pos_login = key[0]
        order = payload["order"]
        legs = payload["legs"]

        s1 = _score_stop_loss(db, order, modifies_map.get(key, []), entry_by_signal, tolerance_pct)
        if s1 is not None:
            stop_scores.append(s1)

        s2 = _score_volume(volume_history.get(pos_login, []), order, volume_multiple, volume_history_min)
        if s2 is not None:
            volume_scores.append(s2)

        exit_scores.append(_score_exit(closes_map.get(key, []), legs))

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
