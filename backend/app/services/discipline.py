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


def _user_modify_close(db, user_id: str, login: str | None, ticket: int, action: str):
    """该仓位下所有**用户发起**（非 auto_ 前缀）的 MODIFY/CLOSE 指令，按时间升序。

    login 用 `==` 精确匹配（含 None，SQLAlchemy 把 `Column == None` 自动改写成
    IS NULL）——不能省略这个过滤条件：ticket 编号只在单个账号内唯一，若 login
    为 None 就不加过滤，会把另一账号里恰好同编号的 MODIFY/CLOSE 也匹配进来。

    User-initiated (non-auto_) MODIFY/CLOSE commands for this position, oldest
    first. `login` is matched with `==` (including None, which SQLAlchemy
    rewrites to IS NULL) — this filter can't be skipped: ticket numbers are
    only unique within one account, so omitting it when login is None would
    also match MODIFY/CLOSE rows from a different account that happens to
    share the same ticket number.
    """
    return (
        db.query(Order)
        .filter(
            Order.user_id == user_id,
            Order.action == action,
            Order.status == "FILLED",
            Order.ticket == ticket,
            Order.mt5_login == login,
            ~Order.client_order_id.like(f"{AUTO_PREFIX}%"),
        )
        .order_by(Order.created_at.asc())
        .all()
    )


def _score_stop_loss(db, user_id: str, login: str | None, ticket: int, order: Order, tolerance_pct: float) -> float | None:
    """D1：止损纪律。逐条用户发起的 MODIFY 比对，任何一次明显恶化即判违规。"""
    ref_sl = order.sl
    if ref_sl in (None, 0):
        # 信号单必然带止损；开仓时就没有止损本身就是最大的违纪
        return 0.0
    side = order.side
    price_ref = order.filled_price
    if price_ref is None:
        sig = db.query(Signal).filter(Signal.id == order.signal_id).first()
        price_ref = sig.entry if sig else None
    if price_ref is None:
        return None  # 无法算距离容差，宁缺勿错

    modifies = _user_modify_close(db, user_id, login, ticket, "MODIFY")
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


def _score_volume(db, user_id: str, login: str | None, order: Order, multiple: float, history_min: int) -> float | None:
    """D2：仓位纪律。跟该账号下本仓位开仓前最近 N 笔信号单的手数中位数比较。
    login 用 `==` 精确匹配（含 None→IS NULL），同 _user_modify_close 的理由：
    不按账号切分会把另一账号的手数历史错误地混进基准里。"""
    history = [
        v
        for (v,) in db.query(Order.volume)
        .filter(
            Order.user_id == user_id,
            Order.signal_id.isnot(None),
            Order.action == "ORDER",
            Order.status == "FILLED",
            Order.mt5_login == login,
            Order.created_at < order.created_at,
        )
        .order_by(Order.created_at.desc())
        .limit(_VOLUME_BASELINE_SAMPLE)
        .all()
    ]
    if len(history) < history_min:
        return None
    baseline = statistics.median(history)
    if baseline <= 0:
        return None
    if order.volume > baseline * multiple:
        return 0.0
    return 100.0


def _score_exit(db, user_id: str, login: str | None, ticket: int, legs: list[ClosedTrade]) -> float:
    """D3：出场纪律。有用户发起的 CLOSE 指令、且该仓位最终亏损，判违规。"""
    manual_closes = _user_modify_close(db, user_id, login, ticket, "CLOSE")
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

    stop_scores: list[float] = []
    volume_scores: list[float] = []
    exit_scores: list[float] = []

    for (pos_login, ticket), payload in positions.items():
        order = payload["order"]
        legs = payload["legs"]

        s1 = _score_stop_loss(db, user_id, pos_login, ticket, order, tolerance_pct)
        if s1 is not None:
            stop_scores.append(s1)

        s2 = _score_volume(db, user_id, pos_login, order, volume_multiple, volume_history_min)
        if s2 is not None:
            volume_scores.append(s2)

        exit_scores.append(_score_exit(db, user_id, pos_login, ticket, legs))

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


async def discipline_snapshot_loop() -> None:
    """定时给每个近期有信号单成交的用户计算并落库当日纪律分快照
    （启动即先跑一次，再按 SNAPSHOT_INTERVAL_SECONDS 循环）。

    Periodically compute and persist each active user's discipline-score
    snapshot for today (runs once on startup, then loops at the fixed interval).
    """
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
