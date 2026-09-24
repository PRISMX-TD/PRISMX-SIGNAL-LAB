"""Gateway HTTP 客户端：调用 C# MT5 Gateway 的 REST 接口。

Gateway 跑在 MT5 服务器本地，只监听 127.0.0.1，通过 X-Gateway-Token 鉴权。
后端通过这个客户端直接操作 MT5 账号，不需要 bridge 轮询。
"""

import asyncio
import logging
import time
from dataclasses import dataclass
from typing import Optional

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


# 只读接口（资金 / 持仓 / 挂单）的时限。
#
# 以前这些调用不传时限，落到客户端默认的 60 秒。它们大多由后台轮询发起，而轮询是
# 「一轮等所有人做完再睡」的节奏——网关那边一次读取卡住（查询连接半开、券商慢），
# 这一轮就被拖满 60 秒，**所有**网关用户的持仓与浮盈一起冻住。正常读取是几百毫秒，
# 15 秒已经是它的几十倍；到点就放弃，这一拍保留上一次的数据，下一拍再读。
# Read-only calls (funds / positions / pending orders). They used to fall through to
# the client's 60s default; one stuck read then held a whole polling round — and
# every gateway user's positions with it — for a minute. Healthy reads take a few
# hundred ms; give up at 15s and keep the previous snapshot until the next tick.
READ_TIMEOUT = 15.0
# 成交历史读取：首扫会回看 7 天甚至一年，比单纯读持仓重，单独放宽。
# Deal history: first scans look back a week or a year, so allow more.
DEALS_READ_TIMEOUT = 30.0


def _timeout(total: float) -> httpx.Timeout:
    """读写按调用给的时限；建连单独只给 5 秒。

    整体一个数的时候，建连也要等满 60 秒：隧道断了、网关没起来，一笔单要干等
    一分钟才知道「根本没连上」。连不上是可以马上确定的事，没必要陪着等 dealer
    的时限。池等待给 10 秒：排不到连接说明这边已经堵死，早点报出来。
    Read/write use the caller's budget; connecting gets 5s on its own. With a
    single number, a dead tunnel cost the full 60s just to learn nothing connected.
    """
    return httpx.Timeout(total, connect=5.0, pool=10.0)

_client: Optional[httpx.AsyncClient] = None


