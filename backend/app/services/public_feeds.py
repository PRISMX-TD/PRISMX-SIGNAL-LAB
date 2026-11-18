"""全员同值的三份读数据：信号列表、多周期趋势、已公开策略的分析（带 shared_cache 缓存）。

原来写在 routers/signals.py、routers/trends.py 的端点函数里，游客预览（services/guest_preview）
要复用就只能反过来 import 路由层，违反「服务层不 import 路由层」（2026-11-18 审计）。现在算法
和缓存键都在这里，路由端点和游客预览都调这一份，口径与缓存仍只有一处。

The three everyone-gets-the-same reads, each behind shared_cache: the signal list, the
multi-timeframe trends, and the published-strategy analysis. They used to live inside the
signals / trends router endpoints, so guest_preview had to import the router layer (the
2026-11-18 audit). The logic and cache keys now live here; the endpoints and the guest
preview both call it, so there is still one definition and one cache.
"""
import hashlib
import json

from fastapi.encoders import jsonable_encoder
from sqlalchemy.orm import Session

from app.models import Signal, Trend
from app.schemas import SignalOut
from app.services import shared_cache
from app.services.settings_store import get_winrate_settings
from app.services.strategy_winrate import compute_strategy_session_winrate

# TTL 的取法见 routers/signals.py 顶部「读缓存」那段说明。
# How the TTLs were chosen: see the "read caches" note at the top of routers/signals.py.
LIST_CACHE_SECONDS = 10
ANALYSIS_CACHE_SECONDS = 60
TRENDS_CACHE_KEY = "trends:list"
TRENDS_CACHE_TTL = 10

# 用户端「策略分析」的窗口，与管理端设置页的 WINRATE_PUBLIC_DAYS 同值。
# 两处必须一致：管理员按设置页上的胜率决定公不公开，用户看到的得是同一个窗口
# 算出来的，否则勾选依据与展示结果对不上。
# The user-facing analysis window, equal to the admin settings page's
# WINRATE_PUBLIC_DAYS. They must match: an admin publishes based on the number on
# that page, so users have to be seeing the same window.
ANALYSIS_DAYS = 30


def list_signals_payload(db: Session, realtime: bool) -> dict:
    """信号列表负载（不含任何按用户个性化的字段，所以可以按等级共享缓存）。
    The list payload; nothing in it is per-user, so it is cached per tier."""
    query = db.query(Signal)
    if not realtime:
        query = query.filter(Signal.status == "EXPIRED")
    rows = query.order_by(Signal.created_at.desc()).limit(50).all()
    signals = [
        SignalOut(
            id=s.id,
            symbol=s.symbol,
            side=s.side,
            entry=s.entry,
            stopLoss=s.stop_loss,
            takeProfit=s.take_profit,
            indicator=s.indicator,
            status=s.status,
            createdAt=s.created_at,
            expireAt=s.expire_at,
            result=s.result or "PENDING",
            resolvedAt=s.resolved_at,
        )
        for s in rows
    ]
    return jsonable_encoder({"signals": signals})


def cached_signal_list(db: Session, realtime: bool) -> dict:
    """按等级缓存的信号列表。/ The signal list, cached per tier."""
    key = shared_cache.SIGNAL_LIST_KEY_REALTIME if realtime else shared_cache.SIGNAL_LIST_KEY_FREE
    return shared_cache.cached_json(key, LIST_CACHE_SECONDS, lambda: list_signals_payload(db, realtime))


def load_trends(db: Session) -> dict:
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


def cached_trends(db: Session) -> dict:
    """全员同值，缓存 10 秒，只靠 TTL 失效（见 routers/trends.py）。
    Identical for everyone, cached 10s, TTL-only invalidation (see routers/trends.py)."""
    return shared_cache.cached_json(TRENDS_CACHE_KEY, TRENDS_CACHE_TTL, lambda: load_trends(db))


def cached_strategy_analysis(db: Session) -> dict:
    """已公开策略的分时段 / 分品种 / 分钟点胜率，口径见 routers/signals.strategy_analysis。
    Published-strategy win rates; see routers/signals.strategy_analysis for the rules."""
    public = get_winrate_settings(db)["public_strategies"]
    # 公开名单进键：管理员改了名单就换一把键，新名单立即生效。取排序后的摘要，
    # 顺序不同的同一名单共用一份，名单里的任意字符也不会混进键名。
    # The published list is part of the key, so editing it switches keys at once.
    key = "signals:analysis:" + hashlib.sha1(
        json.dumps(sorted(public), ensure_ascii=False).encode("utf-8")).hexdigest()
    return shared_cache.cached_json(
        key, ANALYSIS_CACHE_SECONDS,
        # hide_live：还能下单的信号不进统计，否则按品种、按方向的 pending 计数会把它泄露给
        # FREE（2026-10-26 审计，见 compute_strategy_session_winrate）。
        # hide_live: still-tradeable signals stay out, or per-symbol / per-side pending
        # counts would leak them to FREE (2026-10-26 audit).
        lambda: jsonable_encoder(
            compute_strategy_session_winrate(db, ANALYSIS_DAYS, only_strategies=public, hide_live=True)),
    )
