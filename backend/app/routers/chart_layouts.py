"""图表布局（rev 57，表 chart_layouts）：用户存的整套图表布局，每人最多 30 份。
Chart layouts (rev 57, table chart_layouts): a user's saved chart layouts, at most 30 each.

  GET    /chart/layouts              → {layouts: [{id, name, data, createdAt, updatedAt}]}   新改的在前
  POST   /chart/layouts  {name, data} → layout
  PUT    /chart/layouts/{id} {name?, data?} → layout        别人的 / 不存在的 id 一律 404
  DELETE /chart/layouts/{id}         → {deleted: bool}       不存在时 deleted=false（不报错）

data 是前端自定的布局 JSON，后端不解析内容，只卡大小（紧凑序列化后 ≤64KB）。每次写入成功后给该用户
的所有在线连接推 CHART_LAYOUTS_UPDATE {id}，别的设备自己重拉列表。

data is a frontend-owned layout JSON, opaque here apart from the size cap (≤64KB compact). Every
successful write pushes CHART_LAYOUTS_UPDATE {id} to all of the user's connections; other devices
refetch the list.
"""
import json
import re
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from app.core.database import get_db
from app.core.strategy_limits import user_limiter
from app.models import ChartLayout
from app.routers.chart_drawings import _iso, _now_ms
from app.services.connection_manager import manager
from app.services.deps import get_current_user_id_light

router = APIRouter(prefix="/chart/layouts", tags=["chart"])

# 每个用户最多多少份布局 / max layouts per user
LAYOUTS_MAX = 30
# 单份布局 data（紧凑 JSON、UTF-8）的字节上限 / byte cap on one layout's data (compact, UTF-8)
LAYOUT_DATA_MAX_BYTES = 64 * 1024
NAME_MAX = 60

# 与画线同一套按用户限流 / same per-user limits as drawings
LAYOUTS_WRITE_RATE_LIMIT = "60/minute"
LAYOUTS_READ_RATE_LIMIT = "180/minute"

WS_EVENT = "CHART_LAYOUTS_UPDATE"

# 布局 id：服务端生成的 uuid；放宽到字母数字和 -，挡掉路径里乱七八糟的东西。
# Layout ids are server-made uuids; anything else is treated as not found.
_ID_RE = re.compile(r"^[A-Za-z0-9-]{1,64}$")

_NOT_FOUND = "布局不存在 / layout not found"


def _clean_name(name: str | None) -> str:
    n = (name or "").strip()
    if not n:
        raise HTTPException(status_code=422, detail="布局名称不能为空 / layout name is required")
    if len(n) > NAME_MAX:
        raise HTTPException(
            status_code=422,
            detail=f"布局名称最长 {NAME_MAX} 个字符 / layout name is at most {NAME_MAX} characters",
        )
    return n


def encode_layout_data(data: Any) -> str:
    """紧凑序列化并卡大小（413）。NaN / Infinity 拒掉（422），否则浏览器下次读不出来。
    Serialise compactly and enforce the size cap (413); NaN / Infinity are rejected (422) since the
    browser's JSON.parse could not read them back."""
    try:
        encoded = json.dumps(data, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    except ValueError:
        raise HTTPException(
            status_code=422, detail="布局数据含无效数值 / layout data contains invalid numbers (NaN / Infinity)",
        ) from None
    if len(encoded.encode("utf-8")) > LAYOUT_DATA_MAX_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"布局数据过大（上限 {LAYOUT_DATA_MAX_BYTES // 1024}KB）/ "
                   f"layout data too large (max {LAYOUT_DATA_MAX_BYTES // 1024}KB)",
        )
    return encoded


def layout_out(row: ChartLayout) -> dict:
    try:
        data = json.loads(row.data) if row.data is not None else None
    except (TypeError, ValueError):
        data = None
    return {
        "id": row.id,
        "name": row.name,
        "data": data,
        "createdAt": _iso(row.created_at),
        "updatedAt": _iso(row.updated_at),
    }


class LayoutIn(BaseModel):
    # 名称的空白与长度规则在 _clean_name 里给中英文提示；这里只粗卡，挡掉超大请求体。
    # The trim/length rule and its bilingual message live in _clean_name; this is a coarse bound.
    name: str = Field(max_length=500)
    data: Any = None


class LayoutPatch(BaseModel):
    name: str | None = Field(default=None, max_length=500)
    data: Any = None


# ---------------------------------------------------------------- 同步实现（线程池里跑）/ sync bodies