def init_client() -> None:
    """在 lifespan 启动时初始化连接池单例。只调用一次。"""
    global _client
    if _client is not None:
        return
    _client = httpx.AsyncClient(
        timeout=_timeout(60.0),
        # 只重试「连不上」（请求还没发出去），对下单 POST 也安全：隧道闪断或网关
        # 刚重启时，第一次建连失败不必直接判失败。
        # Retries connect failures only (nothing sent yet), so it's safe for trade
        # POSTs: a tunnel blip or fresh gateway restart needn't fail the first try.
        transport=httpx.AsyncHTTPTransport(retries=1),
        # 连接数要跟得上网关的并发上限（gateway.ini 的 http_max_concurrent，默认
        # 256）：每笔在途交易最长占一条连接 65 秒，原来的 20 条在一波行情里先于网关
        # 排满，后面的单只能在这里干等。常驻 64 条，省掉高峰时重新握手的时间。
        # Must keep pace with the gateway's http_max_concurrent (256): each in-flight
        # trade holds a connection for up to 65s, and the old 20 filled up before the
        # gateway did. 64 kept alive so a burst skips the reconnect handshake.
        limits=httpx.Limits(
            max_keepalive_connections=64,
            max_connections=256,
            # 比网关侧 HTTP.sys 的空闲回收更早放手，少撞「对面已关、这边还当好的」连接。
            # Released before the gateway side idles it out, so fewer dead sockets get reused.
            keepalive_expiry=15.0,
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
    # 网关按 clientOrderId 回放的缓存结果（同一笔请求第二次问）。旧网关没有这个
    # 字段，缺省 False。
    # True when the gateway replayed a cached result for this clientOrderId.
    replayed: bool = False
    # 传输层错误分类（_post 的 error 字段）："timeout" 表示网关没在时限内回话——
    # 请求可能已经执行，调用方必须用同一 clientOrderId 再问一次而不是当作拒绝。
    # Transport-level error class from _post; "timeout" means the gateway may have
    # executed the request, so the caller must re-ask with the same clientOrderId.
    error: str = ""
    # 网关侧耗时（毫秒）：整个开仓/平仓调用，以及其中等券商 dealer 回执的部分。
    # 2026-09-14 起网关随回执返回；只进日志，不落库。旧网关没有这两个字段，缺省 0。
    # Gateway-side timings in ms: the whole call and the dealer wait within it.
    # Returned by the gateway since 2026-09-14; logged only. Older gateways omit them.
    elapsed_ms: int = 0
    dealer_ms: int = 0


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
    # 券商记录的「上次改密码时间」（Unix 秒）。绑定时存下来，之后每轮资金刷新
    # 比对，对不上说明密码变了、这次绑定的授权已经作废。
    # 0 = 网关没给（旧版网关）或券商服务器没填这个字段——调用方必须把 0 当成
    # 「没有信号」，绝不能当成「时间是 0」去比对，否则所有账号一上来就被撤销。
    # Broker-recorded last-password-change time (unix seconds); 0 means no signal
    # (old gateway, or the server doesn't fill the field) and must never be
    # compared as a real value — see routers/gateway.py.
    last_pass_change: int = 0
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
    # 见 VerifyRsp.last_pass_change：0 表示「没有信号」，不是一个可比对的时间。
    # See VerifyRsp.last_pass_change: 0 means "no signal", not a comparable time.
    last_pass_change: int = 0


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
class PendingOrderRsp:
    """一张挂在券商服务器上的挂单。字段与 gateway 的 OrderInfo 对应。

    `type` 是 MT5 的订单类型原值（CIMTOrder.EnOrderType）：2=BUY_LIMIT、3=SELL_LIMIT、
    4=BUY_STOP、5=SELL_STOP。转成名字在 routers/gateway 做，这里保持与网关同形。
    A pending order living at the broker. `type` is MT5's raw order type
    (2=BUY_LIMIT, 3=SELL_LIMIT, 4=BUY_STOP, 5=SELL_STOP); naming happens in the
    router so this stays shaped like the gateway's own payload.
    """

    ticket: int
    symbol: str
    type: int
    volume: float
    price_order: float
    stop_loss: float
    take_profit: float
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
    # 网关新版才有：成交原因（Manager API 枚举原值，-1 = 旧网关没给）、平仓时刻的
    # 止损止盈（0 = 无）。/ Newer gateways only: reason enum (-1 = absent), SL/TP at close.
    reason: int = -1
    sl: float = 0.0
    tp: float = 0.0


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
                    timeout=_timeout(timeout),
                )
            else:
                resp = await _client.post(url, json=body, headers=_headers())
        else:
            async with httpx.AsyncClient(timeout=_timeout(timeout or 60)) as client:
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


async def verify_account(login: int, password: str) -> VerifyRsp:
    """验证 MT5 账号**主密码**（用户绑定账号时用）。

    没有「用投资者密码验」这个选项，这是有意的：投资者密码在券商侧是只读凭证，
    而 gateway 绑定成功后所有操作都走 manager、不再校验任何密码——用它绑定等于
    把「只能看」当场换成「能下单」。这个开关以前存在，且由 HTTP 请求体直接控制。

    Main password only, deliberately: the investor password is a read-only
    credential at the broker, but nothing after a successful bind re-checks any
    password, so binding with it would upgrade read-only access to order
    placement. This used to be a request-body flag.
    """
    data = await _post("/verify", {"login": login, "password": password})
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
        last_pass_change=int(data.get("lastPassChange", 0) or 0),
        error=str(data.get("error", "")),
        message=str(data.get("message", "")),
        status=int(data.get("status", 0) or 0),
    )


