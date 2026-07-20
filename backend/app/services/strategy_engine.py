"""用户自定义策略引擎：模板 + 调参，而不是自由拼装指标——目前只开放三个
模板（均线交叉/RSI 超买超卖反转/布林带回归），全部是"信号触发用条件"而非
自动交易,纯粹算出"该给这个用户发一条个人信号了"这件事,不碰下单链路。

指标数学是 `frontend/src/utils/indicators.ts` 的 Python 移植（保持同样的
预热期/None 语义,前端图表与后端评估口径一致）。

User-customizable strategy engine: template + tuned parameters, not free-form
indicator assembly — only three templates for now (MA cross / RSI reversal /
Bollinger reversion). Each is purely an entry-condition detector that decides
"fire a personal signal for this user now" — never places an order itself.

The indicator math is a Python port of `frontend/src/utils/indicators.ts`
(same warm-up/None semantics, so the frontend chart and this engine agree).
"""
import json
import logging
import statistics
from datetime import datetime, timezone

from app.core.database import SessionLocal
from app.models import Candle, StrategySignal, UserStrategy
from app.services.connection_manager import manager
from app.services.push_dispatch import EVENT_STRATEGY_SIGNAL, dispatch_event_push_async

logger = logging.getLogger("prismx.strategy_engine")

# 模板参数默认值与合法范围；未出现在这里的模板一律拒绝。
# Template parameter defaults and valid ranges; templates not listed here are rejected.
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

# 回测/实时评估共用的历史窗口深度：要盖住最大周期(慢线 300)的预热期。
# Shared lookback depth for backtest/live evaluation; must cover the largest
# warm-up period (slow MA up to 300).
LIVE_LOOKBACK_BARS = 400


def validate_and_clamp_params(template: str, raw: dict) -> dict:
    """校验模板参数：未知模板/字段类型不对直接拒绝，数值越界夹到边界内
    （不是拒绝——用户拖滑块拖到头是正常操作，不该报错）。

    Validate template params: unknown templates/wrong field types are
    rejected outright; out-of-range numbers are clamped, not rejected —
    a user dragging a slider to its end is normal, not an error.
    """
    schema = TEMPLATE_SCHEMAS.get(template)
    if schema is None:
        raise ValueError(f"未知策略模板 / unknown strategy template: {template}")
    out: dict = {}
    for key, spec in schema.items():
        val = raw.get(key, spec["default"])
        if spec["type"] == "enum":
            out[key] = val if val in spec["options"] else spec["default"]
        elif spec["type"] == "int":
            try:
                out[key] = max(spec["min"], min(spec["max"], int(val)))
            except (TypeError, ValueError):
                out[key] = spec["default"]
        elif spec["type"] == "float":
            try:
                out[key] = max(spec["min"], min(spec["max"], float(val)))
            except (TypeError, ValueError):
                out[key] = spec["default"]
    if template in ("ma_cross", "macd_cross") and out["slowPeriod"] <= out["fastPeriod"]:
        out["slowPeriod"] = out["fastPeriod"] + 1
    return out


# ---------- 指标数学：indicators.ts 的 Python 移植 ----------
# ---------- Indicator math: Python port of indicators.ts ----------
def _sma(values: list[float], period: int) -> list[float | None]:
    out: list[float | None] = [None] * len(values)
    total = 0.0
    for i, v in enumerate(values):
        total += v
        if i >= period:
            total -= values[i - period]
        if i >= period - 1:
            out[i] = total / period
    return out


def _ema(values: list[float], period: int) -> list[float | None]:
    out: list[float | None] = [None] * len(values)
    if len(values) < period:
        return out
    seed = sum(values[:period]) / period
    out[period - 1] = seed
    k = 2 / (period + 1)
    prev = seed
    for i in range(period, len(values)):
        prev = values[i] * k + prev * (1 - k)
        out[i] = prev
    return out


