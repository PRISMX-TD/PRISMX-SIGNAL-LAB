"""多周期趋势路由 / Multi-timeframe trends router."""
import json

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.models import Trend, User
from app.services import shared_cache
from app.services.deps import get_current_user

router = APIRouter(prefix="/trends", tags=["trends"])


@router.get("", response_model=dict)
def list_trends(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """获取所有品种的最新多周期趋势快照 / list latest trend snapshots for all symbols.

    全员同值，结果放进 shared_cache 10 秒（多 worker 共享）：重连风暴时 N 次整表读 + 逐行
    json.loads 变成 1 次。**只靠 TTL 失效**——不在 webhook 每 5 秒 delete 一次键（那只会
    多出无意义的 Redis 写；趋势本身没变时 webhook 也已经不写库了）。
    Identical for everyone, cached 10s in shared_cache: a reconnect storm's N full-table
    reads + per-row json.loads become one. TTL-only invalidation — the webhook does not
    delete the key every 5s (that would only add pointless Redis writes).
    """
    return shared_cache.cached_json(TRENDS_CACHE_KEY, TRENDS_CACHE_TTL, lambda: _load_trends(db))


TRENDS_CACHE_KEY = "trends:list"
TRENDS_CACHE_TTL = 10


def _load_trends(db: Session) -> dict:
    rows = db.query(Trend).all()
    trends = []
    for r in rows:
        try:
            tf_map = json.loads(r.timeframes or "{}")
        except (ValueError, TypeError):
            tf_map = {}
        trends.append(
            {
                "symbol": r.symbol,
                "timeframes": tf_map,
                "updatedAt": r.updated_at.isoformat() if r.updated_at else None,
            }
        )
    return {"trends": trends}
