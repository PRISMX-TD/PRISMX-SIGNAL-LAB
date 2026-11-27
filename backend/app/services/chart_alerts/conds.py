"""图表警报的条件：校验 spec 形状、画线几何、条件判定。纯函数，不碰库。
Chart alert conditions: spec shape checks, drawing geometry and the condition test. Pure, no DB.

一条警报归结为「A 对 B」：
  · 价格警报：A = 报价（Bid），B = 价位，或通道 [lo, hi]；
  · 画线警报：A = 报价，B = 画线在此刻的价位（趋势线随时间变），通道类取两条线；
  · 指标警报：A = 指标某条线，B = 数值 / 另一条线 / 收盘价，收盘时判。
「按幅度移动」只看 A 自己：最近 N 根 K 线里涨 / 跌了多少（或百分之多少）。

An alert boils down to "A against B": price alerts compare the quote (bid) with a level or a
[lo, hi] channel; drawing alerts compare it with where the drawing is right now (trend lines move
with time), channels taking two lines; indicator alerts compare one plot with a value, another plot
or the close, at bar close. "Moving by" looks at A alone: how far it went over the last N bars.
"""
from __future__ import annotations

import math
import re
from typing import Any

KINDS = ("price", "drawing", "indicator")
CONDS_LINE = ("cross", "crossUp", "crossDown", "gt", "lt")
CONDS_CHANNEL = ("enter", "exit", "inside", "outside")
CONDS_MOVE = ("moveUp", "moveDown", "moveUpPct", "moveDownPct")
CONDS = CONDS_LINE + CONDS_CHANNEL + CONDS_MOVE
TRIGGERS = ("once", "bar", "close")
# 服务端有 K 线的周期（EA 推这几档）/ intervals the server has bars for
INTERVALS = ("1", "5", "15", "60", "240", "D")
INTERVAL_SECONDS = {"1": 60, "5": 300, "15": 900, "60": 3600, "240": 14400, "D": 86400}

SYMBOL_RE = re.compile(r"^[A-Za-z0-9._#&-]{1,64}$")
ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
PART_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,24}$")
MAX_MOVE_BARS = 500
MAX_LINES = 2


class SpecError(ValueError):
    """spec 不合格；消息是中英双语，原样回给前端。/ bad spec; bilingual message for the client."""


def _num(v: Any, name: str, *, positive: bool = False) -> float:
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
        raise SpecError(f"{name} 必须是有限数字 / {name} must be a finite number")
    if positive and v <= 0:
        raise SpecError(f"{name} 必须大于 0 / {name} must be positive")
    return float(v)


def _int(v: Any, name: str, lo: int, hi: int) -> int:
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or int(v) != v:
        raise SpecError(f"{name} 必须是整数 / {name} must be an integer")
    if not lo <= int(v) <= hi:
        raise SpecError(f"{name} 超出范围 {lo}–{hi} / {name} out of range {lo}-{hi}")
    return int(v)


def _label(spec: dict) -> str | None:
    lab = spec.get("label")
    if lab is None:
        return None
    if not isinstance(lab, str) or len(lab) > 60:
        raise SpecError("label 最长 60 个字符 / label is at most 60 characters")
    return lab


def _line(raw: Any) -> dict:
    if not isinstance(raw, dict):
        raise SpecError("画线几何无效 / invalid drawing geometry")
    t1 = _num(raw.get("t1"), "t1")
    t2 = _num(raw.get("t2"), "t2")
    p1 = _num(raw.get("p1"), "p1", positive=True)
    p2 = _num(raw.get("p2"), "p2", positive=True)
    return {"t1": t1, "p1": p1, "t2": t2, "p2": p2, "extL": bool(raw.get("extL")), "extR": bool(raw.get("extR"))}