def _rsi(values: list[float], period: int) -> list[float | None]:
    out: list[float | None] = [None] * len(values)
    if len(values) <= period:
        return out
    gain_sum = loss_sum = 0.0
    for i in range(1, period + 1):
        diff = values[i] - values[i - 1]
        if diff >= 0:
            gain_sum += diff
        else:
            loss_sum -= diff
    avg_gain, avg_loss = gain_sum / period, loss_sum / period
    out[period] = 100.0 if avg_loss == 0 else 100 - 100 / (1 + avg_gain / avg_loss)
    for i in range(period + 1, len(values)):
        diff = values[i] - values[i - 1]
        gain = diff if diff > 0 else 0.0
        loss = -diff if diff < 0 else 0.0
        avg_gain = (avg_gain * (period - 1) + gain) / period
        avg_loss = (avg_loss * (period - 1) + loss) / period
        out[i] = 100.0 if avg_loss == 0 else 100 - 100 / (1 + avg_gain / avg_loss)
    return out


def _bollinger(values: list[float], period: int, mult: float) -> tuple[list[float | None], list[float | None]]:
    mid = _sma(values, period)
    upper: list[float | None] = [None] * len(values)
    lower: list[float | None] = [None] * len(values)
    for i in range(period - 1, len(values)):
        m = mid[i]
        if m is None:
            continue
        window = values[i - period + 1 : i + 1]
        sd = statistics.pstdev(window)
        upper[i] = m + mult * sd
        lower[i] = m - mult * sd
    return upper, lower


def _macd(values: list[float], fast: int, slow: int, signal_period: int) -> tuple[list[float | None], list[float | None]]:
    """MACD：DIF=快慢 EMA 之差，DEA(signal)=DIF 的 EMA——移植自 indicators.ts 的
    macd()，同样先抽出 DIF 里第一个非空值开始的连续段再算 EMA，再按原位置拼回去
    （慢线预热期会让 DIF 数组开头有一段 None）。
    MACD: DIF = fast EMA - slow EMA, signal (DEA) = EMA of DIF — ported from
    indicators.ts's macd(), pulling out the dense run starting at DIF's first
    non-null value before running EMA over it (the slow EMA's warm-up leaves a
    None head), then splicing the result back into position."""
    fast_ema = _ema(values, fast)
    slow_ema = _ema(values, slow)
    macd_line: list[float | None] = [
        None if fast_ema[i] is None or slow_ema[i] is None else fast_ema[i] - slow_ema[i]
        for i in range(len(values))
    ]
    first_valid = next((i for i, v in enumerate(macd_line) if v is not None), -1)
    signal: list[float | None] = [None] * len(values)
    if first_valid >= 0:
        dense = macd_line[first_valid:]
        dense_signal = _ema(dense, signal_period)
        for i, v in enumerate(dense_signal):
            signal[first_valid + i] = v
    return macd_line, signal


def _rolling_max_excl(values: list[float], period: int, i: int) -> float | None:
    """第 i 根 bar 之前(不含)最近 period 根的最大值,历史不够时返回 None。
    Max of the `period` bars strictly before index i; None if there isn't
    enough history yet."""
    if i < period:
        return None
    return max(values[i - period:i])


def _rolling_min_excl(values: list[float], period: int, i: int) -> float | None:
    if i < period:
        return None
    return min(values[i - period:i])


def _apply_direction(side: str | None, direction: str) -> str | None:
    if side is None:
        return None
    if direction == "long" and side == "SELL":
        return None
    if direction == "short" and side == "BUY":
        return None
    return side


def _cmp(a: float, b: float, rel_tol: float = 1e-9) -> int:
    """带容差比较两个浮点数,返回 -1/0/1。

    两条完全由同一批重复价格递推出来的 EMA,理论上应该分毫不差——但
    `prev = value*k + prev*(1-k)` 这种递归乘加运算,只要平滑系数 k=2/(period+1)
    在二进制浮点下不能精确表示(取决于具体的 period,不可预测哪些值会中招,
    实测 period=30 就会、12/26/9/14/50 不会),就会残留 1e-13~1e-14 级别的
    误差(比如 100.0 变成 100.00000000000001)。这点误差如果直接拿去和另一
    条均线做严格的 `<`/`>` 比较,会被误判成"刚刚穿越",凭空报出一个不存在
    的交叉。容差取两数量级的 1e-9 倍(至少 1e-9),比这类浮点残留大出几个
    数量级,又远小于任何真实报价的最小变动单位,不会掩盖真实的交叉。

    Tolerance-based float compare, returns -1/0/1.

    Two EMAs built off literally the same repeated prices should be
    identical in theory — but the recursive multiply-add `prev = value*k +
    prev*(1-k)` leaves ~1e-13-to-1e-14-level residue (e.g. 100.0 becomes
    100.00000000000001) whenever the smoothing constant k=2/(period+1) isn't
    exactly representable in binary floating point — which specific periods
    trigger this is unpredictable (period=30 does, 12/26/9/14/50 don't, in
    this codebase's own tests). Feeding that residue straight into a strict
    `<`/`>` comparison against another series misreads it as "just crossed",
    firing a signal out of thin air. The tolerance is 1e-9 relative (1e-9
    floor) — orders of magnitude above that residue, and orders of magnitude
    below any real quote's tick size, so it never masks an actual crossover.
    """
    tol = max(abs(a), abs(b)) * rel_tol + rel_tol
    if a > b + tol:
        return 1
    if a < b - tol:
        return -1
    return 0


