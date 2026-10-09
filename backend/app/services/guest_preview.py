"""游客预览（2026-10-09）：未登录访客首页那块「带锁的仪表盘」的数据与漏斗计数。

数据是一份**全员同值**的快照，放进 shared_cache 3 秒——广告落地的流量再大，回源也只是
每 3 秒一次，而且每一段都复用现有的缓存（信号列表、趋势、策略分析各有自己的共享缓存，
报价 / 品种 / 情绪是内存读），唯一新增的查询是「近 24 小时信号数」那一条走索引的计数。

**活跃信号的价位在这里抹掉**：entry / stopLoss / takeProfit 置 None，只留盈亏比与风险｜
回报尺的比例（locked）——这两个数推不出任何价位。前端的磨砂数字是随机生成的，真实价位
从来不出服务器。已过期的信号原样给（FREE 用户本来就看得到它们的全部内容）。

Guest preview (2026-10-09): data and funnel counters for the locked dashboard a logged-out
visitor sees on the home page. The data is one snapshot identical for everyone, kept in
shared_cache for 3 seconds, and every section reuses an existing cache (signal lists,
trends and strategy analysis have their own; quotes / symbols / sentiment are in-memory),
so the only new query is the indexed 24-hour signal count. **Active-signal prices are
stripped here**: entry / stopLoss / takeProfit become None and only the R:R and the
risk|reward split survive (`locked`), which reveal no price level. Expired signals are
passed through untouched — FREE users already see everything on them.
"""
import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models import GuestPreviewFunnelDaily, Signal
from app.routers import signals as signals_router
from app.routers import trends as trends_router
from app.services import quotes_store, sentiment_store, shared_cache

logger = logging.getLogger("prismx.guest_preview")

PREVIEW_CACHE_KEY = "guest-preview:live"
PREVIEW_CACHE_TTL = 3
RECENT_LIMIT = 6
STATS_HOURS = 24

FUNNEL_MODES = frozenset({"preview", "landing"})
FUNNEL_STEPS = frozenset({"view", "gate", "cta", "signup"})
FUNNEL_DAYS = 30


def _risk_split(entry, stop_loss, take_profit) -> tuple[float | None, float | None]:
    """盈亏比与尺的风险占比，口径与前端 calcRiskReward / riskFraction 一致（含 8%–92% 夹逼）。
    R:R and the rule's risk share, matching the frontend's calcRiskReward / riskFraction
    (including the 8%–92% clamp)."""
    if entry is None or stop_loss is None or take_profit is None:
        return None, None
    risk = abs(entry - stop_loss)
    reward = abs(take_profit - entry)
    rr = round(reward / risk, 2) if risk > 0 else None
    total = risk + reward
    frac = round(min(0.92, max(0.08, risk / total)), 3) if total > 0 else None
    return rr, frac


def mask_signal(sig: dict) -> dict:
    """抹掉一条活跃信号的价位，换上 locked。/ Strip an active signal's prices for `locked`."""
    rr, frac = _risk_split(sig.get("entry"), sig.get("stopLoss"), sig.get("takeProfit"))
    out = dict(sig)
    out["entry"] = None
    out["stopLoss"] = None
    out["takeProfit"] = None
    out["locked"] = {"rr": rr, "riskFrac": frac}
    return out


def _parse(ts) -> datetime | None:
    if not ts:
        return None
    try:
        d = datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
    except ValueError:
        return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def _still_active(sig: dict, now: datetime) -> bool:
    """状态 ACTIVE 且没过失效时刻。过期扫描每 5 秒一次，这里按时间再判一遍，免得把刚过期
    还没被扫到的那条当成「进行中」锁着给出去。
    ACTIVE and not past its expiry. The sweep runs every 5s, so time is checked again here
    rather than serving a just-expired, not-yet-swept signal as live."""
    if sig.get("status") != "ACTIVE":
        return False
    exp = _parse(sig.get("expireAt"))
    return exp is None or exp > now


def _signal_list(db: Session, realtime: bool) -> list[dict]:
    key = shared_cache.SIGNAL_LIST_KEY_REALTIME if realtime else shared_cache.SIGNAL_LIST_KEY_FREE
    payload = shared_cache.cached_json(
        key, signals_router._LIST_CACHE_SECONDS,
        lambda: signals_router._list_signals_payload(db, realtime))
    return list(payload.get("signals") or [])


