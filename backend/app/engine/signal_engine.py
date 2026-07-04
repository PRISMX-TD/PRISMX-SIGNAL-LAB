"""信号引擎：基于技术指标生成交易信号。
Signal engine: generate trading signals from technical indicators.

本地阶段使用模拟价格序列演示均线交叉 + RSI 过滤策略；
接入真实行情时只需替换 _get_price_series。
Local stage uses synthetic price series to demo an MA-cross + RSI-filter strategy;
swap _get_price_series to plug in real market data.
"""
import asyncio
import logging
import random
from datetime import datetime, timedelta, timezone

import numpy as np
import pandas as pd

from app.core.config import settings
from app.core.database import SessionLocal
from app.models import Signal
from app.schemas import SignalOut
from app.services.connection_manager import manager
from app.services.push_dispatch import dispatch_push_async

logger = logging.getLogger("prismx.engine")

SYMBOLS = ["EURUSD", "GBPUSD", "USDJPY", "XAUUSD", "BTCUSD"]

# 各品种的模拟价格状态 / synthetic price state per symbol
_price_state: dict[str, float] = {
    "EURUSD": 1.0850,
    "GBPUSD": 1.2700,
    "USDJPY": 150.20,
    "XAUUSD": 2350.0,
    "BTCUSD": 68000.0,
}
_history: dict[str, list[float]] = {s: [] for s in SYMBOLS}


def _next_price(symbol: str) -> float:
    """生成下一个模拟价格（随机游走）/ random-walk next price."""
    last = _price_state[symbol]
    vol = last * 0.0008
    nxt = max(0.0001, last + random.gauss(0, vol))
    _price_state[symbol] = nxt
    hist = _history[symbol]
    hist.append(nxt)
    if len(hist) > 200:
        hist.pop(0)
    return nxt


def _rsi(series: pd.Series, period: int = 14) -> float:
    delta = series.diff()
    gain = delta.clip(lower=0).rolling(period).mean()
    loss = (-delta.clip(upper=0)).rolling(period).mean()
    rs = gain / loss.replace(0, np.nan)
    rsi = 100 - (100 / (1 + rs))
    val = rsi.iloc[-1]
    return float(val) if not pd.isna(val) else 50.0


def _evaluate(symbol: str) -> dict | None:
    """对单个品种评估指标，命中则返回信号参数 / evaluate indicators for one symbol."""
    prices = _history[symbol]
    if len(prices) < 35:
        return None

    s = pd.Series(prices)
    fast = s.rolling(5).mean()
    slow = s.rolling(20).mean()
    rsi = _rsi(s)
    price = prices[-1]

    # 金叉 + RSI 不超买 -> 买入 / golden cross + RSI not overbought -> BUY
    crossed_up = fast.iloc[-2] <= slow.iloc[-2] and fast.iloc[-1] > slow.iloc[-1]
    # 死叉 + RSI 不超卖 -> 卖出 / dead cross + RSI not oversold -> SELL
    crossed_down = fast.iloc[-2] >= slow.iloc[-2] and fast.iloc[-1] < slow.iloc[-1]

    side = None
    indicator = ""
    if crossed_up and rsi < 70:
        side = "BUY"
        indicator = f"MA5/MA20 金叉, RSI={rsi:.1f} / Golden cross"
    elif crossed_down and rsi > 30:
        side = "SELL"
        indicator = f"MA5/MA20 死叉, RSI={rsi:.1f} / Dead cross"

    if side is None:
        return None

    # 止损止盈按价格比例 / SL & TP by price ratio
    sl_ratio, tp_ratio = 0.004, 0.008
    if side == "BUY":
        stop_loss = price * (1 - sl_ratio)
        take_profit = price * (1 + tp_ratio)
    else:
        stop_loss = price * (1 + sl_ratio)
        take_profit = price * (1 - tp_ratio)

    digits = 2 if symbol in ("USDJPY", "XAUUSD", "BTCUSD") else 5
    return {
        "symbol": symbol,
        "side": side,
        "entry": round(price, digits),
        "stop_loss": round(stop_loss, digits),
        "take_profit": round(take_profit, digits),
        "indicator": indicator,
    }