def list_layouts_sync(db: Session, user_id: str) -> list[dict]:
    rows = (
        db.query(ChartLayout)
        .filter(ChartLayout.user_id == user_id)
        .order_by(ChartLayout.updated_at.desc())
        .limit(LAYOUTS_MAX)
        .all()
    )
    return [layout_out(r) for r in rows]


def create_layout_sync(db: Session, user_id: str, name: str, encoded: str) -> dict:
    n = db.query(func.count(ChartLayout.id)).filter(ChartLayout.user_id == user_id).scalar() or 0
    if n >= LAYOUTS_MAX:
        raise HTTPException(
            status_code=409,
            detail=f"最多保存 {LAYOUTS_MAX} 份布局，先删掉一些 / at most {LAYOUTS_MAX} layouts; delete some first",
        )
    now = _now_ms()
    row = ChartLayout(user_id=user_id, name=name, data=encoded, created_at=now, updated_at=now)
    db.add(row)
    db.commit()
    db.refresh(row)
    return layout_out(row)


def update_layout_sync(db: Session, user_id: str, layout_id: str, values: dict) -> dict:
    row = (
        db.query(ChartLayout)
        .filter(ChartLayout.id == layout_id, ChartLayout.user_id == user_id)
        .first()
    )
    if row is None:
        raise HTTPException(status_code=404, detail=_NOT_FOUND)
    for k, v in values.items():
        setattr(row, k, v)
    row.updated_at = _now_ms()
    db.commit()
    db.refresh(row)
    return layout_out(row)


def delete_layout_sync(db: Session, user_id: str, layout_id: str) -> bool:
    n = (
        db.query(ChartLayout)
        .filter(ChartLayout.id == layout_id, ChartLayout.user_id == user_id)
        .delete(synchronize_session=False)
    )
    db.commit()
    return bool(n)


async def _push(user_id: str, layout_id: str) -> None:
    await manager.push_to_client(user_id, {"type": WS_EVENT, "data": {"id": layout_id}})


# ---------------------------------------------------------------- 接口 / endpoints

@router.get("")
@user_limiter.limit(LAYOUTS_READ_RATE_LIMIT)
def list_layouts(
    request: Request,
    db: Session = Depends(get_db),
    user_id: str = Depends(get_current_user_id_light),
):
    """当前用户的全部布局（新改的在前）。普通 def：同步查库走线程池。
    All of the user's layouts, most recently changed first. A plain def so the query runs off the loop."""
    return {"layouts": list_layouts_sync(db, user_id)}


@router.post("")
@user_limiter.limit(LAYOUTS_WRITE_RATE_LIMIT)
async def create_layout(
    request: Request,
    body: LayoutIn,
    db: Session = Depends(get_db),
    user_id: str = Depends(get_current_user_id_light),
):
    name = _clean_name(body.name)
    encoded = encode_layout_data(body.data)
    out = await run_in_threadpool(create_layout_sync, db, user_id, name, encoded)
    await _push(user_id, out["id"])
    return out


@router.put("/{layout_id}")
@user_limiter.limit(LAYOUTS_WRITE_RATE_LIMIT)
async def update_layout(
    request: Request,
    layout_id: str,
    body: LayoutPatch,
    db: Session = Depends(get_db),
    user_id: str = Depends(get_current_user_id_light),
):
    """改名和 / 或整份替换 data。两个都不带是 422。data 显式传 null 也算「替换成 null」。
    Rename and/or replace data; neither is a 422. An explicit null data replaces it with null."""
    if not _ID_RE.match(layout_id):
        raise HTTPException(status_code=404, detail=_NOT_FOUND)
    fields = body.model_fields_set
    values: dict = {}
    if "name" in fields:
        values["name"] = _clean_name(body.name)
    if "data" in fields:
        values["data"] = encode_layout_data(body.data)
    if not values:
        raise HTTPException(status_code=422, detail="没有要修改的内容 / nothing to update (name or data)")
    out = await run_in_threadpool(update_layout_sync, db, user_id, layout_id, values)
    await _push(user_id, out["id"])
    return out


@router.delete("/{layout_id}")
@user_limiter.limit(LAYOUTS_WRITE_RATE_LIMIT)
async def delete_layout(
    request: Request,
    layout_id: str,
    db: Session = Depends(get_db),
    user_id: str = Depends(get_current_user_id_light),
):
    """删一份布局。不存在（或不是自己的）返回 deleted=false，不报错、不推送。
    Delete one layout. Missing (or someone else's) gives deleted=false with no push."""
    if not _ID_RE.match(layout_id):
        return {"deleted": False}
    deleted = await run_in_threadpool(delete_layout_sync, db, user_id, layout_id)
    if deleted:
        await _push(user_id, layout_id)
    return {"deleted": deleted}
