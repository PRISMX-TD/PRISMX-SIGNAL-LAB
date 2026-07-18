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
            if fast[i - 1] <= slow[i - 1] and fast[i] > slow[i]:
                out[i] = _apply_direction("BUY", direction)
            elif fast[i - 1] >= slow[i - 1] and fast[i] < slow[i]:
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
            if dif[i - 1] <= dea[i - 1] and dif[i] > dea[i]:
                out[i] = _apply_direction("BUY", direction)
            elif dif[i - 1] >= dea[i - 1] and dif[i] < dea[i]:
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
            if closes[i - 1] > ma[i - 1] and lows[i] <= ma[i] * (1 + tol) and closes[i] > ma[i]:
                out[i] = _apply_direction("BUY", direction)
            elif closes[i - 1] < ma[i - 1] and highs[i] >= ma[i] * (1 - tol) and closes[i] < ma[i]:
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
            if closes[i] > trend_ma[i] and r[i - 1] <= oversold < r[i]:
                out[i] = _apply_direction("BUY", direction)
            elif closes[i] < trend_ma[i] and r[i - 1] >= overbought > r[i]:
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
        return entry - sl_dist, entry + tp_dist
    return entry + sl_dist, entry - tp_dist


def run_backtest(
    bars: list[dict], template: str, params: dict,
    stop_loss_method: str, stop_loss_value: float,
    take_profit_method: str, take_profit_value: float,
    risk_pct: float, capital: float, mode: str, symbol: str,
) -> dict:
    """吃已入库的 K 线历史,回放这个模板+参数组合过去的表现。

    返回结构与既有「如果你跟了」信号回测（`GET /api/signals/simulate`）完全
    一致（summary/points/trades),前端可以复用同一套净值曲线/汇总卡片组件。

    Replays this template+param combo's historical performance against stored
    candle history. Returns the exact same shape as the existing "what if you
    followed" signal replay (summary/points/trades) so the frontend can reuse
    the same equity-curve/summary-tile components.
    """
    signals = entry_signals(bars, template, params)
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

    i = 0
    n = len(bars)
    while i < n and not busted:
        side = signals[i]
        if side is None:
            i += 1
            continue
        entry_price = bars[i]["c"]
        sl, tp = _entry_exit_prices(side, entry_price, stop_loss_method, stop_loss_value, take_profit_method, take_profit_value)
        exit_result = None
        exit_j = None
        for j in range(i + 1, n):
            hi, lo = bars[j]["h"], bars[j]["l"]
            hit_sl = (lo <= sl) if side == "BUY" else (hi >= sl)
            hit_tp = (hi >= tp) if side == "BUY" else (lo <= tp)
            # 同一根 K 线内先摸到止损再摸到止盈也算止损——保守假设,与既有
            # 模拟器"规则公开、不偏袒"的口径一致。
            # If a bar touches both SL and TP, count it as SL — the
            # conservative assumption, consistent with the existing
            # simulator's "rules are public, never favor the outcome" stance.
            if hit_sl:
                exit_result, exit_j = "HIT_SL", j
                break
            if hit_tp:
                exit_result, exit_j = "HIT_TP", j
                break
        if exit_result is None:
            # 到数据末尾还没走出结果,这笔不计入统计(既不是赢也不是输)
            # Ran out of data before resolving; not counted as a win or loss.
            break

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
        i = exit_j + 1

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
    finally:
        db.close()