def entry_signals(bars: list[dict], template: str, params: dict) -> list[str | None]:
    """对整段 K 线算出每根 bar 的入场信号("BUY"/"SELL"/None),长度与 bars 一致。
    Computes the per-bar entry signal ("BUY"/"SELL"/None) over the whole
    series, same length as `bars`."""
    closes = [b["c"] for b in bars]
    highs = [b["h"] for b in bars]
    lows = [b["l"] for b in bars]
    n = len(closes)
    out: list[str | None] = [None] * n
    direction = params.get("direction", "both")

    if template == "ma_cross":
        fn = _ema if params["maType"] == "EMA" else _sma
        fast = fn(closes, params["fastPeriod"])
        slow = fn(closes, params["slowPeriod"])
        for i in range(1, n):
            if None in (fast[i], slow[i], fast[i - 1], slow[i - 1]):
                continue
            if _cmp(fast[i - 1], slow[i - 1]) <= 0 and _cmp(fast[i], slow[i]) > 0:
                out[i] = _apply_direction("BUY", direction)
            elif _cmp(fast[i - 1], slow[i - 1]) >= 0 and _cmp(fast[i], slow[i]) < 0:
                out[i] = _apply_direction("SELL", direction)

    elif template == "rsi_reversal":
        r = _rsi(closes, params["period"])
        oversold, overbought = params["oversold"], params["overbought"]
        for i in range(1, n):
            if r[i] is None or r[i - 1] is None:
                continue
            if r[i - 1] <= oversold < r[i]:
                out[i] = _apply_direction("BUY", direction)
            elif r[i - 1] >= overbought > r[i]:
                out[i] = _apply_direction("SELL", direction)

    elif template == "bollinger_reversion":
        upper, lower = _bollinger(closes, params["period"], params["mult"])
        for i in range(1, n):
            if lower[i] is not None and lower[i - 1] is not None:
                if closes[i - 1] <= lower[i - 1] and closes[i] > lower[i]:
                    out[i] = _apply_direction("BUY", direction)
            if upper[i] is not None and upper[i - 1] is not None:
                if closes[i - 1] >= upper[i - 1] and closes[i] < upper[i]:
                    out[i] = _apply_direction("SELL", direction)

    elif template == "macd_cross":
        dif, dea = _macd(closes, params["fastPeriod"], params["slowPeriod"], params["signalPeriod"])
        for i in range(1, n):
            if None in (dif[i], dea[i], dif[i - 1], dea[i - 1]):
                continue
            if _cmp(dif[i - 1], dea[i - 1]) <= 0 and _cmp(dif[i], dea[i]) > 0:
                out[i] = _apply_direction("BUY", direction)
            elif _cmp(dif[i - 1], dea[i - 1]) >= 0 and _cmp(dif[i], dea[i]) < 0:
                out[i] = _apply_direction("SELL", direction)

    elif template == "ma_pullback":
        fn = _ema if params["maType"] == "EMA" else _sma
        ma = fn(closes, params["period"])
        tol = params["touchTolerancePct"] / 100.0
        for i in range(1, n):
            if ma[i] is None or ma[i - 1] is None:
                continue
            # 上升趋势中回踩均线后收回：前一根收在均线上方，本根探到均线附近
            # 但收盘仍站上均线。/ Uptrend pullback: prior close above the MA,
            # this bar dips toward it but still closes back above.
            if _cmp(closes[i - 1], ma[i - 1]) > 0 and lows[i] <= ma[i] * (1 + tol) and _cmp(closes[i], ma[i]) > 0:
                out[i] = _apply_direction("BUY", direction)
            elif _cmp(closes[i - 1], ma[i - 1]) < 0 and highs[i] >= ma[i] * (1 - tol) and _cmp(closes[i], ma[i]) < 0:
                out[i] = _apply_direction("SELL", direction)

    elif template == "bollinger_breakout":
        upper, lower = _bollinger(closes, params["period"], params["mult"])
        for i in range(1, n):
            if upper[i] is not None and upper[i - 1] is not None:
                if closes[i - 1] <= upper[i - 1] and closes[i] > upper[i]:
                    out[i] = _apply_direction("BUY", direction)
            if lower[i] is not None and lower[i - 1] is not None:
                if closes[i - 1] >= lower[i - 1] and closes[i] < lower[i]:
                    out[i] = _apply_direction("SELL", direction)

    elif template == "rsi_momentum":
        r = _rsi(closes, params["period"])
        for i in range(1, n):
            if r[i] is None or r[i - 1] is None:
                continue
            if r[i - 1] <= 50 < r[i]:
                out[i] = _apply_direction("BUY", direction)
            elif r[i - 1] >= 50 > r[i]:
                out[i] = _apply_direction("SELL", direction)

    elif template == "donchian_breakout":
        period = params["period"]
        for i in range(1, n):
            hi_prev, hi_now = _rolling_max_excl(highs, period, i - 1), _rolling_max_excl(highs, period, i)
            lo_prev, lo_now = _rolling_min_excl(lows, period, i - 1), _rolling_min_excl(lows, period, i)
            # 只在"刚突破"那一根触发一次，避免价格站稳在通道外时每根都重复报信号。
            # Fire only on the bar that newly breaks out, so a price that
            # stays outside the channel doesn't re-signal every bar.
            if hi_now is not None and hi_prev is not None and closes[i - 1] <= hi_prev and closes[i] > hi_now:
                out[i] = _apply_direction("BUY", direction)
            elif lo_now is not None and lo_prev is not None and closes[i - 1] >= lo_prev and closes[i] < lo_now:
                out[i] = _apply_direction("SELL", direction)

    elif template == "momentum_breakout":
        lookback, threshold = params["lookback"], params["thresholdPct"] / 100.0
        for i in range(lookback + 1, n):
            prev_score = closes[i - 1] / closes[i - 1 - lookback] - 1
            score = closes[i] / closes[i - lookback] - 1
            if prev_score <= threshold < score:
                out[i] = _apply_direction("BUY", direction)
            elif prev_score >= -threshold > score:
                out[i] = _apply_direction("SELL", direction)

    elif template == "trend_rsi_filter":
        trend_ma = _ema(closes, params["trendPeriod"])
        r = _rsi(closes, params["rsiPeriod"])
        oversold, overbought = params["oversold"], params["overbought"]
        for i in range(1, n):
            if trend_ma[i] is None or r[i] is None or r[i - 1] is None:
                continue
            # 上升趋势里只接受"回调到超卖区再反弹"的买入；下降趋势对称地只接受
            # "反弹到超买区再回落"的卖出——趋势方向本身就是过滤器。
            # In an uptrend, only accept a "pulled back into oversold, now
            # bouncing" buy; symmetric for a downtrend's sell — the trend
            # direction itself is the filter.
            if _cmp(closes[i], trend_ma[i]) > 0 and r[i - 1] <= oversold < r[i]:
                out[i] = _apply_direction("BUY", direction)
            elif _cmp(closes[i], trend_ma[i]) < 0 and r[i - 1] >= overbought > r[i]:
                out[i] = _apply_direction("SELL", direction)

    else:
        raise ValueError(f"未知策略模板 / unknown strategy template: {template}")

    return out


