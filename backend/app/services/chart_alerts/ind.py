"""指标警报用到的指标计算：从前端 frontend/src/components/charts/ind/math.ts 逐行移植。
Indicator math for indicator alerts, ported line by line from the frontend's ind/math.ts.

口径必须与图上一致——用户看着 RSI 穿 70 建的警报，服务端算出来的 RSI 不能是另一套。所以这里
不复用 strategy/indicators.py（那套是策略引擎的口径：EMA 种子、空值处理都不同），而是照前端的
写法移植，运算顺序也一样（浮点结果才逐位相同）。tests/test_chart_alerts.py 用前端算好的数对拍。

The numbers must match the chart: an alert set while watching RSI cross 70 cannot be evaluated on a
different RSI. Hence not strategy/indicators.py (the strategy engine's conventions differ in EMA
seeding and null handling) but a port of the frontend code with the same operation order, so float
results agree bit for bit. tests/test_chart_alerts.py checks against numbers computed by the frontend.

只移植了一部分指标（下面 DEFS），前端「添加警报」也只对这些开放。
Only a subset is ported (DEFS below); the frontend offers alerts for exactly these.
"""
from __future__ import annotations

import math
from typing import Any, Callable

from app.services.chart_alerts.conds import SpecError

Out = list  # list[float | None]

SOURCES = ("open", "high", "low", "close", "hl2", "hlc3", "ohlc4", "hlcc4")
MA_TYPES = ("sma", "ema", "wma", "rma", "hma", "dema", "tema", "vwma", "alma", "lsma")


def _nulls(n: int) -> Out:
    return [None] * n


def _to_len(v: float) -> int:
    return int(math.floor(v)) if v >= 1 else 0


def _windowed(s: Out, length: int, f: Callable[[int, int], float | None]) -> Out:
    n = len(s)
    out = _nulls(n)
    L = _to_len(length)
    if not L:
        return out
    run = 0
    for i in range(n):
        run = run + 1 if s[i] is not None else 0
        if run >= L:
            out[i] = f(i - L + 1, i)
    return out


def _zip(a: Out, b: Out, f: Callable[[float, float], float | None]) -> Out:
    return [None if x is None or y is None else f(x, y) for x, y in zip(a, b)]


def src(bars: list[dict], kind: str) -> Out:
    if kind == "open":
        return [b["o"] for b in bars]
    if kind == "high":
        return [b["h"] for b in bars]
    if kind == "low":
        return [b["l"] for b in bars]
    if kind == "close":
        return [b["c"] for b in bars]
    if kind == "hl2":
        return [(b["h"] + b["l"]) / 2 for b in bars]
    if kind == "hlc3":
        return [(b["h"] + b["l"] + b["c"]) / 3 for b in bars]
    if kind == "ohlc4":
        return [(b["o"] + b["h"] + b["l"] + b["c"]) / 4 for b in bars]
    if kind == "hlcc4":
        return [(b["h"] + b["l"] + 2 * b["c"]) / 4 for b in bars]
    return [b["v"] for b in bars]


def sma(s: Out, length: float) -> Out:
    L = _to_len(length)

    def f(a: int, b: int) -> float:
        t = 0.0
        for j in range(a, b + 1):
            t += s[j]
        return t / L
    return _windowed(s, L, f)


def _recursive(s: Out, L: int, alpha: float) -> Out:
    n = len(s)
    out = _nulls(n)
    if not L:
        return out
    prev = None
    run = 0
    for i in range(n):
        v = s[i]
        if prev is None:
            if v is None:
                run = 0
                continue
            run += 1
            if run < L:
                continue
            t = 0.0
            for j in range(i - L + 1, i + 1):
                t += s[j]
            prev = t / L
            out[i] = prev
        elif v is not None:
            prev = alpha * v + (1 - alpha) * prev
            out[i] = prev
    return out


def ema(s: Out, length: float) -> Out:
    L = _to_len(length)
    return _recursive(s, L, 2 / (L + 1)) if L else _nulls(len(s))


def rma(s: Out, length: float) -> Out:
    L = _to_len(length)
    return _recursive(s, L, 1 / L) if L else _nulls(len(s))


def wma(s: Out, length: float) -> Out:
    L = _to_len(length)
    norm = (L * (L + 1)) / 2

    def f(a: int, b: int) -> float:
        t = 0.0
        for j in range(a, b + 1):
            t += s[j] * (j - a + 1)
        return t / norm
    return _windowed(s, L, f)


