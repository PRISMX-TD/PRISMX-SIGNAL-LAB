"""新手向策略的扁平条件列表：用法枚举表、参数校验与求值。

取代 rules.py 的 AST。用户不再搭「操作数 + 比较符 + 操作数」，而是选指标、
选一个用法（枚举）、填参数。每个用法背后是一段固定求值逻辑与一个镜像用法，
空头不存储，求值时用镜像实时取反。USAGES 是唯一事实来源：参数规格、镜像、
求值函数都在这里，前端通过 GET /strategies/usages 拉取，不再两侧手抄。

The beginner-facing flat condition list: usage table, param validation and
evaluation. Replaces rules.py's AST. Users pick an indicator, pick one usage
(an enum) and fill in params instead of assembling operand/operator/operand.
Each usage carries one fixed evaluation function and one mirror usage; the
short side isn't stored but derived from the mirror at evaluation time. USAGES
is the single source of truth — param specs, mirrors and evaluators all live
here and the frontend pulls them from GET /strategies/usages.
"""
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Literal

from app.services.strategy import indicators as ind

ALLOWED_INTERVALS = frozenset({"1", "5", "15", "60", "240", "D"})
LOGIC_OPS = frozenset({"AND", "OR"})
INDICATORS: tuple[str, ...] = ("ma", "macd", "rsi", "bollinger", "donchian", "atr")

# 条件数上限。6 个指标各选一个用法就是上限，够表达任何新手策略，同时把
# 「bars 数 x 条件数」的求值成本钉死。
# Condition cap: one usage per indicator hits the ceiling, enough for any
# beginner strategy while pinning down the bars x conditions evaluation cost.
MAX_CONDITIONS = 6


class ConditionError(ValueError):
    """条件列表不合法。message 直接作为 400 的 detail 返回给前端。
    Invalid condition list. `message` is surfaced as the 400 detail."""

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


@dataclass(frozen=True)
class ParamSpec:
    kind: Literal["int", "float", "enum"]
    default: object
    minimum: float | None = None
    maximum: float | None = None
    options: tuple[str, ...] | None = None


@dataclass(frozen=True)
class UsageSpec:
    indicator: str
    key: str
    params: dict[str, ParamSpec]
    mirror: str | None
    # 镜像时是否把 level 换成 100 - level。RSI 的阈值类用法要，使「超卖做多」
    # 的镜像是「超买做空」而不是「非超卖做多」。
    # Whether mirroring also replaces level with 100 - level. RSI's threshold
    # usages need it so that "oversold buys" mirrors to "overbought sells"
    # rather than "not-oversold sells".
    mirror_level_flip: bool = False
    evaluate: Callable[[list[dict], dict], list[bool]] = field(default=None, repr=False)  # type: ignore[assignment]


_MA_TYPE = ParamSpec(kind="enum", default="EMA", options=("SMA", "EMA"))
_MA_PERIOD = ParamSpec(kind="int", default=20, minimum=2, maximum=300)
_RSI_PERIOD = ParamSpec(kind="int", default=14, minimum=2, maximum=50)
_RSI_LEVEL = ParamSpec(kind="int", default=30, minimum=1, maximum=99)
_MACD_FAST = ParamSpec(kind="int", default=12, minimum=2, maximum=50)
_MACD_SLOW = ParamSpec(kind="int", default=26, minimum=3, maximum=100)
_MACD_SIGNAL = ParamSpec(kind="int", default=9, minimum=2, maximum=50)
_BOLL_PERIOD = ParamSpec(kind="int", default=20, minimum=5, maximum=100)
_BOLL_MULT = ParamSpec(kind="float", default=2.0, minimum=0.5, maximum=5.0)
_DONCHIAN_PERIOD = ParamSpec(kind="int", default=20, minimum=5, maximum=100)
_ATR_PERIOD = ParamSpec(kind="int", default=14, minimum=2, maximum=100)
_ATR_MULT = ParamSpec(kind="float", default=1.2, minimum=0.5, maximum=5.0)

