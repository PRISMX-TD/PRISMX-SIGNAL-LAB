"""下单前的交易时段闸门 / The market-hours gate in front of order placement.

为什么要有这一层（2026-10-25）：周末用户在平台下单，指令照样发到 MT5，dealer 把它挂成
一条「request adding」的待处理请求——既不成交也不拒绝，用户在 MT5 里看到一条自己删
不掉的东西。平台应当和 MT5 的交易时段对齐：MT5 不能交易的时候，平台就不让下单；周末
只有 7x24 的加密货币能下。

数据来源分两级：
1. 网关 `/symbol-sessions`：直接读 MT5 品种配置里的交易时段、假日表与 TradeMode，按
   服务器时间判「现在能不能开仓」、「下一次几点开盘」。这是和 MT5 **完全对齐**的真源。
2. 网关不可达 / 品种读不到时退回 candle_store 的固定周末日历（周五 21:00 → 周日 21:00
   UTC，BTCUSD / ETHUSD 豁免）。粗一点，但周末这个最主要的场景不会漏。

结果按品种缓存 30 秒：下单与前端的状态查询都走这里，不会每次都打一次网关。

Why this exists (2026-10-25): an order placed on a weekend still reaches MT5, where
the dealer parks it as a "request adding" request — neither filled nor rejected, and
the user cannot remove it. The platform must follow MT5's own trading hours: when MT5
cannot trade, the platform refuses the order; on weekends only 7x24 crypto trades.

Two sources: the gateway's /symbol-sessions (MT5's own trade sessions, holiday table
and TradeMode, judged in server time — the exact truth), falling back to the fixed
weekend calendar in candle_store when the gateway or the symbol is unavailable.
Results are cached per symbol for 30 seconds.
"""
import logging
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException

from app.core.config import settings
from app.services import gateway_client
from app.services.candle_store import WEEKEND_OPEN_HOUR_UTC, is_weekend_closed
from app.services.symbol_aliases import broker_symbol

logger = logging.getLogger("prismx.market_hours")

# 结果缓存时长。时段边界误差最多 30 秒，换来下单与状态查询不每次打网关。
# Cache TTL: at most 30s of boundary error, in exchange for not hitting the gateway
# on every order and status poll.
CACHE_TTL_SECONDS = 30.0

# 网关读交易时段的超时。下单端点在线程池里同步等它，不能太长；超时就退回日历。
# Timeout for the gateway read. The order endpoint waits synchronously in a worker
# thread, so keep it short and fall back to the calendar on expiry.
GATEWAY_TIMEOUT_SECONDS = 3.0

# 全站展示时区（与 api/utils fmtTime 一致）/ the site-wide display zone (UTC+8)
_DISPLAY_TZ = timezone(timedelta(hours=8))


@dataclass(frozen=True)
class MarketStatus:
    symbol: str
    open: bool
    # "gateway" = MT5 品种配置判定；"calendar" = 固定周末日历兜底
    # "gateway" = judged from MT5's symbol config; "calendar" = fixed weekend fallback
    source: str
    next_open_at: datetime | None
    checked_at: float
    # MT5 品种的 TradeMode（0 禁止 / 1 只多 / 2 只空 / 3 只平 / 4 全部）；日历兜底时为 None。
    # 只平（3）时网关的 openNow 一律是 False（不再看时段），平仓 / 改单 / 撤单的闸门要据此放行。
    # The symbol's MT5 TradeMode (0 disabled / 1 long only / 2 short only / 3 close only /
    # 4 full); None from the calendar. Under close-only the gateway reports openNow=False
    # without looking at sessions, so the manage gate must not refuse on that alone.
    trade_mode: int | None = None


_cache: dict[str, MarketStatus] = {}
_lock = threading.Lock()


def clear_cache() -> None:
    """单测用 / for tests."""
    with _lock:
        _cache.clear()


def _calendar_status(symbol: str, now: datetime | None = None) -> MarketStatus:
    """固定周末日历：周五 21:00 → 周日 21:00 UTC 休市，加密货币豁免（见 candle_store）。
    Fixed weekend calendar: closed Friday 21:00 → Sunday 21:00 UTC, crypto exempt."""
    now = now or datetime.now(timezone.utc)
    base = broker_symbol(symbol.strip().upper())
    closed = is_weekend_closed(now.timestamp(), base)
    next_open = None
    if closed:
        # 下一个周日 21:00 UTC / the coming Sunday 21:00 UTC
        days_ahead = (6 - now.weekday()) % 7
        candidate = (now + timedelta(days=days_ahead)).replace(
            hour=WEEKEND_OPEN_HOUR_UTC, minute=0, second=0, microsecond=0,
        )
        if candidate <= now:
            candidate += timedelta(days=7)
        next_open = candidate
    return MarketStatus(base, not closed, "calendar", next_open, time.monotonic())


async def _gateway_status(symbol: str, login: int | None) -> MarketStatus | None:
    """问网关这个品种现在能不能开仓。网关不可达、品种读不到、回包不完整都返回 None。
    Ask the gateway; None when unreachable, symbol unknown or the reply is incomplete."""
    base = broker_symbol(symbol.strip().upper())
    data = await gateway_client.get_symbol_sessions(base, login, timeout=GATEWAY_TIMEOUT_SECONDS)
    if not data or not data.get("ok") or "openNow" not in data:
        return None
    next_open = None
    try:
        ts = float(data.get("nextOpenUtc") or 0)
        if ts > 0:
            next_open = datetime.fromtimestamp(ts, timezone.utc)
    except (TypeError, ValueError):
        next_open = None
    trade_mode = None
    try:
        if data.get("tradeMode") is not None:
            trade_mode = int(data["tradeMode"])
    except (TypeError, ValueError):
        trade_mode = None
    return MarketStatus(
        base, bool(data["openNow"]), "gateway", next_open, time.monotonic(), trade_mode,
    )


