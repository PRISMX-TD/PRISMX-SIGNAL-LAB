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

from starlette.concurrency import run_in_threadpool

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
        _merge_bars_redis(symbol, interval, bars)
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


def _merge_bars_redis(symbol: str, interval: str, bars: list[dict]) -> None:
    """Redis 侧的 tick 合并：一次读尾部、本地算好、一个 pipeline 写回。

    以前是 llen 一次，再**每根 bar** 一次 lindex + 一次 lset/rpush，最后 ltrim、set
    各一次——而且是在 async 接口里同步跑的。现在固定两次往返：先 LINDEX -1 拿到
    尾部那根（它为空就等价于 llen == 0，没有基线，丢弃这次 tick），然后在本地按
    原来的逐根规则推演「尾部时间戳」，把要做的 lset/rpush 连同 ltrim、时间戳写入
    一次性发出去。
    Tick merge on Redis: read the tail once, work out the edits locally, write them
    back in one pipeline. It used to be an llen, then an lindex plus an lset/rpush
    per bar, then ltrim and set — synchronously inside an async endpoint. Now it is
    two round-trips: LINDEX -1 fetches the tail (None is the same as llen == 0: no
    baseline, drop the tick), the per-bar rule is replayed locally against a
    running "tail timestamp", and the resulting lset/rpush plus ltrim and the
    timestamp go out together.

    读与写之间没有加锁：同一 (品种, 周期) 的写入来自 EA 的同步 WebRequest，一次
    发完才发下一次，跨 worker 并发写同一条序列的窗口实际上不存在；进程内还有
    routers/chart.py 的 per-key 锁。
    No lock between the read and the write: writes to one (symbol, interval) come
    from the EA's synchronous WebRequest, one after another, so two workers merging
    the same series concurrently does not happen in practice; within a process the
    per-key lock in routers/chart.py also applies.
    """
    r = shared_state._redis()
    k = _key(symbol, interval)
    last_raw = r.lindex(k, -1)
    if last_raw is None:
        return
    try:
        last_t = json.loads(last_raw)["t"]
    except (ValueError, TypeError, KeyError):
        last_t = None
    pipe = r.pipeline()
    for b in bars:
        body = json.dumps(b, default=str)
        if last_t is not None and b["t"] == last_t:
            pipe.lset(k, -1, body)
        elif last_t is None or b["t"] > last_t:
            pipe.rpush(k, body)
            last_t = b["t"]
        # 落在中间的旧 bar：进程内实现按时间戳定位覆盖；Redis 侧只覆盖尾部那根，
        # 更早的一律忽略（tick 只会带最近两根，这条分支实际不会走到）。
        # An older bar landing mid-series: the in-memory path overwrites by
        # timestamp; here only the tail is patched (ticks carry the last two
        # bars, so this branch is theoretical).
    pipe.ltrim(k, -MAX_BARS, -1)
    pipe.set(_ts_key(symbol, interval), str(time.time()))
    pipe.execute()


def get_latest(symbol: str, interval: str, n: int = 2) -> dict:
    """最近 n 根 + 最后写入时刻。**配了 Redis 时是阻塞调用**，协程里用 get_latest_async。
    The latest n bars and last-write time. Blocking with Redis on; see get_latest_async."""
    if shared_state.enabled():
        r = shared_state._redis()
        pipe = r.pipeline()
        pipe.lrange(_key(symbol, interval), -n, -1)
        pipe.get(_ts_key(symbol, interval))
        raw, ts = pipe.execute()
        return {"bars": [json.loads(x) for x in raw or []], "updatedAt": float(ts) if ts else None}
    key = (symbol, interval)
    return {"bars": _candles.get(key, [])[-n:], "updatedAt": _updated_at.get(key)}


# ---- 协程入口 / coroutine entry points ----
# 配了 Redis 时上面三个函数都是同步网络往返（客户端 socket_timeout=2 秒），在 async
# 接口里直接调，Redis 一抖就把整个事件循环冻住。这里配了 Redis 才挪进线程池；
# 进程内 dict 的路径是纯内存操作，照旧在事件循环上直接跑（不白跳线程，也不给
# merge_bars 的「先建索引再按索引写」平添撕裂的机会）。
# With Redis on, the three functions above are blocking round-trips (2s socket
# timeout); called from an async endpoint a Redis wobble freezes the whole loop.
# Only then are they moved to the thread pool; the in-process dict path is pure
# memory work and stays on the loop (no pointless hop, and no tearing risk for
# merge_bars' index-then-write).

async def replace_series_async(symbol: str, interval: str, bars: list[dict]) -> None:
    if not shared_state.enabled():
        replace_series(symbol, interval, bars)
        return
    await run_in_threadpool(replace_series, symbol, interval, bars)


async def merge_bars_async(symbol: str, interval: str, bars: list[dict]) -> None:
    if not shared_state.enabled():
        merge_bars(symbol, interval, bars)
        return
    await run_in_threadpool(merge_bars, symbol, interval, bars)


async def get_latest_async(symbol: str, interval: str, n: int = 2) -> dict:
    if not shared_state.enabled():
        return get_latest(symbol, interval, n)
    return await run_in_threadpool(get_latest, symbol, interval, n)
