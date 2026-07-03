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

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.database import get_db
from app.models import MT5Account, Order, Signal, User
from app.schemas import (
    ClosePositionRequest,
    ModifyPositionRequest,
    OrderOut,
    OrderRequest,
)
from app.services.connection_manager import manager
from app.services.deps import get_current_user, is_account_online, validate_order

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
def place_order(
    req: OrderRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """提交下单：风控 + 幂等，落库为 PENDING 等待桥接拉取。
    Place an order: risk check + idempotency; persist as PENDING for the bridge.
    """
    # 1) 风控校验：若指定目标账号，按其净值粗估手数上限。
    #    Risk validation: if a target account is given, cap volume by its equity.
    equity = None
    if req.mt5Login:
        acc = (
            db.query(MT5Account)
            .filter(MT5Account.user_id == user.id, MT5Account.login == req.mt5Login)
            .first()
        )
        if acc and acc.equity:
            equity = acc.equity
    validate_order(req.symbol, req.side, req.volume, equity)

    # 未指定目标账号且有多个账号在线：直接拒单并提示，而不是让指令
    # 静默滞留 5 分钟后作废（桥接只在恰好一个在线账号时才能兜底路由）。
    # No target account while multiple accounts are online: reject with a
    # clear message instead of letting the command silently sit until the
    # 5-minute void (the bridge can only fall back when exactly one is online).
    if not req.mt5Login:
        online_count = sum(
            1
            for acc in db.query(MT5Account).filter(MT5Account.user_id == user.id).all()
            if is_account_online(acc)
        )
        if online_count > 1:
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
    db.add(order)
    db.commit()
    db.refresh(order)
    return _serialize(order)


@router.get("", response_model=dict)
def list_orders(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """查询当前用户订单（先作废超时的 PENDING）。
    List current user's orders (voiding stale PENDING ones first)."""
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
    rows = (
        db.query(Order)
        .filter(Order.user_id == user.id)
        .order_by(Order.created_at.desc())
        .limit(100)
        .all()
    )
    return {"orders": [_serialize(o) for o in rows]}


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
def close_position(
    req: ClosePositionRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """平仓（含部分平仓）：以 CLOSE 指令落库，等待桥接拉取。
    Close a position (incl. partial): persist a CLOSE command for the bridge.
    """
    # 校验目标账号归属，防止越权操控他人/不存在账号 / verify account ownership
    _assert_account_owned(db, user.id, req.mt5Login)

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
    db.add(order)
    db.commit()
    db.refresh(order)
    return _serialize(order)


@router.post("/modify", response_model=OrderOut)
def modify_position(
    req: ModifyPositionRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """修改持仓止损止盈：以 MODIFY 指令落库，等待桥接拉取。
    Modify a position's SL/TP: persist a MODIFY command for the bridge.
    """
    # 校验目标账号归属，防止越权操控他人/不存在账号 / verify account ownership
    _assert_account_owned(db, user.id, req.mt5Login)

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
    db.add(order)
    db.commit()
    db.refresh(order)
    return _serialize(order)


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