def clamp_stop_loss(method: str, value: float) -> float:
    """按 method 夹到合理区间——百分比距离与固定价格距离量纲不同，各自的边界
    不能共用一套。/ Clamp to a sane range per method — percent-distance and
    fixed-price-distance are different units, so they need separate bounds."""
    if method == "percent":
        return max(0.1, min(10.0, value))
    return max(0.00001, min(1_000_000.0, value))


def clamp_take_profit(method: str, value: float) -> float:
    if method == "rr":
        return max(0.5, min(10.0, value))
    if method == "percent":
        return max(0.1, min(50.0, value))
    return max(0.00001, min(1_000_000.0, value))


def _round_price(value: float) -> float:
    """按价格量级四舍五入到合理小数位，清掉百分比/方式换算里残留的浮点误差
    （如 63619.50399999999）。按量级而非逐品种维护白名单——自定义策略可以
    跑在任意 EA 在报的品种上，不能只覆盖写死的那几个。

    Round to a sane decimal precision based on price magnitude, clearing
    floating-point residue left over from the percent/method math (e.g.
    63619.50399999999). Magnitude-based rather than a per-symbol whitelist —
    custom strategies can run on any symbol the EA is feeding, not just a
    hardcoded few.
    """
    if value >= 100:
        return round(value, 2)
    if value >= 1:
        return round(value, 4)
    return round(value, 6)


