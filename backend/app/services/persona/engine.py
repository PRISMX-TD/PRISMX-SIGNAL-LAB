"""交易人格的判定规则（方案第 3、5、6、8、9 节，2026-11-22 定稿；数字是按 17–26 个实盘用户校准的初值）。

纯函数：输入是 positions.Position 列表，输出是可直接 JSON 化的 dict，不碰数据库。
所有分界线是**固定值**，不跟着全站平均水平变（方案第 6 节）。

Persona rules (plan sections 3, 5, 6, 8, 9). Pure functions over positions.Position lists returning
JSON-ready dicts; no database access. Every cut-off is fixed, never relative to the site average.
"""
from __future__ import annotations

import math
import statistics
from collections import Counter, defaultdict
from datetime import timedelta

from app.services.gamification import periods

# ---------------------------------------------------------------- 解锁 / unlock (plan §3)
WINDOW_DAYS = 90
UNLOCK_ACTIONS = 20          # 最近 90 天出手满 20 次 / 20 actions in the last 90 days
UNLOCK_DAYS = 3              # 至少 3 个交易日 / at least 3 trading days
HIDDEN_MIN_WINS = 3          # 不显示的底线：至少 3 盈 3 亏 / hidden floor: 3 wins and 3 losses
HIDDEN_MIN_LOSSES = 3
FORMAL_POSITIONS = 50        # 满 50 笔变正式结果 / 50 positions turn the first look into the result
BURST_SECONDS = 60           # 连点合并：同品种同方向、距上一单开仓 ≤60 秒 / burst merge window

# ---------------------------------------------------------------- 主轴 / axes (plan §5, §6)
JUDGE_CUT = 0.5              # 跟信号占比 ≥50% → R
JUDGE_BUFFER = (0.40, 0.60)
RISK_CUT = 50.0              # 风控分 ≥50 → G
RISK_BUFFER = (45.0, 55.0)
TEMPO_CUT = 50.0             # 节奏分 ≥50 → Q
TEMPO_BUFFER = (45.0, 55.0)
MANAGE_CUT = 0.15            # 开仓 2 分钟后自己改过止损止盈的占比 ≥15% → M
MANAGE_BUFFER = (0.10, 0.20)
MANAGE_GRACE_SECONDS = 120   # 开仓 2 分钟内的改单是开仓动作的一部分，不算 / edits in the first 2 min don't count
STOPOUT_PENALTY = 3.0        # 每 1% 的单被强平扣 3 分 / 3 points per 1% stopped out

AXES = ("judge", "risk", "tempo", "manage")
# 每个主轴的两端字母：value ≥ 分界 → 第二个字母。/ Each axis' poles; value at or above the cut → the 2nd.
POLES = {"judge": ("A", "R"), "risk": ("X", "G"), "tempo": ("L", "Q"), "manage": ("Z", "M")}
FAMILIES = {"AG": "strategist", "AX": "maverick", "RG": "executor", "RX": "chaser"}

CODES = [
    "AGLZ", "AGLM", "AGQZ", "AGQM", "AXLZ", "AXLM", "AXQZ", "AXQM",
    "RGLZ", "RGLM", "RGQZ", "RGQM", "RXLZ", "RXLM", "RXQZ", "RXQM",
]


def _clamp(v: float, lo: float = 0.0, hi: float = 100.0) -> float:
    return max(lo, min(hi, v))


def _log2_score(x: float, mid: float, invert: bool = False) -> float:
    """x 等于 mid 得 50 分，每翻一倍 ±25 分（invert 时反过来）；用于「2.5 / 10 / 40」这类按倍数过渡的刻度。
    50 at x == mid, ±25 per doubling (reversed if invert) — the "2.5 / 10 / 40" style scales."""
    if x <= 0:
        return 0.0 if not invert else 100.0
    s = 50.0 + 25.0 * math.log2(x / mid)
    return _clamp(100.0 - s if invert else s)


