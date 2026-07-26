"""10 个旧模板的预设 AST，以及 template + params -> AST 的等价转换。

模板从「引擎里的 if/elif 分支」降级为「AST 的预设值」：用户载入后可任意修改，
引擎侧不再存在模板概念。转换必须逐 bar 等价于旧引擎，否则已启用的策略会在
升级当天静默改变行为——测试 test_strategy_presets.py 对全部 10 个模板做逐 bar
对照。

规则信封：一个策略的 rules 是 {"long": 组|None, "short": 组|None}。方向不放进
单棵树里，因为「同一棵树同时描述买和卖」表达不出「上穿买、下穿卖」这类天然
成对但条件相反的规则，而拆成两侧后老模板的 direction 参数正好退化为「保留
哪一侧」。

Preset ASTs for the 10 legacy templates plus an equivalent template+params ->
AST conversion. Templates demote from "if/elif branches inside the engine" to
"preset values of an AST" — the user can edit them freely afterwards and the
engine no longer knows what a template is. The conversion has to be bar-for-bar
equivalent to the old engine, otherwise already-enabled strategies silently
change behaviour on upgrade; test_strategy_presets.py checks all 10.

Rule envelope: a strategy's rules are {"long": group|None, "short":
group|None}. Direction lives outside the tree because one tree can't express
"cross up buys, cross down sells" — mirrored conditions, opposite directions —
and with two sides the legacy `direction` param degenerates neatly into "which
side to keep".
"""
from app.services.strategy.rules import (
    MAX_CONDITIONS,
    MAX_INTERVALS,
    RuleError,
    collect_intervals,
    evaluate_rules,
    validate_rules,
)

TEMPLATE_KEYS: tuple[str, ...] = (
    "ma_cross",
    "rsi_reversal",
    "bollinger_reversion",
    "macd_cross",
    "ma_pullback",
    "bollinger_breakout",
    "rsi_momentum",
    "donchian_breakout",
    "momentum_breakout",
    "trend_rsi_filter",
)

# 模板参数默认值与合法范围。从 strategy_engine.TEMPLATE_SCHEMAS 平移，唯一改动
# 是 rsi_momentum 新增 midline（旧实现里硬编码的 50，默认值保持 50 以确保迁移
# 后行为不变）。本字典是模板清单的单一来源，schemas.py 引用 TEMPLATE_KEYS。
# Ported from strategy_engine.TEMPLATE_SCHEMAS; the only change is
# rsi_momentum's new `midline` (the old hardcoded 50, defaulting to 50 so
# migrated strategies behave identically). This dict is the single source of
# truth for the template list; schemas.py references TEMPLATE_KEYS.
TEMPLATE_SCHEMAS: dict[str, dict] = {
    "ma_cross": {
        "maType": {"type": "enum", "options": ["SMA", "EMA"], "default": "EMA"},
        "fastPeriod": {"type": "int", "min": 2, "max": 200, "default": 10},
        "slowPeriod": {"type": "int", "min": 3, "max": 300, "default": 30},
        "direction": {"type": "enum", "options": ["both", "long", "short"], "default": "both"},
    },
    "rsi_reversal": {
        "period": {"type": "int", "min": 2, "max": 50, "default": 14},
        "oversold": {"type": "int", "min": 1, "max": 49, "default": 30},
        "overbought": {"type": "int", "min": 51, "max": 99, "default": 70},
        "direction": {"type": "enum", "options": ["both", "long", "short"], "default": "both"},
    },
    "bollinger_reversion": {
        "period": {"type": "int", "min": 5, "max": 100, "default": 20},
        "mult": {"type": "float", "min": 0.5, "max": 5.0, "default": 2.0},
        "direction": {"type": "enum", "options": ["both", "long", "short"], "default": "both"},
    },
    "macd_cross": {
        "fastPeriod": {"type": "int", "min": 2, "max": 50, "default": 12},
        "slowPeriod": {"type": "int", "min": 3, "max": 100, "default": 26},
        "signalPeriod": {"type": "int", "min": 2, "max": 50, "default": 9},
        "direction": {"type": "enum", "options": ["both", "long", "short"], "default": "both"},
    },
    "ma_pullback": {
        "maType": {"type": "enum", "options": ["SMA", "EMA"], "default": "EMA"},
        "period": {"type": "int", "min": 5, "max": 200, "default": 20},
        "touchTolerancePct": {"type": "float", "min": 0.05, "max": 2.0, "default": 0.3},
        "direction": {"type": "enum", "options": ["both", "long", "short"], "default": "both"},
    },
    "bollinger_breakout": {
        "period": {"type": "int", "min": 5, "max": 100, "default": 20},
        "mult": {"type": "float", "min": 0.5, "max": 5.0, "default": 2.0},
        "direction": {"type": "enum", "options": ["both", "long", "short"], "default": "both"},
    },
    "rsi_momentum": {
        "period": {"type": "int", "min": 2, "max": 50, "default": 14},
        "midline": {"type": "int", "min": 2, "max": 98, "default": 50},
        "direction": {"type": "enum", "options": ["both", "long", "short"], "default": "both"},
    },
    "donchian_breakout": {
        "period": {"type": "int", "min": 5, "max": 100, "default": 20},
        "direction": {"type": "enum", "options": ["both", "long", "short"], "default": "both"},
    },
    "momentum_breakout": {
        "lookback": {"type": "int", "min": 2, "max": 100, "default": 10},
        "thresholdPct": {"type": "float", "min": 0.1, "max": 20.0, "default": 1.0},
        "direction": {"type": "enum", "options": ["both", "long", "short"], "default": "both"},
    },
    "trend_rsi_filter": {
        "trendPeriod": {"type": "int", "min": 10, "max": 200, "default": 50},
        "rsiPeriod": {"type": "int", "min": 2, "max": 50, "default": 14},
        "oversold": {"type": "int", "min": 1, "max": 49, "default": 30},
        "overbought": {"type": "int", "min": 51, "max": 99, "default": 70},
        "direction": {"type": "enum", "options": ["both", "long", "short"], "default": "both"},
    },
}


