"""Gateway HTTP 客户端：调用 C# MT5 Gateway 的 REST 接口。

Gateway 跑在 MT5 服务器本地，只监听 127.0.0.1，通过 X-Gateway-Token 鉴权。
后端通过这个客户端直接操作 MT5 账号，不需要 bridge 轮询。
"""

import asyncio
import logging
import time
from dataclasses import dataclass
from typing import Any, Optional

import httpx

from app.core.config import settings

logger = logging.getLogger("prismx.gateway")

# ---------- 主事件循环引用与跨线程提交 ----------

_main_loop: Optional[asyncio.AbstractEventLoop] = None


def set_main_loop(loop: asyncio.AbstractEventLoop) -> None:
    """在 lifespan 启动时捕获主事件循环。只调用一次。"""
    global _main_loop
    _main_loop = loop
    logger.info("Gateway 客户端已捕获主事件循环")


def run_on_main_loop(coro, timeout: float):
    """从线程池线程把协程提交到主事件循环并等结果。
    
    用于从同步端点（orders.py 的 def 函数）调用异步 gateway 客户端。
    替代 asyncio.run()，后者每次创建新循环且无法复用连接池。
    
    未捕获到主循环时（单测/脚本场景）退回 asyncio.run()。
    
    Args:
        coro: 协程对象
        timeout: 超时秒数，必须显式传入。协程排在主循环上，无超时会挂死线程。
    
    Returns:
        协程的返回值
    
    Raises:
        TimeoutError: 超时
        Exception: 协程内部抛出的异常会原样传播
    """
    if _main_loop is None:
        logger.warning("主事件循环未捕获，退回 asyncio.run()")
        return asyncio.run(coro)
    
    future = asyncio.run_coroutine_threadsafe(coro, _main_loop)
    try:
        return future.result(timeout=timeout)
    except TimeoutError:
        logger.error("Gateway 调用超时 (%.1fs)：协程可能仍在主循环中排队", timeout)
        raise


# ---------- httpx 连接池单例 ----------

_client: Optional[httpx.AsyncClient] = None


def init_client() -> None:
    """在 lifespan 启动时初始化连接池单例。只调用一次。"""
    global _client
    if _client is not None:
        return
    _client = httpx.AsyncClient(
        timeout=httpx.Timeout(60.0),
        limits=httpx.Limits(
            max_keepalive_connections=10,
            max_connections=20,
            keepalive_expiry=30.0,
        ),
    )
    logger.info("Gateway 客户端连接池已初始化")


async def close_client() -> None:
    """在 lifespan 关闭时清理连接池。"""
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None
        logger.info("Gateway 客户端连接池已关闭")

# ---------- 数据结构 ----------


@dataclass
class TradeRsp:
    ok: bool
    retcode: str
    message: str
    deal: int  # deal ticket
    order: int  # order ticket
    price: float
    # 真实仓位号，开仓时由 gateway 反查后返回；平仓/改单为 0。
    # 旧版 gateway 不返回这个字段，缺省 0 时退化成旧行为。
    # Real position id, resolved by the gateway on open (0 for close/modify).
    # Older gateways omit the field; defaulting to 0 keeps the old behaviour.
    position: int = 0


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
    # ok=False 时的失败原因。error 是 gateway 的错误码（group_not_allowed、
    # MTRetCode 名、timeout…），status 是它的 HTTP 状态码（0 表示压根没连上）。
    # 调用方靠这两个字段区分「网关真的挂了」和「网关明确拒绝了这个账号」。
    # Failure detail when ok=False: the gateway's error code and HTTP status
    # (0 = never reached it). Lets callers tell an outage from a refusal.
    error: str = ""
    message: str = ""
    status: int = 0


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