_MA_PARAMS = {"maType": _MA_TYPE, "period": _MA_PERIOD}
_MACD_PARAMS = {"fast": _MACD_FAST, "slow": _MACD_SLOW, "signal": _MACD_SIGNAL}
_RSI_LEVEL_PARAMS = {"period": _RSI_PERIOD, "level": _RSI_LEVEL}
_RSI_SLOPE_PARAMS = {"period": _RSI_PERIOD}
_BOLL_PARAMS = {"period": _BOLL_PERIOD, "mult": _BOLL_MULT}
_DONCHIAN_PARAMS = {"period": _DONCHIAN_PERIOD}
_ATR_PARAMS = {"period": _ATR_PERIOD, "mult": _ATR_MULT}


def _spec(
    indicator: str,
    key: str,
    params: dict[str, ParamSpec],
    mirror: str | None,
    mirror_level_flip: bool = False,
) -> UsageSpec:
    return UsageSpec(
        indicator=indicator,
        key=key,
        params=params,
        mirror=mirror,
        mirror_level_flip=mirror_level_flip,
        # _EVALUATORS 定义在文件末尾，lambda 只在调用时查表，故定义顺序无碍。
        # _EVALUATORS is defined at the bottom of the file; the lambda looks it
        # up at call time, so definition order doesn't matter.
        evaluate=lambda bars, p, _k=key: _EVALUATORS[_k](bars, resolve_params(_k, p)),
    )


_USAGE_LIST: tuple[UsageSpec, ...] = (
    _spec("ma", "ma.price_cross_above", _MA_PARAMS, "ma.price_cross_below"),
    _spec("ma", "ma.price_cross_below", _MA_PARAMS, "ma.price_cross_above"),
    _spec("ma", "ma.price_above", _MA_PARAMS, "ma.price_below"),
    _spec("ma", "ma.price_below", _MA_PARAMS, "ma.price_above"),
    _spec("ma", "ma.rising", _MA_PARAMS, "ma.falling"),
    _spec("ma", "ma.falling", _MA_PARAMS, "ma.rising"),
    _spec("macd", "macd.cross_above_zero", _MACD_PARAMS, "macd.cross_below_zero"),
    _spec("macd", "macd.cross_below_zero", _MACD_PARAMS, "macd.cross_above_zero"),
    _spec("macd", "macd.above_zero", _MACD_PARAMS, "macd.below_zero"),
    _spec("macd", "macd.below_zero", _MACD_PARAMS, "macd.above_zero"),
    _spec("macd", "macd.cross_above_signal", _MACD_PARAMS, "macd.cross_below_signal"),
    _spec("macd", "macd.cross_below_signal", _MACD_PARAMS, "macd.cross_above_signal"),
    _spec("macd", "macd.rising", _MACD_PARAMS, "macd.falling"),
    _spec("macd", "macd.falling", _MACD_PARAMS, "macd.rising"),
    _spec("rsi", "rsi.below_level", _RSI_LEVEL_PARAMS, "rsi.above_level", mirror_level_flip=True),
    _spec("rsi", "rsi.above_level", _RSI_LEVEL_PARAMS, "rsi.below_level", mirror_level_flip=True),
    _spec("rsi", "rsi.cross_above_level", _RSI_LEVEL_PARAMS, "rsi.cross_below_level", mirror_level_flip=True),
    _spec("rsi", "rsi.cross_below_level", _RSI_LEVEL_PARAMS, "rsi.cross_above_level", mirror_level_flip=True),
    _spec("rsi", "rsi.rising", _RSI_SLOPE_PARAMS, "rsi.falling"),
    _spec("rsi", "rsi.falling", _RSI_SLOPE_PARAMS, "rsi.rising"),
    _spec("bollinger", "bollinger.break_upper", _BOLL_PARAMS, "bollinger.break_lower"),
    _spec("bollinger", "bollinger.break_lower", _BOLL_PARAMS, "bollinger.break_upper"),
    _spec("bollinger", "bollinger.back_above_middle", _BOLL_PARAMS, "bollinger.back_below_middle"),
    _spec("bollinger", "bollinger.back_below_middle", _BOLL_PARAMS, "bollinger.back_above_middle"),
    _spec("bollinger", "bollinger.bounce_off_lower", _BOLL_PARAMS, "bollinger.reject_off_upper"),
    _spec("bollinger", "bollinger.reject_off_upper", _BOLL_PARAMS, "bollinger.bounce_off_lower"),
    _spec("donchian", "donchian.new_high", _DONCHIAN_PARAMS, "donchian.new_low"),
    _spec("donchian", "donchian.new_low", _DONCHIAN_PARAMS, "donchian.new_high"),
    _spec("donchian", "donchian.upper_half", _DONCHIAN_PARAMS, "donchian.lower_half"),
    _spec("donchian", "donchian.lower_half", _DONCHIAN_PARAMS, "donchian.upper_half"),
    # ATR 衡量波动幅度而非方向，取反没有交易含义，故 mirror 为 None，多空共用
    # 同一判定结果。UI 上必须标注「此条件多空通用」。
    # ATR measures magnitude, not direction; mirroring it has no trading
    # meaning, so mirror is None and both sides share the same verdict. The UI
    # must label it "applies to both directions".
    _spec("atr", "atr.volatility_above_average", _ATR_PARAMS, None),
    _spec("atr", "atr.volatility_below_average", _ATR_PARAMS, None),
)

