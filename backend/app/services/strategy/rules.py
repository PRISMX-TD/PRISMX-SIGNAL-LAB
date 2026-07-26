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
