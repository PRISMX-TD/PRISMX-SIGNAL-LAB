"""自定义策略路由：模板 CRUD + 回测 + 我的策略信号。

用户从模板选一个、调参数、拿存好的 K 线历史回测、满意再启用；启用后由
`chart.py` 的 K 线入库钩子驱动 `strategy_engine.evaluate_new_candle` 持续
评估，命中生成个人信号（`GET /strategies/signals` 读取），一键下单复用
既有的手动下单端点（`POST /orders`，不传 signalId，直接传 symbol/side/
stopLoss/takeProfit），不需要任何 Order 相关的改动。

**当前仅管理员可用**（`require_admin`，功能内部试用中，未对普通用户开放）。
放开时把下面每个端点的依赖换回 `get_current_user` 即可；PRO 专属开关
（`_check_access`）与每用户策略数上限逻辑本身已按最终设计写好，无需改动。

Custom-strategy router: template CRUD + backtest + "my strategy" signals.

Users pick a template, tune it, backtest against stored candle history, then
enable it; once enabled, `chart.py`'s candle-ingestion hook drives
`strategy_engine.evaluate_new_candle` to keep evaluating it, firing personal
signals (read via `GET /strategies/signals`). One-click order reuses the
existing manual-order endpoint (`POST /orders`, no signalId, explicit
symbol/side/stopLoss/takeProfit) — no Order-side changes needed at all.

**Admin-only for now** (`require_admin`; the feature is in internal trial,
not released to regular users). To release it, swap every endpoint's
dependency back to `get_current_user` — the PRO-exclusive gate
(`_check_access`) and per-user strategy limit are already written for the
final design and need no change.
"""
import json
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.models import Candle, StrategySignal, User, UserStrategy
from app.routers.chart import ALLOWED_INTERVALS
from app.schemas import StrategyBacktestRequest, StrategyCreate, StrategyOut, StrategySignalOut, StrategyUpdate
from app.services.candle_store import INTERVAL_SECONDS
from app.services.deps import require_admin
from app.services.settings_store import get_strategy_settings
from app.services.strategy_engine import (
    TEMPLATE_SCHEMAS,
    clamp_stop_loss,
    clamp_take_profit,
    run_backtest,
    validate_and_clamp_params,
)

router = APIRouter(prefix="/strategies", tags=["strategies"])

MAX_BACKTEST_BARS = 5000


def _check_access(db: Session, user: User) -> None:
    """PRO 专属开关校验(管理后台可调,默认开启)。
    Checks the PRO-exclusive gate (admin-tunable, on by default)."""
    cfg = get_strategy_settings(db)
    if cfg["pro_only"] and user.plan != "PRO":
        raise HTTPException(status_code=403, detail="自定义策略是 PRO 专属功能 / Custom strategies are a PRO-exclusive feature")


def _to_out(s: UserStrategy) -> StrategyOut:
    return StrategyOut(
        id=s.id, template=s.template, name=s.name, symbol=s.symbol, interval=s.interval,
        params=json.loads(s.params or "{}"),
        stopLossMethod=s.stop_loss_method, stopLossValue=s.stop_loss_value,
        takeProfitMethod=s.take_profit_method, takeProfitValue=s.take_profit_value,
        oneTradeAtATime=s.one_trade_at_a_time,
        enabled=s.enabled, createdAt=s.created_at,
    )


@router.get("/templates", response_model=dict)
def list_templates(_user: User = Depends(require_admin)):
    """列出可用的策略模板与其参数定义,前端据此动态渲染调参表单,不写死。
    Lists available strategy templates and their parameter schemas; the
    frontend renders the tuning form from this, nothing hardcoded."""
    return {"templates": TEMPLATE_SCHEMAS}


@router.get("", response_model=dict)
def list_strategies(db: Session = Depends(get_db), user: User = Depends(require_admin)):
    rows = db.query(UserStrategy).filter(UserStrategy.user_id == user.id).order_by(UserStrategy.created_at.asc()).all()
    return {"strategies": [_to_out(s) for s in rows]}


@router.post("", response_model=StrategyOut)
def create_strategy(body: StrategyCreate, db: Session = Depends(get_db), user: User = Depends(require_admin)):
    _check_access(db, user)
    if body.interval not in ALLOWED_INTERVALS:
        raise HTTPException(status_code=400, detail="不支持的周期 / unsupported interval")
    cfg = get_strategy_settings(db)
    count = db.query(UserStrategy).filter(UserStrategy.user_id == user.id).count()
    if count >= int(cfg["max_strategies_per_user"]):
        raise HTTPException(
            status_code=400,
            detail=f"最多只能创建 {cfg['max_strategies_per_user']} 个策略 / at most {cfg['max_strategies_per_user']} strategies allowed",
        )
    try:
        params = validate_and_clamp_params(body.template, body.params)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    row = UserStrategy(
        user_id=user.id, template=body.template, name=(body.name or "").strip() or None,
        symbol=body.symbol.upper(), interval=body.interval,
        params=json.dumps(params, ensure_ascii=False),
        stop_loss_method=body.stopLossMethod, stop_loss_value=clamp_stop_loss(body.stopLossMethod, body.stopLossValue),
        take_profit_method=body.takeProfitMethod, take_profit_value=clamp_take_profit(body.takeProfitMethod, body.takeProfitValue),
        one_trade_at_a_time=body.oneTradeAtATime,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return _to_out(row)


@router.patch("/{strategy_id}", response_model=StrategyOut)
def update_strategy(strategy_id: str, body: StrategyUpdate, db: Session = Depends(get_db), user: User = Depends(require_admin)):
    row = db.query(UserStrategy).filter(UserStrategy.id == strategy_id, UserStrategy.user_id == user.id).first()
    if row is None:
        raise HTTPException(status_code=404, detail="策略不存在 / strategy not found")
    if body.enabled is not None:
        _check_access(db, user)
        row.enabled = body.enabled
    if body.name is not None:
        row.name = body.name.strip() or None
    if body.params is not None:
        try:
            row.params = json.dumps(validate_and_clamp_params(row.template, body.params), ensure_ascii=False)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e)) from e
    if body.stopLossMethod is not None:
        row.stop_loss_method = body.stopLossMethod
    if body.stopLossValue is not None:
        row.stop_loss_value = clamp_stop_loss(row.stop_loss_method, body.stopLossValue)
    if body.takeProfitMethod is not None:
        row.take_profit_method = body.takeProfitMethod
    if body.takeProfitValue is not None:
        row.take_profit_value = clamp_take_profit(row.take_profit_method, body.takeProfitValue)
    if body.oneTradeAtATime is not None:
        row.one_trade_at_a_time = body.oneTradeAtATime
    row.updated_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(row)
    return _to_out(row)