def clean_spec(kind: str, cond: str, raw: Any) -> dict:
    """校验并规整 spec，返回只含已知字段的新 dict；不合格抛 SpecError。
    Validate and normalise a spec into a dict of known fields only; raises SpecError."""
    if kind not in KINDS:
        raise SpecError("未知的警报类型 / unknown alert kind")
    if cond not in CONDS:
        raise SpecError("未知的条件 / unknown condition")
    if not isinstance(raw, dict):
        raise SpecError("spec 必须是对象 / spec must be an object")
    out: dict[str, Any] = {}
    if raw.get("ref") is not None:
        out["ref"] = _num(raw["ref"], "ref", positive=True)
    lab = _label(raw)
    if lab is not None:
        out["label"] = lab

    if cond in CONDS_MOVE:
        out["value"] = _num(raw.get("value"), "value", positive=True)
        out["bars"] = _int(raw.get("bars"), "bars", 1, MAX_MOVE_BARS)

    if kind == "price":
        if cond in CONDS_LINE:
            out["level"] = _num(raw.get("level"), "level", positive=True)
        elif cond in CONDS_CHANNEL:
            lo = _num(raw.get("lo"), "lo", positive=True)
            hi = _num(raw.get("hi"), "hi", positive=True)
            out["lo"], out["hi"] = min(lo, hi), max(lo, hi)
        return out

    if kind == "drawing":
        if cond in CONDS_MOVE:
            raise SpecError("画线警报不支持按幅度移动 / drawing alerts don't support moving-by")
        lines = raw.get("lines")
        need = 2 if cond in CONDS_CHANNEL else 1
        if not isinstance(lines, list) or not need <= len(lines) <= MAX_LINES:
            raise SpecError("画线几何无效 / invalid drawing geometry")
        out["lines"] = [_line(x) for x in lines[:need]]
        # part = 画线上的哪一部分（如通道上沿、斐波那契 0.618）；画线挪动后前端按它重算几何
        # part = which piece of the drawing (channel top, fib 0.618…); the client re-derives geometry by it
        part = raw.get("part")
        if part is not None:
            if not isinstance(part, str) or not PART_RE.match(part):
                raise SpecError("part 无效 / invalid part")
            out["part"] = part
        win = raw.get("win")
        if win is not None:
            if not isinstance(win, list) or len(win) != 2:
                raise SpecError("win 无效 / invalid win")
            a, b = _num(win[0], "win"), _num(win[1], "win")
            out["win"] = [min(a, b), max(a, b)]
        return out

    # indicator
    ind = raw.get("ind")
    if not isinstance(ind, dict):
        raise SpecError("缺少指标 / missing indicator")
    from app.services.chart_alerts import ind as ind_mod

    typ, inputs, plot = ind_mod.clean(ind.get("type"), ind.get("inputs"), ind.get("plot"))
    out["ind"] = {"type": typ, "inputs": inputs, "plot": plot}
    if cond in CONDS_MOVE:
        return out
    target = raw.get("target")
    if not isinstance(target, dict):
        raise SpecError("缺少比较对象 / missing target")
    tk = target.get("kind")
    if cond in CONDS_CHANNEL:
        if tk != "band":
            raise SpecError("通道条件需要上下两个值 / channel conditions need a band")
        lo, hi = _num(target.get("lo"), "lo"), _num(target.get("hi"), "hi")
        out["target"] = {"kind": "band", "lo": min(lo, hi), "hi": max(lo, hi)}
    elif tk == "value":
        out["target"] = {"kind": "value", "v": _num(target.get("v"), "v")}
    elif tk == "plot":
        other = target.get("plot")
        if other not in ind_mod.plots_of(typ) or other == plot:
            raise SpecError("比较的线无效 / invalid target plot")
        out["target"] = {"kind": "plot", "plot": other}
    elif tk == "price":
        out["target"] = {"kind": "price"}
    else:
        raise SpecError("比较对象无效 / invalid target")
    return out


# ───────── 画线几何 / drawing geometry ─────────
# 图表横轴是一根根 K 线，周末没有 K 线；按时间直接线性外推，跨过周末的趋势线会比图上画的
# 多走两天。所以先把时间换成「开市秒数」（扣掉每周五纽约 17:00 到周日纽约 17:00 的 48 小时，
# 即夏令时 21:00、冬令时 22:00 UTC，与 candle_store 的周末闸门同一规则 weekend_boundary_hour_utc），
# 在这个坐标里线性插值。7×24 的品种不扣。
# 做法：先把 UTC 换成纽约钟点（夏令时 −4、冬令时 −5 小时，按 UTC 日期判，同 candle_store），
# 在那个钟点里休市窗口固定是周五 17:00 起 48 小时。夏令时切换发生在周日凌晨，落在休市窗口里，
# 换算的 1 小时跳变被休市段吸收，开市秒数仍单调不减；切换那个周末实际休 47 / 49 小时。
# The chart's x axis is bars and weekends have none; extrapolating in raw time would let a trend
# line crossing a weekend run two days further than drawn. Time is first mapped to "open seconds"
# (dropping Friday 17:00 to Sunday 17:00 New York each week: 21:00 UTC under US DST, 22:00 in
# winter — the same rule as candle_store's weekend gate) and the line interpolated there. 7x24
# symbols keep raw time. In New York clock time the closed window is a fixed 48h from Friday
# 17:00; the DST switch happens early Sunday, inside that window, so the 1h jump is absorbed and
# the axis stays monotonic (the switch weekend is really 47 / 49 hours long in UTC).
_WEEK = 7 * 86400
_MONDAY0 = 4 * 86400  # 1970-01-05 00:00 UTC 是周一 / was a Monday
_CLOSE_FROM = 4 * 86400 + 17 * 3600  # 周五 17:00 纽约钟点（相对周一 0 点）/ Friday 17:00 NY from Monday 00:00
_CLOSED_LEN = 2 * 86400