def _log2_score_wide(x: float, mid: float, invert: bool = False) -> float:
    """x 等于 mid 得 50 分，每翻一倍 ±50 分；用于「0.5 / 1 / 2」的刻度。
    50 at mid, ±50 per doubling — the "0.5 / 1 / 2" scales."""
    if x <= 0:
        return 0.0 if not invert else 100.0
    s = 50.0 + 50.0 * math.log2(x / mid)
    return _clamp(100.0 - s if invert else s)


# ---------------------------------------------------------------- 出手 / actions
def actions(positions) -> list[list]:
    """连点合并：同品种、同方向、距上一单开仓不超过 60 秒的仓位并成一次「出手」。
    Burst merge: positions on the same symbol and side opened within 60 s of the previous one form one action."""
    out: list[list] = []
    last_by_key: dict = {}
    for p in sorted(positions, key=lambda q: q.open_at):
        key = (p.symbol, p.side)
        prev = last_by_key.get(key)
        if prev is not None and (p.open_at - prev[0]).total_seconds() <= BURST_SECONDS:
            prev[1].append(p)
            last_by_key[key] = (p.open_at, prev[1])
            continue
        group = [p]
        out.append(group)
        last_by_key[key] = (p.open_at, group)
    return out


def trading_days(positions) -> int:
    return len({periods.day_key(p.open_at) for p in positions})


def unlock_status(positions) -> dict:
    """解锁进度（方案第 3 节）。对用户只显示出手次数和交易日；盈亏底线只给一个中性的 needMore。
    Unlock progress: users see actions and trading days; the win/loss floor only surfaces as needMore."""
    n_actions = len(actions(positions))
    days = trading_days(positions)
    wins = sum(1 for p in positions if p.is_win)
    losses = sum(1 for p in positions if not p.is_win)
    shown = n_actions >= UNLOCK_ACTIONS and days >= UNLOCK_DAYS
    floor = wins >= HIDDEN_MIN_WINS and losses >= HIDDEN_MIN_LOSSES
    return {
        "unlocked": shown and floor,
        "actions": n_actions, "actionsNeed": UNLOCK_ACTIONS,
        "days": days, "daysNeed": UNLOCK_DAYS,
        # 显示的两条都够了、只差盈亏底线：前端只说「再交易几笔」/ both shown conditions met, floor not
        "needMore": shown and not floor,
    }


# ---------------------------------------------------------------- 四个主轴 / the four axes
def _mean(xs):
    return sum(xs) / len(xs) if xs else None


def judge_value(positions) -> float:
    """跟信号的单占比（0–1）；反着信号做的算自主。/ Share of signal-following positions."""
    return sum(1 for p in positions if p.from_signal) / len(positions) if positions else 0.0


def risk_parts(positions) -> dict:
    """风控分（方案 5.2）：持有时间比 60% + 盈亏比 40% − 强平扣分。
    Risk score: 60% loser/winner hold ratio + 40% payoff ratio − stop-out penalty."""
    wins = [p for p in positions if p.is_win]
    losses = [p for p in positions if not p.is_win]
    win_hold = _mean([p.hold_seconds for p in wins])
    loss_hold = _mean([p.hold_seconds for p in losses])
    avg_win = _mean([p.profit for p in wins])
    avg_loss = _mean([-p.profit for p in losses])
    hold_ratio = (loss_hold / win_hold) if win_hold and loss_hold is not None else None
    payoff = (avg_win / avg_loss) if avg_win is not None and avg_loss else None
    hold_score = _log2_score_wide(hold_ratio, 1.0, invert=True) if hold_ratio is not None else 50.0
    payoff_score = _log2_score_wide(payoff, 1.0) if payoff is not None else 50.0
    realized = [p for p in positions if not p.unrealized]
    stopout_pct = (100.0 * sum(1 for p in realized if p.stopped_out) / len(realized)) if realized else 0.0
    score = _clamp(0.6 * hold_score + 0.4 * payoff_score - STOPOUT_PENALTY * stopout_pct)
    return {"score": score, "holdRatio": hold_ratio, "payoff": payoff, "stopOutPct": stopout_pct}


