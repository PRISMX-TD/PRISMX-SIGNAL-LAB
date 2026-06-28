"""下单路由：提交下单、查询订单 / Orders router: place & query orders."""
from datetime import datetime, timezone

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.models import EABinding, MT5Account, Order, Signal, User
from app.schemas import OrderOut, OrderRequest
from app.services.connection_manager import manager
from app.services.deps import get_current_user, validate_order

router = APIRouter(prefix="/orders", tags=["orders"])


def _serialize(o: Order) -> OrderOut:
    return OrderOut(
        id=o.id,
        clientOrderId=o.client_order_id,
        signalId=o.signal_id,
        symbol=o.symbol,
        side=o.side,
        volume=o.volume,
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
            entry = sig.entry or 0.0
            stop_loss = sig.stop_loss or 0.0
            take_profit = sig.take_profit or 0.0

    # 4) 落库为 PENDING / persist as PENDING
    order = Order(
        user_id=user.id,
        signal_id=req.signalId,
        client_order_id=req.clientOrderId,
        symbol=req.symbol,
        side=req.side,
        volume=req.volume,
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
