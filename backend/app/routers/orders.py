"""下单路由：提交下单、查询订单 / Orders router: place & query orders."""
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.models import EABinding, MT5Account, Order, Signal, User
from app.schemas import (
    ClosePositionRequest,
    ModifyPositionRequest,
    OrderOut,
    OrderRequest,
)
from app.services.connection_manager import manager
from app.services.deps import get_current_user, validate_order

router = APIRouter(prefix="/orders", tags=["orders"])


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


@router.post("", response_model=OrderOut)
async def place_order(
    req: OrderRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """提交下单：风控 + 幂等 + 路由到该用户 EA。
    Place an order: risk check + idempotency + route to the user's EA.
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

    # 2) 幂等：同一 clientOrderId 不重复下单 / idempotency by clientOrderId
    existing = (
        db.query(Order)
        .filter(Order.user_id == user.id, Order.client_order_id == req.clientOrderId)
        .first()
    )
    if existing:
        return _serialize(existing)

    # 3) 取信号的入场价与止损止盈（若提供 signalId）/ fetch entry, SL & TP from signal
    entry = 0.0
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
            entry = sig.entry or 0.0
            stop_loss = sig.stop_loss or 0.0
            take_profit = sig.take_profit or 0.0

    # 用户自定义 SL/TP 覆盖信号默认值 / user's custom SL·TP overrides signal defaults
    if req.stopLoss is not None:
        stop_loss = req.stopLoss
    if req.takeProfit is not None:
        take_profit = req.takeProfit

    # 4) 落库为 PENDING / persist as PENDING
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

    # 5) 路由到该用户的 EA（WebSocket 版即时下发）/ route to WS EA if connected
    # 后缀优先取目标账号（多账号），回退到旧的单一绑定。
    # Suffix: prefer the target account (multi-account), fall back to the legacy binding.
    suffix = ""
    if req.mt5Login:
        acc = (
            db.query(MT5Account)
            .filter(MT5Account.user_id == user.id, MT5Account.login == req.mt5Login)
            .first()
        )
        if acc:
            suffix = (acc.symbol_suffix or "").strip()
    if not suffix:
        binding = db.query(EABinding).filter(EABinding.user_id == user.id).first()
        suffix = (binding.symbol_suffix or "").strip() if binding else ""
    delivered = await manager.send_to_ea(
        user.id,
        {
            "type": "ORDER_CMD",
            "clientOrderId": order.client_order_id,
            "login": order.mt5_login,
            "symbol": order.symbol + suffix,
            "side": order.side,
            "volume": order.volume,
            "entry": entry,
            "stopLoss": stop_loss,
            "takeProfit": take_profit,
        },
    )
    # WS 已送达则标记 delivered；否则保持 PENDING 等待轮询版 EA 拉取。
    # If delivered via WS, mark delivered; otherwise keep PENDING for polling EA to fetch.
    if delivered:
        order.delivered = True
        order.delivered_at = datetime.now(timezone.utc)
        db.commit()
        db.refresh(order)

    return _serialize(order)


@router.get("", response_model=dict)
def list_orders(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """查询当前用户订单 / list current user's orders."""
    rows = (
        db.query(Order)
        .filter(Order.user_id == user.id)
        .order_by(Order.created_at.desc())
        .limit(100)
        .all()
    )
    return {"orders": [_serialize(o) for o in rows]}


async def _route_to_ea(user_id: str, order: Order, suffix: str, db: Session,
                       entry: float = 0.0, stop_loss: float = 0.0, take_profit: float = 0.0) -> None:
    """尝试通过 WS 即时下发指令给 EA；成功则标记 delivered，否则留待桥接轮询。
    Try to push the command to the EA over WS; mark delivered on success,
    otherwise leave PENDING for the bridge to poll.
    """
    delivered = await manager.send_to_ea(user_id, {
        "type": "ORDER_CMD",
        "clientOrderId": order.client_order_id,
        "action": order.action,
        "login": order.mt5_login,
        "symbol": order.symbol + suffix,
        "side": order.side,
        "volume": order.volume,
        "ticket": order.ticket or 0,
        "entry": entry,
        "stopLoss": stop_loss,
        "takeProfit": take_profit,
    })
    if delivered:
        order.delivered = True
        order.delivered_at = datetime.now(timezone.utc)
        db.commit()
        db.refresh(order)


def _suffix_for(user_id: str, mt5_login: str | None, db: Session) -> str:
    """取目标账号的品种后缀 / resolve the symbol suffix for the target account."""
    if mt5_login:
        acc = (
            db.query(MT5Account)
            .filter(MT5Account.user_id == user_id, MT5Account.login == mt5_login)
            .first()
        )
        if acc and (acc.symbol_suffix or "").strip():
            return (acc.symbol_suffix or "").strip()
    binding = db.query(EABinding).filter(EABinding.user_id == user_id).first()
    return (binding.symbol_suffix or "").strip() if binding else ""


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
async def close_position(
    req: ClosePositionRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """平仓（含部分平仓）：以 CLOSE 指令落库并下发。
    Close a position (incl. partial): persist a CLOSE command and dispatch it.
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

    suffix = _suffix_for(user.id, req.mt5Login, db)
    await _route_to_ea(user.id, order, suffix, db)
    return _serialize(order)


@router.post("/modify", response_model=OrderOut)
async def modify_position(
    req: ModifyPositionRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """修改持仓止损止盈：以 MODIFY 指令落库并下发。
    Modify a position's SL/TP: persist a MODIFY command and dispatch it.
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

    suffix = _suffix_for(user.id, req.mt5Login, db)
    await _route_to_ea(user.id, order, suffix, db,
                       stop_loss=req.stopLoss, take_profit=req.takeProfit)
    return _serialize(order)
