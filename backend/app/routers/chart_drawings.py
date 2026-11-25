"""图表画线：每个用户每个品种一行（rev 55，表 chart_drawings）。
Chart drawings: one row per user and symbol (rev 55, table chart_drawings).

以前画线放在 /auth/prefs 的 chartDraw 命名空间里：那份文档每次登录整份读回、每次保存整份推给所有
在线设备，单个命名空间 256KB、整份 1MB 封顶。画线工具扩到近百种之后放不下，也太费流量，于是单独
成表、单独的接口：

  GET  /chart/drawings?symbol=XAUUSD  → {symbol, drawings, updatedAt}   没有行时 drawings=[]、updatedAt=null
  PUT  /chart/drawings  {symbol, drawings} → {symbol, updatedAt}        空数组 = 删掉这一行（updatedAt=null）
  GET  /chart/drawings/symbols        → {symbols: [{symbol, count, updatedAt}]}  不读 data 列

保存成功后给该用户的所有在线连接推 CHART_DRAWINGS_UPDATE {symbol, updatedAt}，**不带画线本身**：
别的设备要是正开着这个品种，自己再 GET 一次；没开着的什么都不用做。

Drawings used to sit in the chartDraw namespace of /auth/prefs, a document read back whole at
every login, pushed whole to every online device on every save, and capped at 256KB per
namespace / 1MB in total. With the drawing tools growing toward ~100 that neither fits nor is
cheap, hence a table and endpoints of their own (shapes above). A successful save pushes
CHART_DRAWINGS_UPDATE {symbol, updatedAt} to all of the user's connections with no drawing
payload: a device showing that symbol refetches, the rest ignore it.

流量（Supabase egress 曾是最大的一笔开销）：三个接口都只选需要的列，symbols 不碰 data；鉴权用
get_current_user_id_light（不查 users 表）；保存时不读旧的 data，直接按 id 覆盖。
Egress (Supabase egress was a top cost): every query selects only the columns it needs, the
symbol list never touches data, auth uses get_current_user_id_light (no users query), and a
save overwrites by id without reading the old data first.
"""
import json
import re
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from app.core.database import get_db
from app.core.strategy_limits import user_limiter
from app.models import ChartDrawing
from app.services.connection_manager import manager
from app.services.deps import get_current_user_id_light

router = APIRouter(prefix="/chart/drawings", tags=["chart"])

# 单个品种画线 JSON（紧凑序列化、UTF-8）的字节上限。默认请求体上限是 1MB（admission.body_budget），
# 这里更紧：一个品种上 500 个画线对象，每个 1KB 也才 500KB。
# Byte cap on one symbol's drawings JSON (compact, UTF-8). Tighter than the 1MB default body
# budget: even 500 drawings at 1KB each stay under it.
DRAWINGS_MAX_BYTES = 512 * 1024
# 单个品种最多多少个画线对象 / max drawing objects per symbol
DRAWINGS_MAX_COUNT = 500
# 每个用户最多多少个品种有画线（行数上限）/ max symbol rows per user
DRAWINGS_MAX_SYMBOLS = 300
# 品种名：字母、数字、. _ - #，1~64 个字符（券商后缀如 XAUUSD.m、US30#）。不转大写——前端用什么
# 键存就按什么键取，转了反而和本地已有的键对不上。
# Symbol: letters, digits and . _ - #, 1-64 chars (broker suffixes like XAUUSD.m, US30#). Not
# upper-cased: whatever key the frontend saves under is the key it reads back.
_SYMBOL_RE = re.compile(r"^[A-Za-z0-9._#-]{1,64}$")

# 按用户限流（与 chart.py 的 /chart/history 同一个 user_limiter）。写：正常画线是松手才保存，
# 前端再加防抖，一分钟远到不了 60 次；读：切品种一次一读，加上别的设备改动后的重拉。
# Per-user limits (same user_limiter as /chart/history). Writes: a drawing saves on release and
# the frontend debounces, nowhere near 60 a minute; reads: one per symbol switch plus refetches
# after another device's change.
DRAWINGS_WRITE_RATE_LIMIT = "60/minute"
DRAWINGS_READ_RATE_LIMIT = "180/minute"

WS_EVENT = "CHART_DRAWINGS_UPDATE"


def _check_symbol(symbol: str) -> str:
    if not isinstance(symbol, str) or not _SYMBOL_RE.match(symbol):
        raise HTTPException(
            status_code=422,
            detail="品种名无效（仅限字母、数字和 . _ - #，最长 64 个字符）/ "
                   "invalid symbol (letters, digits and . _ - # only, up to 64 characters)",
        )
    return symbol