USAGES: dict[str, UsageSpec] = {u.key: u for u in _USAGE_LIST}


def usage_specs_for(indicator: str) -> list[UsageSpec]:
    return [u for u in _USAGE_LIST if u.indicator == indicator]


def resolve_params(usage: str, raw: dict) -> dict:
    """按用法的参数规格补默认值并转型，返回只含合法键的新字典。
    Fill defaults and coerce types per the usage's param spec, returning a new
    dict containing only known keys."""
    spec = USAGES[usage]
    out: dict = {}
    for name, ps in spec.params.items():
        value = raw.get(name, ps.default)
        if ps.kind == "enum":
            out[name] = str(value)
        elif ps.kind == "int":
            out[name] = int(value)
        else:
            out[name] = float(value)
    return out


def _validate_params(usage: str, raw: object) -> None:
    if not isinstance(raw, dict):
        raise ConditionError(f"{usage} 的参数必须是对象 / params for {usage} must be an object")
    spec = USAGES[usage]
    unknown = sorted(set(raw) - set(spec.params))
    if unknown:
        raise ConditionError(
            f"{usage} 不接受参数 {', '.join(unknown)} / {usage} does not accept {', '.join(unknown)}"
        )
    for name, ps in spec.params.items():
        if name not in raw:
            continue  # 缺省走默认值 / falls back to the default
        value = raw[name]
        if ps.kind == "enum":
            if value not in (ps.options or ()):
                raise ConditionError(
                    f"{usage} 的 {name} 只能是 {list(ps.options or ())} / {name} must be one of {list(ps.options or ())}"
                )
            continue
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ConditionError(f"{usage} 的 {name} 必须是数字 / {name} must be a number")
        if ps.kind == "int" and int(value) != value:
            raise ConditionError(f"{usage} 的 {name} 必须是整数 / {name} must be an integer")
        if ps.minimum is not None and value < ps.minimum:
            raise ConditionError(
                f"{usage} 的 {name} 不能小于 {ps.minimum}，当前 {value} / {name} must be >= {ps.minimum}"
            )
        if ps.maximum is not None and value > ps.maximum:
            raise ConditionError(
                f"{usage} 的 {name} 不能大于 {ps.maximum}，当前 {value} / {name} must be <= {ps.maximum}"
            )


