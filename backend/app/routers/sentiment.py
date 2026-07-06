"""社区情绪路由：只读后端缓存，从不在请求路径上现抓（见 sentiment_store.py）。
Community sentiment router: reads the backend cache only, never fetches on
the request path (see sentiment_store.py)."""
from fastapi import APIRouter, Depends

from app.models import User
from app.services import sentiment_store
from app.services.deps import get_current_user

router = APIRouter(prefix="/sentiment", tags=["sentiment"])


@router.get("", response_model=dict)
def get_sentiment(user: User = Depends(get_current_user)):
    """当前缓存的各品种多空比；stale=true 表示上一次刷新失败，数据为之前的旧值。
    Cached long/short percentages per symbol; stale=true means the last
    refresh failed and this is a previous (older) value."""
    return sentiment_store.get_sentiment()