@dataclass
class PositionEvent:
    """持仓变化事件。来自 gateway 的持仓订阅（PositionSubscribe）。

    券商只推 ADD/DELETE 不推 UPDATE（已用探针确认），因此开/平仓即时推送，
    浮盈变化仍靠轮询。
    """

    login: int
    ticket: int
    action: str  # "add" 或 "delete"


# ---------- 客户端 ----------


def _headers() -> dict:
    return {
        "X-Gateway-Token": settings.GATEWAY_TOKEN,
        "Content-Type": "application/json",
    }


async def _post(path: str, body: dict, timeout: float | None = None) -> dict:
    """POST 到 gateway，返回 JSON dict。

    复用模块级连接池单例，省掉每次请求的 TCP 握手——后端与 gateway 跨公网
    通信，握手开销是一整个 RTT。单例未初始化时（单测场景）临时建一个。

    Reuses the module-level pooled client so each call skips the TCP handshake;
    the backend talks to the gateway across the public internet, where that
    handshake costs a full RTT. Falls back to a temporary client when the
    singleton isn't initialised (unit tests).
    """
    url = settings.GATEWAY_URL.rstrip("/") + path
    started = time.perf_counter()
    try:
        if _client is not None:
            # 不传 timeout 时必须**省略**这个参数，不能传 None：httpx 里显式传
            # None 表示「永不超时」，而不是「用客户端的默认值」。传了 None 会让
            # 持仓读取这类没指定超时的调用挂死，慢拍拿不到结果就推空列表，
            # 前端持仓表随即被整表替换成空 —— 表现为每 2 秒闪一次。
            #
            # Omit the argument entirely when no timeout is given: in httpx an
            # explicit None means "wait forever", not "fall back to the client
            # default". Passing None let position reads hang, and a hung read
            # makes the slow tick push an empty list, which the frontend applies
            # as a full replacement.
            if timeout is not None:
                resp = await _client.post(
                    url, json=body, headers=_headers(),
                    timeout=httpx.Timeout(timeout),
                )
            else:
                resp = await _client.post(url, json=body, headers=_headers())
        else:
            async with httpx.AsyncClient(timeout=httpx.Timeout(timeout or 60)) as client:
                resp = await client.post(url, json=body, headers=_headers())
        resp.raise_for_status()
        data = resp.json()
        # 耗时日志：用于度量连接池与 gateway 侧缓存的收益。debug 级别，
        # 平时不刷日志，排查性能时打开即可。
        logger.debug("Gateway %s 耗时 %.1fms", path, (time.perf_counter() - started) * 1000)
        return data
    except httpx.TimeoutException:
        logger.error("Gateway 超时 (%.1fms): %s", (time.perf_counter() - started) * 1000, url)
        return {"ok": False, "error": "timeout", "message": "Gateway 响应超时", "status": 0}
    except httpx.HTTPStatusError as e:
        logger.error("Gateway HTTP %s: %s %s", e.response.status_code, url, e.response.text[:300])
        # gateway 的 4xx 不是「网关坏了」，是有结构的业务拒绝：组不在白名单
        # (403 group_not_allowed)、账号不存在(404 + MTRetCode)、token 不对
        # (401)。把响应体原样带回给调用方，否则这些全部退化成同一句
        # 「Gateway 不可用」，用户看到的和真正断线时一模一样，排查只能靠翻日志。
        #
        # A 4xx from the gateway is a structured refusal, not an outage: group not
        # whitelisted, account missing, bad token. Carry the body through — folding
        # them all into one "gateway unavailable" makes a policy refusal
        # indistinguishable from a real outage at the UI.
        out = {
            "ok": False,
            "error": "http_error",
            "message": str(e),
            "status": e.response.status_code,
        }
        try:
            body = e.response.json()
            if isinstance(body, dict):
                out.update(body)
                # 网关体里的 ok 必定是 false，但状态码只有这里知道，别被 update 覆盖
                out["ok"] = False
                out["status"] = e.response.status_code
        except Exception:
            pass
        return out
    except Exception as e:
        logger.error("Gateway 请求失败: %s %s", url, e)
        return {"ok": False, "error": "request_failed", "message": str(e), "status": 0}


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
        error=str(data.get("error", "")),
        message=str(data.get("message", "")),
        status=int(data.get("status", 0) or 0),
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