def hma(s: Out, length: float) -> Out:
    L = _to_len(length)
    if not L:
        return _nulls(len(s))
    half = wma(s, max(1, L // 2))
    full = wma(s, L)
    # JS Math.round：.5 向上；√整数不会恰好落在 .5 上，floor(x+0.5) 与之等价
    return wma(_zip(half, full, lambda h, f: 2 * h - f), max(1, int(math.floor(math.sqrt(L) + 0.5))))


def dema(s: Out, length: float) -> Out:
    e1 = ema(s, length)
    return _zip(e1, ema(e1, length), lambda a, b: 2 * a - b)


def tema(s: Out, length: float) -> Out:
    e1 = ema(s, length)
    e2 = ema(e1, length)
    e3 = ema(e2, length)
    return [None if a is None or b is None or c is None else 3 * (a - b) + c for a, b, c in zip(e1, e2, e3)]


def vwma(s: Out, vol: Out, length: float) -> Out:
    pv = sma(_zip(s, vol, lambda x, v: x * v), length)
    return _zip(pv, sma(vol, length), lambda a, b: None if b == 0 else a / b)


def alma(s: Out, length: float, offset: float = 0.85, sigma: float = 6) -> Out:
    L = _to_len(length)
    m = offset * (L - 1)
    sd = L / sigma if L else 1
    w: list[float] = []
    norm = 0.0
    for i in range(L):
        x = math.exp(-((i - m) ** 2) / (2 * sd * sd))
        w.append(x)
        norm += x

    def f(a: int, b: int) -> float:
        t = 0.0
        for j in range(a, b + 1):
            t += s[j] * w[j - a]
        return t / norm
    return _windowed(s, L, f)


def lsma(s: Out, length: float, offset: float = 0) -> Out:
    L = _to_len(length)
    sx = (L * (L - 1)) / 2
    sxx = ((L - 1) * L * (2 * L - 1)) / 6
    den = L * sxx - sx * sx

    def f(a: int, b: int) -> float:
        sy = 0.0
        sxy = 0.0
        for j in range(a, b + 1):
            y = s[j]
            sy += y
            sxy += (j - a) * y
        slope = 0 if den == 0 else (L * sxy - sx * sy) / den
        intercept = (sy - slope * sx) / L
        return intercept + slope * (L - 1 - offset)
    return _windowed(s, L, f)


def ma(typ: str, s: Out, length: float, vol: Out | None = None) -> Out:
    if typ == "sma":
        return sma(s, length)
    if typ == "ema":
        return ema(s, length)
    if typ == "wma":
        return wma(s, length)
    if typ == "rma":
        return rma(s, length)
    if typ == "hma":
        return hma(s, length)
    if typ == "dema":
        return dema(s, length)
    if typ == "tema":
        return tema(s, length)
    if typ == "vwma":
        return vwma(s, vol, length) if vol is not None else sma(s, length)
    if typ == "alma":
        return alma(s, length)
    return lsma(s, length)


def stdev(s: Out, length: float) -> Out:
    L = _to_len(length)

    def f(a: int, b: int) -> float:
        m = 0.0
        for j in range(a, b + 1):
            m += s[j]
        m /= L
        q = 0.0
        for j in range(a, b + 1):
            q += (s[j] - m) ** 2
        return math.sqrt(q / L)
    return _windowed(s, L, f)


def highest(s: Out, length: float) -> Out:
    def f(a: int, b: int) -> float:
        v = -math.inf
        for j in range(a, b + 1):
            if s[j] > v:
                v = s[j]
        return v
    return _windowed(s, length, f)


def lowest(s: Out, length: float) -> Out:
    def f(a: int, b: int) -> float:
        v = math.inf
        for j in range(a, b + 1):
            if s[j] < v:
                v = s[j]
        return v
    return _windowed(s, length, f)


def change(s: Out, length: float = 1) -> Out:
    L = _to_len(length)
    out = _nulls(len(s))
    if not L:
        return out
    for i in range(L, len(s)):
        v, o = s[i], s[i - L]
        out[i] = None if v is None or o is None else v - o
    return out


def true_range(bars: list[dict]) -> Out:
    out = []
    for i, b in enumerate(bars):
        if i == 0:
            out.append(b["h"] - b["l"])
        else:
            pc = bars[i - 1]["c"]
            out.append(max(b["h"] - b["l"], abs(b["h"] - pc), abs(b["l"] - pc)))
    return out


def atr(bars: list[dict], length: float, smoothing: str = "rma") -> Out:
    return ma(smoothing, true_range(bars), length)


def rsi(s: Out, length: float = 14) -> Out:
    ch = change(s, 1)
    u = rma([None if v is None else max(v, 0) for v in ch], length)
    d = rma([None if v is None else max(-v, 0) for v in ch], length)
    return _zip(u, d, lambda a, b: 100 if b == 0 else (0 if a == 0 else 100 - 100 / (1 + a / b)))


def _raw_stoch(c: Out, h: Out, low: Out, length: float) -> Out:
    hh = highest(h, length)
    ll = lowest(low, length)
    out = _nulls(len(c))
    for i, v in enumerate(c):
        a, b = hh[i], ll[i]
        if v is None or a is None or b is None or a == b:
            continue
        out[i] = (100 * (v - b)) / (a - b)
    return out


def stoch(bars: list[dict], k_len: float, k_smooth: float, d_len: float) -> dict:
    k = sma(_raw_stoch(src(bars, "close"), src(bars, "high"), src(bars, "low"), k_len), k_smooth)
    return {"k": k, "d": sma(k, d_len)}


def macd(s: Out, fast: float, slow: float, signal: float, osc_ma: str, sig_ma: str) -> dict:
    m = _zip(ma(osc_ma, s, fast), ma(osc_ma, s, slow), lambda a, b: a - b)
    sg = ma(sig_ma, m, signal)
    return {"macd": m, "signal": sg, "hist": _zip(m, sg, lambda a, b: a - b)}


def cci(s: Out, length: float = 20) -> Out:
    L = _to_len(length)

    def f(a: int, b: int) -> float | None:
        m = 0.0
        for j in range(a, b + 1):
            m += s[j]
        m /= L
        dev = 0.0
        for j in range(a, b + 1):
            dev += abs(s[j] - m)
        dev /= L
        return None if dev == 0 else (s[b] - m) / (0.015 * dev)
    return _windowed(s, L, f)


def willr(bars: list[dict], length: float) -> Out:
    hh = highest(src(bars, "high"), length)
    ll = lowest(src(bars, "low"), length)
    out = _nulls(len(bars))
    for i, b in enumerate(bars):
        u, lo = hh[i], ll[i]
        if u is None or lo is None or u == lo:
            continue
        out[i] = (100 * (b["c"] - u)) / (u - lo)
    return out


def roc(s: Out, length: float) -> Out:
    L = _to_len(length)
    out = _nulls(len(s))
    if not L:
        return out
    for i in range(L, len(s)):
        v, o = s[i], s[i - L]
        out[i] = None if v is None or o is None or o == 0 else (100 * (v - o)) / o
    return out


def bollinger(s: Out, length: float, mult: float, ma_type: str) -> dict:
    basis = ma(ma_type, s, length)
    sd = stdev(s, length)
    return {
        "basis": basis,
        "upper": _zip(basis, sd, lambda b, d: b + mult * d),
        "lower": _zip(basis, sd, lambda b, d: b - mult * d),
    }


def donchian(bars: list[dict], length: float) -> dict:
    upper = highest(src(bars, "high"), length)
    lower = lowest(src(bars, "low"), length)
    return {"upper": upper, "lower": lower, "basis": _zip(upper, lower, lambda u, lo: (u + lo) / 2)}


# ───────── 注册表 / registry ─────────
# 每种：输入（键 → (种类, 默认, 取值范围或选项)）、线、计算。与前端 registry.ts 的同名指标一致。
# Per kind: inputs (key -> (kind, default, range or options)), plots, compute. Mirrors registry.ts.
_LEN = lambda d, hi=2000: ("int", d, (1, hi))  # noqa: E731
_SRC = lambda d="close": ("src", d, SOURCES)  # noqa: E731
_OFF = ("int", 0, (-500, 500))


def _ma_def(typ: str, length: int) -> dict:
    return {
        "inputs": {"len": _LEN(length), "src": _SRC(), "offset": _OFF},
        "plots": ("ma",),
        "offset": True,
        "f": lambda bars, i: {"ma": ma(typ, src(bars, i["src"]), i["len"], src(bars, "volume"))},
    }


DEFS: dict[str, dict] = {
    "sma": _ma_def("sma", 20), "ema": _ma_def("ema", 20), "wma": _ma_def("wma", 20), "vwma": _ma_def("vwma", 20),
    "hma": _ma_def("hma", 9), "dema": _ma_def("dema", 9), "tema": _ma_def("tema", 9), "smma": _ma_def("rma", 7),
    "lsma": _ma_def("lsma", 25),
    "rsi": {"inputs": {"len": _LEN(14), "src": _SRC()}, "plots": ("rsi",),
            "f": lambda bars, i: {"rsi": rsi(src(bars, i["src"]), i["len"])}},
    "stoch": {"inputs": {"kLen": _LEN(14), "kSmooth": _LEN(1, 100), "dLen": _LEN(3, 100)}, "plots": ("k", "d"),
              "f": lambda bars, i: stoch(bars, i["kLen"], i["kSmooth"], i["dLen"])},
    "macd": {"inputs": {"fast": _LEN(12, 500), "slow": _LEN(26, 500), "src": _SRC(), "signal": _LEN(9, 200),
                        "oscMa": ("sel", "ema", ("ema", "sma")), "sigMa": ("sel", "ema", ("ema", "sma"))},
             "plots": ("hist", "macd", "signal"),
             "f": lambda bars, i: macd(src(bars, i["src"]), i["fast"], i["slow"], i["signal"], i["oscMa"], i["sigMa"])},
    "bb": {"inputs": {"len": _LEN(20), "maType": ("sel", "sma", MA_TYPES), "src": _SRC(),
                      "mult": ("float", 2, (0.001, 50)), "offset": _OFF},
           "plots": ("basis", "upper", "lower"), "offset": True,
           "f": lambda bars, i: bollinger(src(bars, i["src"]), i["len"], i["mult"], i["maType"])},
    "dc": {"inputs": {"len": _LEN(20), "offset": _OFF}, "plots": ("basis", "upper", "lower"), "offset": True,
           "f": lambda bars, i: donchian(bars, i["len"])},
    "atr": {"inputs": {"len": _LEN(14), "smoothing": ("sel", "rma", ("rma", "sma", "ema", "wma"))}, "plots": ("atr",),
            "f": lambda bars, i: {"atr": atr(bars, i["len"], i["smoothing"])}},
    "cci": {"inputs": {"len": _LEN(20), "src": _SRC("hlc3")}, "plots": ("cci",),
            "f": lambda bars, i: {"cci": cci(src(bars, i["src"]), i["len"])}},
    "willr": {"inputs": {"len": _LEN(14)}, "plots": ("r",), "f": lambda bars, i: {"r": willr(bars, i["len"])}},
    "mom": {"inputs": {"len": _LEN(10), "src": _SRC()}, "plots": ("mom",),
            "f": lambda bars, i: {"mom": change(src(bars, i["src"]), i["len"])}},
    "roc": {"inputs": {"len": _LEN(9), "src": _SRC()}, "plots": ("roc",),
            "f": lambda bars, i: {"roc": roc(src(bars, i["src"]), i["len"])}},
}


def plots_of(typ: str) -> tuple:
    d = DEFS.get(typ)
    return d["plots"] if d else ()


def clean(typ: Any, raw_inputs: Any, plot: Any) -> tuple[str, dict, str]:
    """校验指标类型、输入与线，缺的输入补默认值。不合格抛 SpecError。
    Validate kind, inputs and plot, filling defaults. Raises SpecError."""
    d = DEFS.get(typ) if isinstance(typ, str) else None
    if d is None:
        raise SpecError("这个指标不支持警报 / alerts are not available for this indicator")
    if plot not in d["plots"]:
        raise SpecError("指标线无效 / invalid indicator plot")
    raw = raw_inputs if isinstance(raw_inputs, dict) else {}
    out: dict[str, Any] = {}
    for key, (kind, default, rng) in d["inputs"].items():
        v = raw.get(key, default)
        if kind in ("src", "sel"):
            if v not in rng:
                raise SpecError(f"输入 {key} 无效 / invalid input {key}")
            out[key] = v
            continue
        if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
            raise SpecError(f"输入 {key} 无效 / invalid input {key}")
        lo, hi = rng
        if not lo <= v <= hi:
            raise SpecError(f"输入 {key} 超出范围 / input {key} out of range")
        out[key] = int(v) if kind == "int" else float(v)
    return typ, out, plot


def warmup(typ: str, inputs: dict) -> int:
    """算准最后一根至少要多少根 K 线（递推类按 5 倍长度收敛）。/ bars needed for a settled last value."""
    nums = [v for k, v in inputs.items() if isinstance(v, (int, float)) and not isinstance(v, bool) and k != "offset"]
    longest = int(max(nums)) if nums else 20
    return min(1500, longest * 5 + 50)


def series(typ: str, inputs: dict, plot: str, bars: list[dict]) -> Out:
    """整条线（已按 offset 平移，同前端 offsetInput：正数往右）。/ the whole plot, offset applied."""
    d = DEFS[typ]
    vals = d["f"](bars, inputs)[plot]
    k = int(inputs.get("offset", 0)) if d.get("offset") else 0
    if k == 0:
        return vals
    n = len(vals)
    return [vals[i - k] if 0 <= i - k < n else None for i in range(n)]