def tempo_parts(positions) -> dict:
    """节奏分（方案 5.3）：持仓时间中位数 60% + 每个交易日出手次数 40%。
    Tempo score: 60% median hold + 40% actions per trading day."""
    holds = [p.hold_seconds / 60.0 for p in positions if not p.unrealized]
    median_hold = statistics.median(holds) if holds else None
    days = trading_days(positions)
    per_day = (len(actions(positions)) / days) if days else None
    hold_score = _log2_score(median_hold, 10.0, invert=True) if median_hold is not None else 50.0
    freq_score = _log2_score(per_day, 10.0) if per_day is not None else 50.0
    return {"score": _clamp(0.6 * hold_score + 0.4 * freq_score), "medianHoldMin": median_hold, "perDay": per_day}


def manual_late_edit(p) -> bool:
    """开仓 2 分钟之后被用户自己改过止损或止盈（智能风控改的不算）。
    The user changed SL or TP more than 2 minutes after opening (smart-risk edits excluded)."""
    return any(not e.auto and (e.at - p.open_at).total_seconds() > MANAGE_GRACE_SECONDS for e in p.edits)


def manage_value(positions) -> float:
    realized = [p for p in positions if not p.unrealized]
    return sum(1 for p in realized if manual_late_edit(p)) / len(realized) if realized else 0.0


def _letter(axis: str, value: float, cut: float, buffer: tuple, previous: str | None) -> str:
    lo, hi = POLES[axis]
    if previous in (lo, hi) and buffer[0] <= value <= buffer[1]:
        return previous
    return hi if value >= cut else lo


def compute_persona(positions, previous_code: str | None = None) -> dict:
    """四个主轴 → 四个字母的代号。previous_code 给了的话，落在缓冲带里的主轴沿用上次的字母（方案第 6 节）。
    The four axes → the 4-letter code; with previous_code, an axis inside its buffer keeps its old letter."""
    prev = previous_code if previous_code in CODES else None
    j = judge_value(positions)
    r = risk_parts(positions)
    t = tempo_parts(positions)
    m = manage_value(positions)
    letters = [
        _letter("judge", j, JUDGE_CUT, JUDGE_BUFFER, prev[0] if prev else None),
        _letter("risk", r["score"], RISK_CUT, RISK_BUFFER, prev[1] if prev else None),
        _letter("tempo", t["score"], TEMPO_CUT, TEMPO_BUFFER, prev[2] if prev else None),
        _letter("manage", m, MANAGE_CUT, MANAGE_BUFFER, prev[3] if prev else None),
    ]
    code = "".join(letters)
    realized = [p for p in positions if not p.unrealized]
    return {
        "code": code,
        "family": FAMILIES[code[:2]],
        "positions": len(realized),
        "provisional": len(realized) < FORMAL_POSITIONS,
        # value：0–100，越大越靠近第二个字母；50 是分界。/ 0–100 toward the 2nd pole; 50 is the cut.
        "axes": {
            "judge": {"letter": letters[0], "value": round(j * 100, 1), "share": round(j, 4)},
            "risk": {"letter": letters[1], "value": round(r["score"], 1),
                     "holdRatio": _round(r["holdRatio"], 3), "payoff": _round(r["payoff"], 3),
                     "stopOutPct": round(r["stopOutPct"], 2)},
            "tempo": {"letter": letters[2], "value": round(t["score"], 1),
                      "medianHoldMin": _round(t["medianHoldMin"], 2), "perDay": _round(t["perDay"], 2)},
            # 管理：15% 对应 50，30% 及以上对应 100（方案 5.4）/ 15% maps to 50, 30%+ to 100
            "manage": {"letter": letters[3], "value": round(min(100.0, m / 0.30 * 100), 1), "share": round(m, 4)},
        },
    }