def _recent_stats(db: Session, now: datetime) -> dict:
    since = now - timedelta(hours=STATS_HOURS)
    rows = (db.query(Signal.result, func.count(Signal.id))
              .filter(Signal.created_at >= since)
              .group_by(Signal.result)
              .all())
    by = {r or "PENDING": int(c) for r, c in rows}
    return {
        "hours": STATS_HOURS,
        "issued": sum(by.values()),
        "hitTp": by.get("HIT_TP", 0),
        "hitSl": by.get("HIT_SL", 0),
    }


def _compute(db: Session) -> dict:
    now = datetime.now(timezone.utc)
    active = [mask_signal(s) for s in _signal_list(db, True) if _still_active(s, now)]
    recent = _signal_list(db, False)[:RECENT_LIMIT]
    trends = trends_router.list_trends(user=None, db=db).get("trends") or []
    senti = sentiment_store.get_sentiment() or {}
    return {
        "symbols": quotes_store.get_active_symbols(),
        "quotes": quotes_store.get_all(),
        "trends": trends,
        "sentiment": senti.get("sentiment") or {},
        "active": active,
        "recent": recent,
        "recentStats": _recent_stats(db, now),
    }


def build_preview_payload(db: Session) -> dict:
    return shared_cache.cached_json(PREVIEW_CACHE_KEY, PREVIEW_CACHE_TTL, lambda: _compute(db))


def build_analysis_payload(db: Session) -> dict:
    """「当前时段胜率」卡要的那份策略分析：与登录后 /signals/strategy-analysis 同一个函数、
    同一把缓存键（只含已公开策略）。单独一个接口、页面只取一次——它比实时快照大得多，
    不该跟着 4 秒一次的轮询反复下发。
    The strategy analysis behind the session win-rate card: the same function and cache key
    as the signed-in /signals/strategy-analysis (published strategies only). Its own endpoint,
    fetched once per page — it is far larger than the live snapshot and must not ride the
    4-second poll."""
    return signals_router.strategy_analysis(_user=None, db=db)


def record_event(db: Session, mode: str, step: str, day: str | None = None) -> bool:
    """漏斗 +1。模式、步骤都走白名单；并发撞唯一键时在 SAVEPOINT 里回滚再原子 +1（同
    record_funnel_event）。返回是否计入。
    Bump a funnel counter. Mode and step are allow-listed; a concurrent insert hitting the
    unique key rolls back its SAVEPOINT and falls back to the atomic +1 (as in
    record_funnel_event). Returns whether it counted."""
    if mode not in FUNNEL_MODES or step not in FUNNEL_STEPS:
        return False
    day = day or datetime.now(timezone.utc).strftime("%Y-%m-%d")
    match = (GuestPreviewFunnelDaily.day == day, GuestPreviewFunnelDaily.mode == mode,
             GuestPreviewFunnelDaily.step == step)

    def bump() -> int:
        return (db.query(GuestPreviewFunnelDaily).filter(*match)
                  .update({GuestPreviewFunnelDaily.count: GuestPreviewFunnelDaily.count + 1},
                          synchronize_session=False))

    if not bump():
        try:
            with db.begin_nested():
                db.add(GuestPreviewFunnelDaily(day=day, mode=mode, step=step, count=1))
        except IntegrityError:
            bump()
    db.commit()
    return True


def funnel_rows(db: Session, days: int = FUNNEL_DAYS) -> list[dict]:
    """近 N 天（含今天，UTC）的漏斗行，按天倒序。/ The last N days' rows (UTC), newest first."""
    start = (datetime.now(timezone.utc) - timedelta(days=days - 1)).strftime("%Y-%m-%d")
    rows = (db.query(GuestPreviewFunnelDaily)
              .filter(GuestPreviewFunnelDaily.day >= start)
              .order_by(GuestPreviewFunnelDaily.day.desc())
              .all())
    return [{"day": r.day, "mode": r.mode, "step": r.step, "count": int(r.count or 0)} for r in rows]
