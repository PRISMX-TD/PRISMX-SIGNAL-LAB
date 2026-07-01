"""TradingView Webhook 路由：接收 TradingView 警报推送的交易信号。

TradingView alert webhook: receive trading signals pushed by TradingView alerts.

TradingView 的 webhook 只能 POST 一个 URL + JSON body，不能自定义请求头，
故来源校验依赖 body 内的 "secret" 字段与服务器配置的 WEBHOOK_SECRET 常量时间比较。
TradingView can only POST a URL + JSON body without custom headers, so source
authentication relies on the "secret" field compared (constant-time) to WEBHOOK_SECRET.
"""
import secrets
from datetime import datetime, timedelta, timezone
from typing import Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.database import SessionLocal
from app.core.rate_limit import limiter
from app.models import Signal, Trend
from app.schemas import SYMBOL_PATTERN, SignalOut
from app.services.connection_manager import manager
from app.services.push_dispatch import dispatch_push

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
    ).model_dump(mode="json")


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

    db: Session = SessionLocal()
    try:
        # 2) 去重：带 external_id 且已存在则直接返回，不重复入库 / dedup by external_id
        if payload.id:
            existing = db.query(Signal).filter(Signal.external_id == payload.id).first()
            if existing is not None:
                return {"ok": True, "deduped": True, "id": existing.id}

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
                return {"ok": True, "deduped": True, "id": existing.id}
            raise
        db.refresh(sig)
        data = _serialize(sig)
    finally:
        db.close()

    # 3) 复用现有广播：推给所有在线前端，格式与 mock 引擎一致 / broadcast like the mock engine
    await manager.broadcast_to_clients({"type": "SIGNAL_NEW", "data": data})
    # Web Push 通知 / web push
    try:
        dispatch_push(sig)
    except Exception:
        pass
    return {"ok": True, "deduped": False, "id": data["id"]}


# 允许的趋势方向 / allowed trend directions
TrendDir = Literal["UP", "DOWN", "FLAT"]


class TrendSignal(BaseModel):
    """TradingView 多周期趋势推送载荷 / multi-timeframe trend payload from TradingView."""

    secret: str = Field(min_length=1, max_length=128)
    symbol: str = Field(pattern=SYMBOL_PATTERN)
    # 各周期趋势，键为周期名(M5/M15/H1/H4)，值为方向 / per-timeframe map
    trends: dict[str, TrendDir]
    # 外部编号，仅用于日志/幂等参考，可空 / external id, optional
    id: str | None = Field(default=None, max_length=128)


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
    try:
        data_in = json.loads(raw)
        payload = TrendSignal.model_validate(data_in)
    except (ValueError, TypeError):
        raise HTTPException(status_code=422, detail="请求体不是合法 JSON / body is not valid JSON")

    if not settings.WEBHOOK_SECRET or not secrets.compare_digest(
        payload.secret.encode("utf-8"), settings.WEBHOOK_SECRET.encode("utf-8")
    ):
        raise HTTPException(status_code=401, detail="Webhook 密钥无效 / invalid webhook secret")

    symbol = payload.symbol.upper()
    tf_map = {str(k): str(v) for k, v in payload.trends.items()}
    now = datetime.now(timezone.utc)

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
    finally:
        db.close()

    # 广播给所有在线前端 / broadcast to all online clients
    await manager.broadcast_to_clients({"type": "TREND_UPDATE", "data": data})
    return {"ok": True, "symbol": symbol}
