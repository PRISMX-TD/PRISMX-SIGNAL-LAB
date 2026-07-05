"""图表 K 线内存缓存：喂价器写入，前端读取。

进程重启即空，靠喂价器每 60 秒的 backfill 自愈（见 CHART_SELFHOST_PLAN.md）。
不落库：K 线是可重新拉取的派生数据，没有持久化的必要。
In-memory candle cache: written by the feeder, read by the frontend. Cleared
on restart; the feeder's periodic backfill re-populates it. Not persisted —
candles are re-fetchable derived data, no need to durably store them.
"""
import time

MAX_BARS = 500

# (symbol, interval) -> K 线列表，按时间升序，每根 {"t","o","h","l","c"}
# (symbol, interval) -> candle list, ascending by time, each {"t","o","h","l","c"}
_candles: dict[tuple[str, str], list[dict]] = {}

# (symbol, interval) -> 最近一次被喂价器写入的 epoch 秒
# (symbol, interval) -> epoch seconds of the last feeder write
_updated_at: dict[tuple[str, str], float] = {}


def replace_series(symbol: str, interval: str, bars: list[dict]) -> None:
    """backfill：整段替换（截断到 MAX_BARS 根）/ full replace, truncated to MAX_BARS."""
    key = (symbol, interval)
    _candles[key] = bars[-MAX_BARS:]
    _updated_at[key] = time.time()


def merge_bars(symbol: str, interval: str, bars: list[dict]) -> None:
    """tick：合并最新几根——相同时间戳覆盖（形成中的 bar），新时间戳追加。
    tick: merge the latest few bars — same timestamp overwrites (bar still
    forming), newer timestamp appends.

    后端刚重启、该组合还没被 backfill 过时，series 为 None：直接丢弃这次 tick，
    等下一次 backfill 建立基线，避免在空列表上拼出不连续的碎片序列。
    If this combo hasn't been backfilled yet after a restart, series is None:
    drop this tick and wait for the next backfill to establish a baseline,
    rather than building a disjointed fragment on an empty list.
    """
    key = (symbol, interval)
    series = _candles.get(key)
    if series is None:
        return
    index = {b["t"]: i for i, b in enumerate(series)}
    for b in bars:
        if b["t"] in index:
            series[index[b["t"]]] = b
        elif not series or b["t"] > series[-1]["t"]:
            series.append(b)
    if len(series) > MAX_BARS:
        del series[: len(series) - MAX_BARS]
    _updated_at[key] = time.time()


def get_history(symbol: str, interval: str, limit: int) -> list[dict]:
    return _candles.get((symbol, interval), [])[-limit:]


def get_latest(symbol: str, interval: str, n: int = 2) -> dict:
    key = (symbol, interval)
    return {"bars": _candles.get(key, [])[-n:], "updatedAt": _updated_at.get(key)}
