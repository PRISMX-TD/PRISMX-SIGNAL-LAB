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


def _todo_eval(bars: list[dict], params: dict) -> list[bool]:
    raise NotImplementedError


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
        evaluate=_todo_eval,
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