def validate_conditions(payload: object) -> None:
    """校验一条策略的完整条件配置。不合法抛 ConditionError。
    Validate a strategy's full condition payload; raises ConditionError."""
    if not isinstance(payload, dict):
        raise ConditionError("策略条件必须是对象 / conditions payload must be an object")
    allowed = {"logic", "interval", "symbol", "conditions"}
    unknown = sorted(set(payload) - allowed)
    if unknown:
        raise ConditionError(
            f"不认识的字段 {', '.join(unknown)}，只接受 {sorted(allowed)} / unknown field(s) {', '.join(unknown)}"
        )
    if payload.get("logic") not in LOGIC_OPS:
        raise ConditionError(f"logic 只能是 {sorted(LOGIC_OPS)} / logic must be one of {sorted(LOGIC_OPS)}")
    interval = payload.get("interval")
    if interval not in ALLOWED_INTERVALS:
        raise ConditionError(
            f"不支持的周期 {interval}，可选 {sorted(ALLOWED_INTERVALS)} / unsupported interval {interval}"
        )
    symbol = payload.get("symbol")
    if not isinstance(symbol, str) or not symbol.strip():
        raise ConditionError("必须指定一个品种 / a symbol is required")
    conditions = payload.get("conditions")
    if not isinstance(conditions, list) or not conditions:
        raise ConditionError("至少要有一个条件 / at least one condition is required")
    if len(conditions) > MAX_CONDITIONS:
        raise ConditionError(
            f"最多 {MAX_CONDITIONS} 个条件，当前 {len(conditions)} 个 / at most {MAX_CONDITIONS} conditions"
        )
    for item in conditions:
        if not isinstance(item, dict):
            raise ConditionError("每个条件必须是对象 / each condition must be an object")
        extra = sorted(set(item) - {"indicator", "usage", "params"})
        if extra:
            raise ConditionError(
                f"条件不认识的字段 {', '.join(extra)} / unknown field(s) in condition: {', '.join(extra)}"
            )
        usage = item.get("usage")
        if usage not in USAGES:
            raise ConditionError(f"未知用法 {usage} / unknown usage {usage}")
        indicator = item.get("indicator")
        if indicator != USAGES[usage].indicator:
            raise ConditionError(
                f"用法 {usage} 属于指标 {USAGES[usage].indicator}，收到 {indicator} / "
                f"usage {usage} belongs to indicator {USAGES[usage].indicator}"
            )
        _validate_params(usage, item.get("params") or {})


def _closes(bars: list[dict]) -> list[float]:
    return [float(b["c"]) for b in bars]


def _as_optional(values: list[float]) -> list[float | None]:
    return list(values)


def _ma_line(bars: list[dict], params: dict) -> list[float | None]:
    period = int(params["period"])
    closes = _closes(bars)
    return ind.ema(closes, period) if params["maType"] == "EMA" else ind.sma(closes, period)


def _above(series: list[float | None], ref: list[float | None]) -> list[bool]:
    """series 严格大于 ref；任一为 None 则 False。用 cmp_with_tol 避免浮点
    残留被误判成穿越。
    series strictly above ref; None on either side yields False. cmp_with_tol
    keeps float residue from reading as a crossover."""
    out = [False] * len(series)
    for i in range(len(series)):
        a, b = series[i], ref[i]
        if a is None or b is None:
            continue
        out[i] = ind.cmp_with_tol(a, b) > 0
    return out


def _crosses(series: list[float | None], ref: list[float | None], up: bool) -> list[bool]:
    """前一根未越过、当根越过。四个值任一为 None 则 False。
    Not past on the previous bar, past on this one; any None yields False."""
    out = [False] * len(series)
    for i in range(1, len(series)):
        a0, b0, a1, b1 = series[i - 1], ref[i - 1], series[i], ref[i]
        if a0 is None or b0 is None or a1 is None or b1 is None:
            continue
        prev = ind.cmp_with_tol(a0, b0)
        now = ind.cmp_with_tol(a1, b1)
        out[i] = (prev <= 0 and now > 0) if up else (prev >= 0 and now < 0)
    return out


def _slope(series: list[float | None], up: bool) -> list[bool]:
    """与前一根比较自身走向 / compares the series with its own previous value."""
    shifted: list[float | None] = [None] + series[:-1]
    return _above(series, shifted) if up else _above(shifted, series)


def _const_series(n: int, value: float) -> list[float | None]:
    return [value] * n


def _eval_ma_cross_above(bars, params):
    return _crosses(_as_optional(_closes(bars)), _ma_line(bars, params), up=True)


def _eval_ma_cross_below(bars, params):
    return _crosses(_as_optional(_closes(bars)), _ma_line(bars, params), up=False)


def _eval_ma_price_above(bars, params):
    return _above(_as_optional(_closes(bars)), _ma_line(bars, params))


def _eval_ma_price_below(bars, params):
    return _above(_ma_line(bars, params), _as_optional(_closes(bars)))


def _eval_ma_rising(bars, params):
    return _slope(_ma_line(bars, params), up=True)


def _eval_ma_falling(bars, params):
    return _slope(_ma_line(bars, params), up=False)


def _macd_pair(bars: list[dict], params: dict):
    return ind.macd(_closes(bars), int(params["fast"]), int(params["slow"]), int(params["signal"]))


