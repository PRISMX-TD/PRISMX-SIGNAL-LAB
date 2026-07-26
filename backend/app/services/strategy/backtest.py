"""回测回放引擎：撮合、成本、净值结算、样本内外切分。

与旧 strategy_engine.run_backtest 的三处口径差异，都是刻意的：

1. 净值按实际出场价算，不再假定"赢 = +risk×rr、输 = -risk"。加入成本与超时
   平仓后出场价不再必然等于 SL/TP，固定式会把成本算漏。不含成本且无超时时该
   式退化为旧式，故旧断言仍成立。
2. 全部比较走 rules.py 的容差比较（旧实现只在部分模板用容差）。
3. 结果多了 TIMEOUT 一种。

Backtest replay engine: fills, costs, equity settlement, in/out-of-sample
split. Three deliberate differences from the old strategy_engine.run_backtest:
equity uses the actual exit price (the old fixed "+risk*rr / -risk" would lose
the costs once exits stop landing exactly on SL/TP); every comparison goes
through rules.py's tolerance-aware compare; and TIMEOUT joins the result
vocabulary. With zero costs and no timeout the new formula collapses to the old
one, so the old assertions still hold.
"""
from dataclasses import dataclass
from datetime import datetime, timezone

from app.services.strategy import costs as ct
from app.services.strategy.conditions import evaluate_conditions

SL_METHODS = frozenset({"percent", "steps", "atr"})
TP_METHODS = frozenset({"rr", "percent", "steps", "atr"})

# 样本内外切分：固定 70/30，按时间顺序，不提供关闭开关。自由度提升后过拟合是
# 主要风险，可关闭的警告等于没有警告。
# In/out-of-sample split: fixed 70/30 in time order, no off switch. Overfitting
# is the dominant risk once the rule space opens up, and a dismissible warning
# is no warning.
IN_SAMPLE_FRACTION = 0.7
# 过拟合判定阈值：样本外胜率低于样本内 15 个百分点以上，或样本外收益为负而
# 样本内为正。
# Overfit thresholds: out-of-sample win rate more than 15 points below
# in-sample, or out-of-sample return negative while in-sample was positive.
OVERFIT_WIN_RATE_DROP = 0.15
# 绩效样本不足这个笔数时不给百分比（1 胜 0 负呈现为 100% 是误导）。
# Below this many resolved trades, no percentage is shown (1-0 as "100%" misleads).
MIN_PERF_SAMPLE = 10


@dataclass
class ExitSpec:
    """一套出场配置。timeout_bars 为 None 表示不启用超时平仓。
    One exit configuration; timeout_bars None disables the timeout exit."""

    sl_method: str
    sl_value: float
    tp_method: str
    tp_value: float
    timeout_bars: int | None = None


def exit_prices(
    side: str, entry: float, symbol: str, spec: ExitSpec, atr_value: float | None = None
) -> tuple[float, float]:
    """按各自方法独立算出止损/止盈价。atr 方法需要传入当根的 ATR 值。

    atr_value 缺失时抛 ValueError 而不是回落到别的方法——静默换一种止损口径
    是最难发现的一类偏差（用户以为在测 ATR 自适应，实际测的是百分比）。

    Compute SL/TP prices, each by its own method; the atr method needs that
    bar's ATR value. A missing atr_value raises rather than falling back to
    another method — silently swapping the SL basis is the hardest kind of
    discrepancy to notice (the user thinks they're testing ATR-adaptive stops
    while actually testing a percentage).
    """
    if spec.sl_method not in SL_METHODS:
        raise ValueError(f"未知止损方式 {spec.sl_method}，可选 {sorted(SL_METHODS)} / unknown SL method")
    if spec.tp_method not in TP_METHODS:
        raise ValueError(f"未知止盈方式 {spec.tp_method}，可选 {sorted(TP_METHODS)} / unknown TP method")
    if "atr" in (spec.sl_method, spec.tp_method) and atr_value is None:
        raise ValueError("ATR 方式需要可用的 ATR 值 / the atr method needs an ATR value")

    point = ct.point_size(symbol, entry)
    if spec.sl_method == "percent":
        sl_dist = entry * (spec.sl_value / 100.0)
    elif spec.sl_method == "steps":
        sl_dist = spec.sl_value * point
    else:
        sl_dist = spec.sl_value * atr_value

    if spec.tp_method == "rr":
        tp_dist = sl_dist * spec.tp_value
    elif spec.tp_method == "percent":
        tp_dist = entry * (spec.tp_value / 100.0)
    elif spec.tp_method == "steps":
        tp_dist = spec.tp_value * point
    else:
        tp_dist = spec.tp_value * atr_value

    if side == "BUY":
        sl, tp = entry - sl_dist, entry + tp_dist
    else:
        sl, tp = entry + sl_dist, entry - tp_dist
    return ct.round_price(sl), ct.round_price(tp)


