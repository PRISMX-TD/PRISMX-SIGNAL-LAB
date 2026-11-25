"""图表警报接口（rev 56，表 chart_alerts / chart_alert_logs）。求值与触发在 services/chart_alerts/engine。
Chart alert endpoints (rev 56). Evaluation and firing live in services/chart_alerts/engine.

  GET    /chart/alerts                 → {alerts: [...]}            当前用户全部警报（新建的在前）
  POST   /chart/alerts        AlertIn  → alert                      新建
  PUT    /chart/alerts/{id}   AlertIn  → alert                      整条改（拖价、编辑、停止 / 恢复都走它）
  DELETE /chart/alerts/{id}            → {ok}
  POST   /chart/alerts/delete {ids}    → {deleted}                  批量删（删画线、清理已停止的）
  GET    /chart/alerts/log?limit=      → {log: [...]}               触发记录（新的在前，最多 300）
  DELETE /chart/alerts/log             → {ok}                       清空触发记录

每次写入都给该用户的在线连接推 CHART_ALERTS_UPDATE（不带内容，前端自己重拉），并让求值缓存重读。
Every write pushes CHART_ALERTS_UPDATE (no payload; clients refetch) and invalidates the evaluator cache.
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from app.core.database import get_db
from app.core.strategy_limits import user_limiter
from app.models import ChartAlert, ChartAlertLog
from app.services.chart_alerts import conds as C
from app.services.chart_alerts import engine
from app.services.connection_manager import manager
from app.services.deps import get_current_user_id_light

router = APIRouter(prefix="/chart/alerts", tags=["chart"])

# 每个用户最多多少条警报（含已停止的；TradingView 最高档 400 条且一个月过期，我们不过期）。
# Max alerts per user, stopped ones included.
ALERTS_MAX = 300
MAX_EXPIRY_DAYS = 400
WRITE_RATE_LIMIT = "120/minute"
READ_RATE_LIMIT = "120/minute"


def _iso(dt: datetime | None) -> str | None:
    if dt is None:
        return None
    if dt.tzinfo is not None:
        dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
    return dt.isoformat(timespec="milliseconds") + "Z"


def _aware(dt: datetime | None) -> datetime | None:
    if dt is None:
        return None
    return dt if dt.tzinfo is not None else dt.replace(tzinfo=timezone.utc)


def _now() -> datetime:
    now = datetime.now(timezone.utc)
    return now.replace(microsecond=now.microsecond // 1000 * 1000)


def alert_out(row: ChartAlert) -> dict:
    try:
        spec = json.loads(row.spec or "{}")
    except (TypeError, ValueError):
        spec = {}
    status = row.status
    exp = _aware(row.expires_at)
    if status == "active" and exp is not None and exp < datetime.now(timezone.utc):
        status = "expired"
    return {
        "id": row.id, "symbol": row.symbol, "kind": row.kind, "cond": row.cond, "spec": spec,
        "trigger": row.trigger, "interval": row.interval, "message": row.message or "",
        "push": bool(row.notify_push), "email": bool(row.notify_email), "status": status,
        "expiresAt": _iso(row.expires_at), "drawingId": row.drawing_id,
        "fireCount": int(row.fire_count or 0), "lastFiredAt": _iso(row.last_fired_at),
        "createdAt": _iso(row.created_at), "updatedAt": _iso(row.updated_at),
    }


class AlertIn(BaseModel):
    symbol: str = Field(min_length=1, max_length=64)
    kind: str = Field(max_length=12)
    cond: str = Field(max_length=12)
    spec: dict = Field(default_factory=dict)
    trigger: str = Field(default="once", max_length=8)
    interval: str = Field(default="15", max_length=4)
    message: str = Field(default="", max_length=200)
    push: bool = True
    email: bool = False
    expiresAt: str | None = Field(default=None, max_length=40)
    drawingId: str | None = Field(default=None, max_length=64)
    active: bool = True


class IdsIn(BaseModel):
    ids: list[str] = Field(default_factory=list, max_length=ALERTS_MAX)


def _bad(msg: str) -> HTTPException:
    return HTTPException(status_code=422, detail=msg)


def _clean(body: AlertIn) -> dict:
    """把请求体校验成要写库的字段。/ Validate the body into column values."""
    if not C.SYMBOL_RE.match(body.symbol):
        raise _bad("品种名无效 / invalid symbol")
    if body.trigger not in C.TRIGGERS:
        raise _bad("触发方式无效 / invalid trigger")
    if body.interval not in C.INTERVALS:
        raise _bad("周期无效（只支持 1/5/15/60/240/D）/ invalid interval (1/5/15/60/240/D only)")
    if body.drawingId is not None and not C.ID_RE.match(body.drawingId):
        raise _bad("画线 id 无效 / invalid drawing id")
    if body.kind == "drawing" and not body.drawingId:
        raise _bad("画线警报缺少画线 id / drawing alerts need a drawing id")
    try:
        spec = C.clean_spec(body.kind, body.cond, body.spec)
    except C.SpecError as e:
        raise _bad(str(e)) from None
    encoded = json.dumps(spec, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    if len(encoded) > 4000:
        raise _bad("条件参数过大 / spec too large")
    trigger = body.trigger
    # 收盘类只有「仅一次」与「每次收盘」/ close-based alerts: once or every close
    if (body.kind == "indicator" or body.cond in C.CONDS_MOVE) and trigger == "bar":
        trigger = "close"
    expires = None
    if body.expiresAt:
        try:
            expires = datetime.fromisoformat(body.expiresAt.replace("Z", "+00:00"))
        except ValueError:
            raise _bad("到期时间无效 / invalid expiry") from None
        expires = _aware(expires)
        now = datetime.now(timezone.utc)
        if expires <= now:
            raise _bad("到期时间必须在未来 / expiry must be in the future")
        if expires > now + timedelta(days=MAX_EXPIRY_DAYS):
            raise _bad(f"到期时间最多 {MAX_EXPIRY_DAYS} 天后 / expiry at most {MAX_EXPIRY_DAYS} days ahead")
        expires = expires.astimezone(timezone.utc).replace(tzinfo=None)
    return {
        "symbol": body.symbol.upper(), "kind": body.kind, "cond": body.cond, "spec": encoded,
        "trigger": trigger, "interval": body.interval, "message": body.message.strip()[:200],
        "notify_push": body.push, "notify_email": body.email, "expires_at": expires,
        "drawing_id": body.drawingId if body.kind == "drawing" else None,
        "status": "active" if body.active else "paused",
    }


async def _changed(user_id: str) -> None:
    engine.bump()
    await manager.push_to_client(user_id, {"type": engine.WS_UPDATE, "data": {}})


@router.get("")
@user_limiter.limit(READ_RATE_LIMIT)
def list_alerts(request: Request, db: Session = Depends(get_db), user_id: str = Depends(get_current_user_id_light)):
    rows = (
        db.query(ChartAlert).filter(ChartAlert.user_id == user_id)
        .order_by(ChartAlert.created_at.desc()).limit(ALERTS_MAX).all()
    )
    return {"alerts": [alert_out(r) for r in rows]}


def create_alert_sync(db: Session, user_id: str, values: dict) -> ChartAlert:
    n = db.query(func.count(ChartAlert.id)).filter(ChartAlert.user_id == user_id).scalar() or 0
    if n >= ALERTS_MAX:
        raise _bad(f"最多 {ALERTS_MAX} 条警报，先删掉一些已停止的 / at most {ALERTS_MAX} alerts; delete some stopped ones")
    now = _now()
    row = ChartAlert(user_id=user_id, created_at=now, updated_at=now, seq=0, fire_count=0, **values)
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


@router.post("")
@user_limiter.limit(WRITE_RATE_LIMIT)
async def create_alert(request: Request, body: AlertIn, db: Session = Depends(get_db),
                       user_id: str = Depends(get_current_user_id_light)):
    values = _clean(body)
    row = await run_in_threadpool(create_alert_sync, db, user_id, values)
    out = alert_out(row)
    await _changed(user_id)
    return out


def update_alert_sync(db: Session, user_id: str, alert_id: str, values: dict) -> ChartAlert:
    row = db.query(ChartAlert).filter(ChartAlert.id == alert_id, ChartAlert.user_id == user_id).first()
    if row is None:
        raise HTTPException(status_code=404, detail="警报不存在 / alert not found")
    for k, v in values.items():
        setattr(row, k, v)
    row.seq = int(row.seq or 0) + 1
    row.updated_at = _now()
    db.commit()
    db.refresh(row)
    return row


@router.put("/{alert_id}")
@user_limiter.limit(WRITE_RATE_LIMIT)
async def update_alert(request: Request, alert_id: str, body: AlertIn, db: Session = Depends(get_db),
                       user_id: str = Depends(get_current_user_id_light)):
    if not C.ID_RE.match(alert_id):
        raise HTTPException(status_code=404, detail="警报不存在 / alert not found")
    values = _clean(body)
    row = await run_in_threadpool(update_alert_sync, db, user_id, alert_id, values)
    out = alert_out(row)
    await _changed(user_id)
    return out


def delete_alerts_sync(db: Session, user_id: str, ids: list[str]) -> int:
    ids = [i for i in dict.fromkeys(ids) if isinstance(i, str) and C.ID_RE.match(i)]
    if not ids:
        return 0
    n = (
        db.query(ChartAlert).filter(ChartAlert.user_id == user_id, ChartAlert.id.in_(ids))
        .delete(synchronize_session=False)
    )
    db.commit()
    return int(n or 0)


@router.post("/delete")
@user_limiter.limit(WRITE_RATE_LIMIT)
async def delete_alerts(request: Request, body: IdsIn, db: Session = Depends(get_db),
                        user_id: str = Depends(get_current_user_id_light)):
    n = await run_in_threadpool(delete_alerts_sync, db, user_id, body.ids)
    if n:
        await _changed(user_id)
    return {"deleted": n}


@router.get("/log")
@user_limiter.limit(READ_RATE_LIMIT)
def alert_log(request: Request, limit: int = Query(default=100, ge=1, le=engine.LOG_KEEP),
              db: Session = Depends(get_db), user_id: str = Depends(get_current_user_id_light)):
    rows = (
        db.query(ChartAlertLog.id, ChartAlertLog.alert_id, ChartAlertLog.symbol, ChartAlertLog.price,
                 ChartAlertLog.message, ChartAlertLog.fired_at)
        .filter(ChartAlertLog.user_id == user_id)
        .order_by(ChartAlertLog.fired_at.desc()).limit(limit).all()
    )
    return {"log": [
        {"id": r[0], "alertId": r[1], "symbol": r[2], "price": r[3], "message": r[4] or "", "firedAt": _iso(r[5])}
        for r in rows
    ]}


@router.delete("/log")
@user_limiter.limit(WRITE_RATE_LIMIT)
def clear_alert_log(request: Request, db: Session = Depends(get_db), user_id: str = Depends(get_current_user_id_light)):
    db.query(ChartAlertLog).filter(ChartAlertLog.user_id == user_id).delete(synchronize_session=False)
    db.commit()
    return {"ok": True}


@router.delete("/{alert_id}")
@user_limiter.limit(WRITE_RATE_LIMIT)
async def delete_alert(request: Request, alert_id: str, db: Session = Depends(get_db),
                       user_id: str = Depends(get_current_user_id_light)):
    n = await run_in_threadpool(delete_alerts_sync, db, user_id, [alert_id])
    if not n:
        raise HTTPException(status_code=404, detail="警报不存在 / alert not found")
    await _changed(user_id)
    return {"ok": True}
