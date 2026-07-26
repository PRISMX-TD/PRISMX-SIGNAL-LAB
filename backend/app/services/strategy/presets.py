"""6 条新手预设：给「从预设起步」用的现成条件组合。

预设只是编辑器的起点，载入后完全可改，引擎侧不认识 template 这个概念——它只
读 rules 里的条件列表。预设不含 symbol / interval，那两项由用户在页面第一步
选，preset_payload 负责把它们拼进去。

Six beginner presets: ready-made condition sets for "start from a preset". A
preset is only a starting point in the editor and is freely editable afterwards;
the engine knows nothing about templates and only reads the condition list in
`rules`. Presets carry no symbol/interval — the user picks those in step one and
preset_payload splices them in.
"""
import copy

TEMPLATE_KEYS: tuple[str, ...] = (
    "ma_trend",
    "macd_cross",
    "rsi_reversal",
    "bollinger_breakout",
    "donchian_breakout",
    "macd_rsi_combo",
)

PRESET_LOGIC: dict[str, str] = {
    "ma_trend": "AND",
    "macd_cross": "AND",
    "rsi_reversal": "AND",
    "bollinger_breakout": "AND",
    "donchian_breakout": "AND",
    "macd_rsi_combo": "AND",
}

PRESET_CONDITIONS: dict[str, list[dict]] = {
    "ma_trend": [
        {"indicator": "ma", "usage": "ma.price_cross_above", "params": {"maType": "EMA", "period": 20}},
    ],
    "macd_cross": [
        {"indicator": "macd", "usage": "macd.cross_above_signal", "params": {"fast": 12, "slow": 26, "signal": 9}},
    ],
    "rsi_reversal": [
        {"indicator": "rsi", "usage": "rsi.cross_above_level", "params": {"period": 14, "level": 30}},
    ],
    "bollinger_breakout": [
        {"indicator": "bollinger", "usage": "bollinger.break_upper", "params": {"period": 20, "mult": 2.0}},
    ],
    "donchian_breakout": [
        {"indicator": "donchian", "usage": "donchian.new_high", "params": {"period": 20}},
    ],
    # 两个指标共振：MACD 定方向，RSI 排除已经过热的追高。
    # Two indicators in agreement: MACD sets the direction, RSI rules out
    # chasing an already-overheated move.
    "macd_rsi_combo": [
        {"indicator": "macd", "usage": "macd.above_zero", "params": {"fast": 12, "slow": 26, "signal": 9}},
        {"indicator": "rsi", "usage": "rsi.below_level", "params": {"period": 14, "level": 70}},
    ],
}


def preset_payload(template: str, symbol: str, interval: str) -> dict:
    """组装一份可直接存库的条件配置。深拷贝条件列表，调用方会就地修改它。
    Assemble a ready-to-store condition payload. The condition list is deep
    copied because callers mutate it in place."""
    return {
        "logic": PRESET_LOGIC[template],
        "interval": interval,
        "symbol": symbol,
        "conditions": copy.deepcopy(PRESET_CONDITIONS[template]),
    }
