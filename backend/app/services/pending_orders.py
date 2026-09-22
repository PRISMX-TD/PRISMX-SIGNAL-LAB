"""挂单快照：统一的对外形状，以及 gateway 通道的读取与推送。

两条通道的挂单最终都要变成同一种字典再推给前端（PENDING_ORDERS 帧是整表替换
语义，形状不一致会让前端按来源分叉）。桥接那侧由 mt5_worker._pending_orders_payload
直接产出这个形状；gateway 这侧由本模块把网关的 OrderInfo 翻译过来。键名与
POSITIONS 的载荷刻意保持同名（ticket / symbol / side / volume / login），
前端两张表的行渲染因此能共用同一批字段。

Pending orders from both channels must reach the frontend as the same dict: the
PENDING_ORDERS frame replaces the whole table, so a per-source shape would fork the
rendering. The bridge emits this shape directly (mt5_worker._pending_orders_payload);
this module translates the gateway's OrderInfo into it. Field names deliberately
match the POSITIONS payload so both tables share row-rendering code.
"""
import logging

from sqlalchemy.orm import Session

from app.models import MT5Account
from app.services.connection_manager import manager
from app.services.gateway_binding import not_removed
from app.services.gateway_client import get_pending_orders as gw_get_pending_orders

logger = logging.getLogger("prismx.gateway.router")

# MT5 订单类型原值 -> 名字。0/1 是市价买卖，不会出现在"未成交挂单"里，所以
# 不在表内；真出现了（券商把一张市价单留在挂单表里）就当未知类型丢掉，而不是
# 硬塞成 BUY——界面上多一行看不懂的挂单，远好过一行说错方向的挂单。
# MT5 raw order type -> name. 0/1 are market buy/sell and cannot appear among
# *open* orders, so they are absent: an unknown type is dropped rather than
# coerced, because a missing row beats a row that states the wrong direction.
PENDING_TYPE_NAMES = {
    2: "BUY_LIMIT",
    3: "SELL_LIMIT",
    4: "BUY_STOP",
    5: "SELL_STOP",
}


def pending_row(
    *, ticket: int, symbol: str, type_name: str, volume: float, price: float,
    stop_loss: float, take_profit: float, login: str,
) -> dict:
    """一行挂单的统一形状。`side` 由类型名推出，前端不必再认识四个类型名。"""
    return {
        "ticket": int(ticket),
        "symbol": symbol,
        "type": type_name,
        "side": "BUY" if type_name.startswith("BUY") else "SELL",
        "volume": float(volume),
        "price": float(price),
        "stopLoss": float(stop_loss or 0.0),
        "takeProfit": float(take_profit or 0.0),
        "login": login,
    }


async def read_gateway_pending_orders(login: str) -> tuple[list[dict], bool]:
    """读一个 gateway 账号的挂单，转成统一形状。返回 (列表, 是否成功)。"""
    orders, err = await gw_get_pending_orders(int(login))
    if err:
        logger.warning("Gateway 挂单读取失败 login=%s: %s", login, err)
        return [], False
    rows = []
    for o in orders:
        name = PENDING_TYPE_NAMES.get(int(o.type))
        if name is None:
            continue
        rows.append(pending_row(
            ticket=o.ticket, symbol=o.symbol, type_name=name, volume=o.volume,
            price=o.price_order, stop_loss=o.stop_loss, take_profit=o.take_profit,
            login=login,
        ))
    return rows, True


def gateway_logins(db: Session, user_id: str) -> list[str]:
    """该用户名下未被移除的 gateway 账号 login 列表。"""
    return [
        row[0]
        for row in db.query(MT5Account.login).filter(
            MT5Account.user_id == user_id,
            MT5Account.source == "gateway",
            not_removed(),
        ).all()
    ]


async def push_gateway_pending_orders(user_id: str, logins: list[str]) -> None:
    """读齐该用户**全部** gateway 账号的挂单并推一帧。

    必须读齐再推：PENDING_ORDERS 是整表替换，只推刚操作过的那个账号会让同一
    用户其它 gateway 账号的挂单在界面上整批消失。任一账号读失败就整轮不推——
    残缺快照在整表替换语义下等于"那些挂单没了"。
    Read every gateway account before pushing: the frame replaces the whole table,
    so pushing only the account just acted on would wipe the user's other accounts'
    orders from the UI. A single failed read cancels the push — under replace
    semantics a partial snapshot reads as "those orders are gone".
    """
    if not logins:
        return
    rows: list[dict] = []
    for login in logins:
        got, ok = await read_gateway_pending_orders(login)
        if not ok:
            return
        rows.extend(got)
    await manager.push_pending_orders(user_id, rows, source="gateway")
