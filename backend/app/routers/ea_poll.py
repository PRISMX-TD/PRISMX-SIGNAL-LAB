"""EA 轮询桥接路由（版本 B 用）：通过 REST + API Token 实现指令拉取与回报。
EA polling bridge router (for version B): pull commands & report via REST + API token.
"""
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.models import EABinding, Order, Signal, User
from app.services.connection_manager import manager

router = APIRouter(prefix="/ea/poll", tags=["ea-poll"])


def get_ea_user(
    x_api_token: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> User:
    """通过 API Token 鉴权 EA / authenticate EA by API token."""
    if not x_api_token:
        raise HTTPException(status_code=401, detail="缺少 API Token / Missing API token")
    user = db.query(User).filter(User.api_token == x_api_token).first()
    if not user:
        raise HTTPException(status_code=401, detail="API Token 无效 / Invalid API token")
    return user


def _touch_binding(db: Session, user_id: str, req: "PollRequest"):
    binding = db.query(EABinding).filter(EABinding.user_id == user_id).first()
    if binding is None:
        binding = EABinding(user_id=user_id)
        db.add(binding)
    if req.mt5Login:
        binding.mt5_login = req.mt5Login
    if req.mt5Server:
        binding.mt5_server = req.mt5Server
    # EA 上报的账户信息 / account info reported by EA
    if req.accountName is not None:
        binding.account_name = req.accountName
    if req.accountCurrency is not None:
        binding.account_currency = req.accountCurrency
    if req.balance is not None:
        binding.balance = req.balance
    if req.equity is not None:
        binding.equity = req.equity
    if req.leverage is not None:
        binding.leverage = req.leverage
    if req.company is not None:
        binding.company = req.company
    # EA 自动探测到的后缀作为兜底（仅当用户未手动设置时）/ EA-detected suffix as fallback
    if req.detectedSuffix is not None and not (binding.symbol_suffix or "").strip():
        binding.symbol_suffix = req.detectedSuffix
    binding.online = True
    binding.last_heartbeat = datetime.now(timezone.utc)
    db.commit()
    return binding


class PollRequest(BaseModel):
    mt5Login: str | None = None
    mt5Server: str | None = None
    accountName: str | None = None
    accountCurrency: str | None = None
    balance: float | None = None
    equity: float | None = None
    leverage: int | None = None
    company: str | None = None
    # EA 自动探测到的品种后缀 / suffix auto-detected by EA
    detectedSuffix: str | None = None


@router.post("/poll")
async def poll_commands(
    req: PollRequest,
    user: User = Depends(get_ea_user),
    db: Session = Depends(get_db),
):
    """EA 轮询：上报在线 + 拉取待执行指令。
    EA polling: report online + fetch pending order commands.
    """
    binding = _touch_binding(db, user.id, req)
    suffix = (binding.symbol_suffix or "").strip()
    await manager.push_to_client(
        user.id, {"type": "EA_STATUS", "data": {"online": True, "mt5Login": req.mt5Login}}
    )

    # 取出未下发的 PENDING 订单 / fetch undelivered PENDING orders
    pending = (
        db.query(Order)
        .filter(Order.user_id == user.id, Order.status == "PENDING", Order.delivered == False)  # noqa: E712
        .order_by(Order.created_at.asc())
        .all()
    )
    commands = []
    for o in pending:
        entry = stop_loss = take_profit = 0.0
        if o.signal_id:
            sig = db.query(Signal).filter(Signal.id == o.signal_id).first()
            if sig:
                entry = sig.entry or 0.0
                stop_loss = sig.stop_loss or 0.0
                take_profit = sig.take_profit or 0.0
        commands.append({
            "clientOrderId": o.client_order_id,
            # 拼接券商后缀后的真实品种名 / broker symbol with suffix applied
            "symbol": o.symbol + suffix,
            "side": o.side,
            "volume": o.volume,
            "entry": entry,
            "stopLoss": stop_loss,
            "takeProfit": take_profit,
        })
        o.delivered = True
    db.commit()

    return {"commands": commands}


class ResultRequest(BaseModel):
    clientOrderId: str
    success: bool
    mt5Ticket: int | None = None
    filledPrice: float | None = None
    message: str | None = None


@router.post("/result")
async def report_result(
    req: ResultRequest,
    user: User = Depends(get_ea_user),
    db: Session = Depends(get_db),
):
    """EA 回报执行结果 / EA reports execution result."""
    order = (
        db.query(Order)
        .filter(Order.user_id == user.id, Order.client_order_id == req.clientOrderId)
        .first()
    )
    if not order:
        raise HTTPException(status_code=404, detail="订单不存在 / Order not found")

    order.status = "FILLED" if req.success else "REJECTED"
    order.mt5_ticket = req.mt5Ticket
    order.filled_price = req.filledPrice
    order.message = req.message
    db.commit()
    db.refresh(order)

    await manager.push_to_client(user.id, {
        "type": "ORDER_UPDATE",
        "data": {
            "id": order.id,
            "clientOrderId": order.client_order_id,
            "signalId": order.signal_id,
            "symbol": order.symbol,
            "side": order.side,
            "volume": order.volume,
            "status": order.status,
            "mt5Ticket": order.mt5_ticket,
            "filledPrice": order.filled_price,
            "message": order.message,
            "createdAt": order.created_at.isoformat(),
            "updatedAt": order.updated_at.isoformat(),
        },
    })
    return {"ok": True}


class PositionsRequest(BaseModel):
    data: list = []


@router.post("/positions")
async def report_positions(
    req: PositionsRequest,
    user: User = Depends(get_ea_user),
):
    """EA 上报持仓 / EA reports open positions."""
    await manager.push_to_client(user.id, {"type": "POSITIONS", "data": req.data})
    return {"ok": True}