def resolve_trade(
    bars: list[dict], entry_i: int, side: str, sl: float, tp: float, timeout_bars: int | None
) -> tuple[str | None, int | None]:
    """从入场的下一根开始找先摸到止损还是止盈，或超时。

    同一根摸到两者按止损处理（保守，与 signal_resolution.py 的既有假设一致）。
    超时判定放在 SL/TP 之后：同一根既触及止损又达到超时根数时，触及优先——
    超时是"什么都没发生"的兜底，不该抢走一个真实发生的出场。

    Search forward from the bar after entry for the first SL/TP touch, or a
    timeout. A bar touching both counts as a stop (conservative, matching
    signal_resolution.py). The timeout check comes after SL/TP: when a bar both
    touches a level and reaches the timeout count, the touch wins — the timeout
    is a "nothing happened" fallback and shouldn't steal a real exit.
    """
    for j in range(entry_i + 1, len(bars)):
        hi, lo = bars[j]["h"], bars[j]["l"]
        hit_sl = (lo <= sl) if side == "BUY" else (hi >= sl)
        hit_tp = (hi >= tp) if side == "BUY" else (lo <= tp)
        if hit_sl:
            return "HIT_SL", j
        if hit_tp:
            return "HIT_TP", j
        if timeout_bars is not None and (j - entry_i) >= timeout_bars:
            return "TIMEOUT", j
    return None, None


def _atr_series(bars: list[dict], period: int = 14) -> list[float | None]:
    """回测内部用的 ATR 序列，供 atr 出场方法逐 bar 取值。
    ATR series for the atr-based exit methods to read per bar."""
    from app.services.strategy import indicators as ind

    return ind.atr([b["h"] for b in bars], [b["l"] for b in bars], [b["c"] for b in bars], period)


def _empty_summary(capital: float) -> dict:
    return {
        "finalEquity": capital,
        "returnPct": 0.0,
        "maxDrawdownPct": 0.0,
        "maxLossStreak": 0,
        "wins": 0,
        "losses": 0,
        "winRate": None,
        "avgRr": None,
        "busted": False,
    }


def _collect_entries(
    bars: list[dict],
    signals: list[str | None],
    spec: ExitSpec,
    symbol: str,
    costs: ct.SymbolCosts,
    atrs: list[float | None],
    one_trade_at_a_time: bool,
) -> tuple[list[dict], list[dict]]:
    """第一步：只找出每笔交易的入场/出场，不牵扯净值结算。
    Step one: locate each trade's entry/exit, no equity bookkeeping yet."""
    raw: list[dict] = []
    open_positions: list[dict] = []

    def _open(i: int, side: str) -> dict | None:
        atr_value = atrs[i] if atrs else None
        if "atr" in (spec.sl_method, spec.tp_method) and atr_value is None:
            # ATR 预热期内无法定出场位：跳过这根，不猜一个距离。
            # No exit level definable during ATR warm-up: skip rather than guess.
            return None
        entry_price = ct.round_price(ct.entry_fill(side, bars[i]["c"], costs))
        sl, tp = exit_prices(side, entry_price, symbol, spec, atr_value)
        result, j = resolve_trade(bars, i, side, sl, tp, spec.timeout_bars)
        return {
            "i": i, "side": side, "entry_price": entry_price, "sl": sl, "tp": tp,
            "exit_result": result, "exit_j": j,
        }

    if one_trade_at_a_time:
        i = 0
        while i < len(bars):
            side = signals[i]
            if side is None:
                i += 1
                continue
            t = _open(i, side)
            if t is None:
                i += 1
                continue
            if t["exit_result"] is None:
                open_positions.append({
                    "side": side, "entryPrice": t["entry_price"], "stopLoss": t["sl"],
                    "takeProfit": t["tp"], "entryTime": bars[i]["t"],
                })
                break
            raw.append(t)
            i = t["exit_j"] + 1
    else:
        for i in range(len(bars)):
            side = signals[i]
            if side is None:
                continue
            t = _open(i, side)
            if t is None:
                continue
            if t["exit_result"] is None:
                open_positions.append({
                    "side": side, "entryPrice": t["entry_price"], "stopLoss": t["sl"],
                    "takeProfit": t["tp"], "entryTime": bars[i]["t"],
                })
                continue
            raw.append(t)
        raw.sort(key=lambda t: t["exit_j"])
    return raw, open_positions


