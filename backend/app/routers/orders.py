"""下单路由：提交下单、查询订单 / Orders router: place & query orders.

所有指令落库为 PENDING，由 PRISMX Bridge 轮询 /api/bridge/poll 拉取执行；
超过 ORDER_PENDING_TIMEOUT_SECONDS 未执行的指令自动作废为 FAILED，
防止桥接离线期间的陈旧指令在很久之后按过时价格成交。
All commands are persisted as PENDING and fetched by the PRISMX Bridge via
/api/bridge/poll. Commands not executed within ORDER_PENDING_TIMEOUT_SECONDS
are voided to FAILED so a stale command can't fill at an outdated price after
the bridge comes back online much later.
"""
import asyncio
import logging
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.database import get_db
from app.core.rate_limit import limiter
from app.models import ClosedTrade, DisciplineSnapshot, MT5Account, Order, Signal, User
from app.schemas import (
    ClosePositionRequest,
    ModifyPositionRequest,
    OrderOut,
    OrderRequest,
)
from app.services.connection_manager import manager
from app.services.deps import get_current_user, is_account_online, validate_order, validate_sl_tp_direction
from app.services.discipline import compute_discipline
from app.services.plans import is_realtime_plan
from app.services.trade_performance import compute_personal_winrate

logger = logging.getLogger("prismx.orders")

router = APIRouter(prefix="/orders", tags=["orders"])

# 超时作废的统一提示文案 / message stamped on voided stale orders
STALE_ORDER_MESSAGE = (
    "指令超时未执行，已自动取消。如已开启桥接请重新下单"
    " / Command timed out before execution and was cancelled automatically."
    " Re-place the order once the bridge is online."
)


def _serialize(o: Order) -> OrderOut:
    return OrderOut(
        id=o.id,
        clientOrderId=o.client_order_id,
        signalId=o.signal_id,
        action=o.action or "ORDER",
        symbol=o.symbol,
        side=o.side,
        volume=o.volume,
        ticket=o.ticket,
        mt5Login=o.mt5_login,
        status=o.status,
        mt5Ticket=o.mt5_ticket,
        filledPrice=o.filled_price,
        message=o.message,
        createdAt=o.created_at,
        updatedAt=o.updated_at,
    )


def order_update_payload(o: Order) -> dict:
    """构造前端 ORDER_UPDATE 推送载荷 / build the ORDER_UPDATE push payload."""
    return {
        "type": "ORDER_UPDATE",
        "data": _serialize(o).model_dump(mode="json"),
    }


def is_stale_pending(o: Order, now: datetime | None = None) -> bool:
    """判断一条 PENDING 订单是否已超时 / whether a PENDING order timed out."""
    if o.status != "PENDING" or o.created_at is None:
        return False
    now = now or datetime.now(timezone.utc)
    created = o.created_at
    if created.tzinfo is None:
        created = created.replace(tzinfo=timezone.utc)
    return created < now - timedelta(seconds=settings.ORDER_PENDING_TIMEOUT_SECONDS)


def void_stale_order(o: Order) -> None:
    """把超时订单置为 FAILED（不提交事务）/ mark a stale order FAILED (no commit)."""
    o.status = "FAILED"
    o.message = STALE_ORDER_MESSAGE


