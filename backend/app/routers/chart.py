"""图表行情路由：喂价器写入 K 线 + 前端读取 K 线。
Chart market-data router: the feeder writes candles, the frontend reads them.

写入（/feed/candles）由独立的 Windows 喂价器程序调用，用 X-Feed-Token 头鉴权
（不是用户，没有 JWT）。读取（/chart/history、/chart/latest）复用站内登录态，
与 ChartsPage 的其它接口一致。详见 CHART_SELFHOST_PLAN.md。

Writes (/feed/candles) are called by the standalone Windows feeder program,
authenticated via the X-Feed-Token header (it's not a user, no JWT). Reads
(/chart/history, /chart/latest) reuse the site's normal login, consistent
with ChartsPage's other endpoints. See CHART_SELFHOST_PLAN.md for context.
"""
import secrets

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from pydantic import BaseModel, Field

from app.core.config import settings
from app.models import User
from app.services import chart_store
from app.services.deps import get_current_user

router = APIRouter(tags=["chart"])

# 前端 ChartsPage 的周期 code 集合，须与 chart_feeder.py 的 INTERVAL_TF 保持一致。
# Frontend ChartsPage's interval codes; must match chart_feeder.py's INTERVAL_TF.
ALLOWED_INTERVALS = {"1", "5", "15", "60", "240", "D"}


# ---------- 喂价器写入 / feeder write ----------
class FeedBar(BaseModel):
    t: int
    o: float
    h: float
    l: float
    c: float


class FeedSeries(BaseModel):
    symbol: str = Field(max_length=32)
    interval: str
    bars: list[FeedBar] = []


class FeedRequest(BaseModel):
    mode: str  # "backfill" | "tick"
    series: list[FeedSeries] = []


@router.post("/feed/candles")
async def feed_candles(req: FeedRequest, x_feed_token: str | None = Header(default=None)):
    """喂价器上报 K 线：mode=backfill 整段替换，mode=tick 合并最新几根。
    Feeder reports candles: mode=backfill replaces the full series, mode=tick
    merges the latest few bars."""
    if not settings.FEED_TOKEN or not x_feed_token or not secrets.compare_digest(
        x_feed_token.encode("utf-8"), settings.FEED_TOKEN.encode("utf-8")
    ):
        raise HTTPException(status_code=401, detail="invalid feed token")
    for s in req.series:
        if s.interval not in ALLOWED_INTERVALS:
            continue
        bars = [b.model_dump() for b in s.bars]
        if req.mode == "backfill":
            chart_store.replace_series(s.symbol.upper(), s.interval, bars)
        else:
            chart_store.merge_bars(s.symbol.upper(), s.interval, bars)
    return {"ok": True}


# ---------- 前端读取 / frontend read ----------
@router.get("/chart/history")
async def chart_history(
    symbol: str = Query(max_length=32),
    interval: str = Query(),
    limit: int = Query(default=500, ge=1, le=chart_store.MAX_BARS),
    user: User = Depends(get_current_user),
):
    if interval not in ALLOWED_INTERVALS:
        raise HTTPException(status_code=400, detail="bad interval")
    return {
        "symbol": symbol.upper(),
        "interval": interval,
        "bars": chart_store.get_history(symbol.upper(), interval, limit),
    }


@router.get("/chart/latest")
async def chart_latest(
    symbol: str = Query(max_length=32),
    interval: str = Query(),
    user: User = Depends(get_current_user),
):
    if interval not in ALLOWED_INTERVALS:
        raise HTTPException(status_code=400, detail="bad interval")
    return chart_store.get_latest(symbol.upper(), interval)