def _eval_macd_cross_above_zero(bars, params):
    line, _sig = _macd_pair(bars, params)
    return _crosses(line, _const_series(len(bars), 0.0), up=True)


def _eval_macd_cross_below_zero(bars, params):
    line, _sig = _macd_pair(bars, params)
    return _crosses(line, _const_series(len(bars), 0.0), up=False)


def _eval_macd_above_zero(bars, params):
    line, _sig = _macd_pair(bars, params)
    return _above(line, _const_series(len(bars), 0.0))


def _eval_macd_below_zero(bars, params):
    line, _sig = _macd_pair(bars, params)
    return _above(_const_series(len(bars), 0.0), line)


def _eval_macd_cross_above_signal(bars, params):
    line, sig = _macd_pair(bars, params)
    return _crosses(line, sig, up=True)


def _eval_macd_cross_below_signal(bars, params):
    line, sig = _macd_pair(bars, params)
    return _crosses(line, sig, up=False)


def _eval_macd_rising(bars, params):
    line, _sig = _macd_pair(bars, params)
    return _slope(line, up=True)


def _eval_macd_falling(bars, params):
    line, _sig = _macd_pair(bars, params)
    return _slope(line, up=False)


def _rsi_series(bars: list[dict], params: dict) -> list[float | None]:
    return ind.rsi(_closes(bars), int(params["period"]))


def _eval_rsi_below_level(bars, params):
    return _above(_const_series(len(bars), float(params["level"])), _rsi_series(bars, params))


def _eval_rsi_above_level(bars, params):
    return _above(_rsi_series(bars, params), _const_series(len(bars), float(params["level"])))


def _eval_rsi_cross_above_level(bars, params):
    return _crosses(_rsi_series(bars, params), _const_series(len(bars), float(params["level"])), up=True)


def _eval_rsi_cross_below_level(bars, params):
    return _crosses(_rsi_series(bars, params), _const_series(len(bars), float(params["level"])), up=False)


def _eval_rsi_rising(bars, params):
    return _slope(_rsi_series(bars, params), up=True)


def _eval_rsi_falling(bars, params):
    return _slope(_rsi_series(bars, params), up=False)


def _boll(bars: list[dict], params: dict):
    return ind.bollinger(_closes(bars), int(params["period"]), float(params["mult"]))


def _eval_boll_break_upper(bars, params):
    upper, _m, _l = _boll(bars, params)
    return _above(_as_optional(_closes(bars)), upper)


def _eval_boll_break_lower(bars, params):
    _u, _m, lower = _boll(bars, params)
    return _above(lower, _as_optional(_closes(bars)))


def _eval_boll_back_above_middle(bars, params):
    _u, middle, _l = _boll(bars, params)
    return _crosses(_as_optional(_closes(bars)), middle, up=True)


def _eval_boll_back_below_middle(bars, params):
    _u, middle, _l = _boll(bars, params)
    return _crosses(_as_optional(_closes(bars)), middle, up=False)


def _eval_boll_bounce_off_lower(bars, params):
    _u, _m, lower = _boll(bars, params)
    return _crosses(_as_optional(_closes(bars)), lower, up=True)


def _eval_boll_reject_off_upper(bars, params):
    upper, _m, _l = _boll(bars, params)
    return _crosses(_as_optional(_closes(bars)), upper, up=False)


def _donchian(bars: list[dict], params: dict):
    period = int(params["period"])
    return (
        ind.donchian_high([float(b["h"]) for b in bars], period),
        ind.donchian_low([float(b["l"]) for b in bars], period),
    )


def _eval_donchian_new_high(bars, params):
    high, _low = _donchian(bars, params)
    return _above(_as_optional(_closes(bars)), high)


def _eval_donchian_new_low(bars, params):
    _high, low = _donchian(bars, params)
    return _above(low, _as_optional(_closes(bars)))


def _donchian_mid(bars: list[dict], params: dict) -> list[float | None]:
    high, low = _donchian(bars, params)
    return [
        None if high[i] is None or low[i] is None else (high[i] + low[i]) / 2
        for i in range(len(bars))
    ]