@router.delete("/signals", response_model=dict)
def clear_my_signals(db: Session = Depends(get_db), user: User = Depends(require_admin)):
    """清空当前用户已触发的全部个人策略信号历史,不影响策略本身的启用状态与
    去重游标(last_signal_bar_t)——清空只是清列表,不会让已经触发过的那根
    K 线重新触发一次信号。注册顺序必须排在 DELETE /{strategy_id} 之前——
    否则 "signals" 会被当成 strategy_id 匹配到那条路由,永远走不到这里。
    Clears all of the current user's fired personal strategy signal history.
    Doesn't touch the strategies' enabled state or the de-dup cursor
    (last_signal_bar_t) — clearing only empties the list, it never makes an
    already-fired bar re-fire a signal. Must be registered before
    DELETE /{strategy_id} — otherwise "signals" matches that route's path
    param first and this one is never reached."""
    db.query(StrategySignal).filter(StrategySignal.user_id == user.id).delete()
    db.commit()
    return {"ok": True}


@router.delete("/{strategy_id}", response_model=dict)
def delete_strategy(strategy_id: str, db: Session = Depends(get_db), user: User = Depends(require_admin)):
    row = db.query(UserStrategy).filter(UserStrategy.id == strategy_id, UserStrategy.user_id == user.id).first()
    if row is None:
        raise HTTPException(status_code=404, detail="策略不存在 / strategy not found")
    db.delete(row)
    db.commit()
    return {"ok": True}


@router.post("/backtest", response_model=dict)
def backtest_strategy(body: StrategyBacktestRequest, db: Session = Depends(get_db), user: User = Depends(require_admin)):
    """吃已入库的 K 线历史回放这个模板+参数组合,保存前就能看到历史表现。
    Replays this template+param combo against stored candle history — usable
    before the strategy is even saved."""
    _check_access(db, user)
    if body.interval not in ALLOWED_INTERVALS:
        raise HTTPException(status_code=400, detail="不支持的周期 / unsupported interval")
    try:
        params = validate_and_clamp_params(body.template, body.params)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    seconds = INTERVAL_SECONDS[body.interval]
    cutoff = (datetime.now(timezone.utc) - timedelta(days=body.days)).timestamp()
    rows = (
        db.query(Candle)
        .filter(Candle.symbol == body.symbol.upper(), Candle.interval == body.interval, Candle.t >= cutoff)
        .order_by(Candle.t.asc())
        .limit(MAX_BACKTEST_BARS)
        .all()
    )
    bars = [{"t": r.t, "o": r.o, "h": r.h, "l": r.l, "c": r.c, "v": r.v} for r in rows]
    if len(bars) < 30:
        return {
            "params": body.model_dump(),
            "summary": {
                "finalEquity": body.capital, "returnPct": 0.0, "maxDrawdownPct": 0.0,
                "maxLossStreak": 0, "wins": 0, "losses": 0, "winRate": None, "avgRr": None, "busted": False,
            },
            "points": [], "trades": [], "openPositions": [],
            "insufficientData": True,
            "barsAvailable": len(bars),
        }

    result = run_backtest(
        bars, body.template, params,
        body.stopLossMethod, clamp_stop_loss(body.stopLossMethod, body.stopLossValue),
        body.takeProfitMethod, clamp_take_profit(body.takeProfitMethod, body.takeProfitValue),
        body.riskPct, body.capital, body.mode, body.symbol.upper(),
        one_trade_at_a_time=body.oneTradeAtATime,
    )
    # bars 原样带回给前端画蜡烛图 + 标交易点，避免再单独拉一次历史。
    # Return the bars as-is for the frontend's candlestick chart + trade
    # markers, avoiding a second history round-trip.
    return {"params": body.model_dump(), "barsAvailable": len(bars), "insufficientData": False, "bars": bars, **result}


@router.get("/signals", response_model=dict)
def list_my_signals(limit: int = 50, db: Session = Depends(get_db), user: User = Depends(require_admin)):
    """当前用户已触发的个人策略信号,最新在前。
    The current user's fired personal strategy signals, newest first."""
    rows = (
        db.query(StrategySignal)
        .filter(StrategySignal.user_id == user.id)
        .order_by(StrategySignal.created_at.desc())
        .limit(min(limit, 200))
        .all()
    )
    return {
        "signals": [
            StrategySignalOut(
                id=r.id, strategyId=r.strategy_id, symbol=r.symbol, side=r.side,
                entry=r.entry, stopLoss=r.stop_loss, takeProfit=r.take_profit, createdAt=r.created_at,
            )
            for r in rows
        ]
    }
