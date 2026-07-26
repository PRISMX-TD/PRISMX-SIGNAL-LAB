"""自定义策略路由：规则 AST 的 CRUD + 回测 + 我的策略信号 + 实盘绩效。

用户搭一套规则 AST（或从某个模板预设起步）、选多品种多周期、拿存好的 K 线历史
回测、满意再启用；启用后由 `chart.py` 的 K 线入库钩子驱动
`services.strategy.live.evaluate_new_candle` 持续评估，命中生成个人信号
（`GET /strategies/signals` 读取），一键下单复用既有的手动下单端点
（`POST /orders`，不传 signalId，直接传 symbol/side/stopLoss/takeProfit），
不需要任何 Order 相关的改动。

**2026-07 起已对全体登录用户开放**（原先挂在 `require_admin` 下内部试用，
现已放开，改回 `get_current_user`）。PRO 专属开关（`_check_access`）与每
用户策略数上限仍按原设计在各写操作端点生效，非 PRO 用户点启用会拿到清楚
的 403，不需要额外的路由级门槛。

Custom-strategy router: rule-AST CRUD + backtest + "my strategy" signals + live
performance.

Users build a rule AST (or start from a template preset), pick symbols and
intervals, backtest against stored candle history, then enable it; once enabled,
`chart.py`'s candle-ingestion hook drives
`services.strategy.live.evaluate_new_candle` to keep evaluating it, firing
personal signals (read via `GET /strategies/signals`). One-click order reuses the
existing manual-order endpoint (`POST /orders`, no signalId, explicit
symbol/side/stopLoss/takeProfit) — no Order-side changes needed at all.

**Open to all logged-in users since 2026-07** (was `require_admin`-gated
during internal trial; now `get_current_user`). The PRO-exclusive gate
(`_check_access`) and per-user strategy limit still apply on the write
endpoints as originally designed — a non-PRO user gets a clear 403 on enable,
so no extra route-level gate is needed.
"""
import json
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.database import get_db
from app.core.strategy_limits import (
    BacktestBusy,
    assert_within_cost_cap,
    backtest_gate,
    cache_get,
    cache_key,
    cache_put,
    user_limiter,
)
from app.models import Candle, StrategySignal, StrategyWatch, User, UserStrategy
from app.schemas import (
    StrategyBacktestRequest,
    StrategyCreate,
    StrategyOut,
    StrategyPerformanceOut,
    StrategySignalOut,
    StrategyUpdate,
)
from app.services.deps import get_current_user
from app.services.settings_store import get_strategy_settings
from app.services.strategy import costs as ct
from app.services.strategy.backtest import MIN_PERF_SAMPLE, ExitSpec, run_backtest
from app.services.strategy.coverage import active_symbols, coverage_for, coverage_matrix
from app.services.strategy.presets import (
    PRESET_RULES,
    TEMPLATE_SCHEMAS,
    collect_rules_intervals,
    count_conditions,
    validate_strategy_rules,
)
from app.services.strategy.rules import INTERVAL_SECONDS, MAX_INTERVALS, MAX_SYMBOLS, RuleError

router = APIRouter(prefix="/strategies", tags=["strategies"])

MAX_BACKTEST_BARS = 5000
# 回测响应回传的净值点上限：绘图密度够用，避免把 5000 点全序列化。
# Cap on equity points returned: dense enough to plot, without serializing all
# 5000 of them.
MAX_EQUITY_POINTS = 500


def _check_access(db: Session, user: User) -> None:
    """PRO 专属开关校验(管理后台可调,默认开启)。
    Checks the PRO-exclusive gate (admin-tunable, on by default)."""
    cfg = get_strategy_settings(db)
    if cfg["pro_only"] and user.plan != "PRO":
        raise HTTPException(status_code=403, detail="自定义策略是 PRO 专属功能 / Custom strategies are a PRO-exclusive feature")