def _eval_donchian_upper_half(bars, params):
    return _above(_as_optional(_closes(bars)), _donchian_mid(bars, params))


def _eval_donchian_lower_half(bars, params):
    return _above(_donchian_mid(bars, params), _as_optional(_closes(bars)))


def _atr_vs_average(bars: list[dict], params: dict):
    """当前 ATR 与「ATR 自身近期均值」的比较基准。均值窗口取 period 的 3 倍，
    使「近期」明显长于 ATR 本身的平滑窗口，否则两者几乎同步、判定永远贴着门槛。
    Current ATR against the mean of ATR itself. The mean window is 3x period so
    that "recent" is clearly longer than ATR's own smoothing window; otherwise
    the two move together and the verdict sits on the threshold forever."""
    period = int(params["period"])
    series = ind.atr(
        [float(b["h"]) for b in bars], [float(b["l"]) for b in bars], _closes(bars), period
    )
    window = period * 3
    baseline: list[float | None] = [None] * len(bars)
    seen: list[float] = []
    for i, v in enumerate(series):
        if v is None:
            continue
        seen.append(v)
        if len(seen) < window:
            continue
        baseline[i] = sum(seen[-window:]) / window * float(params["mult"])
    return series, baseline


def _eval_atr_above_average(bars, params):
    series, baseline = _atr_vs_average(bars, params)
    return _above(series, baseline)


def _eval_atr_below_average(bars, params):
    series, baseline = _atr_vs_average(bars, params)
    return _above(baseline, series)


_EVALUATORS: dict[str, Callable[[list[dict], dict], list[bool]]] = {
    "ma.price_cross_above": _eval_ma_cross_above,
    "ma.price_cross_below": _eval_ma_cross_below,
    "ma.price_above": _eval_ma_price_above,
    "ma.price_below": _eval_ma_price_below,
    "ma.rising": _eval_ma_rising,
    "ma.falling": _eval_ma_falling,
    "macd.cross_above_zero": _eval_macd_cross_above_zero,
    "macd.cross_below_zero": _eval_macd_cross_below_zero,
    "macd.above_zero": _eval_macd_above_zero,
    "macd.below_zero": _eval_macd_below_zero,
    "macd.cross_above_signal": _eval_macd_cross_above_signal,
    "macd.cross_below_signal": _eval_macd_cross_below_signal,
    "macd.rising": _eval_macd_rising,
    "macd.falling": _eval_macd_falling,
    "rsi.below_level": _eval_rsi_below_level,
    "rsi.above_level": _eval_rsi_above_level,
    "rsi.cross_above_level": _eval_rsi_cross_above_level,
    "rsi.cross_below_level": _eval_rsi_cross_below_level,
    "rsi.rising": _eval_rsi_rising,
    "rsi.falling": _eval_rsi_falling,
    "bollinger.break_upper": _eval_boll_break_upper,
    "bollinger.break_lower": _eval_boll_break_lower,
    "bollinger.back_above_middle": _eval_boll_back_above_middle,
    "bollinger.back_below_middle": _eval_boll_back_below_middle,
    "bollinger.bounce_off_lower": _eval_boll_bounce_off_lower,
    "bollinger.reject_off_upper": _eval_boll_reject_off_upper,
    "donchian.new_high": _eval_donchian_new_high,
    "donchian.new_low": _eval_donchian_new_low,
    "donchian.upper_half": _eval_donchian_upper_half,
    "donchian.lower_half": _eval_donchian_lower_half,
    "atr.volatility_above_average": _eval_atr_above_average,
    "atr.volatility_below_average": _eval_atr_below_average,
}


def evaluate_usage(bars: list[dict], usage: str, params: dict, memo: dict | None = None) -> list[bool]:
    """逐 bar 求值单个用法，返回与 bars 等长的布尔序列。

    memo 在同一批 bars 上跨策略复用结果：实时链路一根 bar 收盘要评估几十条策略，
    「RSI(14) 低于 30」这种常见条件会被反复算。键里不含 bars，所以同一个 memo
    只能配同一批 bars 用。

    Evaluate one usage bar by bar into a bool series as long as bars. `memo`
    shares results across strategies over the same bars: one closed bar can mean
    evaluating dozens of strategies, and a common condition like "RSI(14) below
    30" would otherwise be recomputed each time. The key excludes bars, so a
    given memo is only valid for one batch of bars.
    """
    if not bars:
        return []
    resolved = resolve_params(usage, params)
    if memo is None:
        return _EVALUATORS[usage](bars, resolved)
    key = (usage, tuple(sorted(resolved.items())))
    if key not in memo:
        memo[key] = _EVALUATORS[usage](bars, resolved)
    return memo[key]


