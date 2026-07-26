"""规则 AST：校验与求值。

AST 只有两类节点——条件组(logic + children，可嵌套)与比较(left/op/right)。
操作数三类：indicator(fn + params + 可选 interval)、const(value)、price(field)。
校验一律报错而不静默夹取，因为静默改写用户参数会让"我明明填了 500"变成
无法解释的行为。

Rule AST: validation and evaluation.

Only two node kinds — a group (logic + children, nestable) and a comparison
(left/op/right). Three operand kinds: indicator (fn + params + optional
interval), const (value), price (field). Validation always raises rather than
clamping: silently rewriting a user's parameter turns "but I typed 500" into
inexplicable behaviour.
"""
from app.services.strategy import indicators as ind

ALLOWED_INTERVALS = frozenset({"1", "5", "15", "60", "240", "D"})
COMPARE_OPS = frozenset({"crosses_above", "crosses_below", "gt", "lt", "gte", "lte"})
PRICE_FIELDS = frozenset({"open", "high", "low", "close"})

MAX_CONDITIONS = 12
MAX_DEPTH = 3
MAX_INDICATOR_INSTANCES = 8
MAX_INTERVALS = 3
MAX_SYMBOLS = 5

# 每个指标的参数规格：名称 -> (最小值, 最大值, 是否整数)
# Per-indicator parameter spec: name -> (min, max, is_int)
INDICATOR_SPECS: dict[str, dict[str, tuple[float, float, bool]]] = {
    "sma": {"period": (2, 300, True)},
    "ema": {"period": (2, 300, True)},
    "rsi": {"period": (2, 50, True)},
    "atr": {"period": (2, 100, True)},
    "macd_dif": {"fastPeriod": (2, 50, True), "slowPeriod": (3, 100, True), "signalPeriod": (2, 50, True)},
    "macd_dea": {"fastPeriod": (2, 50, True), "slowPeriod": (3, 100, True), "signalPeriod": (2, 50, True)},
    "boll_upper": {"period": (5, 100, True), "mult": (0.5, 5.0, False)},
    "boll_middle": {"period": (5, 100, True), "mult": (0.5, 5.0, False)},
    "boll_lower": {"period": (5, 100, True), "mult": (0.5, 5.0, False)},
    "donchian_high": {"period": (5, 100, True)},
    "donchian_low": {"period": (5, 100, True)},
}


class RuleError(ValueError):
    """AST 不合法。message 直接作为 400 的 detail 返回给前端。
    Invalid AST. `message` is surfaced as the 400 detail."""

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


def _indicator_key(operand: dict) -> tuple:
    params = operand.get("params") or {}
    return (
        operand.get("fn"),
        tuple(sorted((k, params[k]) for k in params)),
        operand.get("interval") or "",
    )


def _validate_operand(operand: object) -> None:
    if not isinstance(operand, dict):
        raise RuleError("操作数必须是对象 / operand must be an object")
    kind = operand.get("kind")
    if kind == "const":
        if not isinstance(operand.get("value"), (int, float)) or isinstance(operand.get("value"), bool):
            raise RuleError("常量必须是数字 / const value must be a number")
        return
    if kind == "price":
        if operand.get("field") not in PRICE_FIELDS:
            raise RuleError(f"未知价格字段，可选 {sorted(PRICE_FIELDS)} / unknown price field")
        return
    if kind == "indicator":
        fn = operand.get("fn")
        spec = INDICATOR_SPECS.get(fn)
        if spec is None:
            raise RuleError(f"未知指标 {fn}，可选 {sorted(INDICATOR_SPECS)} / unknown indicator")
        params = operand.get("params")
        if not isinstance(params, dict):
            raise RuleError(f"指标 {fn} 缺少参数 / indicator {fn} is missing params")
        for name, (lo, hi, is_int) in spec.items():
            if name not in params:
                raise RuleError(f"指标 {fn} 缺少参数 {name} / missing param {name}")
            raw = params[name]
            if isinstance(raw, bool) or not isinstance(raw, (int, float)):
                raise RuleError(f"参数 {name} 必须是数字 / param {name} must be a number")
            if is_int and int(raw) != raw:
                raise RuleError(f"参数 {name} 必须是整数 / param {name} must be an integer")
            if raw < lo or raw > hi:
                raise RuleError(
                    f"参数 {name} 超出范围，合法区间 {lo}-{hi} / param {name} out of range {lo}-{hi}"
                )
        for name in params:
            if name not in spec:
                raise RuleError(f"指标 {fn} 不接受参数 {name} / unexpected param {name}")
        interval = operand.get("interval")
        if interval is not None and interval not in ALLOWED_INTERVALS:
            raise RuleError(f"未知周期 {interval}，可选 {sorted(ALLOWED_INTERVALS)} / unknown interval")
        if fn in ("macd_dif", "macd_dea") and params["slowPeriod"] <= params["fastPeriod"]:
            raise RuleError("slowPeriod 必须大于 fastPeriod / slowPeriod must exceed fastPeriod")
        return
    raise RuleError("操作数 kind 必须是 indicator/const/price / operand kind must be indicator, const or price")


