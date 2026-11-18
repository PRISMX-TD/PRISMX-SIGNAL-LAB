"""多周期趋势路由 / Multi-timeframe trends router."""
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.models import User
from app.services import public_feeds
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
    return public_feeds.cached_trends(db)


# 算法与缓存键在 services/public_feeds（游客预览也用）。/ Logic and cache key live in services/public_feeds.
TRENDS_CACHE_KEY = public_feeds.TRENDS_CACHE_KEY