async def market_status_async(symbol: str, login: int | None = None) -> MarketStatus:
    """某品种现在能不能下单（带 30 秒缓存）。网关优先，退回固定周末日历。
    Whether the symbol can be traded now (30s cache): gateway first, calendar fallback."""
    key = broker_symbol(symbol.strip().upper())
    now = time.monotonic()
    with _lock:
        hit = _cache.get(key)
    if hit is not None and now - hit.checked_at < CACHE_TTL_SECONDS:
        return hit

    status: MarketStatus | None = None
    try:
        status = await _gateway_status(symbol, login)
    except Exception as e:  # noqa: BLE001 —— 判定出错不能挡下单，退回日历
        logger.warning("读取 %s 交易时段失败，退回周末日历: %s", key, e)
    if status is None:
        status = _calendar_status(symbol)
    with _lock:
        _cache[key] = status
    return status


def market_status(symbol: str, login: int | None = None) -> MarketStatus:
    """同步版，供线程池里的下单端点用。主循环排不上（超时）也退回日历，绝不让下单
    端点因为这一步挂住。
    Sync wrapper for the thread-pool order endpoints. A main-loop timeout also falls
    back to the calendar so the order endpoint never hangs on this step."""
    try:
        return gateway_client.run_on_main_loop(
            market_status_async(symbol, login), timeout=GATEWAY_TIMEOUT_SECONDS + 2.0,
        )
    except Exception as e:  # noqa: BLE001
        logger.warning("交易时段判定超时/出错，退回周末日历 %s: %s", symbol, e)
        return _calendar_status(symbol)


def closed_message(status: MarketStatus) -> str:
    """给用户看的休市提示（中 / 英，前端按语言取一半）。
    The user-facing closed message (zh / en; the frontend keeps one half)."""
    if status.next_open_at is not None:
        when = status.next_open_at.astimezone(_DISPLAY_TZ).strftime("%m-%d %H:%M")
        return (
            f"该品种休市中，预计 {when} (UTC+8) 开盘，暂不能下单"
            f" / Market closed for this symbol, reopens around {when} (UTC+8)"
        )
    return "该品种休市中，暂不能下单 / Market closed for this symbol"


def assert_market_open(symbol: str, login: int | None = None) -> None:
    """下单前调用：休市就以 409 拒单。MARKET_HOURS_GATE 关掉时直接放行（单测 / 应急）。
    Call before placing: 409 when closed. Bypassed when MARKET_HOURS_GATE is off."""
    if not settings.MARKET_HOURS_GATE:
        return
    status = market_status(symbol, login)
    if status.open:
        return
    logger.info("休市拒单 %s（%s）", status.symbol, status.source)
    raise HTTPException(status_code=409, detail=closed_message(status))


# MT5 CIMTConSymbol.EnTradeMode 里「只平」的取值 / MT5's TRADE_CLOSEONLY value
TRADE_MODE_CLOSEONLY = 3


def manage_allowed(status: MarketStatus) -> bool:
    """平仓 / 改单 / 改挂单 / 撤挂单（「管理」已有仓位与挂单）此刻能不能发。

    和开仓同一份判定，只有一处不同：券商把品种设成「只平」时，网关的 openNow 不再看
    交易时段、一律回 False——那是「不能开新仓」，不是「休市」，平仓必须照常放行。只平时
    后端判不了时段，交给网关那道闸（它按时段判、不看只平）。
    Whether a close / modify / pending modify / pending cancel may be sent now. Same
    verdict as an open except under close-only, where the gateway's openNow is False
    regardless of the session: that means "no new positions", not "closed", so closes
    must still pass; the gateway's own manage gate judges the session in that case.
    """
    return status.open or status.trade_mode == TRADE_MODE_CLOSEONLY


def closed_for_manage(symbol: str | None, login: int | None = None) -> MarketStatus | None:
    """休市时返回该品种的状态（调用方据此拒单），能发或判不了返回 None。
    MARKET_HOURS_GATE 关掉、品种为空时一律 None。
    The closed status when a manage action must not be sent now, else None (also
    when MARKET_HOURS_GATE is off or the symbol is empty)."""
    if not settings.MARKET_HOURS_GATE or not symbol:
        return None
    status = market_status(symbol, login)
    if manage_allowed(status):
        return None
    return status


def assert_market_open_for_manage(symbol: str | None, login: int | None = None) -> None:
    """平仓 / 改单 / 撤单前调用：休市以 409 拒，文案与开仓同一句（closed_message）。
    休市时发出的 dealer 请求同样会被 MT5 挂成删不掉的「request adding」。
    Call before a close / modify / cancel: 409 when closed, with the same message as
    an open. A dealer request sent into a closed session is parked the same way."""
    status = closed_for_manage(symbol, login)
    if status is None:
        return
    logger.info("休市拒绝平仓 / 改单 %s（%s）", status.symbol, status.source)
    raise HTTPException(status_code=409, detail=closed_message(status))


def serialize(status: MarketStatus) -> dict:
    return {
        "symbol": status.symbol,
        "open": status.open,
        "source": status.source,
        "nextOpenAt": status.next_open_at.isoformat() if status.next_open_at else None,
    }