# 说明：下单/平仓/改单端点声明为普通 def——FastAPI 会放到线程池执行，
# 同步 SQLAlchemy 查询不再阻塞事件循环（WS 推送与桥接轮询共用该循环）。
# Note: these endpoints are plain `def` so FastAPI runs them in a thread pool;
# the blocking SQLAlchemy calls no longer stall the event loop shared by the
# WebSocket pushes and bridge polling.
@router.post("", response_model=OrderOut)
@limiter.limit(settings.RATE_LIMIT_ORDER)
def place_order(
    request: Request,
    req: OrderRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """提交下单：风控 + 幂等，落库为 PENDING 等待桥接拉取。
    Place an order: risk check + idempotency; persist as PENDING for the bridge.
    """
    # 1) 风控校验：按净值粗估手数上限。指定了目标账号就用它；没指定但只有
    #    一个账号在线时，也用那唯一的在线账号——它正是桥接稍后单账号兜底
    #    路由会实际打过去的目标（见 bridge.py 的 target 逻辑），不取它的净值
    #    会让"不传 mt5Login"变成绕开净值上限的漏洞。只有多个账号在线、
    #    确实无法确定目标账号时才不做净值校验（后面的 online_count 检查会
    #    直接拒单，不会走到下单这一步）。
    #    Risk validation: cap volume by equity. Use the named target account if
    #    given; if none was given but exactly one account is online, use that
    #    one too — it's exactly the account the bridge's single-account
    #    fallback would route the order to (see bridge.py's `target` logic),
    #    so skipping its equity would let omitting mt5Login bypass the cap
    #    entirely. Only when multiple accounts are online (target genuinely
    #    unknown) is the equity check skipped — but that case is rejected
    #    outright by the online_count check below before an order is ever placed.
    accounts = db.query(MT5Account).filter(MT5Account.user_id == user.id).all()
    online_accounts = [acc for acc in accounts if is_account_online(acc)]
    target_acc = None
    if req.mt5Login:
        target_acc = next((acc for acc in accounts if acc.login == req.mt5Login), None)
    elif len(online_accounts) == 1:
        target_acc = online_accounts[0]
    equity = target_acc.equity if target_acc and target_acc.equity else None
    validate_order(req.symbol, req.side, req.volume, equity)

    # 未指定目标账号且有多个账号在线：直接拒单并提示，而不是让指令
    # 静默滞留 5 分钟后作废（桥接只在恰好一个在线账号时才能兜底路由）。
    # No target account while multiple accounts are online: reject with a
    # clear message instead of letting the command silently sit until the
    # 5-minute void (the bridge can only fall back when exactly one is online).
    if not req.mt5Login and len(online_accounts) > 1:
        raise HTTPException(
            status_code=400,
            detail="多个 MT5 账号在线，请指定目标账户 / Multiple accounts online; choose a target account",
        )

    # 2) 幂等：同一 clientOrderId 不重复下单 / idempotency by clientOrderId
    existing = (
        db.query(Order)
        .filter(Order.user_id == user.id, Order.client_order_id == req.clientOrderId)
        .first()
    )
    if existing:
        return _serialize(existing)

    # 3) 取信号的入场价与止损止盈（若提供 signalId）/ fetch entry, SL & TP from signal
    stop_loss = 0.0
    take_profit = 0.0
    if req.signalId:
        sig = db.query(Signal).filter(Signal.id == req.signalId).first()
        if sig:
            # 拒绝按已过期信号下单，防止按过时价格成交。
            # Reject orders on an expired signal to avoid trading on stale prices.
            is_expired = sig.status == "EXPIRED"
            if not is_expired and sig.expire_at is not None:
                exp = sig.expire_at
                if exp.tzinfo is None:
                    exp = exp.replace(tzinfo=timezone.utc)
                is_expired = exp < datetime.now(timezone.utc)
            # FREE 只能用行情图表手动下单，不能跟信号下单：带 signalId 且信号仍
            # 有效时，FREE 一律拒绝（免费只看得到已过期信号，这里再兜底一层，
            # 防止有人拿到一条仍在有效期内的 signalId——如降级前保存的——绕过）。
            # 不带 signalId 的手动图表下单不走这里，任何等级都放行。
            # FREE users may trade manually from the chart but not by following
            # signals: with a signalId on a still-live signal, FREE is rejected
            # (FREE only ever sees expired signals; this is the server-side
            # backstop in case someone obtains a still-live signalId, e.g. one
            # saved before downgrading). Manual chart orders carry no signalId,
            # never reach here, and are allowed on any plan.
            if not is_realtime_plan(user.plan) and not is_expired:
                raise HTTPException(
                    status_code=403,
                    detail="免费版信号延迟显示，请升级查看实时信号后再下单 / Free tier sees delayed signals only; upgrade for real-time trading",
                )
            if is_expired:
                raise HTTPException(
                    status_code=409,
                    detail="信号已过期，无法下单 / Signal expired, cannot place order",
                )
            stop_loss = sig.stop_loss or 0.0
            take_profit = sig.take_profit or 0.0

    # 用户自定义 SL/TP 覆盖信号默认值 / user's custom SL·TP overrides signal defaults
    if req.stopLoss is not None:
        stop_loss = req.stopLoss
    if req.takeProfit is not None:
        take_profit = req.takeProfit

    # 止损止盈方向校验：两者都填时买单必须 SL<TP、卖单 SL>TP，挡住绕过前端
    # 直接发的"填反了"订单（前端已拦一层，这里是服务端兜底）。
    # SL/TP direction check (server-side backstop for the UI's own check).
    validate_sl_tp_direction(req.side, stop_loss, take_profit)

    # 4) 落库为 PENDING，等待桥接轮询拉取 / persist as PENDING for the bridge to poll
    order = Order(
        user_id=user.id,
        signal_id=req.signalId,
        client_order_id=req.clientOrderId,
        action="ORDER",
        symbol=req.symbol,
        side=req.side,
        volume=req.volume,
        sl=stop_loss or None,
        tp=take_profit or None,
        mt5_login=req.mt5Login,
        status="PENDING",
    )
    return _commit_order_or_existing(db, order, user.id, req.clientOrderId)


@router.get("", response_model=dict)
def list_orders(
    limit: int = 100,
    offset: int = 0,
    since: datetime | None = None,
    until: datetime | None = None,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """查询当前用户订单（先作废超时的 PENDING）。

    limit/offset 支持分页；since/until 可选，按 created_at 筛选时间范围
    （until 用 < 而非 <=，前端传"选中截止日+1天"实现"含当天"的直觉）。
    不传这些参数时行为与此前完全一致（最新 100 条），不影响 useLive() 里
    依赖这个接口做实时订单跟踪的既有调用方。

    List current user's orders (voiding stale PENDING ones first).

    limit/offset support pagination; since/until optionally filter by
    created_at (until uses < rather than <=; the frontend sends "selected end
    date + 1 day" to make the picked end date feel inclusive). Behavior is
    unchanged (latest 100) when none of these are passed, so the live-order
    tracking that already calls this endpoint via useLive() isn't affected.
    """
    stale = [
        o
        for o in db.query(Order)
        .filter(Order.user_id == user.id, Order.status == "PENDING")
        .all()
        if is_stale_pending(o)
    ]
    if stale:
        for o in stale:
            void_stale_order(o)
        db.commit()
    limit = max(1, min(limit, 500))
    offset = max(0, offset)
    query = db.query(Order).filter(Order.user_id == user.id)
    if since is not None:
        query = query.filter(Order.created_at >= since)
    if until is not None:
        query = query.filter(Order.created_at < until)
    total = query.count()
    rows = query.order_by(Order.created_at.desc()).offset(offset).limit(limit).all()
    return {"orders": [_serialize(o) for o in rows], "total": total}


@router.post("/{order_id}/cancel", response_model=OrderOut)
@limiter.limit(settings.RATE_LIMIT_ORDER)
def cancel_order(
    request: Request,
    order_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """撤销一条尚未执行的挂单（PENDING）。

    只能撤销仍处于 PENDING 的指令；一旦桥接已回执（FILLED/REJECTED/FAILED）
    或已作废，撤销请求直接拒绝。桥接若恰好已把该指令发给 MT5，撤销无法追回
    那次执行——这是本地队列式下单模型的固有限制。

    Cancel a not-yet-executed (PENDING) order. Orders already in a terminal
    state are rejected. If the bridge already dispatched the command to MT5
    moments earlier, cancelling here can't undo that fill — an inherent limit
    of the queued-command model.
    """
    order = (
        db.query(Order)
        .filter(Order.id == order_id, Order.user_id == user.id)
        .first()
    )
    if not order:
        raise HTTPException(status_code=404, detail="订单不存在 / Order not found")
    if order.status != "PENDING":
        raise HTTPException(
            status_code=409,
            detail="订单已不是待执行状态，无法撤销 / Order is no longer pending and cannot be cancelled",
        )
    order.status = "CANCELLED"
    order.message = "用户已撤销 / Cancelled by user"
    db.commit()
    db.refresh(order)
    return _serialize(order)


def _commit_order_or_existing(db: Session, order: Order, user_id: str, client_order_id: str):
    """提交新订单；若与并发请求撞上同一 clientOrderId 的唯一约束，回滚后
    返回那个已存在的订单而非把 500 抛给客户端。
    Commit a new order; if a concurrent request races us on the same
    clientOrderId's unique constraint, roll back and return the order that
    won instead of surfacing a raw 500.
    """
    db.add(order)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        existing = (
            db.query(Order)
            .filter(Order.user_id == user_id, Order.client_order_id == client_order_id)
            .first()
        )
        if existing:
            return _serialize(existing)
        raise
    db.refresh(order)
    return _serialize(order)


def _bound_logins(db: Session, user_id: str) -> list[str]:
    """该用户当前仍绑定的 MT5 账号登录名（已删除/换绑的旧账号不在内）。
    This user's currently-bound MT5 account logins (deleted/replaced accounts excluded)."""
    return [row[0] for row in db.query(MT5Account.login).filter(MT5Account.user_id == user_id).all()]


@router.get("/winrate", response_model=dict)
def order_winrate(
    login: str | None = None,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """当前用户的个人跟单胜率：基于真实平仓明细，一个仓位全部平完才算数
    （方案 B，见 app/services/trade_performance.py）。只有自己能看到自己的。

    不传 login：统计范围限定在当前仍绑定的账号（已删除的旧账号不计入）。
    传 login：进一步只看这一个账号——账号必须是当前绑定的，否则视为不存在。

    The current user's personal win rate, based on real close records; a
    position only counts once fully closed (design B). Visible only to the
    user themself.

    Without login: scoped to currently-bound accounts (deleted ones excluded).
    With login: narrowed to that one account — it must be currently bound, or
    it's treated as not found.
    """
    bound = _bound_logins(db, user.id)
    if login is not None and login not in bound:
        raise HTTPException(status_code=404, detail="账号不存在 / Account not found")
    return compute_personal_winrate(db, user.id, bound_logins=bound, login=login)


@router.get("/discipline", response_model=dict)
def order_discipline(
    login: str | None = None,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """当前用户的纪律分：回答"有没有按计划执行"，与赚不赚钱无关，纯只读统计。

    账号过滤语义与 /orders/winrate 完全一致（见 services/discipline.py）。
    等级裁剪：FREE 只返回 total/windowDays/positions/trend，PRO 额外返回
    dimensions 逐维度明细——门槛直接判 user.plan == "PRO"，不经
    services.plans.can_auto_manage 之类的旁支，明细展示与自动仓管没有关系。

    The current user's discipline score: whether the plan was followed,
    independent of P&L. Purely read-only.

    Account-filter semantics exactly match /orders/winrate (see
    services/discipline.py). Plan gating: FREE gets total/windowDays/
    positions/trend only; PRO also gets the per-dimension breakdown — gated
    directly on user.plan == "PRO", not via services.plans.can_auto_manage or
    similar (the detail view has nothing to do with auto-management).
    """
    bound = _bound_logins(db, user.id)
    if login is not None and login not in bound:
        raise HTTPException(status_code=404, detail="账号不存在 / Account not found")
    result = compute_discipline(db, user.id, bound_logins=bound, login=login)

    snapshot_login = login or ""
    trend_cutoff = datetime.now(timezone.utc) - timedelta(days=30)
    trend_rows = (
        db.query(DisciplineSnapshot)
        .filter(
            DisciplineSnapshot.user_id == user.id,
            DisciplineSnapshot.login == snapshot_login,
            DisciplineSnapshot.date >= trend_cutoff.date().isoformat(),
        )
        .order_by(DisciplineSnapshot.date.asc())
        .all()
    )
    trend = [{"date": r.date, "total": r.total} for r in trend_rows]

    response = {
        "total": result["total"],
        "windowDays": result["windowDays"],
        "positions": result["positions"],
        "trend": trend,
    }
    if user.plan == "PRO":
        response["dimensions"] = result["dimensions"]
    return response


@router.get("/closed-trades", response_model=dict)
def list_closed_trades(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """当前用户的真实平仓成交明细，最新在前，限定当前仍绑定的账号（已删除的
    旧账号不再出现；重新绑回后自动恢复，记录从不删除）。只有自己能看到自己的。

    与个人跟单胜率同一份数据源（ClosedTrade），但这里给出逐笔记录而非聚合
    数字——"透明度"承诺不能只停在一个百分比上，用户应该能看到构成这个百分比
    的每一笔真实成交。

    The current user's real closed-trade legs, newest first, scoped to
    currently-bound accounts (a deleted account's history disappears; it comes
    back automatically once re-bound — nothing is ever deleted). Visible only
    to the user themself.

    Same underlying data as the personal win rate (ClosedTrade), but exposed
    as individual records instead of an aggregate — the "transparency"
    promise shouldn't stop at a single percentage; the user should be able to
    see every real fill that number is built from.
    """
    bound = _bound_logins(db, user.id)
    rows = (
        db.query(ClosedTrade)
        .filter(ClosedTrade.user_id == user.id, ClosedTrade.mt5_login.in_(bound))
        .order_by(ClosedTrade.closed_at.desc())
        .limit(200)
        .all()
    )
    return {
        "trades": [
            {
                "id": r.id,
                "mt5Login": r.mt5_login,
                "symbol": r.symbol,
                "side": r.side,
                "closeVolume": r.close_volume,
                "closePrice": r.close_price,
                "profit": r.profit,
                "positionTicket": r.position_ticket,
                "dealTicket": r.deal_ticket,
                "closedAt": r.closed_at.isoformat() if r.closed_at else None,
            }
            for r in rows
        ]
    }


def _assert_account_owned(db: Session, user_id: str, mt5_login: str | None) -> None:
    """校验目标账号归属当前用户（指定 mt5Login 时）。
    Verify the target account belongs to the current user (when mt5Login given).
    """
    if not mt5_login:
        return
    acc = (
        db.query(MT5Account)
        .filter(MT5Account.user_id == user_id, MT5Account.login == mt5_login)
        .first()
    )
    if acc is None:
        raise HTTPException(status_code=404, detail="账号不存在或不属于当前用户 / Account not found")


@router.post("/close", response_model=OrderOut)
@limiter.limit(settings.RATE_LIMIT_ORDER)
def close_position(
    request: Request,
    req: ClosePositionRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """平仓（含部分平仓）：以 CLOSE 指令落库，等待桥接拉取。
    Close a position (incl. partial): persist a CLOSE command for the bridge.
    """
    # 校验目标账号归属，防止越权操控他人/不存在账号 / verify account ownership
    _assert_account_owned(db, user.id, req.mt5Login)

    # 部分平仓手数不得低于单笔最小手数（省略或 0 表示全平，不受此限）。
    # 否则一笔拆不开的小额平仓会被下发、再由 MT5 拒绝，白白回执一条报错。
    # A partial-close volume must not fall below the per-order minimum (omit or
    # 0 means full close, which is exempt). Otherwise an un-fillable tiny close
    # gets dispatched only to be rejected by MT5, wasting an error receipt.
    if req.volume is not None and 0 < req.volume < settings.MIN_VOLUME_PER_ORDER:
        raise HTTPException(
            status_code=400,
            detail=f"低于单笔最小手数 {settings.MIN_VOLUME_PER_ORDER} / Below min volume",
        )

    # 幂等 / idempotency by clientOrderId
    existing = (
        db.query(Order)
        .filter(Order.user_id == user.id, Order.client_order_id == req.clientOrderId)
        .first()
    )
    if existing:
        return _serialize(existing)

    order = Order(
        user_id=user.id,
        client_order_id=req.clientOrderId,
        action="CLOSE",
        symbol=req.symbol,
        side=req.side,
        volume=req.volume or 0.0,
        ticket=req.ticket,
        mt5_login=req.mt5Login,
        status="PENDING",
    )
    return _commit_order_or_existing(db, order, user.id, req.clientOrderId)


@router.post("/modify", response_model=OrderOut)
@limiter.limit(settings.RATE_LIMIT_ORDER)
def modify_position(
    request: Request,
    req: ModifyPositionRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """修改持仓止损止盈：以 MODIFY 指令落库，等待桥接拉取。
    Modify a position's SL/TP: persist a MODIFY command for the bridge.
    """
    # 校验目标账号归属，防止越权操控他人/不存在账号 / verify account ownership
    _assert_account_owned(db, user.id, req.mt5Login)

    # 止损止盈方向校验：两者都非 0 时买单必须 SL<TP、卖单 SL>TP（0 表示清除该侧）。
    # SL/TP direction check (0 means "clear that side" and is skipped).
    validate_sl_tp_direction(req.side, req.stopLoss, req.takeProfit)

    existing = (
        db.query(Order)
        .filter(Order.user_id == user.id, Order.client_order_id == req.clientOrderId)
        .first()
    )
    if existing:
        return _serialize(existing)

    order = Order(
        user_id=user.id,
        client_order_id=req.clientOrderId,
        action="MODIFY",
        symbol=req.symbol,
        side=req.side,
        volume=0.0,
        ticket=req.ticket,
        sl=req.stopLoss,
        tp=req.takeProfit,
        mt5_login=req.mt5Login,
        status="PENDING",
    )
    return _commit_order_or_existing(db, order, user.id, req.clientOrderId)


# ---------- 超时订单后台清理 / stale-order background sweep ----------
async def stale_order_monitor_loop() -> None:
    """周期性把超时未执行的 PENDING 订单置为 FAILED 并推送前端。

    覆盖用户下单后既不刷新订单页、桥接也一直不上线的场景：
    没有任何请求触发作废时，由本任务兜底，让前端及时看到"已取消"。

    Periodically void stale PENDING orders and push ORDER_UPDATE, covering the
    case where neither the orders page nor the bridge ever touches them.
    """
    from starlette.concurrency import run_in_threadpool

    from app.core.database import SessionLocal

    def _sweep() -> list[tuple[str, dict]]:
        """作废超时订单（同步 DB 操作），返回 (user_id, payload) 列表。
        Void stale orders (blocking DB work); return (user_id, payload) pairs."""
        db = SessionLocal()
        try:
            voided: list[Order] = []
            pending = db.query(Order).filter(Order.status == "PENDING").all()
            for o in pending:
                if is_stale_pending(o):
                    void_stale_order(o)
                    voided.append(o)
            if voided:
                db.commit()
            out = []
            for o in voided:
                db.refresh(o)
                out.append((o.user_id, order_update_payload(o)))
            return out
        finally:
            db.close()

    while True:
        await asyncio.sleep(10)
        try:
            # DB 扫描放线程池，避免阻塞事件循环 / DB sweep off the event loop
            for user_id, payload in await run_in_threadpool(_sweep):
                await manager.push_to_client(user_id, payload)
        except Exception:
            logger.exception("stale_order_monitor_loop error")