def _walk(node: object, depth: int, stats: dict) -> None:
    if not isinstance(node, dict):
        raise RuleError("节点必须是对象 / node must be an object")
    if "logic" in node:
        if depth > MAX_DEPTH:
            raise RuleError(f"条件嵌套过深，最多 {MAX_DEPTH} 层 / nesting deeper than {MAX_DEPTH}")
        if node["logic"] not in ("AND", "OR"):
            raise RuleError("logic 必须是 AND 或 OR / logic must be AND or OR")
        children = node.get("children")
        if not isinstance(children, list) or not children:
            raise RuleError("条件组不能为空 / a group must have at least one child")
        for child in children:
            _walk(child, depth + 1, stats)
        return
    if node.get("op") not in COMPARE_OPS:
        raise RuleError(f"未知比较符，可选 {sorted(COMPARE_OPS)} / unknown operator")
    stats["conditions"] += 1
    if stats["conditions"] > MAX_CONDITIONS:
        raise RuleError(f"条件数超过上限 {MAX_CONDITIONS} / more than {MAX_CONDITIONS} conditions")
    for side in ("left", "right"):
        if side not in node:
            raise RuleError(f"比较缺少 {side} / comparison is missing {side}")
        operand = node[side]
        _validate_operand(operand)
        if isinstance(operand, dict) and operand.get("kind") == "indicator":
            stats["indicators"].add(_indicator_key(operand))
            if operand.get("interval"):
                stats["intervals"].add(operand["interval"])


def validate_rules(ast: object) -> None:
    """校验整棵 AST。不合法抛 RuleError，合法返回 None。
    Validate the whole AST: raises RuleError when invalid, returns None when OK."""
    stats = {"conditions": 0, "indicators": set(), "intervals": set()}
    _walk(ast, 1, stats)
    if stats["conditions"] == 0:
        raise RuleError("至少需要一个条件 / at least one condition is required")
    if len(stats["indicators"]) > MAX_INDICATOR_INSTANCES:
        raise RuleError(
            f"不同指标实例超过上限 {MAX_INDICATOR_INSTANCES} / more than "
            f"{MAX_INDICATOR_INSTANCES} distinct indicator instances"
        )
    if len(stats["intervals"]) > MAX_INTERVALS:
        raise RuleError(f"涉及周期超过上限 {MAX_INTERVALS} / more than {MAX_INTERVALS} intervals")


def collect_intervals(ast: dict) -> set[str]:
    """收集 AST 中显式指定的所有非主周期。用于回测/实时评估预取多周期数据。
    Collect every explicitly-specified interval, so the backtest and live
    evaluator know which extra series to fetch."""
    stats = {"conditions": 0, "indicators": set(), "intervals": set()}
    _walk(ast, 1, stats)
    return stats["intervals"]


INTERVAL_SECONDS: dict[str, int] = {
    "1": 60, "5": 300, "15": 900, "60": 3600, "240": 14400, "D": 86400,
}


def align_series(
    base_times: list[int],
    other_times: list[int],
    other_values: list[float | None],
    other_interval_seconds: int,
) -> list[float | None]:
    """把非主周期序列对齐到主周期时间轴，只使用已收盘的非主周期 bar。

    一根非主周期 bar 的开盘时间是 t，收盘时刻是 t + interval_seconds。在主周期
    时间 bt 上，只有满足 t + interval_seconds <= bt 的那些 bar 才是"已经收盘、
    信息已经完整"的；取其中最晚的一根的值。这是整个多周期功能防止未来函数的
    唯一关口——如果这里放宽成 t <= bt，策略就能在 4H K 线还在形成时就用到它
    最终的收盘价，回测会凭空多出无法在实盘复现的收益。

    Align a non-primary-interval series onto the primary timeline, using only
    closed bars. A bar opening at t closes at t + interval_seconds, so at
    primary-timeline moment bt only bars satisfying
    t + interval_seconds <= bt are complete; take the latest such bar's value.
    This is the single guard against look-ahead bias in the whole
    multi-timeframe feature — relaxing it to t <= bt would let a strategy use
    a 4H bar's final close while that bar is still forming, inventing
    backtest profit that can never be reproduced live.
    """
    out: list[float | None] = [None] * len(base_times)
    j = -1  # 指向最后一根已确认收盘的非主周期 bar / last bar confirmed closed
    last_value: float | None = None
    for i, bt in enumerate(base_times):
        while j + 1 < len(other_times) and other_times[j + 1] + other_interval_seconds <= bt:
            j += 1
            last_value = other_values[j]
        out[i] = last_value
    return out