def _iso(dt: datetime | None) -> str | None:
    """库里的时间都是 UTC；SQLite / Postgres 的 TIMESTAMP 读回来不带时区，按 UTC 看。统一到毫秒，
    PUT 的返回、WS 推送和之后的 GET 拿到的是同一个字符串，前端可以直接比较。
    Stored times are UTC (naive on read-back from SQLite / Postgres TIMESTAMP). Millisecond
    precision everywhere, so the PUT response, the WS push and a later GET give the same string."""
    if dt is None:
        return None
    if dt.tzinfo is not None:
        dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
    return dt.isoformat(timespec="milliseconds") + "Z"


def _now_ms() -> datetime:
    """当前 UTC 时间截到毫秒再落库，读回来格式化的结果才和这次返回的一致。
    Now in UTC truncated to milliseconds before storing, so a read-back formats identically."""
    now = datetime.now(timezone.utc)
    return now.replace(microsecond=now.microsecond // 1000 * 1000)


class DrawingsIn(BaseModel):
    # 长度先粗卡，具体规则（字符集）在 _check_symbol 里给出中英文提示。
    # Coarse length bound here; the character rule and its bilingual message are in _check_symbol.
    symbol: str = Field(min_length=1, max_length=64)
    # 画线对象数组，后端不解析内容。数量上限在路由里查，好给出中英文提示。
    # The array of drawing objects, opaque to the backend. The count cap is checked in the route
    # so it can carry a bilingual message.
    drawings: list[dict] = Field(default_factory=list)


def encode_drawings(drawings: list[dict]) -> str:
    """校验数量与大小并序列化成紧凑 JSON。超限抛 HTTPException（数量 422、大小 413）。
    allow_nan=False：Python 的 json 能解析 NaN / Infinity，原样存进去的话浏览器的 JSON.parse 会在
    下一次 GET 时整份读不出来，所以这里直接拒。
    Validate count and size, then serialise compactly. Raises 422 (count) or 413 (size).
    allow_nan=False: Python's json accepts NaN / Infinity, and storing them would make the next GET
    unparseable by the browser's JSON.parse, so they are rejected here."""
    if len(drawings) > DRAWINGS_MAX_COUNT:
        raise HTTPException(
            status_code=422,
            detail=f"单个品种最多 {DRAWINGS_MAX_COUNT} 个画线 / at most {DRAWINGS_MAX_COUNT} drawings per symbol",
        )
    try:
        encoded = json.dumps(drawings, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    except ValueError:
        raise HTTPException(
            status_code=422, detail="画线数据含无效数值 / drawings contain invalid numbers (NaN / Infinity)",
        ) from None
    if len(encoded.encode("utf-8")) > DRAWINGS_MAX_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"画线数据过大（单个品种上限 {DRAWINGS_MAX_BYTES // 1024}KB）/ "
                   f"drawings too large (max {DRAWINGS_MAX_BYTES // 1024}KB per symbol)",
        )
    return encoded


def save_drawings(db: Session, user_id: str, symbol: str, encoded: str, count: int) -> datetime | None:
    """保存一个品种的画线（覆盖），返回新的 updated_at；count 为 0 时删掉这一行并返回 None。
    阻塞的同步函数（调用方放线程池）。拆成模块级函数是为了让测试能直接驱动（理由同 account.save_prefs）。

    不读旧的 data：只按 (user_id, symbol) 取 id，再按 id 直接 UPDATE。两台设备同时保存同一个品种
    就是后写的赢——整组覆盖的语义本来如此，WS 推送会让输的那台重拉到赢的那份。两台同时**新建**同一行
    时后到的会撞唯一约束，回滚后改走 UPDATE。

    Save (overwrite) one symbol's drawings and return the new updated_at; count 0 deletes the row and
    returns None. Blocking; callers use a thread pool. Module-level so tests can drive it directly (same
    reason as account.save_prefs). The old data is never read: fetch the id, then UPDATE by id. Two
    devices saving the same symbol at once means last write wins, which is the whole-array semantics
    anyway, and the WS push makes the loser refetch. Two devices *creating* the same row at once: the
    later insert hits the unique constraint, rolls back and updates instead.
    """
    row_id = (
        db.query(ChartDrawing.id)
        .filter(ChartDrawing.user_id == user_id, ChartDrawing.symbol == symbol)
        .scalar()
    )
    if count == 0:
        if row_id is not None:
            db.query(ChartDrawing).filter(ChartDrawing.id == row_id).delete(synchronize_session=False)
            db.commit()
        return None

    now = _now_ms()
    values = {"data": encoded, "count": count, "updated_at": now}
    if row_id is not None:
        db.query(ChartDrawing).filter(ChartDrawing.id == row_id).update(values, synchronize_session=False)
        db.commit()
        return now

    # 新增一行才数行数：覆盖已有品种不增加行数。/ Only a new row counts against the symbol cap.
    n_rows = (
        db.query(func.count(ChartDrawing.id)).filter(ChartDrawing.user_id == user_id).scalar() or 0
    )
    if n_rows >= DRAWINGS_MAX_SYMBOLS:
        raise HTTPException(
            status_code=422,
            detail=f"最多在 {DRAWINGS_MAX_SYMBOLS} 个品种上保存画线 / "
                   f"drawings can be saved on at most {DRAWINGS_MAX_SYMBOLS} symbols",
        )
    db.add(ChartDrawing(user_id=user_id, symbol=symbol, created_at=now, **values))
    try:
        db.commit()
    except IntegrityError:
        # 另一个请求刚建了同一行 / another request just created the same row
        db.rollback()
        db.query(ChartDrawing).filter(
            ChartDrawing.user_id == user_id, ChartDrawing.symbol == symbol
        ).update(values, synchronize_session=False)
        db.commit()
    return now


@router.get("")
@user_limiter.limit(DRAWINGS_READ_RATE_LIMIT)
def get_drawings(
    request: Request,
    symbol: str = Query(max_length=64),
    db: Session = Depends(get_db),
    user_id: str = Depends(get_current_user_id_light),
):
    """读一个品种的画线。只选 data、updated_at 两列；没有行时返回空数组。
    普通 def：同步查库，FastAPI 放线程池跑，不占事件循环。
    One symbol's drawings. Selects data and updated_at only; no row gives an empty list.
    A plain def so the blocking query runs on the thread pool, not the event loop."""
    sym = _check_symbol(symbol)
    row = (
        db.query(ChartDrawing.data, ChartDrawing.updated_at)
        .filter(ChartDrawing.user_id == user_id, ChartDrawing.symbol == sym)
        .first()
    )
    if row is None:
        return {"symbol": sym, "drawings": [], "updatedAt": None}
    try:
        drawings = json.loads(row[0] or "[]")
    except (json.JSONDecodeError, TypeError):
        drawings = []
    if not isinstance(drawings, list):
        drawings = []
    return {"symbol": sym, "drawings": drawings, "updatedAt": _iso(row[1])}


@router.get("/symbols")
@user_limiter.limit(DRAWINGS_READ_RATE_LIMIT)
def list_drawing_symbols(
    request: Request,
    db: Session = Depends(get_db),
    user_id: str = Depends(get_current_user_id_light),
):
    """当前用户有画线的品种（新改的在前），带画线个数与更新时间。**不读 data 列**。
    Symbols the user has drawings on (most recently changed first), with count and updatedAt.
    Never reads the data column."""
    rows = (
        db.query(ChartDrawing.symbol, ChartDrawing.count, ChartDrawing.updated_at)
        .filter(ChartDrawing.user_id == user_id)
        .order_by(ChartDrawing.updated_at.desc())
        .limit(DRAWINGS_MAX_SYMBOLS)
        .all()
    )
    return {
        "symbols": [
            {"symbol": r[0], "count": int(r[1] or 0), "updatedAt": _iso(r[2])} for r in rows
        ]
    }


@router.put("")
@user_limiter.limit(DRAWINGS_WRITE_RATE_LIMIT)
async def put_drawings(
    request: Request,
    body: DrawingsIn,
    db: Session = Depends(get_db),
    user_id: str = Depends(get_current_user_id_light),
):
    """整组覆盖保存一个品种的画线；空数组删除这一行。成功后推 CHART_DRAWINGS_UPDATE 给该用户的
    所有在线连接（含发起保存的这台——前端拿 updatedAt 和自己这次 PUT 的返回比，相同就忽略）。
    Overwrite one symbol's drawings; an empty list deletes the row. On success push
    CHART_DRAWINGS_UPDATE to all of the user's connections (the saving device included — the
    frontend compares updatedAt with its own PUT response and ignores a match)."""
    sym = _check_symbol(body.symbol)
    encoded = encode_drawings(body.drawings)
    updated = await run_in_threadpool(save_drawings, db, user_id, sym, encoded, len(body.drawings))
    updated_at = _iso(updated)
    await manager.push_to_client(user_id, {"type": WS_EVENT, "data": {"symbol": sym, "updatedAt": updated_at}})
    return {"symbol": sym, "updatedAt": updated_at}
