"""Gateway HTTP 客户端：调用 C# MT5 Gateway 的 REST 接口。

Gateway 跑在 MT5 服务器本地，只监听 127.0.0.1，通过 X-Gateway-Token 鉴权。
后端通过这个客户端直接操作 MT5 账号，不需要 bridge 轮询。
"""

import logging
from dataclasses import dataclass
from typing import Any, Optional

import httpx

from app.core.config import settings

logger = logging.getLogger("prismx.gateway")

# ---------- 数据结构 ----------


@dataclass
class TradeRsp:
    ok: bool
    retcode: str
    message: str
    deal: int  # deal ticket
    order: int  # order ticket
    price: float


@dataclass
class VerifyRsp:
    ok: bool
    valid: bool
    retcode: str
    login: int = 0
    name: str = ""
    group: str = ""
    leverage: int = 0
    balance: float = 0.0
    equity: float = 0.0


@dataclass
class AccountRsp:
    ok: bool
    login: int
    name: str
    group: str
    leverage: int
    balance: float
    equity: float
    margin: float
    margin_free: float


@dataclass
class PositionRsp:
    ticket: int
    symbol: str
    side: str
    volume: float
    price_open: float
    price_current: float
    stop_loss: float
    take_profit: float
    profit: float
    comment: str


@dataclass
class DealRsp:
    """一笔成交（历史）。字段与 gateway 的 DealInfo 对应。"""

    ticket: int
    position_id: int
    symbol: str
    action: int  # 0=buy 1=sell，其余为非交易类（入金/手续费等）
    entry: int  # 0=in 1=out 2=inout 3=out_by
    volume: float
    price: float
    profit: float
    commission: float
    storage: float
    time: int  # Unix 秒（UTC）
    comment: str


# ---------- 客户端 ----------


def _headers() -> dict:
    return {
        "X-Gateway-Token": settings.GATEWAY_TOKEN,
        "Content-Type": "application/json",
    }


async def _post(path: str, body: dict) -> dict:
    """POST 到 gateway，返回 JSON dict。"""
    url = settings.GATEWAY_URL.rstrip("/") + path
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(60)) as client:
            resp = await client.post(url, json=body, headers=_headers())
            resp.raise_for_status()
            return resp.json()
    except httpx.TimeoutException:
        logger.error("Gateway 超时: %s", url)
        return {"ok": False, "error": "timeout", "message": "Gateway 响应超时"}
    except httpx.HTTPStatusError as e:
        logger.error("Gateway HTTP %s: %s %s", e.response.status_code, url, e.response.text[:300])
        return {"ok": False, "error": "http_error", "message": str(e)}
    except Exception as e:
        logger.error("Gateway 请求失败: %s %s", url, e)
        return {"ok": False, "error": "request_failed", "message": str(e)}


# ---------- 业务接口 ----------


async def verify_account(login: int, password: str, investor_only: bool = False) -> VerifyRsp:
    """验证 MT5 账号密码（用户绑定账号时用）。"""
    data = await _post("/verify", {"login": login, "password": password, "investorOnly": investor_only})
    return VerifyRsp(
        ok=data.get("ok", False),
        valid=data.get("valid", False),
        retcode=str(data.get("retcode", "")),
        login=data.get("login", 0),
        name=data.get("name", ""),
        group=data.get("group", ""),
        leverage=data.get("leverage", 0),
        balance=data.get("balance", 0.0),
        equity=data.get("equity", 0.0),
    )


async def get_account(login: int) -> AccountRsp | None:
    """读取账号资金信息。"""
    data = await _post("/account", {"login": login})
    if not data.get("ok"):
        return None
    return AccountRsp(
        ok=True,
        login=data.get("login", login),
        name=data.get("name", ""),
        group=data.get("group", ""),
        leverage=data.get("leverage", 0),
        balance=data.get("balance", 0.0),
        equity=data.get("equity", 0.0),
        margin=data.get("margin", 0.0),
        margin_free=data.get("marginFree", 0.0),
    )


async def get_positions(login: int) -> tuple[list[PositionRsp], str]:
    """读取持仓列表。返回 (列表, 错误信息)。"""
    data = await _post("/positions", {"login": login})
    if not data.get("ok"):
        return [], data.get("error", "unknown")
    positions = []
    for p in data.get("positions", []):
        positions.append(PositionRsp(
            ticket=p.get("ticket", 0),
            symbol=p.get("symbol", ""),
            side=p.get("side", ""),
            volume=p.get("volume", 0.0),
            price_open=p.get("priceOpen", 0.0),
            price_current=p.get("priceCurrent", 0.0),
            stop_loss=p.get("stopLoss", 0.0),
            take_profit=p.get("takeProfit", 0.0),
            profit=p.get("profit", 0.0),
            comment=p.get("comment", ""),
        ))
    return positions, ""