def _ny_clock(t: float) -> float:
    """UTC 秒 → 纽约钟点秒（夏令时 −4h，冬令时 −5h；按 UTC 日期判，同 candle_store）。
    UTC seconds → New York clock seconds (−4h under US DST, −5h otherwise; by UTC date)."""
    from datetime import datetime, timezone

    from app.services.candle_store import _us_dst_on

    day = datetime.fromtimestamp(t, timezone.utc).date()
    return t - (4 if _us_dst_on(day) else 5) * 3600


def open_time(t: float, symbol: str) -> float:
    """把 UTC 秒换成开市秒数坐标（单调不减；只用来比差值，绝对值无意义）。
    Map UTC seconds to the open-seconds axis (monotonic; only differences matter)."""
    from app.services.candle_store import WEEKEND_TRADING_SYMBOLS

    if symbol.upper() in WEEKEND_TRADING_SYMBOLS:
        return t
    n = _ny_clock(t)
    rel = n - _MONDAY0
    weeks = math.floor(rel / _WEEK)
    off = rel - weeks * _WEEK
    closed = weeks * _CLOSED_LEN + min(max(off - _CLOSE_FROM, 0.0), _CLOSED_LEN)
    return n - closed


def line_value(line: dict, t: float, symbol: str) -> float | None:
    """画线在时刻 t 的价位；不在线段范围内（没延长的那头之外）返回 None。
    The drawing's price at time t; None outside the segment on a side that isn't extended."""
    t1, t2 = line["t1"], line["t2"]
    p1, p2 = line["p1"], line["p2"]
    ext_l, ext_r = bool(line.get("extL")), bool(line.get("extR"))
    # extL / extR 跟着点走（extL = 第一点那头）；两点时间倒序时一起换过来
    # extL / extR follow the points (extL = beyond the first point); swap them with the points
    if t2 < t1:
        t1, t2, p1, p2 = t2, t1, p2, p1
        ext_l, ext_r = ext_r, ext_l
    if t < t1 and not ext_l:
        return None
    if t > t2 and not ext_r:
        return None
    x1, x2, x = open_time(t1, symbol), open_time(t2, symbol), open_time(t, symbol)
    if x2 - x1 < 1e-9:
        return p1 if p1 == p2 else (p1 + p2) / 2
    return p1 + (p2 - p1) * (x - x1) / (x2 - x1)


# ───────── 判定 / the test ─────────

def check_line(cond: str, a0: float | None, b0: float | None, a1: float, b1: float) -> bool:
    """A 对一条线 B：上穿 / 下穿 / 穿越 / 大于 / 小于。a0、b0 是上一次的值（没有时只判状态类）。
    A against one line B. a0 / b0 are the previous values (missing → only state conditions)."""
    d1 = a1 - b1
    if cond == "gt":
        return d1 > 0
    if cond == "lt":
        return d1 < 0
    if a0 is None or b0 is None:
        return False
    d0 = a0 - b0
    up = d0 < 0 <= d1
    down = d0 > 0 >= d1
    if cond == "crossUp":
        return up
    if cond == "crossDown":
        return down
    return up or down


def check_channel(cond: str, a0: float | None, band0: tuple[float, float] | None, a1: float, band1: tuple[float, float]) -> bool:
    """A 对通道 [lo, hi]：进入 / 离开 / 在内 / 在外。/ A against a [lo, hi] channel."""
    lo1, hi1 = band1
    in1 = lo1 <= a1 <= hi1
    if cond == "inside":
        return in1
    if cond == "outside":
        return not in1
    if a0 is None or band0 is None:
        return False
    in0 = band0[0] <= a0 <= band0[1]
    if cond == "enter":
        return not in0 and in1
    return in0 and not in1


def check_move(cond: str, past: float | None, now: float, value: float) -> bool:
    """最近 N 根里移动了多少：past 是 N 根之前的收盘（或指标值）。/ moved by value over N bars."""
    if past is None:
        return False
    if cond == "moveUp":
        return now - past >= value
    if cond == "moveDown":
        return past - now >= value
    if past == 0:
        return False
    pct = (now - past) / abs(past) * 100
    if cond == "moveUpPct":
        return pct >= value
    return -pct >= value


def band_of(v1: float | None, v2: float | None) -> tuple[float, float] | None:
    if v1 is None or v2 is None:
        return None
    return (min(v1, v2), max(v1, v2))