def _assert_symbols_fed(symbols: list[str]) -> None:
    """未接入行情的品种直接 400 并点名，不让用户建完策略再靠 insufficientData
    才发现。判断依据是"当前是否有报价在推"，与 K 线历史深度是两件事（后者由
    coverage 端点回答）。
    400 and name any symbol with no live feed, instead of letting the user save a
    strategy and only discover it via insufficientData later. The check is "are
    quotes arriving", which is distinct from candle-history depth (answered by
    the coverage endpoint)."""
    fed = set(active_symbols())
    missing = [s for s in symbols if s not in fed]
    if missing:
        raise HTTPException(
            status_code=400,
            detail=(
                f"品种 {', '.join(missing)} 未接入行情，无法评估 / "
                f"no live feed for {', '.join(missing)}"
            ),
        )


def _assert_scope(symbols: list[str], intervals: list[str]) -> None:
    """品种数与周期数的滥用上限，超限点名具体上限值。上限的唯一来源是
    rules.MAX_SYMBOLS / MAX_INTERVALS，不在 schema 里再抄一份。
    Abuse caps on symbol/interval counts; the message names the actual limit.
    rules.MAX_SYMBOLS / MAX_INTERVALS are the single source — not duplicated in
    the schema."""
    if not symbols:
        raise HTTPException(status_code=400, detail="至少要选一个品种 / at least one symbol required")
    if not intervals:
        raise HTTPException(status_code=400, detail="至少要选一个周期 / at least one interval required")
    if len(symbols) > MAX_SYMBOLS:
        raise HTTPException(
            status_code=400,
            detail=f"最多 {MAX_SYMBOLS} 个品种，当前 {len(symbols)} 个 / at most {MAX_SYMBOLS} symbols",
        )
    if len(intervals) > MAX_INTERVALS:
        raise HTTPException(
            status_code=400,
            detail=f"最多 {MAX_INTERVALS} 个周期，当前 {len(intervals)} 个 / at most {MAX_INTERVALS} intervals",
        )
    for itv in intervals:
        if itv not in INTERVAL_SECONDS:
            raise HTTPException(
                status_code=400,
                detail=f"不支持的周期 {itv}，可选 {sorted(INTERVAL_SECONDS)} / unsupported interval",
            )


def _assert_intervals_subscribed(rules: dict, intervals: list[str]) -> None:
    """AST 里引用的周期必须是本策略订阅的周期的子集，否则实时评估时那一路指标
    永远取不到数据——校验期就说清楚，而不是上线后静默不触发。
    Intervals referenced by the AST must be a subset of the strategy's own
    intervals, or that indicator branch would never have data at evaluation
    time. Say so at validation time instead of silently never firing."""
    unsubscribed = sorted(collect_rules_intervals(rules) - set(intervals))
    if unsubscribed:
        raise HTTPException(
            status_code=400,
            detail=(
                f"规则引用了未订阅的周期 {', '.join(unsubscribed)}，请把它加入 intervals / "
                f"rules reference unsubscribed interval(s) {', '.join(unsubscribed)}"
            ),
        )


def _resolve_rules(template: str | None, rules: dict | None) -> dict:
    """确定这个策略实际用哪套 AST：显式 rules 优先，否则用模板预设；都没有则 400。
    校验失败时把 RuleError 的消息原样带给用户——那条消息就是"违反了哪一项"。
    Decide which AST this strategy actually uses: explicit rules win, else the
    template preset; neither is a 400. On validation failure the RuleError
    message is passed through verbatim — that message *is* the violated rule."""
    if rules is None:
        if template is None:
            raise HTTPException(
                status_code=400,
                detail="必须提供 rules 或 template 之一 / either rules or template is required",
            )
        rules = PRESET_RULES[template]
    try:
        validate_strategy_rules(rules)
    except RuleError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return rules


def _sync_watches(db: Session, row: UserStrategy) -> None:
    """按 symbols x intervals 重建该策略的盯盘三元组。整删整建而不是差分——
    组合数上限是 5 x 3 = 15 行，差分的复杂度换不来任何东西。调用方管事务。
    Rebuild this strategy's watch triples from symbols x intervals. Delete-all
    then insert rather than diffing: the combination count is capped at 5 x 3 =
    15 rows, so diffing buys nothing. The caller owns the transaction."""
    db.query(StrategyWatch).filter(StrategyWatch.strategy_id == row.id).delete()
    for sym in json.loads(row.symbols or "[]"):
        for itv in json.loads(row.intervals or "[]"):
            db.add(StrategyWatch(strategy_id=row.id, symbol=sym, interval=itv))