def _round(v, n):
    return round(v, n) if v is not None else None


# ---------------------------------------------------------------- 徽章 / monthly badges (plan §8)
BADGE_MIN_POSITIONS = 10     # 本月少于 10 笔不发徽章，样本太小 / no badges below 10 positions a month


def _median_lot(positions):
    lots = [p.volume for p in positions if p.volume > 0]
    return statistics.median(lots) if lots else None


def badges(month_positions, window_positions=None) -> list[str]:
    """本月徽章。window_positions 用来定「自己常用的手数」（默认就用本月的）。
    This month's badges. window_positions defines the user's usual lot size (defaults to the month)."""
    ps = [p for p in month_positions if not p.unrealized]
    if len(ps) < BADGE_MIN_POSITIONS:
        return []
    out: list[str] = []
    holds = [p.hold_seconds for p in ps]
    if statistics.median(holds) < 120:
        out.append("lightning")
    sym = Counter(p.symbol for p in ps)
    if len(sym) >= 4 and sym.most_common(1)[0][1] / len(ps) < 0.6:
        out.append("multiSymbol")
    if sum(1 for p in ps if p.source == "reverse") / len(ps) > 0.10:
        out.append("contrarian")
    if stacked_share(ps) > 0.5:
        out.append("stacker")
    buy = sum(1 for p in ps if p.side == "BUY") / len(ps)
    if buy > 0.75:
        out.append("bull")
    elif buy < 0.25:
        out.append("bear")
    if sum(1 for p in ps if p.auto_managed) / len(ps) > 0.5:
        out.append("autopilot")
    usual = _median_lot([p for p in (window_positions or ps) if not p.unrealized])
    if usual:
        off = sum(1 for p in ps if p.volume >= usual * 2 or p.volume <= usual / 2) / len(ps)
        if off < 0.10:
            out.append("lotSteady")
        elif off > 0.30:
            out.append("lotWild")
    return out


def stacked_share(positions) -> float:
    """开仓时同品种同方向已经有持仓的单占比。/ Share opened while a same-symbol same-side position was open."""
    ps = sorted(positions, key=lambda p: p.open_at)
    if not ps:
        return 0.0
    n = 0
    for i, p in enumerate(ps):
        if any(q.symbol == p.symbol and q.side == p.side and q.open_at < p.open_at < q.close_at for q in ps[:i]):
            n += 1
    return n / len(ps)


# ---------------------------------------------------------------- 每笔单的标签 / trade tags (plan §9)
TAGS = ("unprotected", "heldLoser", "earlyExit", "movedStop", "revenge", "stoppedOut")
HELD_LOSER_FACTOR = 3.0
REVENGE_MINUTES = 30
REVENGE_FACTOR = 1.5


def _ever_had_stop(p) -> bool:
    if p.sl_at_open:
        return True
    if any(e.sl for e in p.edits):
        return True
    return bool(p.sl_at_close)


def _moved_stop_against(p) -> bool:
    """把止损往亏损方向移，或直接撤掉（只看用户自己改的）。/ SL moved toward loss or removed (manual edits)."""
    prev_sl = p.sl_at_open or None
    for e in p.edits:
        before = e.prev_sl if e.prev_sl is not None else prev_sl
        after = e.sl or None
        if not e.auto and before:
            if after is None:
                return True
            if p.side == "BUY" and after < before:
                return True
            if p.side == "SELL" and after > before:
                return True
        prev_sl = after
    return False


def _early_exit(p) -> bool:
    """盈利时手动平仓，止盈还没到，实际盈利不到目标的一半。/ Manual win closed before half the TP distance."""
    if not p.is_win or not p.manual_close:
        return False
    tp = p.tp_at_close or p.tp_at_open
    if not tp or p.open_price is None or p.close_price is None:
        return False
    target = abs(tp - p.open_price)
    got = abs(p.close_price - p.open_price)
    return target > 0 and got < 0.5 * target