def template_defaults(template: str) -> dict:
    """某模板的默认参数 / a template's default params."""
    schema = TEMPLATE_SCHEMAS.get(template)
    if schema is None:
        raise RuleError(f"未知策略模板 {template} / unknown strategy template {template}")
    return {k: spec["default"] for k, spec in schema.items()}


def validate_strategy_rules(rules: object) -> None:
    """校验规则信封：至少一侧非空，两侧各自合法，条件数与周期数按合计判上限。

    合计而非分侧判上限：CPU 成本是两侧之和，分侧各 12 条等于把真实上限翻倍。

    Validate a rule envelope: at least one side present, each side valid on its
    own, with the condition and interval caps applied to the two sides
    combined — CPU cost is the sum, so per-side caps would silently double the
    real limit.
    """
    if not isinstance(rules, dict):
        raise RuleError("规则必须是对象 / rules must be an object")
    unknown = set(rules) - {"long", "short"}
    if unknown:
        raise RuleError(f"规则只接受 long/short 两侧，收到 {sorted(unknown)} / only long/short are accepted")
    sides = [rules.get("long"), rules.get("short")]
    if all(s is None for s in sides):
        raise RuleError("多头与空头至少要有一侧 / at least one of long/short is required")
    total_conditions = 0
    intervals: set[str] = set()
    for side in sides:
        if side is None:
            continue
        validate_rules(side)
        total_conditions += _count_side(side)
        intervals |= collect_intervals(side)
    if total_conditions > MAX_CONDITIONS:
        raise RuleError(
            f"条件数超过上限 {MAX_CONDITIONS}（多空合计）/ more than {MAX_CONDITIONS} conditions in total"
        )
    if len(intervals) > MAX_INTERVALS:
        raise RuleError(
            f"涉及周期超过上限 {MAX_INTERVALS}（多空合计）/ more than {MAX_INTERVALS} intervals in total"
        )


def _count_side(node: dict) -> int:
    if "logic" in node:
        return sum(_count_side(c) for c in node["children"])
    return 1