async def get_account(login: int, timeout: float = READ_TIMEOUT) -> AccountRsp | None:
    """读取账号资金信息。"""
    data = await _post("/account", {"login": login}, timeout=timeout)
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
        last_pass_change=int(data.get("lastPassChange", 0) or 0),
    )


async def get_positions(login: int, timeout: float = READ_TIMEOUT) -> tuple[list[PositionRsp], str]:
    """读取持仓列表。返回 (列表, 错误信息)。"""
    data = await _post("/positions", {"login": login}, timeout=timeout)
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


async def get_pending_orders(login: int, timeout: float = READ_TIMEOUT) -> tuple[list[PendingOrderRsp], str]:
    """读取该账号挂在券商服务器上的挂单列表。返回 (列表, 错误信息)。

    与持仓不同，这里**不按 comment 前缀过滤**：gateway 账号没有 MT5 客户端，
    这条通道上的挂单只可能是平台下的。桥接那侧仍按魔术号过滤（见
    mt5_worker._pending_orders_payload），因为那边用户真的能在客户端里自己挂单。
    Unlike bridge accounts there is no comment/magic filter here: a gateway account
    has no MT5 client, so every order on this channel was placed by the platform.
    """
    data = await _post("/orders", {"login": login}, timeout=timeout)
    if not data.get("ok"):
        return [], data.get("error", "unknown")
    return [
        PendingOrderRsp(
            ticket=o.get("ticket", 0),
            symbol=o.get("symbol", ""),
            type=o.get("type", 0),
            volume=o.get("volume", 0.0),
            price_order=o.get("priceOrder", 0.0),
            stop_loss=o.get("stopLoss", 0.0) or 0.0,
            take_profit=o.get("takeProfit", 0.0) or 0.0,
            comment=o.get("comment", ""),
        )
        for o in data.get("orders", [])
    ], ""


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


async def get_deals(
    login: int, from_unix: int, to_unix: int, timeout: float = DEALS_READ_TIMEOUT,
) -> tuple[list[DealRsp], str]:
    """读取一段时间内的成交历史。返回 (列表, 错误信息)。

    ⚠️ 时间参数与返回的 DealRsp.time **都在券商服务器墙钟的参照系里，不是 UTC**
    （本券商 +3 小时）。这里原样透传、不做任何换算；换算在 routers/gateway.py：
    观测用 observe_server_offset()，落库在 build_closed_trade_legs() 里减掉偏移。

    这段注释此前写的是「Manager API 直接按 UTC 秒解读，不存在 Bridge 那侧的
    陷阱」——那句话是错的，2026-09-05 被一笔漂进别场比赛的平仓证伪（踩坑 #63）。
    留着它的代价不是看着别扭，而是下一个人据此把换算拆掉。

    Both the query bounds and DealRsp.time live in the broker server's wall-clock
    frame, not UTC (+3h for this broker). This function passes them through
    untouched; conversion happens in routers/gateway.py. The previous claim that
    "Manager API reads plain UTC seconds" was wrong and was disproved in
    production on 2026-09-05.
    """
    data = await _post("/deals", {"login": login, "from": from_unix, "to": to_unix}, timeout=timeout)
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
            reason=d.get("reason", -1),
            sl=d.get("sl", 0.0) or 0.0,
            tp=d.get("tp", 0.0) or 0.0,
        ))
    return deals, ""


def _trade_rsp(data: dict) -> TradeRsp:
    return TradeRsp(
        ok=data.get("ok", False),
        retcode=str(data.get("retcode", "")),
        message=data.get("message", ""),
        deal=data.get("deal", 0),
        order=data.get("order", 0),
        price=data.get("price", 0.0),
        position=data.get("position", 0) or 0,
        replayed=bool(data.get("replayed", False)),
        error=str(data.get("error", "") or ""),
        elapsed_ms=int(data.get("elapsedMs", 0) or 0),
        dealer_ms=int(data.get("dealerMs", 0) or 0),
    )


