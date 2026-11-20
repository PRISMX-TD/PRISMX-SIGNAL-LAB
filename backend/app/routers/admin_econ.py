"""财经日历的管理接口（2026-11-20，第一期只给管理员）：状态、设置、立即同步、日历列表、重写预案。
main 里 include 时挂 require_admin，这里每个接口也自己要 require_admin。
普通用户端的接口等管理员看过一段时间预案质量后再开。

Economic-calendar admin endpoints (admin-only for now): status, settings, sync now, the calendar
list, regenerate a preview. Guarded by require_admin on include and per endpoint.
"""
import json
from datetime import date, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from app.core.database import get_db
from app.models import EconPreview, EconRelease, User
from app.services.audit import log_change
from app.services.deps import require_admin
from app.services.econ import deepseek, loop, narwhal, previews, rules, store

router = APIRouter(prefix="/admin/econ", tags=["admin"], dependencies=[Depends(require_admin)])


class EconSettingsIn(BaseModel):
    enabled: bool | None = None
    previews: bool | None = None
    countries: list[str] | None = Field(default=None, max_length=50)
    previewMinImportance: int | None = Field(default=None, ge=rules.LOW, le=rules.HIGH)
    dailyLlmCap: int | None = Field(default=None, ge=0, le=2000)


class RegenerateIn(BaseModel):
    groupKey: str = Field(min_length=5, max_length=64)


def _iso(dt: datetime | None) -> str | None:
    return dt.isoformat() + "Z" if dt else None