async def drain_position_events() -> tuple[list[PositionEvent], bool]:
    """取走 gateway 订阅积压的开/平仓事件。返回 (事件列表, 订阅是否可用)。

    这是「开平仓要等一整个轮询周期才被发现」的解法：MT5 服务器在仓位建立或
    关闭的瞬间就回调 gateway，gateway 把事件排进队列，这里取到即可立刻推前端。

    注意语义是「取走」：一次调用清空队列，同一个事件不会返回两次，所以整个
    后端只能有一个消费者（gateway_positions_loop 那一个循环）。

    券商只推 ADD/DELETE 不推 UPDATE（已用探针确认），因此浮盈仍靠轮询。
    订阅不可用时返回 ([], False)，调用方退回纯轮询，行为与改动前一致。

    超时取 5 秒而不是 _post 的 60 秒：这个调用在每轮的最前面，卡住会把整轮
    持仓推送一起拖住。宁可这轮丢掉事件（轮询兜底会补上），也不要拖慢所有人。
    """
    url = settings.GATEWAY_URL.rstrip("/") + "/position-events"
    try:
        if _client is not None:
            resp = await _client.get(url, headers=_headers(), timeout=httpx.Timeout(5))
        else:
            async with httpx.AsyncClient(timeout=httpx.Timeout(5)) as client:
                resp = await client.get(url, headers=_headers())
        resp.raise_for_status()
        data = resp.json()
    except Exception as e:
        # 降级为 debug：gateway 短暂不可达时轮询仍在工作，不该刷 error 日志
        logger.debug("Gateway 持仓事件读取失败: %s", e)
        return [], False

    if not data.get("ok"):
        return [], False

    events = []
    for e in data.get("events", []):
        login = e.get("login", 0)
        action = e.get("action", "")
        if not login or action not in ("add", "delete"):
            continue
        events.append(PositionEvent(
            login=int(login),
            ticket=int(e.get("ticket", 0)),
            action=action,
        ))

    return events, bool(data.get("subscribed"))


async def drain_deal_events() -> tuple[list[int], bool]:
    """取走 gateway 订阅积压的成交事件。返回 (发生了成交的 login 列表, 订阅是否可用)。

    与 drain_position_events 同构，但**只返回 login，不返回成交明细**。

    事件在这里的角色是"门铃"而不是数据通道：收到就立刻去跑那套已有的平仓扫描
    （它自带 15 分钟回看窗、按仓位号归因、部分平仓按手数分摊手续费与隔夜费）。
    把金额字段从订阅这条路搬过来，等于把那套口径重新实现一遍，两份实现迟早不一致。

    同一个 login 在一批里可能出现多次（一次平仓产生多笔成交），调用方按 login
    去重后每个只触发一次扫描即可——扫描本身是按时间窗拉取的，不是按成交号。

    语义同样是"取走"：一次调用清空队列，所以整个后端只能有一个消费者。

    Mirrors drain_position_events but returns only logins, never deal details.
    An event is a doorbell: it triggers the existing closed-trade scan, which owns
    the 15-minute lookback, position-id attribution and the per-lot allocation of
    commission and swap across partial closes. Carrying the money fields over this
    channel would duplicate those rules and inevitably drift from them.
    """
    url = settings.GATEWAY_URL.rstrip("/") + "/deal-events"
    try:
        if _client is not None:
            resp = await _client.get(url, headers=_headers(), timeout=httpx.Timeout(5))
        else:
            async with httpx.AsyncClient(timeout=httpx.Timeout(5)) as client:
                resp = await client.get(url, headers=_headers())
        resp.raise_for_status()
        data = resp.json()
    except Exception as e:
        logger.debug("Gateway 成交事件读取失败: %s", e)
        return [], False

    if not data.get("ok"):
        return [], False

    logins: list[int] = []
    seen: set[int] = set()
    for e in data.get("events", []):
        login = e.get("login", 0)
        if not login or login in seen:
            continue
        seen.add(int(login))
        logins.append(int(login))

    return logins, bool(data.get("subscribed"))


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
        position=data.get("position", 0) or 0,
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
        if _client is not None:
            resp = await _client.get(url, timeout=httpx.Timeout(5))
        else:
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