async def get_deals(login: int, from_unix: int, to_unix: int) -> tuple[list[DealRsp], str]:
    """读取一段时间内的成交历史。返回 (列表, 错误信息)。

    时间参数是 Unix 秒（UTC），Manager API 直接按 UTC 秒解读——不存在 Bridge
    那侧用 MetaTrader5 Python 包时必须换算服务器本地时区的陷阱。
    """
    data = await _post("/deals", {"login": login, "from": from_unix, "to": to_unix})
    if not data.get("ok"):
        return [], data.get("error", "unknown")
    deals = []
    for d in data.get("deals", []):
        deals.append(DealRsp(
            ticket=d.get("ticket", 0),
            position_id=d.get("positionId", 0),
            symbol=d.get("symbol", ""),
            action=d.get("action", 0),
            entry=d.get("entry", 0),
            volume=d.get("volume", 0.0),
            price=d.get("price", 0.0),
            profit=d.get("profit", 0.0),
            commission=d.get("commission", 0.0),
            storage=d.get("storage", 0.0),
            time=d.get("time", 0),
            comment=d.get("comment", ""),
        ))
    return deals, ""


async def trade_open(
    login: int, symbol: str, side: str, volume: float,
    stop_loss: float = 0, take_profit: float = 0, tag: str = "",
) -> TradeRsp:
    """市价开仓。"""
    data = await _post("/trade/open", {
        "login": login,
        "symbol": symbol,
        "side": side.upper(),
        "volume": volume,
        "stopLoss": stop_loss,
        "takeProfit": take_profit,
        "tag": tag,
    })
    return TradeRsp(
        ok=data.get("ok", False),
        retcode=str(data.get("retcode", "")),
        message=data.get("message", ""),
        deal=data.get("deal", 0),
        order=data.get("order", 0),
        price=data.get("price", 0.0),
    )


async def trade_close(login: int, ticket: int, volume: float = 0, tag: str = "") -> TradeRsp:
    """平仓（volume=0 全平）。"""
    data = await _post("/trade/close", {
        "login": login,
        "ticket": ticket,
        "volume": volume,
        "tag": tag,
    })
    return TradeRsp(
        ok=data.get("ok", False),
        retcode=str(data.get("retcode", "")),
        message=data.get("message", ""),
        deal=data.get("deal", 0),
        order=data.get("order", 0),
        price=data.get("price", 0.0),
    )


async def trade_modify(login: int, ticket: int, sl: float = 0, tp: float = 0) -> TradeRsp:
    """改 SL/TP（传 0 表示清除该项）。"""
    data = await _post("/trade/modify", {
        "login": login,
        "ticket": ticket,
        "stopLoss": sl,
        "takeProfit": tp,
    })
    return TradeRsp(
        ok=data.get("ok", False),
        retcode=str(data.get("retcode", "")),
        message=data.get("message", ""),
        deal=data.get("deal", 0),
        order=data.get("order", 0),
        price=data.get("price", 0.0),
    )


async def get_quote(symbol: str) -> tuple[float, float, str]:
    """取报价。返回 (bid, ask, 错误信息)。"""
    data = await _post("/quote", {"symbol": symbol})
    if not data.get("ok"):
        return 0, 0, data.get("error", "unknown")
    return data.get("bid", 0), data.get("ask", 0), ""


async def health_check() -> dict:
    """探活。"""
    try:
        url = settings.GATEWAY_URL.rstrip("/") + "/health"
        async with httpx.AsyncClient(timeout=httpx.Timeout(5)) as client:
            resp = await client.get(url)
            return resp.json()
    except Exception as e:
        return {"ok": False, "error": str(e)}


# ---------- 在线状态缓存 ----------
# Gateway 账号没有 bridge 心跳，在线与否取决于 gateway 服务本身是否可达。
# 列账号是高频操作，每次都发 HTTP 探活不合理，这里做 TTL 缓存。
# Gateway accounts have no bridge heartbeat; liveness depends on the gateway
# service itself. Account listing is frequent, so cache the probe result.
_HEALTH_TTL_SECONDS = 10
_health_cache: dict = {"at": 0.0, "online": False}


def is_gateway_online() -> bool:
    """Gateway 是否可达（带 10 秒缓存）。同步接口，供 serializer 调用。"""
    import asyncio
    import time

    now = time.monotonic()
    if now - _health_cache["at"] < _HEALTH_TTL_SECONDS:
        return _health_cache["online"]

    try:
        rsp = asyncio.run(health_check())
        online = bool(rsp.get("ok")) and bool(rsp.get("mt5Connected"))
    except Exception:
        online = False

    _health_cache["at"] = now
    _health_cache["online"] = online
    return online