def count_conditions(rules: dict) -> int:
    """信封两侧的条件总数。Task 10 用它算「bars 数 × 规则节点数」的成本上限。
    Total conditions across both sides; Task 10 uses it for the
    bars x nodes cost cap."""
    return sum(_count_side(s) for s in (rules.get("long"), rules.get("short")) if s is not None)


def collect_rules_intervals(rules: dict) -> set[str]:
    """信封中出现的所有显式非主周期 / every explicit non-primary interval."""
    out: set[str] = set()
    for side in (rules.get("long"), rules.get("short")):
        if side is not None:
            out |= collect_intervals(side)
    return out


def evaluate_strategy(
    bars: list[dict],
    rules: dict,
    extra_series: dict[str, list[dict]] | None = None,
    memo: dict | None = None,
) -> list[str | None]:
    """对整段 bars 求值信封，逐 bar 返回 "BUY" / "SELL" / None。

    同一根同时满足两侧时取多头——与旧引擎 if/elif 的分支顺序一致（旧实现里
    多头分支总在前），不是随意选的。

    Evaluate the envelope over bars, returning "BUY"/"SELL"/None per bar. A bar
    satisfying both sides resolves to BUY, matching the old engine's if/elif
    ordering (the long branch always came first) rather than an arbitrary pick.
    """
    n = len(bars)
    if n == 0:
        return []
    long_side = rules.get("long")
    short_side = rules.get("short")
    longs = evaluate_rules(bars, long_side, extra_series, memo) if long_side else [False] * n
    shorts = evaluate_rules(bars, short_side, extra_series, memo) if short_side else [False] * n
    out: list[str | None] = [None] * n
    for i in range(n):
        if longs[i]:
            out[i] = "BUY"
        elif shorts[i]:
            out[i] = "SELL"
    return out


def _ind(fn: str, params: dict, shift: int = 0, scale: float | None = None) -> dict:
    node: dict = {"kind": "indicator", "fn": fn, "params": params}
    if shift:
        node["shift"] = shift
    if scale is not None:
        node["scale"] = scale
    return node


def _price(field: str, shift: int = 0, scale: float | None = None) -> dict:
    node: dict = {"kind": "price", "field": field}
    if shift:
        node["shift"] = shift
    if scale is not None:
        node["scale"] = scale
    return node


def _const(value: float) -> dict:
    return {"kind": "const", "value": value}


def _cmp(left: dict, op: str, right: dict) -> dict:
    return {"left": left, "op": op, "right": right}


def _group(*children: dict, logic: str = "AND") -> dict:
    return {"logic": logic, "children": list(children)}


def _ma_fn(ma_type: str) -> str:
    return "ema" if ma_type == "EMA" else "sma"