def _to_out(s: UserStrategy) -> StrategyOut:
    return StrategyOut(
        id=s.id, template=s.template, name=s.name,
        rules=json.loads(s.rules or "{}"),
        symbols=json.loads(s.symbols or "[]"),
        intervals=json.loads(s.intervals or "[]"),
        stopLossMethod=s.stop_loss_method, stopLossValue=s.stop_loss_value,
        takeProfitMethod=s.take_profit_method, takeProfitValue=s.take_profit_value,
        oneTradeAtATime=s.one_trade_at_a_time,
        exitTimeoutBars=s.exit_timeout_bars,
        sessionFilter=json.loads(s.session_filter) if s.session_filter else None,
        dailySignalCap=s.daily_signal_cap,
        cooldownMinutes=s.cooldown_minutes,
        enabled=s.enabled, createdAt=s.created_at,
    )


@router.get("/templates", response_model=dict)
def list_templates(_user: User = Depends(get_current_user)):
    """列出可用的策略模板与其参数定义,前端据此动态渲染调参表单,不写死。
    Lists available strategy templates and their parameter schemas; the
    frontend renders the tuning form from this, nothing hardcoded."""
    return {"templates": TEMPLATE_SCHEMAS}


@router.get("/coverage", response_model=dict)
def get_coverage(
    symbols: str = "",
    intervals: str = "",
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """某些 (品种, 周期) 的实际可用数据量与断档情况，回测执行之前就能看到。

    不传 symbols 时用当前有报价的全部品种；不传 intervals 时用六档全部。
    前端据此在回测前显示"已选 365 天，实际可用 47 天"，并把未接入品种置灰。

    Actual available data and gaps for some (symbol, interval) pairs, visible
    before a backtest runs. Empty symbols means every currently quoted symbol;
    empty intervals means all six. The frontend uses this to show "365 days
    requested, 47 days available" up front and to grey out unfed symbols.
    """
    _check_access(db, user)
    sym_list = [s.strip().upper() for s in symbols.split(",") if s.strip()] or active_symbols()
    itv_list = [i.strip() for i in intervals.split(",") if i.strip()] or sorted(INTERVAL_SECONDS)
    if len(sym_list) > MAX_SYMBOLS:
        raise HTTPException(
            status_code=400,
            detail=f"一次最多查询 {MAX_SYMBOLS} 个品种 / at most {MAX_SYMBOLS} symbols per request",
        )
    for itv in itv_list:
        if itv not in INTERVAL_SECONDS:
            raise HTTPException(
                status_code=400,
                detail=f"不支持的周期 {itv}，可选 {sorted(INTERVAL_SECONDS)} / unsupported interval",
            )
    return {
        "coverage": coverage_matrix(db, sym_list, itv_list),
        "activeSymbols": active_symbols(),
    }


@router.get("", response_model=dict)
def list_strategies(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    rows = db.query(UserStrategy).filter(UserStrategy.user_id == user.id).order_by(UserStrategy.created_at.asc()).all()
    return {"strategies": [_to_out(s) for s in rows]}


@router.post("", response_model=StrategyOut)
@user_limiter.limit(settings.RATE_LIMIT_STRATEGY_WRITE)
def create_strategy(
    request: Request,
    body: StrategyCreate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    _check_access(db, user)
    _assert_scope(body.symbols, body.intervals)
    _assert_symbols_fed(body.symbols)
    rules = _resolve_rules(body.template, body.rules)
    _assert_intervals_subscribed(rules, body.intervals)
    cfg = get_strategy_settings(db)
    count = db.query(UserStrategy).filter(UserStrategy.user_id == user.id).count()
    if count >= int(cfg["max_strategies_per_user"]):
        raise HTTPException(
            status_code=400,
            detail=f"最多只能创建 {cfg['max_strategies_per_user']} 个策略 / at most {cfg['max_strategies_per_user']} strategies allowed",
        )

    row = UserStrategy(
        user_id=user.id, template=body.template, name=(body.name or "").strip() or None,
        rules=json.dumps(rules, ensure_ascii=False),
        symbols=json.dumps(body.symbols), intervals=json.dumps(body.intervals),
        # 旧的单值列仍非空约束，写入第一个值以兼容；读取一律走 symbols/intervals。
        # The legacy single-value columns are still NOT NULL; write the first
        # value for compatibility. Reads always go through symbols/intervals.
        symbol=body.symbols[0], interval=body.intervals[0],
        params="{}",
        stop_loss_method=body.stopLossMethod, stop_loss_value=body.stopLossValue,
        take_profit_method=body.takeProfitMethod, take_profit_value=body.takeProfitValue,
        one_trade_at_a_time=body.oneTradeAtATime,
        exit_timeout_bars=body.exitTimeoutBars,
        session_filter=json.dumps(body.sessionFilter.model_dump()) if body.sessionFilter else None,
        daily_signal_cap=body.dailySignalCap,
        cooldown_minutes=body.cooldownMinutes,
    )
    db.add(row)
    db.flush()  # 先拿到 row.id 再建 watch 行 / need row.id before the watch rows
    _sync_watches(db, row)
    db.commit()
    db.refresh(row)
    return _to_out(row)


@router.patch("/{strategy_id}", response_model=StrategyOut)
@user_limiter.limit(settings.RATE_LIMIT_STRATEGY_WRITE)
def update_strategy(
    request: Request,
    strategy_id: str,
    body: StrategyUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    row = db.query(UserStrategy).filter(UserStrategy.id == strategy_id, UserStrategy.user_id == user.id).first()
    if row is None:
        raise HTTPException(status_code=404, detail="策略不存在 / strategy not found")
    if body.enabled is not None:
        _check_access(db, user)
        row.enabled = body.enabled
    if body.name is not None:
        row.name = body.name.strip() or None

    # 品种/周期/规则任一变动都要整体重新校验：三者的约束是耦合的（AST 引用的
    # 周期必须在订阅列表里），单独校验改动的那一项会漏掉组合后的非法状态。
    # Any change to symbols/intervals/rules triggers a full re-validation: the
    # three constraints are coupled (AST-referenced intervals must be subscribed),
    # so validating only the changed field would miss illegal combinations.
    touches_scope = body.symbols is not None or body.intervals is not None or body.rules is not None
    if touches_scope:
        symbols = body.symbols if body.symbols is not None else json.loads(row.symbols or "[]")
        intervals = body.intervals if body.intervals is not None else json.loads(row.intervals or "[]")
        _assert_scope(symbols, intervals)
        if body.symbols is not None:
            _assert_symbols_fed(symbols)
        rules = body.rules if body.rules is not None else json.loads(row.rules or "{}")
        try:
            validate_strategy_rules(rules)
        except RuleError as e:
            raise HTTPException(status_code=400, detail=str(e)) from e
        _assert_intervals_subscribed(rules, intervals)
        row.rules = json.dumps(rules, ensure_ascii=False)
        row.symbols = json.dumps(symbols)
        row.intervals = json.dumps(intervals)
        row.symbol, row.interval = symbols[0], intervals[0]

    if body.stopLossMethod is not None:
        row.stop_loss_method = body.stopLossMethod
    if body.stopLossValue is not None:
        row.stop_loss_value = body.stopLossValue
    if body.takeProfitMethod is not None:
        row.take_profit_method = body.takeProfitMethod
    if body.takeProfitValue is not None:
        row.take_profit_value = body.takeProfitValue
    if body.oneTradeAtATime is not None:
        row.one_trade_at_a_time = body.oneTradeAtATime
    if body.exitTimeoutBars is not None:
        row.exit_timeout_bars = body.exitTimeoutBars
    if body.sessionFilter is not None:
        row.session_filter = json.dumps(body.sessionFilter.model_dump())
    if body.dailySignalCap is not None:
        row.daily_signal_cap = body.dailySignalCap
    if body.cooldownMinutes is not None:
        row.cooldown_minutes = body.cooldownMinutes
    row.updated_at = datetime.now(timezone.utc)
    if touches_scope:
        _sync_watches(db, row)
    db.commit()
    db.refresh(row)
    return _to_out(row)


@router.delete("/signals", response_model=dict)
@user_limiter.limit(settings.RATE_LIMIT_STRATEGY_WRITE)
def clear_my_signals(request: Request, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
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
def delete_strategy(strategy_id: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    row = db.query(UserStrategy).filter(UserStrategy.id == strategy_id, UserStrategy.user_id == user.id).first()
    if row is None:
        raise HTTPException(status_code=404, detail="策略不存在 / strategy not found")
    # watch 行没有级联删除，留下孤儿行会让实时评估反复查到一个已不存在的策略。
    # The watch rows aren't cascade-deleted; orphans would make the live
    # evaluator keep resolving a strategy that no longer exists.
    db.query(StrategyWatch).filter(StrategyWatch.strategy_id == row.id).delete()
    db.delete(row)
    db.commit()
    return {"ok": True}


def _thin(points: list[dict], cap: int = MAX_EQUITY_POINTS) -> list[dict]:
    """等距抽稀净值点。首尾必须保留：净值曲线的起点与终点是用户唯一会去读具体
    数值的两个点。
    Evenly decimate equity points, always keeping first and last — those are the
    two values a user actually reads off an equity curve."""
    if len(points) <= cap:
        return points
    step = len(points) / cap
    idx = sorted({int(i * step) for i in range(cap)} | {len(points) - 1})
    return [points[i] for i in idx]


@router.post("/backtest", response_model=dict)
@user_limiter.limit(settings.RATE_LIMIT_BACKTEST_SHORT)
@user_limiter.limit(settings.RATE_LIMIT_BACKTEST_LONG)
def backtest_strategy(
    request: Request,
    body: StrategyBacktestRequest,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """吃已入库的 K 线历史回放这套规则，返回含成本与不含成本两套结果、样本内外
    两段指标、以及本次实际用到的数据覆盖范围。

    Replay these rules against stored candle history: cost-adjusted and
    cost-free results, in/out-of-sample metrics, and the data coverage actually
    used for this run.
    """
    _check_access(db, user)
    symbol = body.symbol.upper()
    _assert_scope([symbol], [body.interval])
    _assert_symbols_fed([symbol])
    rules = _resolve_rules(body.template, body.rules)
    referenced = collect_rules_intervals(rules)
    unsubscribed = sorted(referenced - {body.interval})
    if unsubscribed:
        raise HTTPException(
            status_code=400,
            detail=(
                f"回测只跑单周期 {body.interval}，但规则引用了 {', '.join(unsubscribed)} / "
                f"backtest runs one interval; rules reference {', '.join(unsubscribed)}"
            ),
        )

    cov = coverage_for(db, symbol, body.interval)
    version = ct.costs_version(db)
    key = cache_key(
        rules, symbol, body.interval, body.days, version,
        extra={
            "sl": [body.stopLossMethod, body.stopLossValue],
            "tp": [body.takeProfitMethod, body.takeProfitValue],
            "one": body.oneTradeAtATime,
            "timeout": body.exitTimeoutBars,
            "risk": body.riskPct,
            "capital": body.capital,
            "mode": body.mode,
            # 库里最新一根的时间进 key：新 K 线到达后旧结果必须失效，否则用户
            # 看到的"最新回测"会停在几分钟前那根上。
            # The latest stored bar time goes into the key: a new bar must
            # invalidate the old result, or the "latest backtest" would stay
            # pinned to a bar from minutes ago.
            "latest": cov["latestT"],
        },
    )
    hit = cache_get(key)
    if hit is not None:
        return {**hit, "cached": True}

    cutoff = (datetime.now(timezone.utc) - timedelta(days=body.days)).timestamp()
    # 按时间倒序取最新的 MAX_BACKTEST_BARS 根,再翻回正序——不能直接正序 limit。
    # `days` 窗口里的实际行数完全可能超过 5000(比如 1 分钟线,K 线历史入库
    # 才上线没几天,单一品种几天内就能攒够);正序 limit 会永远只拿到窗口里
    # 最早的那 5000 根,新增的数据无论多久之后都追不上,回测就会像卡住在
    # 某个固定日期不再往前一样——这正是 evaluate_new_candle() 已经在用的
    # 同一种取法,这里此前没跟上。
    # Fetch the newest MAX_BACKTEST_BARS rows in descending order, then
    # reverse back to ascending — can't limit on ascending order directly.
    # The `days` window can easily hold more than 5000 rows (e.g. 1-minute
    # candles: candle-history ingestion only just launched, and a single
    # symbol can accumulate that many within days); an ascending limit would
    # forever return only the earliest 5000 rows in the window, with no
    # amount of newly-arrived data ever catching up — the backtest would look
    # permanently stuck on some fixed date. Same fetch pattern
    # evaluate_new_candle() already uses; this call site just hadn't matched it.
    rows = (
        db.query(Candle)
        .filter(Candle.symbol == symbol, Candle.interval == body.interval, Candle.t >= cutoff)
        .order_by(Candle.t.desc())
        .limit(MAX_BACKTEST_BARS)
        .all()
    )
    rows.reverse()
    bars = [{"t": r.t, "o": r.o, "h": r.h, "l": r.l, "c": r.c, "v": r.v} for r in rows]

    try:
        assert_within_cost_cap(len(bars), count_conditions(rules))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    if len(bars) < 30:
        return {
            "insufficientData": True,
            "barsUsed": len(bars),
            "requestedDays": body.days,
            "coverage": cov,
            "cached": False,
        }

    spec = ExitSpec(
        sl_method=body.stopLossMethod, sl_value=body.stopLossValue,
        tp_method=body.takeProfitMethod, tp_value=body.takeProfitValue,
        timeout_bars=body.exitTimeoutBars,
    )
    try:
        with backtest_gate(user.id):
            result = run_backtest(
                bars, rules, spec,
                symbol=symbol, risk_pct=body.riskPct, capital=body.capital,
                mode=body.mode, one_trade_at_a_time=body.oneTradeAtATime,
                costs=ct.symbol_costs(db, symbol),
            )
    except BacktestBusy as e:
        raise HTTPException(
            status_code=429,
            detail="你已有一个回测在跑，请等它结束 / a backtest of yours is already running",
        ) from e
    except RuleError as e:
        # 指标序列过短（数据含空洞）这类求值期错误：400 并说明，不返回半套结果。
        # Evaluation-time errors such as too-short indicator series (data gaps):
        # 400 with an explanation rather than half a result.
        raise HTTPException(status_code=400, detail=str(e)) from e

    # 响应不带 bars：前端画蜡烛图另走 GET /chart/candles，这里只回净值点、交易点
    # 与汇总指标（5000 根 bars 序列化一次就是几百 KB）。
    # No bars in the response: the frontend charts candles via GET /chart/candles,
    # and this only returns equity points, trades and summaries (serializing 5000
    # bars is hundreds of KB).
    payload = {
        **result,
        "points": _thin(result["points"]),
        "requestedDays": body.days,
        "coverage": cov,
        "insufficientData": False,
        "cached": False,
    }
    cache_put(key, payload)
    return payload


@router.get("/signals", response_model=dict)
def list_my_signals(limit: int = 50, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
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
                id=r.id, strategyId=r.strategy_id, symbol=r.symbol, interval=r.interval,
                side=r.side, entry=r.entry, stopLoss=r.stop_loss, takeProfit=r.take_profit,
                result=r.result, barsHeld=r.bars_held or 0,
                resolvedAt=r.resolved_at, createdAt=r.created_at,
            )
            for r in rows
        ]
    }


def live_performance(db: Session, strategy_id: str) -> dict:
    """一个策略的实盘绩效。口径与回测的 summary 对齐，使两者可以并排比较：

    - HIT_TP 记胜、HIT_SL 记负。
    - TIMEOUT 计入已判定笔数（它是一次真实出场），但本次未新增出场价列，
      无法还原盈亏方向，因此单列 timeouts 不摊入胜负。
    - STALE 与 PENDING 完全排除：前者是数据源中断的兜底，不是交易结果。
    - 已判定不足 MIN_PERF_SAMPLE 笔时不给百分比——1 胜 0 负呈现为 100% 会
      直接误导用户加仓。

    平均盈亏比按各信号自身的 TP/SL 距离比计算（命中 TP 记 +ratio，命中 SL 记
    -1），而不是用统一的 R 值：AST 化之后每条信号的 SL/TP 距离可以各不相同。

    Live performance for one strategy, aligned with the backtest summary so the
    two can be compared side by side. HIT_TP wins, HIT_SL loses. TIMEOUT counts
    toward the resolved total (it is a real exit) but is tallied separately,
    since no exit-price column was added and its direction can't be recovered.
    STALE and PENDING are excluded entirely. Below MIN_PERF_SAMPLE resolved
    trades no percentages are reported: 1-0 rendered as 100% would directly
    mislead someone into sizing up. Average R is computed from each signal's own
    TP/SL distance ratio rather than a single global R, because after the AST
    change every signal can carry different distances.
    """
    rows = (
        db.query(StrategySignal)
        .filter(StrategySignal.strategy_id == strategy_id)
        .order_by(StrategySignal.created_at.asc())
        .all()
    )
    wins = losses = timeouts = pending = 0
    rr_sum = 0.0
    streak = max_streak = 0
    for r in rows:
        if r.result == "PENDING":
            pending += 1
            continue
        if r.result == "STALE":
            continue
        if r.result == "TIMEOUT":
            timeouts += 1
            streak = 0
            continue
        risk = abs(r.entry - r.stop_loss)
        reward = abs(r.take_profit - r.entry)
        if r.result == "HIT_TP":
            wins += 1
            rr_sum += (reward / risk) if risk > 0 else 0.0
            streak = 0
        elif r.result == "HIT_SL":
            losses += 1
            rr_sum -= 1.0
            streak += 1
            max_streak = max(max_streak, streak)
    resolved = wins + losses + timeouts
    enough = resolved >= MIN_PERF_SAMPLE
    decided = wins + losses
    return {
        "strategyId": strategy_id,
        "resolved": resolved,
        "wins": wins,
        "losses": losses,
        "timeouts": timeouts,
        "pending": pending,
        "winRate": (wins / decided) if enough and decided > 0 else None,
        "avgRr": (rr_sum / decided) if enough and decided > 0 else None,
        "maxLossStreak": max_streak,
        "insufficientSample": not enough,
        "sampleThreshold": MIN_PERF_SAMPLE,
    }


@router.get("/{strategy_id}/performance", response_model=StrategyPerformanceOut)
def get_strategy_performance(
    strategy_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """实盘绩效，供策略卡片与回测结果并排对比。

    跨用户访问返回 404 而不是 403：403 会确认"这个 id 确实存在"，把别人策略的
    存在性泄露出去。

    `backtest` 字段留给前端填：本次不在服务端保存历史回测结果（没有存储回测
    快照的表，凭空加一张会把"回测是无状态的重放"这个前提也一起改掉）。前端手上
    已有它刚发起的那次回测响应，并排对比在前端完成。

    Live performance, for side-by-side comparison with a backtest on the
    strategy card. Another user's strategy is a 404 rather than a 403 — a 403
    would confirm the id exists and leak someone else's strategy's existence.
    The `backtest` field is left for the frontend to fill: no backtest snapshots
    are persisted server-side (there's no table for them, and adding one would
    also change the premise that a backtest is a stateless replay). The frontend
    already holds the backtest response it just requested.
    """
    row = (
        db.query(UserStrategy)
        .filter(UserStrategy.id == strategy_id, UserStrategy.user_id == user.id)
        .first()
    )
    if row is None:
        raise HTTPException(status_code=404, detail="策略不存在 / strategy not found")
    return StrategyPerformanceOut(**live_performance(db, strategy_id))
