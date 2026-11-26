"""财经日历的用户端接口（2026-11-21 对登录用户开放）：只读的日历列表，带公布前预案。
设置、同步、生成预案都留在管理接口（admin_econ）。管理员在设置里关掉「对用户开放」后这里返回空。

返回的内容对所有用户相同，按参数缓存 60 秒（进程内）：仪表盘卡片每个在线用户 5 分钟拉一次，
不必每次都查库。预案只带写好的正文，不带模型名、token 数、失败原因这些管理信息。

Read-only calendar for signed-in users, with the pre-release previews. Settings, sync and generation
stay on the admin router. With "open to users" switched off this returns nothing. The payload is the
same for everyone, so it is cached per parameter set for 60s in-process. Previews carry only the
finished text, never the model name, token counts or failure reasons.
"""
import time
from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.models import User
from app.routers.admin_econ import list_groups
from app.services.deps import get_current_user
from app.services.econ import rules, store

router = APIRouter(prefix="/econ", tags=["econ"])

CACHE_SECONDS = 60
MAX_SPAN_DAYS = 120   # 与库里保留的天数一致 / matches the retention window
_cache: dict[tuple, tuple[float, dict]] = {}


def _public_group(g: dict) -> dict:
    p = g.get("preview")
    ok = p is not None and p.get("status") == "ok" and p.get("content")
    return {
        **g,
        "releases": [{"name": r["name"], "period": r["period"]} for r in g["releases"]],
        "preview": {"status": "ok", "content": p["content"]} if ok else None,
    }


def clear_cache() -> None:
    _cache.clear()


def calendar_payload(db: Session, start: date | None, days: int, minImportance: int) -> dict:
    """登录用户和游客预览共用：参数校验 + 60 秒缓存 / shared by signed-in users and the guest preview."""
    today = store.utcnow().date()
    start = start or (today - timedelta(days=1))
    if abs((start - today).days) > MAX_SPAN_DAYS:
        raise HTTPException(400, "日期超出范围 / Date out of range")
    key = (start, days, minImportance)
    hit = _cache.get(key)
    now = time.monotonic()
    if hit and now - hit[0] < CACHE_SECONDS:
        return hit[1]
    if not store.get_settings(db)["public"]:
        out = {"public": False, "start": start.isoformat(), "days": days, "items": []}
    else:
        out = {"public": True, "start": start.isoformat(), "days": days,
               "items": [_public_group(g) for g in list_groups(db, start, days, minImportance)]}
    if len(_cache) > 200:   # 参数组合有限，这里只防意外增长 / bounded parameter space; guard anyway
        _cache.clear()
    _cache[key] = (now, out)
    return out


@router.get("/calendar")
def econ_calendar(
    start: date | None = None,
    days: int = Query(7, ge=1, le=14),
    minImportance: int = Query(rules.LOW, ge=rules.LOW, le=rules.HIGH),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    return calendar_payload(db, start, days, minImportance)
