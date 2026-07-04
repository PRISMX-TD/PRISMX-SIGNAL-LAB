"""信号路由 / Signals router."""
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.models import Signal, User
from app.schemas import SignalOut
from app.services.deps import get_current_user

router = APIRouter(prefix="/signals", tags=["signals"])

# 按天统计的天数窗口 / number of days covered by the daily stats window
STATS_DAYS = 7


def _expire_stale(db: Session) -> None:
    """把已过有效期但仍标记 ACTIVE 的信号置为 EXPIRED。
    Mark ACTIVE signals past their expiry as EXPIRED.
    """
    now = datetime.now(timezone.utc)
    active = (
        db.query(Signal)
        .filter(Signal.status == "ACTIVE", Signal.expire_at.isnot(None))
        .all()
    )
    changed = False
    for s in active:
        exp = s.expire_at
        if exp.tzinfo is None:
            exp = exp.replace(tzinfo=timezone.utc)
        if exp < now:
            s.status = "EXPIRED"
            changed = True
    if changed:
        db.commit()


@router.get("", response_model=dict)
def list_signals(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """获取信号列表（最新在前）/ list signals, newest first."""
    _expire_stale(db)
    rows = db.query(Signal).order_by(Signal.created_at.desc()).limit(50).all()
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
    return {"signals": signals}


@router.get("/stats", response_model=dict)
def signal_stats(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """近 N 天每日信号发出量（含当天，按 UTC 日期分组）。
    Daily signal count for the last N days (incl. today, grouped by UTC date).
    """
    _expire_stale(db)
    now = datetime.now(timezone.utc)
    start_date = (now - timedelta(days=STATS_DAYS - 1)).date()

    rows = (
        db.query(Signal.created_at)
        .filter(Signal.created_at >= datetime.combine(start_date, datetime.min.time(), tzinfo=timezone.utc))
        .all()
    )

    # 按 UTC 日期分组计数 / count grouped by UTC date, done in Python for DB-dialect neutrality
    counts: dict[str, int] = {}
    for i in range(STATS_DAYS):
        day = start_date + timedelta(days=i)
        counts[day.isoformat()] = 0
    for (created_at,) in rows:
        ts = created_at if created_at.tzinfo else created_at.replace(tzinfo=timezone.utc)
        key = ts.date().isoformat()
        if key in counts:
            counts[key] += 1

    daily = [{"date": d, "count": c} for d, c in counts.items()]
    return {"daily": daily, "total": sum(c["count"] for c in daily)}


@router.get("/winrate", response_model=dict)
def signal_winrate(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """真实（TradingView）信号的客观胜率：基于行情是否先碰到止盈或止损判定，
    与任何用户的实际下单/平仓行为无关。STALE（追踪中断）与 PENDING（未分胜负）
    不计入胜率分母。

    Objective win rate for real (TradingView) signals: based on whether price
    reached take-profit or stop-loss first, independent of any user's actual
    order/close behavior. STALE (tracking interrupted) and PENDING (not yet
    resolved) are excluded from the win-rate denominator.
    """
    rows = (
        db.query(Signal.result)
        .filter(Signal.source == "tradingview")
        .all()
    )
    counts = {"PENDING": 0, "HIT_TP": 0, "HIT_SL": 0, "STALE": 0}
    for (result,) in rows:
        key = result if result in counts else "PENDING"
        counts[key] += 1

    resolved = counts["HIT_TP"] + counts["HIT_SL"]
    win_rate = counts["HIT_TP"] / resolved if resolved > 0 else None
    return {
        "hitTp": counts["HIT_TP"],
        "hitSl": counts["HIT_SL"],
        "pending": counts["PENDING"],
        "stale": counts["STALE"],
        "totalResolved": resolved,
        "winRate": win_rate,
    }