async def trade_open(
    login: int, symbol: str, side: str, volume: float,
    stop_loss: float = 0, take_profit: float = 0, tag: str = "",
    client_order_id: str = "", timeout: float | None = None,
) -> TradeRsp:
    """市价开仓。

    `client_order_id` 是幂等键：网关对同一 (login, clientOrderId) 只执行一次，重复
    请求回放缓存结果（见 gateway/Idempotency.cs）。`tag` 仍然照旧写进 comment。
    `client_order_id` is the idempotency key — the gateway executes one
    (login, clientOrderId) once and replays the cached result after that.
    """
    data = await _post("/trade/open", {
        "login": login,
        "symbol": symbol,
        "side": side.upper(),
        "volume": volume,
        "stopLoss": stop_loss,
        "takeProfit": take_profit,
        "tag": tag,
        "clientOrderId": client_order_id,
    }, timeout=timeout)
    return _trade_rsp(data)


async def trade_pending(
    login: int, symbol: str, order_type: str, volume: float, price: float,
    stop_loss: float = 0, take_profit: float = 0, tag: str = "",
    client_order_id: str = "", timeout: float | None = None,
) -> TradeRsp:
    """挂单（限价 / 止损）。`order_type` 是 BUY_LIMIT / SELL_LIMIT / BUY_STOP / SELL_STOP。

    回执里的 `order` 是券商给的挂单票号——撤单、以及把这条指令与挂单列表对上，
    靠的都是它。`deal` / `price` 在挂单成功时为 0：还没有成交。
    `client_order_id` 的幂等语义同 trade_open：重复请求不会挂出第二张单。
    The receipt's `order` is the broker's ticket for the new pending order (the
    handle for cancelling it and for matching it against the orders list); `deal`
    and `price` are 0 because nothing filled. Idempotency works as in trade_open.
    """
    data = await _post("/trade/pending", {
        "login": login,
        "symbol": symbol,
        "type": order_type.upper(),
        "volume": volume,
        "price": price,
        "stopLoss": stop_loss,
        "takeProfit": take_profit,
        "tag": tag,
        "clientOrderId": client_order_id,
    }, timeout=timeout)
    return _trade_rsp(data)


async def trade_modify_pending(
    login: int, ticket: int, price: float | None = None,
    sl: float | None = None, tp: float | None = None,
    client_order_id: str = "", timeout: float | None = None,
) -> TradeRsp:
    """改挂单的触发价 / 止损 / 止盈。三项都是 None = 保留现值；SL/TP 传 0 = 清除。

    与 trade_modify 同一套「null ≠ 0」的语义，理由见那边的注释——这里更要紧：
    图表上拖一条线只改一项，另外两项必须原样留着。
    Same "null is not 0" contract as trade_modify, and it matters more here: dragging
    one line on the chart changes one field and the other two must survive untouched.
    """
    data = await _post("/trade/modify-pending", {
        "login": login,
        "ticket": ticket,
        "price": price,
        "stopLoss": sl,
        "takeProfit": tp,
        "clientOrderId": client_order_id,
    }, timeout=timeout)
    return _trade_rsp(data)


async def trade_cancel(
    login: int, ticket: int, client_order_id: str = "", timeout: float | None = None,
) -> TradeRsp:
    """撤销一张挂单（按券商票号）。`client_order_id` 的幂等语义同 trade_open。"""
    data = await _post("/trade/cancel", {
        "login": login,
        "ticket": ticket,
        "clientOrderId": client_order_id,
    }, timeout=timeout)
    return _trade_rsp(data)


async def trade_close(
    login: int, ticket: int, volume: float = 0, tag: str = "",
    client_order_id: str = "", timeout: float | None = None,
) -> TradeRsp:
    """平仓（volume=0 全平）。`client_order_id` 语义同 trade_open。"""
    data = await _post("/trade/close", {
        "login": login,
        "ticket": ticket,
        "volume": volume,
        "tag": tag,
        "clientOrderId": client_order_id,
    }, timeout=timeout)
    return _trade_rsp(data)