def _entry_exit_prices(
    side: str, entry: float,
    stop_loss_method: str, stop_loss_value: float,
    take_profit_method: str, take_profit_value: float,
) -> tuple[float, float]:
    """按各自的方式独立算出止损/止盈距离，而不是只有"百分比距离 + R 倍数"
    一种固定组合——用户可以自由搭配（如止损用百分比、止盈用固定价格距离）。

    Independently computes the SL/TP distance per its own method rather than
    one fixed "% distance + R multiple" combo — users can mix and match
    (e.g. percent SL with a fixed price-distance TP).
    """
    sl_dist = entry * (stop_loss_value / 100.0) if stop_loss_method == "percent" else stop_loss_value
    if take_profit_method == "rr":
        tp_dist = sl_dist * take_profit_value
    elif take_profit_method == "percent":
        tp_dist = entry * (take_profit_value / 100.0)
    else:
        tp_dist = take_profit_value
    if side == "BUY":
        sl, tp = entry - sl_dist, entry + tp_dist
    else:
        sl, tp = entry + sl_dist, entry - tp_dist
    return _round_price(sl), _round_price(tp)


def _resolve_trade(bars: list[dict], entry_i: int, side: str, sl: float, tp: float) -> tuple[str | None, int | None]:
    """从入场的下一根开始找先摸到止损还是止盈；同一根摸到两者按止损处理——
    保守假设，与既有模拟器"规则公开、不偏袒"的口径一致。数据走到底还没
    结果则返回 (None, None)。

    Search forward from the bar after entry for the first SL/TP touch; a bar
    touching both counts as a stop-loss (conservative, matching the existing
    simulator's "rules are public, never favor the outcome" stance). Returns
    (None, None) if the data runs out before it resolves.
    """
    for j in range(entry_i + 1, len(bars)):
        hi, lo = bars[j]["h"], bars[j]["l"]
        hit_sl = (lo <= sl) if side == "BUY" else (hi >= sl)
        hit_tp = (hi >= tp) if side == "BUY" else (lo <= tp)
        if hit_sl:
            return "HIT_SL", j
        if hit_tp:
            return "HIT_TP", j
    return None, None


