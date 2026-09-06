"""图表 K 线缓存：EA 写入，前端读取。

单 worker（REDIS_URL 留空）时是进程内 dict，进程重启即空，靠 EA 每 60 秒的
backfill 自愈；配了 REDIS_URL 时每个 (品种, 周期) 是一条 Redis list，全体 worker
共享——EA 的推送只打到一个 worker，不共享的话别的 worker 上 /chart/latest 永远
是空的。不落库：K 线是可重新拉取的派生数据（长期历史另有 candles 表）。

Candle cache written by the EA, read by the frontend. In-process with an empty
REDIS_URL (cleared on restart, re-populated by the EA's periodic backfill); a
Redis list per (symbol, interval) when configured so every worker sees the
series the EA pushed to one of them. Not persisted here — long-term history
lives in the candles table.
"""
import json
import time

from app.services import shared_state

MAX_BARS = 500

# (symbol, interval) -> K 线列表，按时间升序，每根 {"t","o","h","l","c","v"}
# （本模块只透传 dict，不关心具体字段，加字段无需改这里的合并/替换逻辑）
# (symbol, interval) -> candle list, ascending by time; this module passes dicts
# through and is agnostic to the fields.
_candles: dict[tuple[str, str], list[dict]] = {}
# (symbol, interval) -> 最近一次被 EA 写入的 epoch 秒 / epoch seconds of the last EA write
_updated_at: dict[tuple[str, str], float] = {}


def _key(symbol: str, interval: str) -> str:
    return shared_state._k(f"chart:{symbol}:{interval}")


def _ts_key(symbol: str, interval: str) -> str:
    return shared_state._k(f"chart:{symbol}:{interval}:ts")


def replace_series(symbol: str, interval: str, bars: list[dict]) -> None:
    """backfill：整段替换（截断到 MAX_BARS 根）/ full replace, truncated to MAX_BARS."""
    tail = bars[-MAX_BARS:]
    if shared_state.enabled():
        r = shared_state._redis()
        k = _key(symbol, interval)
        pipe = r.pipeline()
        pipe.delete(k)
        if tail:
            pipe.rpush(k, *[json.dumps(b, default=str) for b in tail])
        pipe.set(_ts_key(symbol, interval), str(time.time()))
        pipe.execute()
        return
    key = (symbol, interval)
    _candles[key] = list(tail)
    _updated_at[key] = time.time()


def merge_bars(symbol: str, interval: str, bars: list[dict]) -> None:
    """tick：合并最新几根——相同时间戳覆盖（形成中的 bar），新时间戳追加。

    后端刚重启、该组合还没被 backfill 过时 series 为空：直接丢弃这次 tick，等下一次
    backfill 建立基线，避免在空列表上拼出不连续的碎片序列。
    Merge the latest few bars: same timestamp overwrites (bar still forming), a
    newer one appends. With no baseline yet (no backfill since restart) the tick
    is dropped rather than building a disjointed fragment on an empty list.
    """
    if shared_state.enabled():
        r = shared_state._redis()
        k = _key(symbol, interval)
        if r.llen(k) == 0:
            return
        for b in bars:
            last_raw = r.lindex(k, -1)
            last_t = json.loads(last_raw)["t"] if last_raw else None
            body = json.dumps(b, default=str)
            if last_t is not None and b["t"] == last_t:
                r.lset(k, -1, body)
            elif last_t is None or b["t"] > last_t:
                r.rpush(k, body)
            else:
                # 落在中间的旧 bar：进程内实现按时间戳定位覆盖；Redis 侧只覆盖尾部那根，
                # 更早的一律忽略（tick 只会带最近两根，这条分支实际不会走到）。
                # An older bar landing mid-series: the in-memory path overwrites by
                # timestamp; here only the tail is patched (ticks carry the last two
                # bars, so this branch is theoretical).
                continue
        r.ltrim(k, -MAX_BARS, -1)
        r.set(_ts_key(symbol, interval), str(time.time()))
        return
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


def get_latest(symbol: str, interval: str, n: int = 2) -> dict:
    if shared_state.enabled():
        r = shared_state._redis()
        raw = r.lrange(_key(symbol, interval), -n, -1)
        ts = r.get(_ts_key(symbol, interval))
        return {"bars": [json.loads(x) for x in raw], "updatedAt": float(ts) if ts else None}
    key = (symbol, interval)
    return {"bars": _candles.get(key, [])[-n:], "updatedAt": _updated_at.get(key)}