async def trade_modify(
    login: int, ticket: int, sl: float | None = None, tp: float | None = None,
    timeout: float | None = None,
) -> TradeRsp:
    """改 SL/TP。0 = 清除该项；None 发成 JSON null = 网关保留仓位上的现值。

    两者必须分开。以前签名是 `sl: float = 0, tp: float = 0`，调用方再 `order.tp or 0`
    ——于是一条只带止损的改单（自动仓管的保本 / 追踪止损就是这种形状）到网关就成了
    takeProfit=0，而网关对 0 的处理是清除：用户的止盈被顺手抹掉。桥接通道
    （routers/bridge.py 的 MODIFY 分支）早就是发 null，这里对齐。
    Modify SL/TP. 0 clears a side; None goes out as JSON null and the gateway keeps
    the position's current value. Previously both defaulted to 0 and callers wrote
    `order.tp or 0`, so a stop-only modify (exactly what auto-management sends)
    reached the gateway as takeProfit=0 — which it treats as "clear". The bridge
    channel (routers/bridge.py MODIFY) already sends null; this matches it.
    """
    data = await _post("/trade/modify", {
        "login": login,
        "ticket": ticket,
        "stopLoss": sl,
        "takeProfit": tp,
    }, timeout=timeout)
    # 走 _trade_rsp 才带得上 error 字段：以前这里手拼 TradeRsp、丢了 error，
    # 网关超时于是被当成普通失败落成 REJECTED，而改单其实可能已经生效。
    # _trade_rsp keeps the error field; the hand-built TradeRsp dropped it, so a
    # gateway timeout landed as REJECTED although the modify may have applied.
    return _trade_rsp(data)


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

# 后台探活的间隔与"探活结果还算新鲜"的上限。
#
# 以前在线状态是**请求线程里现探**的：TTL 一过，下一个来列账号 / 下单的请求就在
# 自己的线程里发一次 /health 并干等（最长 5 秒），期间还攥着一条数据库连接；而探活
# 没有"同一时刻只探一次"，网关一慢，每个并发请求各探一次，同步线程与连接池被一起
# 拖满，前端随之报"无法连接到服务器"——网关抖一下，整站跟着抖。
# 现在由每个 worker 上的一条后台协程定时探活，请求线程只读缓存、从不阻塞。
#
# Background probe cadence and how old a probe result may get before it's no
# longer trusted. Liveness used to be probed inline: once the TTL lapsed, the next
# request probed /health on its own thread and waited (up to 5s) while holding a DB
# connection, with no single-flight — a slow gateway made every concurrent request
# probe at once and starved the sync pool and the DB pool. Now one background task
# per worker probes on a timer and request threads only read the cache.
_HEALTH_PROBE_INTERVAL_SECONDS = 5.0
_HEALTH_MONITOR_STALE_SECONDS = 20.0

# 后台探活协程是否在跑。没在跑（单测、脚本）时退回旧的"请求里现探"。
# Whether the background monitor runs; without it (tests, scripts) fall back to
# the old inline probe.
_health_monitor_running = False


def _probe_ok(rsp: dict) -> bool:
    # dealerActive 也要算：连着但 dealer 通道没起来时，查得到持仓却一单都下不了，
    # 界面不该显示「在线」。旧网关没有这个字段，缺省按可用处理。
    # dealerActive counts too: connected without a dealer channel shows positions
    # but can't place a single order. Older gateways omit it; default to usable.
    return (
        bool(rsp.get("ok"))
        and bool(rsp.get("mt5Connected"))
        and bool(rsp.get("dealerActive", True))
    )


def _online_at(now: float) -> bool:
    """按最近一次成功探活算在线：宽限期内都算。

    ok_at > 0 的判断不能省：进程刚起来时 ok_at 还是 0，而 monotonic() 的起点因平台
    而异，可能恰好小于宽限期，那样会在从未成功探活过的情况下报「在线」。
    Online while within the grace period of the last successful probe. The
    ok_at > 0 check matters: monotonic()'s origin is platform-dependent, so without
    it a never-probed process could report online.
    """
    ok_at = _health_cache["ok_at"]
    return ok_at > 0.0 and now - ok_at < _HEALTH_GRACE_SECONDS