def run_backtest(
    bars: list[dict], template: str, params: dict,
    stop_loss_method: str, stop_loss_value: float,
    take_profit_method: str, take_profit_value: float,
    risk_pct: float, capital: float, mode: str, symbol: str,
    one_trade_at_a_time: bool = True,
) -> dict:
    """吃已入库的 K 线历史,回放这个模板+参数组合过去的表现。

    返回结构与既有「如果你跟了」信号回测（`GET /api/signals/simulate`）完全
    一致（summary/points/trades),前端可以复用同一套净值曲线/汇总卡片组件。

    one_trade_at_a_time=True（默认）：一次只算一笔仓位，某笔信号入场后要等
    它摸到止损/止盈平仓，期间新出现的信号被跳过，不开新的模拟单——与
    evaluate_new_candle() 的"一次一单"实盘门槛用同一套语义。False 时任何
    满足入场条件的 bar 都独立开一笔，彼此互不影响，最后按出场时间重新
    排序结算，保证净值曲线的时间线正确（不同笔交易的出场先后顺序不一定
    等于入场先后顺序）。

    某笔仓位到数据末尾都没摸到止损/止盈时（"还开着"），不计入 trades/summary——
    但会把它记在返回值的 `openPosition` 里，而不是悄无声息地丢掉。这点很重要：
    K 线历史本身就是有限的窗口（尤其是刚上线不久、1 分钟/5 分钟这类周期历史很
    短的品种），只要最早的一笔一直没等到结果，之前的实现会直接放弃继续往后扫，
    连同它之后所有本该正常出结果的信号一起消失，界面上只看到一个没有任何解释
    的"0 笔交易"。

    Replays this template+param combo's historical performance against stored
    candle history. Returns the exact same shape as the existing "what if you
    followed" signal replay (summary/points/trades) so the frontend can reuse
    the same equity-curve/summary-tile components.

    one_trade_at_a_time=True (default): only one position at a time — after a
    signal enters, wait for it to hit SL/TP before considering new signals;
    matches evaluate_new_candle()'s live "one trade at a time" gate. False:
    every bar meeting the entry condition opens its own independent trade;
    trades are re-sorted by exit time before settlement so the equity curve's
    timeline stays correct (exit order isn't necessarily entry order).

    A position that never hits SL/TP by the end of the data ("still open")
    isn't counted in trades/summary — but is reported back via `openPosition`
    instead of silently vanishing. This matters because the candle history is
    a bounded window (especially for symbols/intervals with a short history,
    like 1m/5m soon after launch): if the very first signal never resolves,
    the previous implementation gave up scanning entirely, taking every later
    — otherwise perfectly resolvable — signal down with it, leaving the UI
    with an unexplained "0 trades".
    """
    signals = entry_signals(bars, template, params)
    n = len(bars)

    # 第一步：只找出每笔交易的入场/出场，不牵扯净值结算。
    # Step 1: find each trade's entry/exit only, no equity bookkeeping yet.
    raw: list[dict] = []
    # 未摸到止损/止盈就到了数据末尾的那一笔（如果有）——只记最后遇到的一笔，
    # 供前端解释"为什么统计里没有它"，而不是让调用方猜。
    # The one position (if any) that never hit SL/TP before the data ran out —
    # only the last one encountered is kept, so the frontend can explain why
    # it's missing from the stats instead of the caller having to guess.
    open_position: dict | None = None
    if one_trade_at_a_time:
        i = 0
        while i < n:
            side = signals[i]
            if side is None:
                i += 1
                continue
            entry_price = bars[i]["c"]
            sl, tp = _entry_exit_prices(side, entry_price, stop_loss_method, stop_loss_value, take_profit_method, take_profit_value)
            exit_result, exit_j = _resolve_trade(bars, i, side, sl, tp)
            if exit_result is None:
                # 到数据末尾还没走出结果,这笔不计入统计(既不是赢也不是输),
                # 但明确记下来——一次一单下没法再继续扫后面的信号(仓位仍
                # "开着"),不代表策略之后就再也不触发了。
                # Ran out of data before resolving; not counted as a win or
                # loss, but recorded explicitly — one-trade-at-a-time can't
                # keep scanning past it (the position is still "open"), that
                # doesn't mean the strategy never fires again after this.
                open_position = {"side": side, "entryPrice": entry_price, "stopLoss": sl, "takeProfit": tp, "entryTime": bars[i]["t"]}
                break
            raw.append({"i": i, "side": side, "entry_price": entry_price, "sl": sl, "tp": tp, "exit_result": exit_result, "exit_j": exit_j})
            i = exit_j + 1
    else:
        for i in range(n):
            side = signals[i]
            if side is None:
                continue
            entry_price = bars[i]["c"]
            sl, tp = _entry_exit_prices(side, entry_price, stop_loss_method, stop_loss_value, take_profit_method, take_profit_value)
            exit_result, exit_j = _resolve_trade(bars, i, side, sl, tp)
            if exit_result is None:
                open_position = {"side": side, "entryPrice": entry_price, "stopLoss": sl, "takeProfit": tp, "entryTime": bars[i]["t"]}
                continue
            raw.append({"i": i, "side": side, "entry_price": entry_price, "sl": sl, "tp": tp, "exit_result": exit_result, "exit_j": exit_j})
        raw.sort(key=lambda t: t["exit_j"])

    # 第二步：按出场先后顺序结算净值/胜负/回撤，与一次一单时的原逻辑完全
    # 一样，只是数据来源换成了上面统一构造好的 raw 列表。
    # Step 2: settle equity/win-loss/drawdown in exit order — identical to
    # the original one-trade-at-a-time logic, just fed from the raw list
    # built above.
    risk_frac = risk_pct / 100.0
    equity = 1.0
    peak = 1.0
    max_dd = 0.0
    wins = losses = 0
    loss_streak = max_loss_streak = 0
    rr_sum = 0.0
    busted = False
    points: list[dict] = []
    trades: list[dict] = []

    for t in raw:
        if busted:
            break
        i, side, entry_price, sl, tp = t["i"], t["side"], t["entry_price"], t["sl"], t["tp"]
        exit_result, exit_j = t["exit_result"], t["exit_j"]

        rr = abs(tp - entry_price) / abs(entry_price - sl)
        rr_sum += rr
        if exit_result == "HIT_TP":
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
            equity += pnl_pct
        if equity <= 0:
            equity = 0.0
            busted = True

        peak = max(peak, equity)
        if peak > 0:
            max_dd = max(max_dd, (peak - equity) / peak)

        bar_time = datetime.fromtimestamp(bars[exit_j]["t"], tz=timezone.utc).isoformat()
        points.append({"t": bar_time, "equity": equity})
        trades.append({
            "id": str(i),
            "symbol": symbol,
            "side": side,
            "createdAt": datetime.fromtimestamp(bars[i]["t"], tz=timezone.utc).isoformat(),
            "resolvedAt": bar_time,
            # entry/exitTime：入场/出场那根 K 线的 epoch 秒，供前端在图表上精确
            # 定位标记，不用把 ISO 字符串再解析回时间戳。
            # entry/exitTime: epoch seconds of the entry/exit bar, so the
            # frontend can place chart markers precisely without re-parsing
            # the ISO strings back into timestamps.
            "entryTime": bars[i]["t"],
            "exitTime": bars[exit_j]["t"],
            "entryPrice": entry_price,
            "exitPrice": sl if exit_result == "HIT_SL" else tp,
            "result": exit_result,
            "rr": rr,
            "pnlPct": pnl_pct * 100,
            "equityAfter": equity,
        })

    resolved = wins + losses
    summary = {
        "finalEquity": equity * capital,
        "returnPct": (equity - 1.0) * 100,
        "maxDrawdownPct": max_dd * 100,
        "maxLossStreak": max_loss_streak,
        "wins": wins,
        "losses": losses,
        "winRate": wins / resolved if resolved > 0 else None,
        "avgRr": rr_sum / resolved if resolved > 0 else None,
        "busted": busted,
    }
    return {
        "summary": summary,
        "points": [{"t": p["t"], "equity": p["equity"] * capital} for p in points],
        "trades": [{**t, "equityAfter": t["equityAfter"] * capital} for t in trades],
        "openPosition": open_position,
    }