@router.get("/status")
def econ_status(db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    st = store.get_status()
    return {
        "settings": store.get_settings(db),
        "narwhalConfigured": narwhal.configured(),
        "deepseekConfigured": deepseek.configured(),
        "llmCallsToday": store.llm_calls_today(),
        "status": st,
        "releases": db.query(EconRelease).count(),
        "previews": db.query(EconPreview).filter(EconPreview.status == "ok").count(),
    }


@router.put("/settings")
def econ_save_settings(body: EconSettingsIn, db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    before = store.get_settings(db)
    patch = body.model_dump(exclude_none=True)
    if "countries" in patch:
        patch["countries"] = [c.strip().upper() for c in patch["countries"] if c.strip()]
        if not patch["countries"]:
            raise HTTPException(400, "至少保留一个国家 / Keep at least one country")
    after = store.save_settings(db, patch)
    log_change(db, admin.id, admin.id, f"setting:{store.SETTINGS_KEY}",
               json.dumps(before, ensure_ascii=False), json.dumps(after, ensure_ascii=False))
    db.commit()
    return after


@router.post("/sync")
async def econ_sync_now(admin: User = Depends(require_admin)):
    """立即同步一次（总开关关着也能用，用来试数据源）。约 2–3 次 Narwhal 调用。
    Sync once now (works with the switch off, for trying the source). About 2–3 Narwhal calls."""
    if not narwhal.configured():
        raise HTTPException(400, "未配置 NARWHAL_API_KEY / NARWHAL_API_KEY is not set")
    out = await run_in_threadpool(loop.run_once, True)
    if out.get("error"):
        raise HTTPException(502, out["error"])
    return out


def _group_payload(key: str, rows: list[EconRelease], preview: EconPreview | None) -> dict:
    first = rows[0]
    values = store.merged_values(rows)
    primary, _ = previews._group_primary(first.country, rows)
    primary_measure = preview.primary_measure if preview and preview.primary_measure else (
        primary.get("measure") if primary else None)
    statuses = {r.status for r in rows}
    status = "published" if "published" in statuses else ("cancelled" if statuses == {"cancelled"} else "scheduled")
    content = None
    if preview is not None and preview.content_json:
        try:
            content = json.loads(preview.content_json)
        except ValueError:
            content = None
    return {
        "key": key,
        "country": first.country,
        "currency": first.currency,
        "at": _iso(first.at),
        "date": first.date,
        "allDay": first.at is None,
        "indicative": all(r.indicative for r in rows),
        "importance": max(r.importance for r in rows),
        "status": status,
        "releases": [{"id": r.id, "name": r.name, "period": r.period, "status": r.status,
                      "actualSeenAt": _iso(r.actual_seen_at)} for r in rows],
        "values": values,
        "primaryMeasure": primary_measure,
        "outcome": previews.outcome_for(first.country, rows, primary_measure),
        "preview": None if preview is None else {
            "status": preview.status, "content": content, "error": preview.error, "attempts": preview.attempts,
            "model": preview.model, "generatedAt": _iso(preview.generated_at),
            "tokensIn": preview.tokens_in, "tokensOut": preview.tokens_out,
        },
    }


@router.get("/calendar")
def econ_calendar(
    start: date | None = None,
    days: int = Query(7, ge=1, le=14),
    minImportance: int = Query(rules.LOW, ge=rules.NONE, le=rules.HIGH),
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    """按组列出 [start, start+days) 的发布（UTC 日期），带合并后的数值、主指标结果和预案。
    Releases in [start, start+days) grouped, with merged figures, the primary result and the preview."""
    start = start or (store.utcnow().date() - timedelta(days=1))
    lo = datetime.combine(start, datetime.min.time())
    hi = lo + timedelta(days=days)
    rows = (db.query(EconRelease)
            .filter(((EconRelease.at >= lo) & (EconRelease.at < hi))
                    | ((EconRelease.at.is_(None)) & (EconRelease.date >= lo.date().isoformat())
                       & (EconRelease.date < hi.date().isoformat())))
            .order_by(EconRelease.at, EconRelease.country).all())
    groups: dict[str, list[EconRelease]] = {}
    for r in rows:
        key = r.group_key or f"{r.country}|{r.date}"
        groups.setdefault(key, []).append(r)
    keys = [k for k, members in groups.items() if max(m.importance for m in members) >= minImportance]
    prev = {p.group_key: p for p in db.query(EconPreview).filter(EconPreview.group_key.in_(keys)).all()} if keys else {}
    items = [_group_payload(k, groups[k], prev.get(k)) for k in keys]
    items.sort(key=lambda g: (g["at"] or (g["date"] or "") + "T00:00", g["country"]))
    return {"start": start.isoformat(), "days": days, "items": items}


@router.post("/previews/regenerate")
async def econ_regenerate(body: RegenerateIn, admin: User = Depends(require_admin)):
    """手动重写一组的预案（调一次 DeepSeek，计入每日用量）。/ Rewrite one group's preview (one model call)."""
    if not deepseek.configured():
        raise HTTPException(400, "未配置 DEEPSEEK_API_KEY / DEEPSEEK_API_KEY is not set")
    return await run_in_threadpool(_regenerate, body.groupKey)


def _regenerate(key: str) -> dict:
    from app.core.database import SessionLocal

    db = SessionLocal()
    try:
        rows = db.query(EconRelease).filter(EconRelease.group_key == key).all()
        if not rows or rows[0].at is None:
            raise HTTPException(404, "没有这组数据 / No such release group")
        primary, _ = previews._group_primary(rows[0].country, rows)
        if primary is None:
            raise HTTPException(400, "这组数据没有预期值，不写预案 / No consensus in this group, no preview")
        cfg = store.get_settings(db)
        if store.llm_calls_today() >= cfg["dailyLlmCap"]:
            raise HTTPException(429, "今天的模型调用已到上限 / Today's model-call cap is reached")
        existing = db.query(EconPreview).filter(EconPreview.group_key == key).first()
        if existing is not None:
            existing.consensus_sig = None   # 强制重写 / force a rewrite
        p = previews.generate(db, key, rows, store.utcnow())
        db.commit()
        return _group_payload(key, rows, p)
    finally:
        db.close()
