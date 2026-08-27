"""自定义策略路由：条件列表的 CRUD + 回测 + 我的策略信号 + 实盘绩效。

用户选一个品种一个周期、加几个指标条件（或从某个预设起步）、拿存好的 K 线历史
回测、满意再启用；启用后由 `chart.py` 的 K 线入库钩子驱动
`services.strategy.live.evaluate_new_candle` 持续评估，命中生成个人信号
（`GET /strategies/signals` 读取），一键下单复用既有的手动下单端点
（`POST /orders`，不传 signalId，直接传 symbol/side/stopLoss/takeProfit），
不需要任何 Order 相关的改动。

**2026-07 起已对全体登录用户开放**（原先挂在 `require_admin` 下内部试用，
现已放开，改回 `get_current_user`）。PRO 专属开关（`_check_access`）与每
用户策略数上限仍按原设计在各写操作端点生效，非 PRO 用户点启用会拿到清楚
的 403，不需要额外的路由级门槛。

Custom-strategy router: condition-list CRUD + backtest + "my strategy" signals +
live performance.

Users pick one symbol and one interval, add a few indicator conditions (or start
from a preset), backtest against stored candle history, then enable it; once
enabled,
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
import logging
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import case, func
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
from app.services.strategy.coverage import (
    MAX_COVERAGE_SYMBOLS,
    active_symbols,
    coverage_for,
    coverage_matrix,
    symbols_with_history,
)
from app.services.strategy.conditions import (
    ALLOWED_INTERVALS,
    INDICATORS,
    MAX_CONDITIONS,
    ConditionError,
    usage_specs_for,
    validate_conditions,
)
from app.services.strategy.presets import PRESET_CONDITIONS, PRESET_LOGIC, TEMPLATE_KEYS, preset_payload

logger = logging.getLogger("prismx.strategies")

router = APIRouter(prefix="/strategies", tags=["strategies"])

# 回测单次最多读多少根。730 天(days 的上限)的 15 分钟线约 4.9 万根、1 小时线约
# 1.2 万根,取 60000 让这两者都能被完整回测,不会因为撞上限而悄悄只回测了最近一段。
# 1 分钟线 730 天约 75 万根会被截断,但它有 30 天保留期(m1_retention_days),库里本
# 来就只有约 3 万根,同样装得下。
# 上限不能去掉:回测是同步的纯 Python 循环,单次读进来的 bar 数直接决定内存占用和
# 耗时(生产 2 核单进程),无界读取会让一次请求拖住整个事件循环。
# Max bars a single backtest reads. Over the 730-day `days` ceiling, 15-minute
# bars come to ~49k and hourly to ~12k, so 60000 lets both backtest in full
# instead of silently testing only the most recent stretch after hitting the cap.
# 730 days of 1-minute bars (~750k) would still be truncated, but that interval
# has a 30-day retention (m1_retention_days) so only ~30k exist to begin with.
# The cap can't be dropped: the backtest is a synchronous pure-Python loop, and
# the bars read in one go drive both memory and runtime (2 cores, single process
# in production) — an unbounded read would stall the whole event loop.
MAX_BACKTEST_BARS = 60000
# 回测响应回传的净值点上限：绘图密度够用，避免把全部点位序列化。
# Cap on equity points returned: dense enough to plot, without serializing every
# one of them.
MAX_EQUITY_POINTS = 500
# 最长连亏的回看窗口，单位是"已判定信号笔数"。
# 其余绩效字段都能在 SQL 里聚合出来，只有连亏是顺序相关的，必须把行取回 Python
# 逐笔走一遍。而 strategy_signals 没有任何保留期清理（只增不减），全量回看意味着
# 一个跑了一年的策略每次打开卡片都要载入它的全部历史；前端还是每个策略各发一个
# 请求，两个维度相乘。
# 200 的取法：连亏是用来判断"现在是不是该停手"的近况指标，看到半年前的连亏对这个
# 判断没有帮助；按 15 分钟线的触发频率，200 笔已判定信号覆盖的时间跨度远超用户
# 会关心的范围。窗口值随响应一起返回（streakWindow），口径变化对前端是显式的。
# Look-back window for the longest losing streak, counted in resolved signals.
# Every other field can be aggregated in SQL; the streak is order-dependent, so
# rows have to come back to Python and be walked in sequence. Since
# strategy_signals has no retention sweep (append-only), an unbounded look-back
# means a year-old strategy loads its entire history every time its card opens —
# and the frontend still issues one request per strategy, so the two multiply.
# Why 200: the streak answers "should I stop trading this right now", a
# recent-form question that a losing run from six months ago does not inform. At
# 15-minute trigger rates, 200 resolved signals already span far more time than
# anyone reads it over. The window is returned in the response (streakWindow) so
# the narrower definition is explicit to the frontend.
STREAK_WINDOW = 200


def _check_access(db: Session, user: User) -> None:
    """PRO 专属开关校验(管理后台可调,默认开启)。
    Checks the PRO-exclusive gate (admin-tunable, on by default)."""
    cfg = get_strategy_settings(db)
    if cfg["pro_only"] and user.plan != "PRO":
        raise HTTPException(status_code=403, detail="自定义策略是 PRO 专属功能 / Custom strategies are a PRO-exclusive feature")


def _assert_symbol_fed(symbol: str) -> None:
    """未接入行情的品种直接 400 并点名，不让用户建完策略再靠 insufficientData
    才发现。判断依据是"当前是否有报价在推"，与 K 线历史深度是两件事（后者由
    coverage 端点回答）。
    400 and name the symbol if it has no live feed, instead of letting the user
    save a strategy and only discover it via insufficientData later. The check is
    "are quotes arriving", which is distinct from candle-history depth (answered
    by the coverage endpoint)."""
    if symbol not in set(active_symbols()):
        raise HTTPException(
            status_code=400,
            detail=f"品种 {symbol} 未接入行情，无法评估 / no live feed for {symbol}",
        )


def _assert_interval(interval: str) -> None:
    if interval not in ALLOWED_INTERVALS:
        raise HTTPException(
            status_code=400,
            detail=f"不支持的周期 {interval}，可选 {sorted(ALLOWED_INTERVALS)} / unsupported interval",
        )


def _resolve_rules(template: str | None, rules: dict | None, symbol: str, interval: str) -> dict:
    """确定这个策略实际用哪套条件：显式 rules 优先，否则用模板预设；都没有则 400。

    rules 里的 symbol / interval 必须与请求顶层一致。两处都存是为了让 rules 自
    成一体（求值时不必再传上下文），但两者一旦不一致，实盘按顶层订阅、求值按
    rules 里的值，用户会看到一条订阅了 15 分钟却按 1 小时判定的策略。

    Decide which conditions this strategy uses: explicit rules win, else the
    template preset; neither is a 400. The symbol/interval inside `rules` must
    match the top-level request. Both carry them so that `rules` is
    self-contained at evaluation time, but if they diverge, live evaluation
    subscribes by the top-level pair and judges by the one in `rules` — a
    strategy watching 15m but deciding on 1h.
    """
    if rules is None:
        if template is None:
            raise HTTPException(
                status_code=400,
                detail="必须提供 rules 或 template 之一 / either rules or template is required",
            )
        rules = preset_payload(template, symbol, interval)
    try:
        validate_conditions(rules)
    except ConditionError as e:
        raise HTTPException(status_code=400, detail=e.message) from e
    if rules["symbol"] != symbol or rules["interval"] != interval:
        raise HTTPException(
            status_code=400,
            detail=(
                f"rules 里的品种/周期（{rules['symbol']}/{rules['interval']}）与请求"
                f"（{symbol}/{interval}）不一致 / rules symbol/interval must match the request"
            ),
        )
    return rules


def _sync_watches(db: Session, row: UserStrategy) -> None:
    """重建该策略的盯盘行。一条策略只有一个 (品种, 周期)，整删整建即可。
    Rebuild this strategy's watch row. A strategy has exactly one (symbol,
    interval) pair, so delete-then-insert is all that's needed. The caller owns
    the transaction."""
    db.query(StrategyWatch).filter(StrategyWatch.strategy_id == row.id).delete()
    db.add(StrategyWatch(strategy_id=row.id, symbol=row.symbol, interval=row.interval))


def _rules_out(s: UserStrategy) -> dict:
    """把存库的 rules 读成响应用的条件结构；不是新结构就返回空条件列表。

    迁移刻意不重写旧 AST（表达力超出新结构，自动映射只能是猜测），只把策略停用。
    但停用的策略照样要能被读取和编辑，于是旧形状会经这里发给客户端——客户端拿到
    没有 conditions 的对象就崩了，实际表现是「点编辑白屏」。
    这里统一收敛成合法形状：conditions 为空，客户端据此提示重新配置即可。库里的
    原始 rules 不动，保留可读痕迹，也不做不可逆改写。

    Read the stored rules into the response's condition structure, falling back to
    an empty condition list when it isn't the new shape.

    The migration deliberately leaves a legacy AST unrewritten (it out-expresses
    the new structure, so any mapping is guesswork) and only disables the
    strategy. Disabled strategies still have to be readable and editable, though,
    so the old shape would travel to clients through here — and a client handed an
    object with no `conditions` crashes, which shows up as a blank screen on edit.
    This narrows it to a valid shape with empty conditions, letting the client
    prompt for reconfiguration. The stored rules stay untouched, keeping a
    readable trace and avoiding an irreversible rewrite.
    """
    raw = json.loads(s.rules or "{}")
    try:
        validate_conditions(raw)
    except (ConditionError, ValueError, TypeError):
        return {"logic": "AND", "symbol": s.symbol, "interval": s.interval, "conditions": []}
    return raw


def _to_out(s: UserStrategy) -> StrategyOut:
    return StrategyOut(
        id=s.id, template=s.template, name=s.name,
        rules=_rules_out(s),
        symbol=s.symbol,
        interval=s.interval,
        stopLossMethod=s.stop_loss_method, stopLossValue=s.stop_loss_value,
        takeProfitMethod=s.take_profit_method, takeProfitValue=s.take_profit_value,
        oneTradeAtATime=s.one_trade_at_a_time,
        exitTimeoutBars=s.exit_timeout_bars,
        sessionFilter=json.loads(s.session_filter) if s.session_filter else None,
        dailySignalCap=s.daily_signal_cap,
        cooldownMinutes=s.cooldown_minutes,
        enabled=s.enabled, createdAt=s.created_at,
    )


@router.get("/usages", response_model=dict)
def list_usages(_user: User = Depends(get_current_user)):
    """指标与用法清单：参数规格、取值范围、镜像关系。

    前端的指标选择器与参数表单完全由这份清单驱动。清单只在后端维护，前端不带
    副本——两边各存一份的话，加一个用法就得改两处，漏改的那次就是用户填了合法
    参数却被 400。

    The indicator/usage catalogue: param specs, ranges and mirrors. The
    frontend's indicator picker and param forms are driven entirely by this. It
    lives only in the backend; the frontend keeps no copy, because two copies
    mean adding a usage requires two edits, and the edit you forget shows up as a
    400 on params the user was told were valid.
    """
    return {
        "intervals": sorted(ALLOWED_INTERVALS, key=lambda v: (v == "D", int(v) if v != "D" else 0)),
        "maxConditions": MAX_CONDITIONS,
        "indicators": [
            {
                "key": indicator,
                "usages": [
                    {
                        "key": u.key,
                        "mirror": u.mirror,
                        "params": {
                            name: {
                                "kind": ps.kind,
                                "default": ps.default,
                                "min": ps.minimum,
                                "max": ps.maximum,
                                "options": list(ps.options) if ps.options else None,
                            }
                            for name, ps in u.params.items()
                        },
                    }
                    for u in usage_specs_for(indicator)
                ],
            }
            for indicator in INDICATORS
        ],
    }


@router.get("/templates", response_model=dict)
def list_templates(_user: User = Depends(get_current_user)):
    """列出 6 条新手预设的条件组合。载入后完全可改，引擎侧不认识 template。
    Lists the six beginner presets' condition sets. Freely editable once loaded;
    the engine knows nothing about templates."""
    return {
        "presets": {
            key: {"logic": PRESET_LOGIC[key], "conditions": PRESET_CONDITIONS[key]}
            for key in TEMPLATE_KEYS
        }
    }


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
    asked = [s.strip().upper() for s in symbols.split(",") if s.strip()]
    sym_list = asked or active_symbols()
    itv_list = [i.strip() for i in intervals.split(",") if i.strip()] or sorted(ALLOWED_INTERVALS)
    # 上限只约束显式传入的清单，不约束 active_symbols() 默认值：覆盖度的用途
    # 正是把未接入品种置灰，天然要看全部品种，拿单条策略的盯盘上限卡这个只读
    # 聚合查询会让默认分支永远 400，整个策略页加载即失败。
    # The cap applies only to an explicitly requested list, never to the
    # active_symbols() default: greying out unfed symbols inherently needs them
    # all, and applying a per-strategy watch cap to this read-only aggregate
    # would 400 the default branch and fail the whole strategies page.
    if len(asked) > MAX_COVERAGE_SYMBOLS:
        raise HTTPException(
            status_code=400,
            detail=(
                f"一次最多查询 {MAX_COVERAGE_SYMBOLS} 个品种 / "
                f"at most {MAX_COVERAGE_SYMBOLS} symbols per request"
            ),
        )
    for itv in itv_list:
        _assert_interval(itv)
    return {
        "coverage": coverage_matrix(db, sym_list, itv_list),
        "activeSymbols": active_symbols(),
    }


@router.get("/symbols", response_model=dict)
async def list_candidate_symbols(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """策略编辑器的候选品种，以及其中哪些当前正在推报价。

    symbols 的语义是"有历史数据、能回测"；activeSymbols 是其中此刻在推的子集，
    两者的差集就是前端要置灰的品种。

    本端点的存在是为了让首屏不必再调 /strategies/coverage：后者不传参时会对每个
    (品种, 周期) 组合各算一行，而首屏要的只是品种名。统计数字由回测面板按当前
    选中的那一对单独拉取。

    The strategy editor's candidate symbols plus which of them are being quoted.
    `symbols` means "has history, can be backtested"; `activeSymbols` is the
    subset quoting right now, and the frontend greys out the difference.

    This exists so the first paint no longer needs /strategies/coverage, which
    without arguments computes a row per (symbol, interval) pair when all the
    page wants is the names. The statistics are fetched by the backtest panel for
    the one pair it's showing.
    """
    _check_access(db, user)
    return {
        "symbols": symbols_with_history(db),
        "activeSymbols": active_symbols(),
    }


@router.get("/performance", response_model=dict)
def list_all_performance(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """当前用户全部策略的实盘绩效，一个请求解决。

    存在的理由：策略页原先对每个策略各发一次 /{strategy_id}/performance，请求数
    随策略数线性增长，而每次都是同一张表的同一类聚合。这里用一条带
    GROUP BY strategy_id, result 的语句覆盖该用户全部策略，避免把 HTTP 层的 N+1
    原样搬到 SQL 层。

    连亏是例外：它顺序相关、无法聚合，仍然每策略一次限窗口查询。取舍是明知的——
    每次查询有 STREAK_WINDOW 的硬上限、只取 result 一列，且策略数本身受每用户上限
    约束，所以总成本有界。合并成一条要靠窗口函数做分组编号来识别连续段，那段 SQL
    比它省下的几次单列小查询更难读也更难验证，这里选择不换。

    路由必须注册在任何 /{strategy_id} 之前，否则 "performance" 会被当成一个
    strategy_id 匹配掉。

    Live performance for every strategy the caller owns, in one request. The
    strategies page used to issue one /{strategy_id}/performance per strategy —
    request count growing linearly while every one of them ran the same
    aggregate over the same table. A single GROUP BY strategy_id, result covers
    them all, so the HTTP-layer N+1 isn't just moved down into SQL.

    The streak is the exception: order-dependent, not aggregatable, so it stays
    one windowed query per strategy. That's a deliberate trade — each is capped
    at STREAK_WINDOW rows of a single column, and the per-user strategy limit
    bounds how many run, so total cost is bounded. Folding them into the one
    statement would take window-function gap-and-island SQL that is harder to read
    and verify than the handful of small single-column queries it saves.

    Must be registered ahead of any /{strategy_id} route, or "performance" gets
    matched as a strategy_id.
    """
    _check_access(db, user)
    ids = [
        r[0]
        for r in db.query(UserStrategy.id)
        .filter(UserStrategy.user_id == user.id)
        .order_by(UserStrategy.created_at.asc())
        .all()
    ]
    groups = _perf_groups(db, ids)
    return {
        "performance": [
            _perf_payload(sid, groups.get(sid, {}), _max_loss_streak(db, sid))
            for sid in ids
        ]
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
    _assert_interval(body.interval)
    _assert_symbol_fed(body.symbol)
    rules = _resolve_rules(body.template, body.rules, body.symbol, body.interval)
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
        symbol=body.symbol, interval=body.interval,
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

    # 品种/周期/条件任一变动都要整体重新校验：rules 里也存着品种周期，只校验
    # 改动的那一项会留下「顶层改了、rules 没改」的错位状态。
    # Any change to symbol/interval/rules triggers a full re-validation: `rules`
    # carries its own symbol/interval, so validating only the changed field would
    # leave the top-level pair and the one inside rules out of sync.
    touches_scope = body.symbol is not None or body.interval is not None or body.rules is not None
    if touches_scope:
        symbol = body.symbol if body.symbol is not None else row.symbol
        interval = body.interval if body.interval is not None else row.interval
        _assert_interval(interval)
        if body.symbol is not None:
            _assert_symbol_fed(symbol)
        rules = body.rules if body.rules is not None else json.loads(row.rules or "{}")
        rules = _resolve_rules(None, rules, symbol, interval)
        row.rules = json.dumps(rules, ensure_ascii=False)
        row.symbol, row.interval = symbol, interval

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
    # 以下四个可空字段一律用 model_fields_set 而不是 `is not None` 判断。
    #
    # 显式传 null（把这项关掉）与压根不传（保持原值）在 Pydantic 里都是 None，
    # 只有「这个键出现过吗」能区分两者。用 is not None 判断的后果是关不掉——用户
    # 在编辑器里把「超时出场 30 根」改成 0（前端转成 null 发出，见
    # StrategiesPage.tsx 的 `v > 0 ? v : null`），保存提示成功，回来一看还是 30。
    # 这四个字段前端都是恒定传出的，不存在「省略键」的调用方，所以判据换成键是否
    # 出现之后，语义就是前端一直以为的那个。
    #
    # These four nullable fields all key off model_fields_set rather than
    # `is not None`. An explicit null (turn this off) and an omitted field both
    # arrive as None in Pydantic, and only "was this key present" separates them.
    # With an `is not None` guard they cannot be switched off: the user sets
    # "exit after 30 bars" to 0 in the editor (sent as null — see
    # `v > 0 ? v : null` in StrategiesPage.tsx), the save reports success, and the
    # value is still 30 on return. The frontend always sends all four, so no
    # caller omits them, and keying off presence gives them the semantics the
    # frontend assumed all along.
    if "exitTimeoutBars" in body.model_fields_set:
        row.exit_timeout_bars = body.exitTimeoutBars
    if "sessionFilter" in body.model_fields_set:
        row.session_filter = (
            json.dumps(body.sessionFilter.model_dump()) if body.sessionFilter else None
        )
    if "dailySignalCap" in body.model_fields_set:
        row.daily_signal_cap = body.dailySignalCap
    if "cooldownMinutes" in body.model_fields_set:
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


def _load_backtest_bars(db: Session, symbol: str, interval: str, days: int) -> list[dict]:
    """回测这一段 K 线的唯一取法。回测本身与画图都必须走这里。

    此前画图用的是 GET /chart/history,那条读的是内存缓存(chart_store,硬上限
    500 根、只留最近的),而回测读的是 Candle 表按 days 窗口取的最多
    MAX_BACKTEST_BARS 根。两份数据的时间范围根本不同,于是回测算出的入场/出场
    时间戳大量落在图上那 500 根蜡烛之外——标记被挤到边缘、成交连线在没有蜡烛
    的空白区悬着,看起来就是"标记线不准"。抽成一个函数是为了让"回测用哪段数据"
    只有一个答案。

    The single way to load the backtest's bar window; both the backtest and its
    chart must go through here.

    The chart used to fetch GET /chart/history, which reads the in-memory cache
    (chart_store: hard cap of 500 bars, newest only), while the backtest reads
    up to MAX_BACKTEST_BARS rows from the Candle table over the `days` window.
    Two different time ranges, so most of the computed entry/exit timestamps
    fell outside the 500 charted candles — markers squashed against the edge,
    trade lines floating over blank space. That is the "markers are inaccurate"
    report. One function so "which bars does the backtest use" has one answer.

    取法本身与 evaluate_new_candle() 一致:按时间倒序取最新的 MAX_BACKTEST_BARS
    根再翻回正序。不能直接正序 limit——days 窗口里的行数完全可能超过上限(比如
    1 分钟线),正序 limit 会永远只拿到窗口里最早的那些,新到的数据再多也追不上,
    回测看起来就像卡在某个固定日期。
    Same fetch pattern as evaluate_new_candle(): newest MAX_BACKTEST_BARS rows
    descending, then reversed. An ascending limit would forever return only the
    earliest rows in the window (a `days` window can hold more than the cap,
    e.g. 1-minute candles), leaving the backtest apparently stuck on a fixed
    date no matter how much new data arrives.
    """
    cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).timestamp()
    rows = (
        db.query(Candle)
        .filter(Candle.symbol == symbol, Candle.interval == interval, Candle.t >= cutoff)
        .order_by(Candle.t.desc())
        .limit(MAX_BACKTEST_BARS)
        .all()
    )
    rows.reverse()
    return [{"t": r.t, "o": r.o, "h": r.h, "l": r.l, "c": r.c, "v": r.v} for r in rows]


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
    _assert_interval(body.interval)
    _assert_symbol_fed(symbol)
    rules = _resolve_rules(body.template, body.rules, symbol, body.interval)

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

    bars = _load_backtest_bars(db, symbol, body.interval, body.days)

    try:
        assert_within_cost_cap(len(bars), len(rules.get("conditions") or []))
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
    except ValueError as e:
        # 指标序列过短（数据含空洞）、ATR 预热期取不到值这类求值期错误：400 并
        # 说明，不返回半套结果。捕的是 ValueError 而不是某个专有异常：
        # ConditionError 本身就是 ValueError 的子类，backtest.exit_prices 抛的也是
        # 裸 ValueError，一条分支同时覆盖两者。
        #
        # 这里曾经写的是 `except RuleError`，而 RuleError 随 rules.py 改名成
        # conditions.py 时一并消失了——except 子句只在真的有异常经过时才求值，所以
        # 单测走的正常路径永远碰不到它。一旦 run_backtest 抛出任何非 BacktestBusy
        # 的异常，Python 求值这个不存在的名字会抛 NameError，用户拿到的是 500 而
        # 不是本该有的 400；更糟的是 500 会绕过 CORS 中间件、响应不带跨域头，浏览器
        # 一律报成 CORS 错误（同《部署与上线进度》踩坑记录 #27 的现象），排查方向
        # 会被直接带偏到 nginx 和 CORS_ORIGINS 上去。
        #
        # Evaluation-time errors — too-short indicator series (data gaps), no ATR
        # value during warm-up — become a 400 with an explanation rather than half
        # a result. This catches ValueError rather than a dedicated exception
        # because ConditionError subclasses ValueError and backtest.exit_prices
        # raises a bare ValueError; one clause covers both.
        #
        # This used to read `except RuleError`, a name that disappeared when
        # rules.py became conditions.py. An except clause is only evaluated when an
        # exception actually passes through, so the happy paths the tests exercise
        # never touched it. The moment run_backtest raised anything other than
        # BacktestBusy, evaluating that missing name raised NameError and the user
        # got a 500 instead of the intended 400 — and a 500 bypasses the CORS
        # middleware, so the browser reports it as a CORS error (the same symptom
        # as deployment-log pitfall #27), sending anyone debugging it off toward
        # nginx and CORS_ORIGINS instead.
        logger.warning("backtest failed for user %s (%s/%s): %s", user.id, symbol, body.interval, e)
        raise HTTPException(status_code=400, detail=str(e)) from e

    # 响应不带 bars：5000 根序列化一次就是几百 KB。前端画蜡烛图走
    # GET /strategies/backtest/bars，那条与这里共用 _load_backtest_bars，取的是
    # 同一段数据（此前它走 /chart/history，只有最近 500 根内存缓存，于是标记
    # 与蜡烛对不上）。
    # No bars in the response: serializing 5000 is hundreds of KB. The chart
    # fetches GET /strategies/backtest/bars, which shares _load_backtest_bars
    # with this handler and therefore returns the same window (it used to call
    # /chart/history — the newest 500 cached bars only — which is why the markers
    # didn't line up with the candles).
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


@router.get("/backtest/bars", response_model=dict)
def get_backtest_bars(
    symbol: str,
    interval: str,
    days: int = 90,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """回测图用的 K 线：与 POST /strategies/backtest 完全同一段数据。

    只读、无副作用,不跑回测、不进回测并发闸门,所以刷新图不会撞上"你已有一个
    回测在跑"。days 的取值范围与 StrategyBacktestRequest.days 一致(7-730):
    两边必须相同,否则图能取到的区间与回测算过的区间又会分叉,正是这次要修的
    那个问题。

    Candles for the backtest chart: the exact same window as POST
    /strategies/backtest. Read-only with no side effects — it neither runs a
    backtest nor enters the backtest concurrency gate, so refreshing the chart
    can't trip "a backtest of yours is already running". The `days` bounds match
    StrategyBacktestRequest.days (7-730) and have to: a different range here
    would let the charted window diverge from the computed one all over again,
    which is the exact bug being fixed.

    注册在 GET /{strategy_id}/performance 之前不是必须的(路径段数不同,不会
    互相匹配),但与 /signals 的处理保持一致:具体路径先于参数路径。
    Registering before GET /{strategy_id}/performance isn't strictly required
    (different segment counts, so no collision), but it matches how /signals is
    handled: literal paths ahead of parameterized ones.
    """
    _check_access(db, user)
    _assert_interval(interval)
    sym = symbol.strip().upper()
    if not 7 <= days <= 730:
        raise HTTPException(status_code=400, detail="days 需在 7-730 之间 / days must be 7-730")
    bars = _load_backtest_bars(db, sym, interval, days)
    return {"symbol": sym, "interval": interval, "days": days, "bars": bars}


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


def _perf_groups(db: Session, strategy_ids: list[str]) -> dict[str, dict[str, tuple[int, float]]]:
    """按 (策略, result) 聚合出笔数与 R 值之和，一条 SQL 覆盖传入的全部策略。

    为什么把 R 值也放进 SQL：avgRr 要按每条信号自己的 TP/SL 距离算，看着像必须
    逐行处理，但"求和"这一步 SQL 自己就能做——CASE 里算 reward/risk 再 SUM，
    结果与逐行累加完全一致，却不必把信号行送进 Python。这是本次改动的关键：
    strategy_signals 只增不减，全量载入的成本会随策略寿命线性上涨。

    risk 为 0（entry 与 stop_loss 相同，理论上不该出现但库里没有约束挡着）时记 0.0，
    与原逐行实现的分支一致——除零会让整个聚合报错，而不是只坏掉一行。

    Aggregate count and summed R per (strategy, result) with one statement for
    every strategy passed in. avgRr uses each signal's own TP/SL distance, which
    looks row-bound, but the summation itself is something SQL does: compute
    reward/risk inside a CASE and SUM it, which matches the row-by-row total
    exactly without shipping signal rows to Python. That matters because
    strategy_signals is append-only, so a full load costs more the longer a
    strategy lives. A zero risk (entry == stop_loss — shouldn't happen, but no
    constraint forbids it) contributes 0.0, mirroring the original branch: a
    division by zero would fail the whole aggregate rather than one row.
    """
    if not strategy_ids:
        return {}
    risk = func.abs(StrategySignal.entry - StrategySignal.stop_loss)
    reward = func.abs(StrategySignal.take_profit - StrategySignal.entry)
    rr = case(
        (StrategySignal.result == "HIT_TP", case((risk > 0, reward / risk), else_=0.0)),
        (StrategySignal.result == "HIT_SL", -1.0),
        else_=0.0,
    )
    rows = (
        db.query(
            StrategySignal.strategy_id,
            StrategySignal.result,
            func.count(StrategySignal.id),
            func.coalesce(func.sum(rr), 0.0),
        )
        .filter(StrategySignal.strategy_id.in_(strategy_ids))
        .group_by(StrategySignal.strategy_id, StrategySignal.result)
        .all()
    )
    out: dict[str, dict[str, tuple[int, float]]] = {}
    for sid, result, n, rr_sum in rows:
        out.setdefault(sid, {})[result] = (int(n), float(rr_sum or 0.0))
    return out


def _max_loss_streak(db: Session, strategy_id: str) -> int:
    """最近 STREAK_WINDOW 笔已判定信号里的最长连亏。

    排序键是 bar_t 而不是 created_at：created_at 是 `default=_now`，同一批写入的
    多行会拿到相同或几乎相同的时间戳，用它排序实际上是在依赖数据库返回插入顺序。
    bar_t 是触发那根 K 线的 epoch 秒，在同一策略内严格递增，是这里唯一可靠的顺序。

    TIMEOUT 会打断连亏（它是一次真实出场），STALE/PENDING 不参与所以直接过滤掉，
    否则它们会占掉窗口名额，让实际回看的已判定笔数少于 STREAK_WINDOW。

    Longest losing run within the most recent STREAK_WINDOW resolved signals.
    Ordered by bar_t, not created_at: created_at is `default=_now`, so rows
    written together share a timestamp and ordering by it really means trusting
    the database to hand back insertion order. bar_t is the triggering bar's
    epoch second, strictly increasing within a strategy, and the only dependable
    sequence here. TIMEOUT breaks a run (it's a real exit); STALE/PENDING are
    filtered out rather than skipped in Python, or they would consume window
    slots and leave fewer than STREAK_WINDOW resolved signals actually examined.
    """
    rows = (
        db.query(StrategySignal.result)
        .filter(
            StrategySignal.strategy_id == strategy_id,
            StrategySignal.result.in_(("HIT_TP", "HIT_SL", "TIMEOUT")),
        )
        .order_by(StrategySignal.bar_t.desc())
        .limit(STREAK_WINDOW)
        .all()
    )
    streak = max_streak = 0
    for (result,) in reversed(rows):  # 取回是倒序，连亏必须正序数 / restore ascending order
        if result == "HIT_SL":
            streak += 1
            max_streak = max(max_streak, streak)
        else:
            streak = 0
    return max_streak


def _perf_payload(strategy_id: str, groups: dict[str, tuple[int, float]], max_streak: int) -> dict:
    """把一个策略的分组聚合结果拼成响应体。口径见 live_performance 的说明。
    Assemble one strategy's response body from its grouped aggregate; see
    live_performance for the definitions."""
    wins, win_rr = groups.get("HIT_TP", (0, 0.0))
    losses, loss_rr = groups.get("HIT_SL", (0, 0.0))
    timeouts = groups.get("TIMEOUT", (0, 0.0))[0]
    pending = groups.get("PENDING", (0, 0.0))[0]
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
        "avgRr": ((win_rr + loss_rr) / decided) if enough and decided > 0 else None,
        "maxLossStreak": max_streak,
        "streakWindow": STREAK_WINDOW,
        "insufficientSample": not enough,
        "sampleThreshold": MIN_PERF_SAMPLE,
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

    maxLossStreak 只覆盖最近 STREAK_WINDOW 笔已判定信号（响应里的 streakWindow
    就是这个值）；其余字段是全历史，且都在一条 GROUP BY 里算完，不再把信号行载入
    Python。
    maxLossStreak covers only the most recent STREAK_WINDOW resolved signals
    (reported as streakWindow); the other fields span all history and are computed
    by a single GROUP BY instead of loading signal rows into Python.
    """
    groups = _perf_groups(db, [strategy_id]).get(strategy_id, {})
    return _perf_payload(strategy_id, groups, _max_loss_streak(db, strategy_id))


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