def _serialize(sig: Signal) -> dict:
    return SignalOut(
        id=sig.id,
        symbol=sig.symbol,
        side=sig.side,
        entry=sig.entry,
        stopLoss=sig.stop_loss,
        takeProfit=sig.take_profit,
        indicator=sig.indicator,
        status=sig.status,
        createdAt=sig.created_at,
        expireAt=sig.expire_at,
        result=sig.result or "PENDING",
        resolvedAt=sig.resolved_at,
    ).model_dump(mode="json")


def _expire_stale_signals() -> list[str]:
    """标记到期信号为 EXPIRED，返回其 id（同步 DB 操作，放线程池执行）。
    Mark expired signals as EXPIRED and return their ids (blocking DB work,
    run in a thread pool)."""
    db = SessionLocal()
    expired_ids: list[str] = []
    try:
        now = datetime.now(timezone.utc)
        active = (
            db.query(Signal)
            .filter(Signal.status == "ACTIVE", Signal.expire_at.isnot(None))
            .all()
        )
        for s in active:
            exp = s.expire_at
            if exp.tzinfo is None:
                exp = exp.replace(tzinfo=timezone.utc)
            if exp < now:
                s.status = "EXPIRED"
                expired_ids.append(s.id)
        if expired_ids:
            db.commit()
    finally:
        db.close()
    return expired_ids


async def signal_expiry_loop() -> None:
    """独立的信号过期扫描任务：到期即广播 SIGNAL_EXPIRED。

    与模拟信号引擎解耦——关闭 ENABLE_MOCK_SIGNAL_ENGINE 接入真实信号后，
    webhook 信号的过期仍能实时广播到前端（此前广播只挂在引擎循环里）。

    Standalone expiry sweep: broadcasts SIGNAL_EXPIRED as signals lapse.
    Decoupled from the mock engine so webhook signals still expire in real
    time on the frontend once ENABLE_MOCK_SIGNAL_ENGINE is turned off (the
    broadcast used to live only inside the engine loop).
    """
    from starlette.concurrency import run_in_threadpool

    while True:
        await asyncio.sleep(5)
        try:
            expired_ids = await run_in_threadpool(_expire_stale_signals)
            for sid in expired_ids:
                await manager.broadcast_to_clients({"type": "SIGNAL_EXPIRED", "data": {"id": sid}})
        except Exception:
            logger.exception("signal_expiry_loop error")


async def signal_loop() -> None:
    """信号生成主循环 / main signal generation loop."""
    for sym in SYMBOLS:
        for _ in range(40):
            _next_price(sym)

    while True:
        await asyncio.sleep(settings.SIGNAL_INTERVAL_SECONDS)
        try:
            # 过期扫描由独立的 signal_expiry_loop 负责，这里只管生成新信号。
            # Expiry is handled by the standalone signal_expiry_loop; this loop
            # only generates new signals.

            # 更新所有品种价格 / advance prices for all symbols
            for sym in SYMBOLS:
                _next_price(sym)

            # 随机挑选一个品种评估，避免每拍都出信号 / evaluate one random symbol per tick
            candidate = random.choice(SYMBOLS)
            result = _evaluate(candidate)
            if result is None:
                continue

            db = SessionLocal()
            try:
                now = datetime.now(timezone.utc)
                sig = Signal(
                    symbol=result["symbol"],
                    side=result["side"],
                    entry=result["entry"],
                    stop_loss=result["stop_loss"],
                    take_profit=result["take_profit"],
                    indicator=result["indicator"],
                    status="ACTIVE",
                    created_at=now,
                    expire_at=now + timedelta(minutes=settings.SIGNAL_EXPIRE_MINUTES),
                )
                db.add(sig)
                db.commit()
                db.refresh(sig)
                payload = _serialize(sig)
            finally:
                db.close()

            # 推送新信号给所有前端 / broadcast new signal to all clients
            await manager.broadcast_to_clients({"type": "SIGNAL_NEW", "data": payload})
            # Web Push 通知：线程池执行，不阻塞引擎与事件循环。
            # Web push runs in a thread pool; the engine and event loop keep ticking.
            await dispatch_push_async(sig)
        except Exception:  # 引擎不可因单次异常退出 / engine must not die on a single error
            logger.exception("signal_loop error")