def _series_for_operand(
    operand: dict,
    bars: list[dict],
    extra_series: dict[str, list[dict]] | None,
) -> list[float | None]:
    """把一个操作数解析成与 bars 等长的数值序列。
    Resolve an operand into a series the same length as bars."""
    kind = operand.get("kind")
    interval = operand.get("interval")

    if kind == "const":
        return [float(operand["value"])] * len(bars)

    # 指标与价格字段都可能带 interval：先决定在哪一组 bars 上计算
    # Both indicators and price fields may carry an interval: decide which
    # bar series to compute on first.
    if interval:
        source = (extra_series or {}).get(interval)
        if not source:
            return [None] * len(bars)
    else:
        source = bars

    if kind == "price":
        field = {"open": "o", "high": "h", "low": "l", "close": "c"}[operand["field"]]
        raw: list[float | None] = [b[field] for b in source]
    elif kind == "indicator":
        raw = _indicator_series(operand["fn"], operand.get("params") or {}, source)
    else:
        raise RuleError(f"未知操作数类型 {kind} / unknown operand kind {kind}")

    if not interval:
        return raw
    return align_series(
        [b["t"] for b in bars],
        [b["t"] for b in source],
        raw,
        INTERVAL_SECONDS[interval],
    )


def _indicator_series(fn: str, params: dict, source: list[dict]) -> list[float | None]:
    """按指标名在给定 bars 上算出数值序列。
    Compute an indicator series over the given bars."""
    closes = [b["c"] for b in source]
    highs = [b["h"] for b in source]
    lows = [b["l"] for b in source]
    if fn == "sma":
        return ind.sma(closes, int(params["period"]))
    if fn == "ema":
        return ind.ema(closes, int(params["period"]))
    if fn == "rsi":
        return ind.rsi(closes, int(params["period"]))
    if fn == "atr":
        return ind.atr(highs, lows, closes, int(params["period"]))
    if fn == "donchian_high":
        return ind.donchian_high(highs, int(params["period"]))
    if fn == "donchian_low":
        return ind.donchian_low(lows, int(params["period"]))
    if fn in ("boll_upper", "boll_middle", "boll_lower"):
        upper, middle, lower = ind.bollinger(closes, int(params["period"]), float(params["mult"]))
        return {"boll_upper": upper, "boll_middle": middle, "boll_lower": lower}[fn]
    if fn in ("macd_dif", "macd_dea"):
        dif, dea = ind.macd(
            closes, int(params["fastPeriod"]), int(params["slowPeriod"]), int(params["signalPeriod"])
        )
        return dif if fn == "macd_dif" else dea
    raise RuleError(f"未知指标 {fn} / unknown indicator {fn}")


def _compare_series(
    left: list[float | None], right: list[float | None], op: str
) -> list[bool]:
    """按比较符逐位比较两条序列，任一侧为 None 的位置结果为 False。

    交叉类比较需要前一根的值，首根一律 False。全部比较（包括 gt/lt 等非交叉
    比较）都走带容差的 cmp_with_tol——现有实现只在部分模板里用容差，导致
    布林/唐奇安/动量模板会被 1e-13 级浮点残留误判，这里统一口径。

    Element-wise comparison; any position with a None operand is False.
    Crossing operators need the previous bar, so the first position is always
    False. Every comparison — not just crossings — goes through the
    tolerance-aware cmp_with_tol; the previous implementation only applied
    tolerance in some templates, letting 1e-13 float residue produce phantom
    results in the Bollinger/Donchian/momentum ones.
    """
    n = len(left)
    out = [False] * n
    for i in range(n):
        a, b = left[i], right[i]
        if a is None or b is None:
            continue
        if op in ("crosses_above", "crosses_below"):
            if i == 0:
                continue
            pa, pb = left[i - 1], right[i - 1]
            if pa is None or pb is None:
                continue
            prev = ind.cmp_with_tol(pa, pb)
            cur = ind.cmp_with_tol(a, b)
            if op == "crosses_above":
                out[i] = prev <= 0 and cur > 0
            else:
                out[i] = prev >= 0 and cur < 0
            continue
        c = ind.cmp_with_tol(a, b)
        if op == "gt":
            out[i] = c > 0
        elif op == "lt":
            out[i] = c < 0
        elif op == "gte":
            out[i] = c >= 0
        elif op == "lte":
            out[i] = c <= 0
    return out


def _eval_node(
    node: dict, bars: list[dict], extra_series: dict[str, list[dict]] | None
) -> list[bool]:
    if "logic" in node:
        child_results = [_eval_node(c, bars, extra_series) for c in node["children"]]
        combine = all if node["logic"] == "AND" else any
        return [combine(r[i] for r in child_results) for i in range(len(bars))]
    left = _series_for_operand(node["left"], bars, extra_series)
    right = _series_for_operand(node["right"], bars, extra_series)
    return _compare_series(left, right, node["op"])


def evaluate_rules(
    bars: list[dict], ast: dict, extra_series: dict[str, list[dict]] | None = None
) -> list[bool]:
    """对 bars 求值整棵规则树，返回等长布尔序列。

    调用方应已通过 validate_rules 校验过 ast。指标预热期、数据缺失、非主周期
    尚未收盘等情况一律产出 False，不抛异常——单个位置无法判定不应让整次回测
    失败。

    Evaluate the whole rule tree over bars, returning a boolean series of the
    same length. Callers are expected to have run validate_rules first.
    Warm-up periods, missing data and not-yet-closed higher-timeframe bars all
    yield False rather than raising — one undecidable position shouldn't fail
    an entire backtest.
    """
    if not bars:
        return []
    return _eval_node(ast, bars, extra_series)
