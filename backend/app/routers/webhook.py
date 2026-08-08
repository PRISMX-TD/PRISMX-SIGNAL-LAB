"""TradingView Webhook 路由：接收 TradingView 警报推送的交易信号。

TradingView alert webhook: receive trading signals pushed by TradingView alerts.

TradingView 的 webhook 只能 POST 一个 URL + JSON body，不能自定义请求头，
故来源校验依赖 body 内的 "secret" 字段与服务器配置的 WEBHOOK_SECRET 常量时间比较。
TradingView can only POST a URL + JSON body without custom headers, so source
authentication relies on the "secret" field compared (constant-time) to WEBHOOK_SECRET.
"""
import secrets
import threading
from datetime import datetime, timedelta, timezone
from typing import Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from app.core.config import settings
from app.core.database import SessionLocal
from app.core.rate_limit import limiter
from app.models import Signal, Trend
from app.schemas import SYMBOL_PATTERN, SignalOut
from app.services.connection_manager import manager
from app.services.push_dispatch import dispatch_push_async
from app.services.signal_broadcast import broadcast_signal_new_realtime
from app.services.signal_resolution import resolve_signals_with_price

import json

router = APIRouter(prefix="/webhook", tags=["webhook"])


class TradingViewSignal(BaseModel):
    """TradingView 警报推送的信号载荷 / signal payload pushed by a TradingView alert."""

    secret: str = Field(min_length=1, max_length=128)
    symbol: str = Field(pattern=SYMBOL_PATTERN)
    side: Literal["BUY", "SELL", "buy", "sell"]
    entry: float | None = None
    stopLoss: float | None = Field(default=None, ge=0)
    takeProfit: float | None = Field(default=None, ge=0)
    # 策略名，展示在前端 indicator 字段 / strategy name shown in the UI
    strategy: str | None = Field(default=None, max_length=128)
    # 外部唯一编号，用于去重；省略则不去重 / external unique id for dedup; optional
    id: str | None = Field(default=None, max_length=128)


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


# 每个品种一把锁，/trend 用。
#
# 改造前 224-256 那段整体同步跑在事件循环上、中间没有 await，所以同品种的两次
# 上报天然串行。搬进线程池后会交错，带来两个真实后果：
#   ① Trend 行与 TREND_UPDATE 广播回退到较旧数据——先到的那个可能后提交，而
#      前端 live.tsx 按 symbol 无条件覆盖、不比较 updatedAt。
#   ② resolve_signals_with_price 的 PENDING 扫描被重复执行：两个线程各扫一遍、
#      互相看不见对方刚写下的终态，重叠部分的行被重复传输。该查询自己的注释写明
#      它占总 egress 的 36%，所以这条直接踩红线一。
#
# 用 threading.Lock 而不是 asyncio.Lock：临界区整体在工作线程里执行，锁必须能被
# 工作线程持有。锁本身在事件循环上取、在线程内加解，语义清晰。
#
# One lock per symbol for /trend. Before this change the whole block ran on the
# event loop with no await inside, so same-symbol reports were naturally
# serialized. Interleaving would let an older snapshot win the Trend upsert (the
# frontend overwrites by symbol without comparing updatedAt) and would run the
# PENDING scan twice with neither pass seeing the other's writes — and that query
# accounts for ~36% of total egress, so it breaks the "no new queries" rule.
# threading.Lock rather than asyncio.Lock because the critical section runs
# inside the worker thread and the lock must be held there.
_trend_locks: dict[str, threading.Lock] = {}
_trend_locks_guard = threading.Lock()


def _trend_lock(symbol: str) -> threading.Lock:
    """取（必要时新建）某品种的锁。品种集合有界，无需清理。
    Fetch (creating on first use) the lock for a symbol. Bounded key space."""
    with _trend_locks_guard:
        lock = _trend_locks.get(symbol)
        if lock is None:
            lock = threading.Lock()
            _trend_locks[symbol] = lock
        return lock