# 探活失败后的宽限期。
#
# Bridge 账号的在线判定（deps.py 的 ONLINE_WINDOW）刻意留了约 3 个心跳周期的
# 容错，理由写在那儿：偶发丢包不该判成离线。Gateway 账号这边此前**一次容错都
# 没有**——一次探活失败就直接置离线，而这条探活要跨公网到 Windows VPS，还要
# 经由 run_on_main_loop 排进主事件循环（那条循环同时在跑 2 秒持仓轮询和 0.25 秒
# 事件快拍，忙起来光排队就可能吃掉 5 秒超时）。结果是顶部状态徽标会无缘无故
# 闪成「未连接」，刷新一下又好了——因为一次失败会被 TTL 缓存钉住 10 秒。
#
# 30 秒配合 10 秒 TTL，意味着要连续两次探活都失败才真的判离线，与 bridge 那侧
# 「容忍 3 个周期」的取舍一致。代价是网关真的挂掉时，界面最多晚 30 秒变灰；
# 而这段时间里用户若去下单，会拿到明确的下单失败提示，不会被误导太久。
#
# Grace period after a failed probe. Bridge liveness deliberately tolerates ~3
# missed heartbeats (see ONLINE_WINDOW); gateway liveness tolerated nothing — a
# single failed probe flipped the badge to "disconnected" and the TTL then
# pinned that for 10s. The probe crosses the public internet and queues on the
# main event loop (busy with the 2s position tick and 0.25s event pump), so
# transient failures are expected. 30s means two consecutive failures are needed
# before reporting offline. Cost: a genuinely dead gateway takes up to 30s to
# show as offline, during which an order attempt fails with a clear error.
_HEALTH_GRACE_SECONDS = 30

# ok_at 是最近一次**成功**探活的时刻，与 at（最近一次探活的时刻，不论成败）分开。
# ok_at is the last *successful* probe; `at` is the last probe of any outcome.
_health_cache: dict = {"at": 0.0, "online": False, "ok_at": 0.0}


def is_gateway_online() -> bool:
    """Gateway 是否可达（10 秒缓存 + 30 秒失败宽限）。同步接口，供 serializer 调用。"""
    now = time.monotonic()
    if now - _health_cache["at"] < _HEALTH_TTL_SECONDS:
        return _health_cache["online"]

    try:
        rsp = run_on_main_loop(health_check(), timeout=5.0)
        ok = bool(rsp.get("ok")) and bool(rsp.get("mt5Connected"))
    except Exception:
        ok = False

    _health_cache["at"] = now

    if ok:
        _health_cache["ok_at"] = now
        _health_cache["online"] = True
    else:
        # 宽限期内沿用上一次的成功结果。ok_at > 0 的判断不能省：进程刚起来时
        # ok_at 还是 0，而 monotonic() 的起点因平台而异，可能恰好小于宽限期，
        # 那样会在从未成功探活过的情况下报「在线」。
        # The ok_at > 0 check matters: at startup ok_at is 0 and monotonic()'s
        # origin is platform-dependent, so without it a never-probed process
        # could report online.
        _health_cache["online"] = (
            _health_cache["ok_at"] > 0.0
            and now - _health_cache["ok_at"] < _HEALTH_GRACE_SECONDS
        )

    return _health_cache["online"]