def _settle(
    bars: list[dict], raw: list[dict], symbol: str, costs: ct.SymbolCosts,
    risk_pct: float, capital: float, mode: str,
) -> tuple[dict, list[dict], list[dict], float]:
    """第二步：按出场先后结算净值/胜负/回撤，返回 (summary, points, trades, 总成本)。

    盈亏按实际出场价与入场价的价格距离折算成"名义止损距离的倍数"，再乘风险
    百分比。名义止损距离用的是含成本入场价推出的 SL——用户设定的风险是"这笔
    最多亏 1%"，成本让实际出场更差，就该体现为亏超过 1%，而不是把风险定义
    改掉。

    Step two: settle equity/wins/drawdown in exit order, returning (summary,
    points, trades, total cost). P&L converts the actual exit-vs-entry price
    distance into multiples of the nominal stop distance, then scales by the
    risk percentage. The nominal distance comes from the cost-adjusted entry: the
    user's "risk 1% on this trade" should show up as losing slightly more than
    1% once costs bite, rather than silently redefining the risk.
    """
    risk_frac = risk_pct / 100.0
    equity = 1.0
    peak = 1.0
    max_dd = 0.0
    wins = losses = 0
    loss_streak = max_loss_streak = 0
    rr_sum = 0.0
    busted = False
    total_cost = 0.0
    points: list[dict] = []
    trades: list[dict] = []

    for t in raw:
        if busted:
            break
        i, side, entry_price = t["i"], t["side"], t["entry_price"]
        sl, tp, result, exit_j = t["sl"], t["tp"], t["exit_result"], t["exit_j"]

        if result == "HIT_SL":
            exit_price = ct.exit_fill(side, sl, costs, is_stop=True)
        elif result == "HIT_TP":
            exit_price = ct.exit_fill(side, tp, costs, is_stop=False)
        else:  # TIMEOUT：按当根收盘价平仓 / close at that bar's close
            exit_price = ct.exit_fill(side, bars[exit_j]["c"], costs, is_stop=True)
        exit_price = ct.round_price(exit_price)

        risk_dist = abs(entry_price - sl)
        rr = abs(tp - entry_price) / risk_dist if risk_dist > 0 else 0.0
        rr_sum += rr
        gain = (exit_price - entry_price) if side == "BUY" else (entry_price - exit_price)
        commission = ct.commission_cost(costs)
        total_cost += commission + abs(entry_price - bars[i]["c"])
        net = gain - commission
        pnl_pct = risk_frac * (net / risk_dist) if risk_dist > 0 else 0.0

        if net > 0:
            wins += 1
            loss_streak = 0
        else:
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
            "entryTime": bars[i]["t"],
            "exitTime": bars[exit_j]["t"],
            "entryPrice": entry_price,
            "exitPrice": exit_price,
            "result": result,
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
    points = [{"t": p["t"], "equity": p["equity"] * capital} for p in points]
    trades = [{**tr, "equityAfter": tr["equityAfter"] * capital} for tr in trades]
    return summary, points, trades, total_cost


def _overfit_verdict(in_s: dict, out_s: dict) -> dict:
    """过拟合判定。任一样本笔数不足 MIN_PERF_SAMPLE 时不判定——样本太小的
    "胜率暴跌"是噪声，报出来只会训练用户忽略这个提示。
    Overfit verdict. Not evaluated when either sample has fewer than
    MIN_PERF_SAMPLE trades — a "collapse" on a tiny sample is noise, and
    reporting it just teaches users to ignore the warning."""
    in_n = in_s["wins"] + in_s["losses"]
    out_n = out_s["wins"] + out_s["losses"]
    if in_n < MIN_PERF_SAMPLE or out_n < MIN_PERF_SAMPLE:
        return {"flagged": False, "reason": None, "insufficientSample": True}
    in_wr, out_wr = in_s["winRate"], out_s["winRate"]
    if in_wr is not None and out_wr is not None and (in_wr - out_wr) > OVERFIT_WIN_RATE_DROP:
        return {"flagged": True, "reason": "winRateDrop", "insufficientSample": False}
    if out_s["returnPct"] < 0 < in_s["returnPct"]:
        return {"flagged": True, "reason": "returnFlip", "insufficientSample": False}
    return {"flagged": False, "reason": None, "insufficientSample": False}