def _persist_signal_sync(payload: TradingViewSignal):
    """信号落库的同步段。返回 (去重命中的既有 id, 序列化数据, ORM 实例)。

    now 刻意留在这个函数内、且仍在去重查询之后计算——保持与改造前逐行相同的位置，
    否则 created_at/expire_at 会被提前到去重查询之前，语义就变了。

    Blocking half of signal persistence. `now` deliberately stays inside this
    function and still after the dedup query, matching the original line order —
    hoisting it would shift created_at/expire_at before the dedup lookup.
    """
    db: Session = SessionLocal()
    try:
        # 2) 去重：带 external_id 且已存在则直接返回，不重复入库 / dedup by external_id
        if payload.id:
            existing = db.query(Signal).filter(Signal.external_id == payload.id).first()
            if existing is not None:
                return existing.id, None, None

        now = datetime.now(timezone.utc)
        sig = Signal(
            symbol=payload.symbol,
            side=payload.side.upper(),
            entry=payload.entry,
            stop_loss=payload.stopLoss,
            take_profit=payload.takeProfit,
            indicator=payload.strategy or "TradingView",
            source="tradingview",
            external_id=payload.id,
            status="ACTIVE",
            created_at=now,
            expire_at=now + timedelta(minutes=settings.SIGNAL_EXPIRE_MINUTES),
        )
        db.add(sig)
        try:
            db.commit()
        except IntegrityError:
            # external_id 唯一约束并发冲突：视为重复，回滚后返回已存在记录。
            # Unique-constraint race on external_id: treat as duplicate.
            db.rollback()
            existing = db.query(Signal).filter(Signal.external_id == payload.id).first()
            if existing is not None:
                return existing.id, None, None
            raise
        db.refresh(sig)
        return None, _serialize(sig), sig
    finally:
        db.close()


@router.post("/tradingview", response_model=dict)
@limiter.limit("60/minute")
async def tradingview_webhook(request: Request, payload: TradingViewSignal):
    """接收 TradingView 信号：校验密钥 -> 去重 -> 存库 -> 广播。
    Receive a TradingView signal: verify secret -> dedup -> persist -> broadcast.
    """
    # 1) 来源校验：常量时间比较，密钥未配置则一律拒绝 / verify source, reject if unset
    # 按 UTF-8 字节比较，避免非 ASCII 密钥触发 compare_digest 的 TypeError（应返回 401 而非 500）。
    # Compare as UTF-8 bytes so a non-ASCII secret returns 401 instead of crashing compare_digest.
    if not settings.WEBHOOK_SECRET or not secrets.compare_digest(
        payload.secret.encode("utf-8"), settings.WEBHOOK_SECRET.encode("utf-8")
    ):
        raise HTTPException(status_code=401, detail="Webhook 密钥无效 / invalid webhook secret")

    # 落库整段是同步 SQLAlchemy，走线程池。去重的并发竞态由 external_id 的唯一
    # 约束 + IntegrityError 回退兜底，与改造前一致，不需要额外加锁。
    # The persistence half is blocking SQLAlchemy and moves to the thread pool.
    # The dedup race is still handled by the external_id unique constraint plus
    # the IntegrityError fallback, exactly as before — no extra lock needed.
    deduped_id, data, sig = await run_in_threadpool(_persist_signal_sync, payload)
    if deduped_id is not None:
        return {"ok": True, "deduped": True, "id": deduped_id}

    # 3) 推送：只给实时等级的在线用户；FREE 等级要等信号过期后才第一次看到
    # push: real-time-tier clients only; FREE tier sees it once it expires
    await broadcast_signal_new_realtime(data)
    # Web Push 通知：线程池执行，避免阻塞事件循环 / web push off the event loop
    await dispatch_push_async(sig)
    return {"ok": True, "deduped": False, "id": data["id"]}


# 允许的趋势方向 / allowed trend directions
TrendDir = Literal["UP", "DOWN", "FLAT"]


def _valid_trend_secret(secret: str) -> bool:
    """趋势推送的密钥校验：接受 WEBHOOK_SECRET（TradingView 指标，legacy）或
    EA_TOKEN（MT5 EA），任一匹配即通过。两者都放在 JSON body 的 "secret"
    字段里，与 TradingView 不支持自定义请求头的限制保持一致。
    Trend-push secret check: accept either WEBHOOK_SECRET (the legacy
    TradingView indicator) or EA_TOKEN (the MT5 EA). Both are carried in the
    body's "secret" field, consistent with TradingView's no-custom-headers
    limitation."""
    if settings.WEBHOOK_SECRET and secrets.compare_digest(
        secret.encode("utf-8"), settings.WEBHOOK_SECRET.encode("utf-8")
    ):
        return True
    if settings.EA_TOKEN and secrets.compare_digest(
        secret.encode("utf-8"), settings.EA_TOKEN.encode("utf-8")
    ):
        return True
    return False


def _extract_json_block(text: str) -> str | None:
    """从任意文本中抠出第一个大括号平衡的 JSON 对象。
    Extract the first brace-balanced JSON object from arbitrary text.
    用于 TradingView 把说明文字和 alert() 的 JSON 拼在一起发送的情况。
    Handles the case where TradingView concatenates description text with the JSON.
    """
    start = text.find("{")
    if start < 0:
        return None
    depth = 0
    for i in range(start, len(text)):
        c = text[i]
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return text[start : i + 1]
    return None