def trade_tags(positions, reference=None) -> dict:
    """每笔仓位的标签：{(login, ticket): [tag, ...]}。reference 定「自己盈利单平均持有时间」，默认就用 positions。
    Tags per position. reference sets the user's average winner hold (defaults to positions)."""
    ref = [p for p in (reference or positions) if p.is_win and not p.unrealized]
    avg_win_hold = _mean([p.hold_seconds for p in ref])
    ordered = sorted(positions, key=lambda p: p.open_at)
    out: dict = {}
    for i, p in enumerate(ordered):
        tags: list[str] = []
        if not p.unrealized and not _ever_had_stop(p):
            tags.append("unprotected")
        if not p.is_win and avg_win_hold and p.hold_seconds > HELD_LOSER_FACTOR * avg_win_hold:
            tags.append("heldLoser")
        if _early_exit(p):
            tags.append("earlyExit")
        if _moved_stop_against(p):
            tags.append("movedStop")
        # 上一笔亏损平仓后 30 分钟内再开仓、手数是那一笔的 1.5 倍以上
        # Opened within 30 min of a losing close, at 1.5x+ that position's lots.
        for q in ordered[:i]:
            if (not q.is_win and not q.unrealized and q.close_at <= p.open_at
                    and p.open_at - q.close_at <= timedelta(minutes=REVENGE_MINUTES)
                    and q.volume > 0 and p.volume >= REVENGE_FACTOR * q.volume):
                tags.append("revenge")
                break
        if p.stopped_out:
            tags.append("stoppedOut")
        out[(p.login, p.ticket)] = tags
    return out


def tag_summary(positions, tags: dict) -> dict:
    """每个标签几笔、一共盈亏多少。/ Count and total P&L per tag."""
    out = {t: {"count": 0, "profit": 0.0} for t in TAGS}
    for p in positions:
        for t in tags.get((p.login, p.ticket), []):
            out[t]["count"] += 1
            out[t]["profit"] += p.profit
    for v in out.values():
        v["profit"] = round(v["profit"], 2)
    return out


# ---------------------------------------------------------------- 分类报表 / breakdowns (plan §10)
# 时段按 UTC 切（与游戏化其余部分同一把尺，见 gamification/stats.py 的说明）。
# Sessions are cut in UTC, the same ruler as the rest of gamification.
SESSIONS = (("asia", 0, 7), ("europe", 7, 12), ("overlap", 12, 16), ("america", 16, 21), ("late", 21, 24))
HOLD_BUCKETS = (("lt2m", 0, 120), ("m2to10", 120, 600), ("m10to40", 600, 2400), ("m40to4h", 2400, 14400),
                ("gt4h", 14400, float("inf")))


def _bucket(rows, key_fn, order=None):
    acc: dict = defaultdict(lambda: {"trades": 0, "wins": 0, "profit": 0.0})
    for p in rows:
        k = key_fn(p)
        acc[k]["trades"] += 1
        acc[k]["wins"] += 1 if p.is_win else 0
        acc[k]["profit"] += p.profit
    keys = order if order is not None else sorted(acc, key=lambda k: -acc[k]["trades"])
    return [{"key": k, **{**acc[k], "profit": round(acc[k]["profit"], 2)}} for k in keys if k in acc]


def breakdowns(positions) -> dict:
    ps = list(positions)       # 含存档时的浮亏单，与 summary 一致 / floating losers included, as in summary

    def session(p):
        h = p.open_at.hour
        return next(name for name, a, b in SESSIONS if a <= h < b)

    def hold(p):
        s = p.hold_seconds
        return next(name for name, a, b in HOLD_BUCKETS if a <= s < b)

    return {
        "symbol": _bucket(ps, lambda p: p.symbol),
        "session": _bucket(ps, session, [s[0] for s in SESSIONS]),
        "weekday": _bucket(ps, lambda p: p.open_at.weekday(), list(range(7))),
        "hold": _bucket(ps, hold, [b[0] for b in HOLD_BUCKETS]),
        "source": _bucket(ps, lambda p: p.source, ["signal", "reverse", "strategy", "chart"]),
    }


