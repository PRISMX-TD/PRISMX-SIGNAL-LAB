"""订单的对外形状：OrderOut 序列化、ORDER_UPDATE 推送载荷、PENDING 超时判定。

从 routers/orders.py 搬出来（2026-09-06）：这些不依赖任何路由，而 services/
gateway_execute.py 与 routers/bridge.py 都要用——服务层不该反过来 import 路由模块。
Order presentation helpers, moved out of routers/orders.py so the service layer
(gateway_execute) and the bridge router can use them without importing a router.
"""
from datetime import datetime, timedelta, timezone

from app.core.config import settings
from app.models import Order
from app.schemas import OrderOut


# 超时作废的统一提示文案 / message stamped on voided stale orders
STALE_ORDER_MESSAGE = (
    "指令超时未执行，已自动取消。如已开启桥接请重新下单"
    " / Command timed out before execution and was cancelled automatically."
    " Re-place the order once the bridge is online."
)


def serialize_order(o: Order) -> OrderOut:
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
        "data": serialize_order(o).model_dump(mode="json"),
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