class TrendSignal(BaseModel):
    """TradingView 多周期趋势推送载荷 / multi-timeframe trend payload from TradingView."""

    secret: str = Field(min_length=1, max_length=128)
    symbol: str = Field(pattern=SYMBOL_PATTERN)
    # 各周期趋势，键为周期名(M5/M15/H1/H4)，值为方向 / per-timeframe map
    trends: dict[str, TrendDir]
    # 该指标所在图表周期（如 5 分钟）当前 K 线的最高/最低价，用于顺带判定该品种
    # 下所有未分胜负信号是否命中止盈/止损。两者都缺省则跳过胜负判定，仅更新趋势。
    # High/low of the current bar on this indicator's chart timeframe (e.g. 5m),
    # used to opportunistically resolve any pending signals on this symbol
    # against TP/SL. Skips resolution (trend-only update) if either is missing.
    high: float | None = Field(default=None, ge=0)
    low: float | None = Field(default=None, ge=0)
    # 外部编号，仅用于日志/幂等参考，可空 / external id, optional
    id: str | None = Field(default=None, max_length=128)


class TrendItem(BaseModel):
    """批量推送里的单个品种条目。与 TrendSignal 相同，只是不带 secret
    ——密钥在批量载荷的外层统一带一次。
    One symbol inside a batch push: same as TrendSignal minus the secret, which
    the batch envelope carries once for the whole request."""

    symbol: str = Field(pattern=SYMBOL_PATTERN)
    trends: dict[str, TrendDir]
    high: float | None = Field(default=None, ge=0)
    low: float | None = Field(default=None, ge=0)
    id: str | None = Field(default=None, max_length=128)


class TrendBatch(BaseModel):
    """批量趋势推送载荷。

    EA 原本每个品种发一个请求，7 个品种就是每 5 秒 7 个请求。更要命的是 EA 的
    WebRequest 是同步的：后端慢的时候，7 × 5 秒超时 = 最坏 35 秒卡在 1 秒一次的
    定时器回调里，连带把喂价和 K 线一起拖停。合并成一个请求后，最坏阻塞降到 5 秒。

    与单条格式并存、按 items 键区分，**旧 EA 不受任何影响**——后端先上线时线上
    跑的还是旧 EA，必须照常工作。

    Batch trend payload. The EA used to send one request per symbol — 7 requests
    every 5 seconds — and its WebRequest is synchronous, so a slow backend meant
    up to 7 × 5s = 35s stuck inside a 1-second timer callback, stalling the candle
    and quote feeds with it. One request caps that at 5s. Coexists with the single
    format and is told apart by the `items` key, so an older EA keeps working
    unchanged — which it must, since the backend ships first.
    """

    secret: str = Field(min_length=1, max_length=128)
    # 上限与 EA 实际发送量（7 个品种）留足余量，同时防止畸形载荷撑爆单次请求。
    # Capped well above the EA's real payload (7 symbols) while still refusing
    # a malformed request that would blow up a single call.
    items: list[TrendItem] = Field(min_length=1, max_length=64)


def _trend_db_work(
    symbol: str,
    tf_map: dict,
    now: datetime,
    low: float | None,
    high: float | None,
) -> dict:
    """趋势 upsert + 顺带的信号判定。整段在同品种锁内执行。

    now 由调用方在事件循环上算好传进来：它在改造前就是在 SessionLocal() 之前
    计算的，保持原位置，Trend.updated_at 与响应里的 updatedAt 才仍是同一个值。

    Trend upsert plus the opportunistic signal resolution, all inside the
    per-symbol lock. `now` is computed by the caller on the event loop because it
    was computed before SessionLocal() originally; keeping it there preserves the
    identity between Trend.updated_at and the broadcast's updatedAt.
    """
    with _trend_lock(symbol):
        db: Session = SessionLocal()
        try:
            # 每个品种一条，后来的覆盖前面的 / one row per symbol, upsert
            row = db.query(Trend).filter(Trend.symbol == symbol).first()
            if row is None:
                row = Trend(symbol=symbol, timeframes=json.dumps(tf_map), updated_at=now)
                db.add(row)
            else:
                row.timeframes = json.dumps(tf_map)
                row.updated_at = now
            try:
                db.commit()
            except IntegrityError:
                # symbol 唯一约束并发冲突：回滚后重取再写 / unique-constraint race
                db.rollback()
                row = db.query(Trend).filter(Trend.symbol == symbol).first()
                if row is not None:
                    row.timeframes = json.dumps(tf_map)
                    row.updated_at = now
                    db.commit()
            data = {"symbol": symbol, "timeframes": tf_map, "updatedAt": now.isoformat()}

            # 顺带用这根 K 线的高低点判定该品种下所有未分胜负信号是否命中 TP/SL。
            # 与趋势更新共用同一次 webhook 调用，不需要额外的行情通道。
            # Opportunistically resolve pending signals on this symbol against this
            # bar's high/low, riding on the same webhook call as the trend update —
            # no separate price channel needed.
            if low is not None and high is not None:
                resolved = resolve_signals_with_price(db, symbol, low, high)
                if resolved:
                    db.commit()
            return data
        finally:
            db.close()