def mirror_condition(condition: dict) -> dict | None:
    """把一个条件换成交易语义相反的那个。无镜像（ATR）返回 None。

    RSI 阈值类同时把 level 换成 100 - level：「RSI 低于 30 做多」的反面是
    「RSI 高于 70 做空」，而不是「RSI 高于 30 做空」——后者在 30~70 之间也会
    触发，等于把中性区当成看跌信号。

    Turn a condition into its trading-wise opposite; None when there's no
    mirror (ATR). RSI threshold usages also map level to 100 - level: the
    opposite of "buy when RSI is below 30" is "sell when RSI is above 70", not
    "sell when RSI is above 30" — the latter fires anywhere in 30..70, treating
    the neutral zone as bearish.
    """
    usage = condition["usage"]
    spec = USAGES[usage]
    if spec.mirror is None:
        return None
    params = resolve_params(usage, condition.get("params") or {})
    if spec.mirror_level_flip:
        params["level"] = 100 - int(params["level"])
    return {"indicator": spec.indicator, "usage": spec.mirror, "params": params}


def mirror_conditions(payload: dict) -> list[dict]:
    """整条策略的空头条件。无镜像的条件原样保留——波动率条件多空共用同一判定，
    丢掉它会让空头侧比多头侧少一道门槛。
    A whole strategy's short-side conditions. Mirror-less conditions are kept
    as-is: a volatility filter applies to both directions, and dropping it
    would leave the short side with one fewer gate than the long side."""
    out: list[dict] = []
    for c in payload.get("conditions") or []:
        out.append(mirror_condition(c) or resolve_condition(c))
    return out


def resolve_condition(condition: dict) -> dict:
    usage = condition["usage"]
    return {
        "indicator": USAGES[usage].indicator,
        "usage": usage,
        "params": resolve_params(usage, condition.get("params") or {}),
    }


def evaluate_side(
    bars: list[dict], conditions: list[dict], logic: str, memo: dict | None = None
) -> list[bool]:
    """把一侧的多个条件按 AND/OR 合并成逐 bar 的布尔序列。

    空列表返回全 False 而不是全 True：一侧没有条件意味着「无从判断」，
    AND 的数学恒等元会让这一侧每根 bar 都开仓。

    Combine one side's conditions into a per-bar bool series under AND/OR. An
    empty list yields all-False rather than all-True: no conditions means "no
    basis to act", and AND's identity element would open a position on every
    single bar.
    """
    if not bars:
        return []
    if not conditions:
        return [False] * len(bars)
    series = [evaluate_usage(bars, c["usage"], c.get("params") or {}, memo) for c in conditions]
    if logic == "OR":
        return [any(s[i] for s in series) for i in range(len(bars))]
    return [all(s[i] for s in series) for i in range(len(bars))]


def evaluate_conditions(bars: list[dict], payload: dict, memo: dict | None = None) -> list[str | None]:
    """整条策略逐 bar 求值，返回 "BUY" / "SELL" / None。

    两侧同时成立时取多头：ATR 这类无镜像条件会让两侧判定完全一致，此时必须有
    个确定的偏向，否则同一根 bar 的结果取决于字典遍历顺序。

    Evaluate a whole strategy bar by bar into "BUY" / "SELL" / None. When both
    sides hold, long wins: mirror-less conditions like ATR make both sides
    identical, and without a fixed preference the verdict for a bar would hinge
    on iteration order.
    """
    if not bars:
        return []
    logic = payload.get("logic") or "AND"
    longs = evaluate_side(bars, payload.get("conditions") or [], logic, memo)
    shorts = evaluate_side(bars, mirror_conditions(payload), logic, memo)
    out: list[str | None] = []
    for i in range(len(bars)):
        if longs[i]:
            out.append("BUY")
        elif shorts[i]:
            out.append("SELL")
        else:
            out.append(None)
    return out