# ---------------------------------------------------------------- 本月成绩 / month summary (plan §10)
def summary(positions) -> dict:
    """胜率、盈亏比、净盈亏、综合评分等。综合评分 = 胜率分、盈亏比分、风控分、盈利日占比四项各 25%。
    Win rate, payoff, net P&L and the composite score (win rate, payoff, risk and green-day share, 25% each).
    月底存档补进来的浮亏单算亏损单（方案第 4 节）；盈亏日历只看已平仓的。
    Floating losers added at archive count as losses; the calendar only uses closed positions."""
    ps = list(positions)
    n = len(ps)
    wins = [p for p in ps if p.is_win]
    losses = [p for p in ps if not p.is_win]
    gross_win = sum(p.profit for p in wins)
    gross_loss = -sum(p.profit for p in losses)
    win_rate = len(wins) / n if n else None
    avg_win = gross_win / len(wins) if wins else None
    avg_loss = gross_loss / len(losses) if losses else None
    payoff = (avg_win / avg_loss) if avg_win is not None and avg_loss else None
    days = calendar(ps)        # calendar() 自己会跳过浮亏单 / skips floating losers itself
    green = sum(1 for d in days if d["profit"] > 0)
    score = None
    if n:
        wr_score = _clamp((win_rate - 0.30) / 0.40 * 100)                    # 30% → 0, 70% → 100
        po_score = _log2_score_wide(payoff, 1.0) if payoff is not None else (100.0 if not losses else 0.0)
        rk_score = risk_parts(ps)["score"]
        day_score = 100.0 * green / len(days) if days else 0.0
        score = round(0.25 * (wr_score + po_score + rk_score + day_score))
    holds = [p.hold_seconds for p in ps]
    best = max(ps, key=lambda p: p.profit) if ps else None
    worst = min(ps, key=lambda p: p.profit) if ps else None
    return {
        "trades": n, "wins": len(wins), "losses": len(losses),
        "winRate": _round(win_rate, 4),
        "profit": round(sum(p.profit for p in ps), 2),
        "grossWin": round(gross_win, 2), "grossLoss": round(gross_loss, 2),
        "avgWin": _round(avg_win, 2), "avgLoss": _round(avg_loss, 2),
        "payoff": _round(payoff, 3),
        "profitFactor": _round(gross_win / gross_loss, 3) if gross_loss else None,
        "medianHoldMin": _round(statistics.median(holds) / 60.0, 2) if holds else None,
        "lots": round(sum(p.weighted_volume for p in ps), 2),
        "tradingDays": len(days), "greenDays": green,
        "best": _round(best.profit, 2) if best else None,
        "worst": _round(worst.profit, 2) if worst else None,
        "score": score,
        "maxDrawdown": _max_drawdown(ps),
    }


def _max_drawdown(ps) -> float:
    """按平仓顺序累计盈亏算的最大回撤（没有资金曲线，方案第 11 节）。/ Max drawdown of cumulative closed P&L."""
    peak = cum = dd = 0.0
    for p in sorted(ps, key=lambda q: q.close_at):
        cum += p.profit
        peak = max(peak, cum)
        dd = max(dd, peak - cum)
    return round(dd, 2)


def calendar(positions) -> list[dict]:
    """盈亏日历：按平仓那天（UTC）汇总。/ P&L calendar by close day (UTC)."""
    acc: dict = defaultdict(lambda: {"profit": 0.0, "trades": 0})
    for p in positions:
        if p.unrealized:
            continue
        k = periods.day_key(p.close_at)
        acc[k]["profit"] += p.profit
        acc[k]["trades"] += 1
    return [{"day": k, "profit": round(v["profit"], 2), "trades": v["trades"]} for k, v in sorted(acc.items())]