@router.post("/trend", response_model=dict)
@limiter.limit("120/minute")
async def tradingview_trend(request: Request):
    """接收多周期趋势：校验密钥 -> upsert 覆盖 -> 广播 TREND_UPDATE。
    Receive a multi-timeframe trend: verify secret -> upsert -> broadcast.

    手动读取原始 body 再解析，不依赖 Content-Type。
    TradingView 的 webhook 发的是 text/plain，若声明 JSON body 模型会被 FastAPI 判 422。
    Read the raw body and parse manually, independent of Content-Type. TradingView
    sends webhooks as text/plain, which would trigger a 422 with a declared JSON body.
    """
    raw = await request.body()
    text = raw.decode("utf-8", errors="ignore").strip()
    payload = None
    batch = None
    # 先尝试整体解析；失败则从文本中抠出第一个 {...} JSON 块再解析。
    # TradingView 有时会把警报说明文字和 alert() 的 JSON 拼在一起发送。
    # Try whole-body parse first; if it fails, extract the first {...} block.
    # TradingView may concatenate the alert description with the alert() JSON.
    for candidate in (text, _extract_json_block(text)):
        if not candidate:
            continue
        try:
            parsed = json.loads(candidate)
        except (ValueError, TypeError):
            continue
        # 按 items 键区分批量与单条。批量是 EA 用的（一次带上全部品种），单条是
        # TradingView 指标的历史契约，两者必须并存：后端先于 EA 上线，那段时间
        # 线上跑的还是旧 EA，单条格式一天都不能断。
        # The `items` key tells a batch from a single push. Batch is what the EA
        # sends; the single form is TradingView's existing contract. Both must
        # work: the backend ships before the EA, so the single form cannot break
        # for even a moment.
        try:
            if isinstance(parsed, dict) and "items" in parsed:
                batch = TrendBatch.model_validate(parsed)
            else:
                payload = TrendSignal.model_validate(parsed)
            break
        except (ValueError, TypeError):
            continue
    if payload is None and batch is None:
        raise HTTPException(status_code=422, detail="请求体未包含合法趋势 JSON / no valid trend JSON in body")

    secret = batch.secret if batch is not None else payload.secret
    if not _valid_trend_secret(secret):
        raise HTTPException(status_code=401, detail="Webhook 密钥无效 / invalid webhook secret")

    # 统一成条目列表处理，两条路径共用下面的循环——避免单条/批量各写一遍判定逻辑
    # 而慢慢长歪（信号判定就挂在这条路径上，两份实现迟早会不一致）。
    # Normalize both shapes into one list so a single loop serves them. Two copies
    # of this logic would drift, and signal resolution rides on this path.
    items = batch.items if batch is not None else [payload]

    # now 对整批取同一个值：同一次上报里各品种的 updated_at 应当一致，否则前端
    # 看到的"最后更新时间"会在同一批内相差几十毫秒，徒增困惑。
    # One `now` for the whole batch: symbols reported together should share an
    # updated_at rather than differing by tens of milliseconds within one push.
    now = datetime.now(timezone.utc)

    results = []
    for item in items:
        symbol = item.symbol.upper()
        tf_map = {str(k): str(v) for k, v in item.trends.items()}
        data = await run_in_threadpool(_trend_db_work, symbol, tf_map, now, item.low, item.high)
        results.append((symbol, data))

    # 广播维持每品种一帧：前端已按这个形状处理 TREND_UPDATE，改成一帧多品种就要
    # 同时改前端，而本次改造的目的是减少 EA→后端的请求数，不是动前端契约。
    # Still one frame per symbol: the frontend already handles TREND_UPDATE in this
    # shape. Batching frames would require a frontend change, and the point here is
    # to cut EA→backend requests, not to alter the frontend contract.
    for _symbol, data in results:
        await manager.broadcast_to_clients({"type": "TREND_UPDATE", "data": data})

    if batch is not None:
        return {"ok": True, "symbols": [s for s, _ in results]}
    return {"ok": True, "symbol": results[0][0]}