def _record_probe(ok: bool, now: float, detail: str = "") -> bool:
    """记下一次探活结果，返回据此判定的在线状态；状态翻转时记一行日志。

    这行日志是排查「用户说连接不稳定」的第一手证据：以前在线判定翻来翻去一个字
    都不留，只能靠用户描述猜是网关、隧道还是前端。
    Record one probe and return the resulting verdict, logging on every flip — the
    first-hand evidence when users report instability, which used to leave no trace.
    """
    was = _health_cache["online"]
    _health_cache["at"] = now
    if ok:
        _health_cache["ok_at"] = now
    online = _online_at(now)
    _health_cache["online"] = online
    if online != was:
        if online:
            logger.info("Gateway 在线状态 -> 在线 / gateway is online")
        else:
            ok_at = _health_cache["ok_at"]
            logger.warning(
                "Gateway 在线状态 -> 离线（%s没有成功探活，最近一次：%s）/ gateway is offline",
                "%.0f 秒" % (now - ok_at) if ok_at > 0.0 else "启动以来一直",
                detail or "unknown",
            )
    return online


def _describe_probe(rsp: dict) -> str:
    """探活失败时说明是哪一项不满足，写进状态翻转日志。/ Which condition failed."""
    if not rsp.get("ok"):
        return "不可达 unreachable: %s" % (rsp.get("error") or "no response")
    return "mt5Connected=%s dealerActive=%s" % (rsp.get("mt5Connected"), rsp.get("dealerActive"))


async def gateway_health_monitor_loop() -> None:
    """每个 worker 一条：定时探活网关，把结果写进在线缓存。

    不走 BackgroundLoops 的选主：is_gateway_online() 在每个 worker 的请求线程里都会
    被调用，每个 worker 都要有自己新鲜的缓存。探活本身只是一次轻量 GET（网关在接收
    线程上就地回答，不碰 MT5），多几个 worker 各探一次无所谓。
    One per worker: probe the gateway on a timer and feed the liveness cache. Not
    leader-elected — every worker's request threads read is_gateway_online(), so each
    needs a fresh cache; the probe is a cheap GET answered without touching MT5.
    """
    global _health_monitor_running
    _health_monitor_running = True
    try:
        while True:
            try:
                rsp = await health_check()
                ok = _probe_ok(rsp)
                _record_probe(ok, time.monotonic(), "" if ok else _describe_probe(rsp))
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("gateway 探活循环异常 / health monitor iteration failed")
            await asyncio.sleep(_HEALTH_PROBE_INTERVAL_SECONDS)
    finally:
        _health_monitor_running = False


def is_gateway_online() -> bool:
    """Gateway 是否可用（30 秒失败宽限）。同步接口，供 serializer 调用。

    后台探活在跑时只读缓存，绝不阻塞请求线程。缓存太旧（探活协程停了、主循环卡住）
    或根本没有后台探活（单测、脚本）时，退回旧的"10 秒 TTL + 现探"。
    Reads the cache while the background monitor runs — never blocks a request thread.
    Falls back to the old "10s TTL + inline probe" when the cache is stale or there
    is no monitor (tests, scripts).
    """
    now = time.monotonic()
    at = _health_cache["at"]
    if _health_monitor_running and at > 0.0 and now - at < _HEALTH_MONITOR_STALE_SECONDS:
        return _online_at(now)

    if now - at < _HEALTH_TTL_SECONDS:
        return _online_at(now)

    try:
        rsp = run_on_main_loop(health_check(), timeout=5.0)
        ok = _probe_ok(rsp)
        detail = "" if ok else _describe_probe(rsp)
    except Exception as e:
        ok = False
        detail = "探活超时或异常 probe failed: %s" % e

    return _record_probe(ok, now, detail)