async def evaluate_new_candle(symbol: str, interval: str) -> None:
    """某个品种/周期刚有一根 K 线收盘时调用：对该组合下所有已启用的策略求值，
    命中就给策略主人生成一条个人信号并推送。没有任何策略在盯这个品种/周期时
    直接返回，不做任何多余查询。

    Called whenever a bar just closed for a symbol/interval: evaluates every
    enabled strategy on that combo, firing a personal signal to its owner on
    a hit. Returns immediately if nothing is watching this combo — no wasted
    queries.
    """
    db = SessionLocal()
    try:
        strategies = (
            db.query(UserStrategy)
            .filter(UserStrategy.symbol == symbol, UserStrategy.interval == interval, UserStrategy.enabled.is_(True))
            .all()
        )
        if not strategies:
            return

        rows = (
            db.query(Candle)
            .filter(Candle.symbol == symbol, Candle.interval == interval)
            .order_by(Candle.t.desc())
            .limit(LIVE_LOOKBACK_BARS)
            .all()
        )
        if len(rows) < 5:
            return
        bars = [{"t": r.t, "o": r.o, "h": r.h, "l": r.l, "c": r.c, "v": r.v} for r in reversed(rows)]
        last_bar = bars[-1]

        for strat in strategies:
            if strat.last_signal_bar_t == last_bar["t"]:
                continue
            # 一次一单：上一笔触发的信号还没摸到止损/止盈就不开新仓——用这根
            # 新收盘 K 线的高低点顺带判定上一笔是否已经平仓,与回测的
            # _resolve_trade 用同一套"同根摸到两边按止损处理"的保守假设。
            # One trade at a time: don't fire while the previous signal hasn't
            # hit its SL/TP yet — this newly closed bar's high/low doubles as
            # the check for whether it just did, using the same conservative
            # "both touched in one bar counts as SL" assumption as the
            # backtest's _resolve_trade.
            if strat.one_trade_at_a_time:
                pending = (
                    db.query(StrategySignal)
                    .filter(StrategySignal.strategy_id == strat.id, StrategySignal.result == "PENDING")
                    .order_by(StrategySignal.created_at.desc())
                    .first()
                )
                if pending is not None:
                    hi, lo = last_bar["h"], last_bar["l"]
                    if pending.side == "BUY":
                        hit_tp = hi >= pending.take_profit
                        hit_sl = lo <= pending.stop_loss
                    else:
                        hit_tp = lo <= pending.take_profit
                        hit_sl = hi >= pending.stop_loss
                    if hit_sl or hit_tp:
                        pending.result = "HIT_SL" if hit_sl else "HIT_TP"
                        pending.resolved_at = datetime.now(timezone.utc)
                        db.commit()
                    # 不管这根 K 线是否刚把上一笔判定平仓,这根都不再开新仓——
                    # 平仓和开新仓不共用同一根 K 线,与回测 i = exit_j + 1 的
                    # 语义一致。
                    # Whether or not this bar just resolved the pending trade,
                    # it never opens a new one on the same bar — exit and next
                    # entry never share a bar, matching the backtest's
                    # i = exit_j + 1 semantics.
                    continue
            try:
                params = validate_and_clamp_params(strat.template, json.loads(strat.params or "{}"))
                side = entry_signals(bars, strat.template, params)[-1]
            except ValueError:
                continue
            if side is None:
                continue
            entry_price = last_bar["c"]
            sl, tp = _entry_exit_prices(
                side, entry_price,
                strat.stop_loss_method, strat.stop_loss_value,
                strat.take_profit_method, strat.take_profit_value,
            )
            sig = StrategySignal(
                strategy_id=strat.id, user_id=strat.user_id, symbol=symbol, side=side,
                entry=entry_price, stop_loss=sl, take_profit=tp, bar_t=last_bar["t"],
            )
            db.add(sig)
            strat.last_signal_bar_t = last_bar["t"]
            db.commit()
            logger.info("strategy_engine: fired %s %s signal for user=%s strategy=%s", symbol, side, strat.user_id, strat.id)
            await manager.push_to_client(strat.user_id, {
                "type": "STRATEGY_SIGNAL",
                "data": {
                    "id": sig.id, "strategyId": strat.id, "symbol": symbol, "side": side,
                    "entry": entry_price, "stopLoss": sl, "takeProfit": tp,
                    "createdAt": sig.created_at.isoformat() if sig.created_at else None,
                },
            })
            # 与平台信号一样可推送通知,但只发给这一个用户(触发它的策略主人),
            # 走事件类通知(与 order_filled/auto_manage 同一条单用户推送路径),
            # 受用户自己的通知偏好开关控制,不是强制打扰。
            # Pushable just like a platform signal, but only to the one user
            # who owns the triggering strategy — goes through the same
            # single-user event-notification path as order_filled/
            # auto_manage, gated by that user's own notification prefs, not
            # a forced interruption.
            strat_label = strat.name or strat.template
            await dispatch_event_push_async(
                strat.user_id, EVENT_STRATEGY_SIGNAL,
                f"我的策略信号 {symbol}",
                f"{side} · {strat_label}",
            )
    finally:
        db.close()