def run_backtest(
    bars: list[dict],
    rules: dict,
    spec: ExitSpec,
    *,
    symbol: str,
    risk_pct: float,
    capital: float,
    mode: str,
    one_trade_at_a_time: bool = True,
    costs: ct.SymbolCosts | None = None,
) -> dict:
    """回放这套规则在给定 K 线上的表现，返回含成本与不含成本两套结果。

    样本内外各自独立回放（而不是把整段的交易按时间切两半）：切交易会让一笔
    跨越切分点的仓位归属不明，独立回放则两段各自从零开始，语义清晰。

    Replay these rules over the given bars, returning both cost-adjusted and
    cost-free results. The two samples are replayed independently rather than
    slicing the full trade list in half — slicing leaves a position straddling
    the boundary with no clear owner, while replaying gives each section a clean
    start.
    """
    c = costs if costs is not None else ct.DEFAULT_COSTS
    if not bars:
        empty = _empty_summary(capital)
        return {
            "summary": empty, "points": [], "trades": [], "openPositions": [],
            "inSample": {"barsUsed": 0, "summary": _empty_summary(capital), "trades": []},
            "outOfSample": {"barsUsed": 0, "summary": _empty_summary(capital), "trades": []},
            "overfitRisk": {"flagged": False, "reason": None, "insufficientSample": True},
            "totalCost": 0.0,
            "withoutCosts": {"summary": _empty_summary(capital), "trades": []},
            "barsUsed": 0,
        }

    signals = evaluate_conditions(bars, rules)
    atrs = _atr_series(bars) if "atr" in (spec.sl_method, spec.tp_method) else []

    def _run(
        section_bars: list[dict],
        section_signals: list[str | None],
        section_atrs: list[float | None],
        section_costs: ct.SymbolCosts,
    ):
        raw, open_pos = _collect_entries(
            section_bars, section_signals, spec, symbol, section_costs, section_atrs, one_trade_at_a_time
        )
        summary, points, trades, total = _settle(
            section_bars, raw, symbol, section_costs, risk_pct, capital, mode
        )
        return summary, points, trades, total, open_pos

    summary, points, trades, total_cost, open_positions = _run(bars, signals, atrs, c)
    free_summary, _, free_trades, _, _ = _run(bars, signals, atrs, ct.SymbolCosts(0.0, 0.0, 0.0))

    split = int(len(bars) * IN_SAMPLE_FRACTION)
    in_bars, out_bars = bars[:split], bars[split:]
    in_summary, _, in_trades, _, _ = _run(in_bars, signals[:split], atrs[:split], c)
    # 样本外段单独求值：直接切 signals 会让样本外首几根缺少指标预热与交叉判定
    # 所需的前置 bar，凭空少掉信号。
    # The out-of-sample section is re-evaluated on its own: slicing `signals`
    # would leave its first bars without the preceding bars that indicator
    # warm-up and crossing detection need, silently dropping signals.
    out_signals = evaluate_conditions(out_bars, rules) if out_bars else []
    out_atrs = _atr_series(out_bars) if atrs else []
    out_summary, _, out_trades, _, _ = _run(out_bars, out_signals, out_atrs, c)

    return {
        "summary": summary,
        "points": points,
        "trades": trades,
        "openPositions": open_positions,
        "inSample": {"barsUsed": len(in_bars), "summary": in_summary, "trades": in_trades},
        "outOfSample": {"barsUsed": len(out_bars), "summary": out_summary, "trades": out_trades},
        "overfitRisk": _overfit_verdict(in_summary, out_summary),
        "totalCost": total_cost,
        "withoutCosts": {"summary": free_summary, "trades": free_trades},
        "barsUsed": len(bars),
    }