def _long_short(template: str, p: dict) -> tuple[dict, dict]:
    """按模板产出 (多头条件组, 空头条件组)，尚未按 direction 裁剪。
    Build (long group, short group) for a template, before direction pruning."""
    if template == "ma_cross":
        fn = _ma_fn(p["maType"])
        fast = _ind(fn, {"period": p["fastPeriod"]})
        slow = _ind(fn, {"period": p["slowPeriod"]})
        return (
            _group(_cmp(fast, "crosses_above", slow)),
            _group(_cmp(fast, "crosses_below", slow)),
        )

    if template == "rsi_reversal":
        r = _ind("rsi", {"period": p["period"]})
        return (
            _group(_cmp(r, "crosses_above", _const(float(p["oversold"])))),
            _group(_cmp(r, "crosses_below", _const(float(p["overbought"])))),
        )

    if template == "bollinger_reversion":
        period, mult = p["period"], p["mult"]
        lower = _ind("boll_lower", {"period": period, "mult": mult})
        upper = _ind("boll_upper", {"period": period, "mult": mult})
        return (
            _group(_cmp(_price("close"), "crosses_above", lower)),
            _group(_cmp(_price("close"), "crosses_below", upper)),
        )

    if template == "macd_cross":
        mp = {
            "fastPeriod": p["fastPeriod"],
            "slowPeriod": p["slowPeriod"],
            "signalPeriod": p["signalPeriod"],
        }
        dif, dea = _ind("macd_dif", mp), _ind("macd_dea", mp)
        return (
            _group(_cmp(dif, "crosses_above", dea)),
            _group(_cmp(dif, "crosses_below", dea)),
        )

    if template == "ma_pullback":
        fn = _ma_fn(p["maType"])
        period = p["period"]
        tol = p["touchTolerancePct"] / 100.0
        ma = _ind(fn, {"period": period})
        ma_prev = _ind(fn, {"period": period}, shift=1)
        # 三个条件与旧实现逐项对应：前一根收在均线上方、本根探到均线容差带内、
        # 本根仍收在均线上方。/ Three conditions map 1:1 onto the old branch.
        return (
            _group(
                _cmp(_price("close", shift=1), "gt", ma_prev),
                _cmp(_price("low"), "lte", _ind(fn, {"period": period}, scale=1 + tol)),
                _cmp(_price("close"), "gt", ma),
            ),
            _group(
                _cmp(_price("close", shift=1), "lt", ma_prev),
                _cmp(_price("high"), "gte", _ind(fn, {"period": period}, scale=1 - tol)),
                _cmp(_price("close"), "lt", ma),
            ),
        )

    if template == "bollinger_breakout":
        period, mult = p["period"], p["mult"]
        upper = _ind("boll_upper", {"period": period, "mult": mult})
        lower = _ind("boll_lower", {"period": period, "mult": mult})
        return (
            _group(_cmp(_price("close"), "crosses_above", upper)),
            _group(_cmp(_price("close"), "crosses_below", lower)),
        )

    if template == "rsi_momentum":
        r = _ind("rsi", {"period": p["period"]})
        mid = _const(float(p["midline"]))
        return (
            _group(_cmp(r, "crosses_above", mid)),
            _group(_cmp(r, "crosses_below", mid)),
        )

    if template == "donchian_breakout":
        period = p["period"]
        return (
            _group(_cmp(_price("close"), "crosses_above", _ind("donchian_high", {"period": period}))),
            _group(_cmp(_price("close"), "crosses_below", _ind("donchian_low", {"period": period}))),
        )

    if template == "momentum_breakout":
        lookback = p["lookback"]
        th = p["thresholdPct"] / 100.0
        # 旧实现比较的是 close[i]/close[i-lookback]-1 与 ±th 的上/下穿；两边同乘
        # close[i-lookback]（正价格，不改变不等号方向）后即为下面的形式。
        # The old branch crossed close[i]/close[i-lookback]-1 over ±th;
        # multiplying both sides by the (positive) close[i-lookback] gives this.
        return (
            _group(_cmp(_price("close"), "crosses_above", _price("close", shift=lookback, scale=1 + th))),
            _group(_cmp(_price("close"), "crosses_below", _price("close", shift=lookback, scale=1 - th))),
        )

    if template == "trend_rsi_filter":
        trend = _ind("ema", {"period": p["trendPeriod"]})
        r = _ind("rsi", {"period": p["rsiPeriod"]})
        return (
            _group(
                _cmp(_price("close"), "gt", trend),
                _cmp(r, "crosses_above", _const(float(p["oversold"]))),
            ),
            _group(
                _cmp(_price("close"), "lt", trend),
                _cmp(r, "crosses_below", _const(float(p["overbought"]))),
            ),
        )

    raise RuleError(f"未知策略模板 {template} / unknown strategy template {template}")


def template_to_ast(template: str, params: dict) -> dict:
    """把模板 + 参数转成规则信封。缺失参数取模板默认值。
    Convert template + params into a rule envelope; missing params take the
    template default."""
    p = template_defaults(template)
    for k in p:
        if k in params and params[k] is not None:
            p[k] = params[k]
    long_group, short_group = _long_short(template, p)
    direction = p.get("direction", "both")
    return {
        "long": None if direction == "short" else long_group,
        "short": None if direction == "long" else short_group,
    }


def preset_rules(template: str) -> dict:
    """该模板用默认参数生成的预设信封 / the template's preset envelope."""
    return template_to_ast(template, {})


PRESET_RULES: dict[str, dict] = {k: preset_rules(k) for k in TEMPLATE_KEYS}
