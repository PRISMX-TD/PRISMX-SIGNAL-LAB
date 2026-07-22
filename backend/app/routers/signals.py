"""信号路由 / Signals router."""
import threading
import time
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.models import Signal, User
from app.schemas import SignalOut
from app.services.deps import get_current_user, require_admin
from app.services.plans import is_realtime_plan

router = APIRouter(prefix="/signals", tags=["signals"])

# 按天统计的天数窗口 / number of days covered by the daily stats window
STATS_DAYS = 7


def _aware(dt: datetime | None) -> datetime | None:
    """库里存的是 naive UTC，比较/序列化前统一补上时区。
    Stored naive as UTC; attach the tzinfo before comparing/serializing."""
    if dt is None:
        return None
    return dt if dt.tzinfo is not None else dt.replace(tzinfo=timezone.utc)


@router.get("", response_model=dict)
def list_signals(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """获取信号列表（最新在前）/ list signals, newest first.

    FREE 等级只能看到已过期（EXPIRED）的信号：一个信号从生成到过期共
    SIGNAL_EXPIRE_MINUTES 分钟，这段时间内它对 FREE 用户完全不可见，
    过期之后才连同最终判定结果一起出现——等同于"延迟到无法再下单才可见"。
    FREE tier only sees EXPIRED signals: for the SIGNAL_EXPIRE_MINUTES it's
    tradeable, it's invisible to FREE users; it appears (with its final
    result) only once expired — effectively "visible only once it can no
    longer be traded".

    过期扫描交给独立的后台任务 signal_expiry_loop（每 5 秒一次，见
    engine/signal_engine.py），这里不再重复现算——避免每次请求都全表扫一遍
    ACTIVE 信号；FREE 用户看到某条信号变为 EXPIRED 最多晚 5 秒，与后台任务
    的扫描节拍一致，且已经有 WS SIGNAL_EXPIRED 推送兜底及时性。
    Expiry sweeping is delegated to the standalone signal_expiry_loop
    background task (every 5s, see engine/signal_engine.py) instead of being
    recomputed on every request here — this used to scan every ACTIVE signal
    per page load. A FREE user sees a signal flip to EXPIRED at most 5s late,
    matching the sweep's own cadence, with the WS SIGNAL_EXPIRED push already
    covering timeliness for connected clients.
    """
    query = db.query(Signal)
    if not is_realtime_plan(user.plan):
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
    return {"signals": signals}


@router.get("/stats", response_model=dict)
def signal_stats(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """近 N 天每日信号发出量（含当天，按 UTC 日期分组）。
    Daily signal count for the last N days (incl. today, grouped by UTC date).
    """
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


# ---------- 历史信号回放（模拟器）/ historical signal replay (simulator) ----------

# 回放结果缓存：键是 (days, risk, mode)，值按 capital=1 归一化后存放。
# **本金刻意不进缓存键**——两种模式的净值都与本金严格成线性比例
# （复利 equity = capital × ∏(1+r)，等额 equity = capital × (1+Σr)），
# 所以算一份归一化结果、返回时乘上请求的本金即可，不同本金的请求共用同一次计算。
# 收益率/回撤/连亏/胜率/是否归零本身与本金无关，不做任何缩放。
#
# Replay cache keyed by (days, risk, mode); values are normalized to capital=1.
# Capital is deliberately NOT part of the key — equity scales strictly linearly
# with it in both modes (compound: capital × ∏(1+r); flat: capital × (1+Σr)) —
# so one normalized run is computed and simply multiplied by the requested
# capital on the way out, letting different capitals share a single computation.
# Return %, drawdown, streaks, win rate and the busted flag are all
# capital-independent and are never scaled.
_SIM_CACHE_TTL_SECONDS = 60
_sim_cache: dict[tuple, tuple[float, dict]] = {}
_sim_lock = threading.Lock()


def _simulate_normalized(db: Session, days: int, risk: float, mode: str) -> dict:
    """按 capital=1 回放窗口内已判定的信号，返回归一化结果。

    Replay every resolved signal in the window with capital=1, returning a
    normalized result.

    只取 `result` 已判定为 HIT_TP/HIT_SL 的 TradingView 信号——与客观胜率
    (`GET /signals/winrate`) 的分母口径**完全一致**：PENDING（还没走出结果）
    与 STALE（行情追踪中断，见 signal_resolution.py）都不进曲线。
    Only TradingView signals already resolved to HIT_TP/HIT_SL are taken —
    exactly the same denominator as the objective win rate: PENDING (no outcome
    yet) and STALE (price tracking broke, see signal_resolution.py) are excluded.
    """
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    rows = (
        db.query(Signal)
        .filter(
            Signal.source == "tradingview",
            Signal.result.in_(("HIT_TP", "HIT_SL")),
            Signal.created_at >= cutoff,
        )
        .order_by(Signal.created_at.asc())
        .all()
    )

    risk_frac = risk / 100.0
    equity = 1.0
    peak = 1.0  # 回撤从初始本金起算：开局就亏也算回撤 / drawdown counts from the starting equity
    max_dd = 0.0
    wins = losses = skipped = 0
    loss_streak = max_loss_streak = 0
    rr_sum = 0.0
    busted = False
    points: list[dict] = []
    trades: list[dict] = []

    for s in rows:
        entry, sl, tp = s.entry, s.stop_loss, s.take_profit
        # 数据不完整的信号明确跳过并计数，不静默丢弃——跳过数如实展示给用户
        # （"规则公开"的品牌纪律）。/ Incomplete signals are skipped and counted,
        # never silently dropped — the skip count is shown to the user.
        if entry is None or sl is None or tp is None or abs(entry - sl) <= 0:
            skipped += 1
            continue

        rr = abs(tp - entry) / abs(entry - sl)
        rr_sum += rr
        if s.result == "HIT_TP":
            pnl_pct = risk_frac * rr
            wins += 1
            loss_streak = 0
        else:
            pnl_pct = -risk_frac
            losses += 1
            loss_streak += 1
            max_loss_streak = max(max_loss_streak, loss_streak)

        if mode == "compound":
            equity *= 1 + pnl_pct
        else:
            # 等额：每单金额恒按初始本金算，归一化后每单就是 ±pnl_pct
            # Flat: every trade is sized off the starting capital, so the
            # normalized move per trade is simply ±pnl_pct.
            equity += pnl_pct
        if equity <= 0:
            # 净值归零：夹到 0 并停止累计（等额模式才可能发生；复利模式下
            # risk ≤ 3% 时数学上永远为正）。/ Equity wiped out: clamp and stop
            # (only reachable in flat mode; compound with risk ≤ 3% stays positive).
            equity = 0.0
            busted = True

        peak = max(peak, equity)
        if peak > 0:
            max_dd = max(max_dd, (peak - equity) / peak)

        created = _aware(s.created_at)
        resolved = _aware(s.resolved_at)
        points.append({"t": created.isoformat() if created else None, "equity": equity})
        trades.append(
            {
                "id": s.id,
                "symbol": s.symbol,
                "side": s.side,
                "createdAt": created.isoformat() if created else None,
                "resolvedAt": resolved.isoformat() if resolved else None,
                "result": s.result,
                "rr": rr,
                "pnlPct": pnl_pct * 100,
                "equityAfter": equity,
            }
        )

        if busted:
            # 造成归零的这一单要记录（它是归零的原因），其后的信号不再累计。
            # The busting trade is recorded (it caused the wipeout); signals
            # after it are not accumulated.
            break

    resolved_count = wins + losses
    return {
        "summary": {
            "finalEquity": equity,  # 归一化，返回前乘本金 / normalized; scaled by capital on the way out
            "returnPct": (equity - 1.0) * 100,
            "maxDrawdownPct": max_dd * 100,
            "maxLossStreak": max_loss_streak,
            "wins": wins,
            "losses": losses,
            "winRate": wins / resolved_count if resolved_count > 0 else None,
            "avgRr": rr_sum / resolved_count if resolved_count > 0 else None,
            "skipped": skipped,
            "busted": busted,
        },
        "points": points,
        "trades": trades,
    }


def _scale(normalized: dict, capital: float) -> dict:
    """把归一化结果（capital=1）按真实本金缩放，返回全新的对象。

    Scale a normalized (capital=1) result by the real capital, returning fresh
    objects — the cached normalized dict must never be mutated.
    """
    summary = dict(normalized["summary"])
    summary["finalEquity"] = summary["finalEquity"] * capital
    return {
        "summary": summary,
        "points": [{"t": p["t"], "equity": p["equity"] * capital} for p in normalized["points"]],
        "trades": [{**t, "equityAfter": t["equityAfter"] * capital} for t in normalized["trades"]],
    }


@router.get("/simulate", response_model=dict)
def simulate_signals(
    days: int = Query(default=90, ge=7, le=365),
    risk: float = Query(default=1.0, ge=0.1, le=3.0, description="单笔风险 % / risk per trade in %"),
    capital: float = Query(default=10000, ge=1, le=1e9),
    mode: str = Query(default="compound", pattern="^(compound|flat)$"),
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    """「如果你跟了」历史信号回放：用已判定的真实信号回放一条净值曲线。

    "What if you followed" replay: an equity curve built from real, already
    resolved signals.

    **当前仅管理员可见**（`require_admin`）——功能先内部试用，暂不对普通用户
    开放；对外开放时把依赖换回 `get_current_user` 即可，本端点不读取任何用户
    私有数据（只吃全局信号表），所以放开权限不需要任何其它改动。
    **Admin-only for now** (`require_admin`) — the feature is being trialed
    internally before release. To open it up, swap the dependency back to
    `get_current_user`: this endpoint reads no user-private data (only the
    global signals table), so widening access needs no other change.
    """
    key = (days, risk, mode)
    now = time.time()
    with _sim_lock:
        hit = _sim_cache.get(key)
        if hit and now - hit[0] < _SIM_CACHE_TTL_SECONDS:
            return {"params": {"days": days, "risk": risk, "capital": capital, "mode": mode},
                    **_scale(hit[1], capital)}

    normalized = _simulate_normalized(db, days, risk, mode)
    with _sim_lock:
        _sim_cache[key] = (now, normalized)

    return {"params": {"days": days, "risk": risk, "capital": capital, "mode": mode},
            **_scale(normalized, capital)}
