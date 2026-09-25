"""全局报价缓存：EA 写入，前端读取。

单 worker（REDIS_URL 留空）时是进程内 dict，进程重启即空，靠 EA 的持续推送自愈；
配了 REDIS_URL 时放在 Redis 里，全体 worker 读的是同一份——EA 的推送只会打到
其中一个 worker，不共享的话别的 worker 上 /api/symbols 就是空的、图表没品种。
不落库：报价是可重新拉取的实时派生数据。这是全站统一的一份报价（不区分用户），
供仪表盘/报价表/图表等展示用途；下单确认页用的是按交易商账户区分的报价，见
connection_manager.py 的 _quotes。

Site-wide quote cache written by the EA, read by the frontend. In-process with
an empty REDIS_URL (cleared on restart, re-populated by the EA's push); in
Redis when configured, so every worker reads the same snapshot — the EA's push
lands on one worker only. Not persisted to the DB: quotes are re-fetchable
derived data. The order-confirmation page uses per-broker-account quotes
instead; see connection_manager.py's _quotes.
"""
import json
import time

from starlette.concurrency import run_in_threadpool

from app.services import shared_state

# ---- 进程内 / in-process ----
# symbol -> {"symbol","bid","ask","digits"}
_quotes: dict[str, dict] = {}
# symbol -> 最近一次被 EA 写入的 epoch 秒 / epoch seconds of the last EA write
_updated_at: dict[str, float] = {}

# ---- Redis 键 / keys ----
# hash：品种 -> 报价 JSON；hash：品种 -> 更新时刻；list：品种首次出现的顺序（对齐 EA
# 的 InpSymbols 顺序，见 get_active_symbols）。
_KEY_QUOTES = "quotes"
_KEY_TS = "quotes:ts"
_KEY_ORDER = "quotes:order"


def _changed(old: dict | None, q: dict) -> bool:
    # closed 翻转(休市↔恢复)也算变化,即使兜底价格本身没变——否则前端要等到
    # 下一次真正的价格变动才会看到"休市"标签更新。
    # A closed-state flip counts as a change too, even if the fallback price is
    # unchanged — otherwise the "closed" label would lag until the next real move.
    return (
        old is None
        or old.get("bid") != q.get("bid")
        or old.get("ask") != q.get("ask")
        or old.get("closed") != q.get("closed")
    )


def update(quotes: list[dict]) -> list[dict]:
    """合并一批报价，仅返回相对上次发生变化的条目。**配了 Redis 时是阻塞调用**，
    协程里用 update_async。
    Merge a batch of quotes; return only entries changed since last time.
    Blocking with Redis on; coroutines use update_async."""
    changed: list[dict] = []
    now = time.time()
    if shared_state.enabled():
        return _update_redis(quotes, now)
    for q in quotes or []:
        sym = q.get("symbol")
        if not sym:
            continue
        if _changed(_quotes.get(sym), q):
            _quotes[sym] = q
            changed.append(q)
        _updated_at[sym] = now
    return changed


def _update_redis(quotes: list[dict], now: float) -> list[dict]:
    """Redis 侧的合并：一次 HGETALL 取全部旧值、本地比对，再用一个 pipeline 批量写。

    以前是每个品种 hget + hset + hset 三次往返（首次出现再加一次 rpush），EA 一批
    报 7 个品种就是 21 次往返，而这段是在 async 接口里直接跑的——Redis 稍慢一点，
    整个事件循环就陪着等。现在固定两次往返，与品种数无关。
    Redis merge: one HGETALL for every old value, compare locally, then write in a
    single pipeline. It used to be hget + hset + hset per symbol (plus an rpush on
    first sight) — 21 round-trips for a 7-symbol batch, run straight on the event
    loop. Now it is two round-trips regardless of the batch size.

    「首次出现顺序」表：两个 worker 恰好同时第一次见到同一个品种时会各 rpush 一次，
    表里就出现重复。这里不为这个罕见窗口加锁或上 Lua，而是读的一侧（_all_redis）
    按首次出现去重——顺序语义不变，重复项无害。
    The first-seen order list: two workers seeing a brand-new symbol at the same
    instant would each rpush it. Rather than a lock or Lua for that rare window, the
    reader (_all_redis) de-duplicates by first occurrence — same ordering semantics,
    and a duplicate entry is harmless.
    """
    r = shared_state._redis()
    kq, kt, ko = shared_state._k(_KEY_QUOTES), shared_state._k(_KEY_TS), shared_state._k(_KEY_ORDER)
    stored = r.hgetall(kq)
    changed: list[dict] = []
    new_syms: list[str] = []
    changed_map: dict[str, str] = {}
    ts_map: dict[str, str] = {}
    for q in quotes or []:
        sym = q.get("symbol")
        if not sym:
            continue
        raw = stored.get(sym)
        try:
            old = json.loads(raw) if raw else None
        except (ValueError, TypeError):
            old = None
        # 同一批里同一个品种出现两次：第二次要跟第一次比，而不是跟 Redis 里的旧值比。
        # A symbol repeated within one batch compares against its first occurrence.
        if sym in changed_map:
            old = json.loads(changed_map[sym])
        elif raw is None and sym not in new_syms:
            new_syms.append(sym)
        if _changed(old, q):
            changed_map[sym] = json.dumps(q, default=str)
            changed.append(q)
        ts_map[sym] = str(now)
    if not ts_map:
        return changed
    pipe = r.pipeline()
    if new_syms:
        pipe.rpush(ko, *new_syms)
    if changed_map:
        pipe.hset(kq, mapping=changed_map)
    pipe.hset(kt, mapping=ts_map)
    pipe.execute()
    return changed


async def update_async(quotes: list[dict]) -> list[dict]:
    """同 update，协程里用：配了 Redis 时挪到线程池（进程内 dict 直接跑，不白跳线程）。
    Same as update, for coroutines: offloaded with Redis on, inline otherwise."""
    if not shared_state.enabled():
        return update(quotes)
    return await run_in_threadpool(update, quotes)


def _all_redis() -> tuple[list[str], dict[str, dict], dict[str, float]]:
    r = shared_state._redis()
    # 三条读合成一次往返 / three reads in one round-trip
    pipe = r.pipeline()
    pipe.lrange(shared_state._k(_KEY_ORDER), 0, -1)
    pipe.hgetall(shared_state._k(_KEY_QUOTES))
    pipe.hgetall(shared_state._k(_KEY_TS))
    order_raw, raw, ts = pipe.execute()
    quotes: dict[str, dict] = {}
    for sym, v in (raw or {}).items():
        try:
            quotes[sym] = json.loads(v)
        except (ValueError, TypeError):
            continue
    updated: dict[str, float] = {}
    for sym, v in (ts or {}).items():
        try:
            updated[sym] = float(v)
        except (ValueError, TypeError):
            continue
    # 按首次出现去重（并发首次写入可能留下重复项，见 _update_redis）。
    # De-duplicate by first occurrence (a concurrent first write may leave one; see _update_redis).
    order = list(dict.fromkeys(order_raw or []))
    # 顺序表里没有的（理论上不会有）补到末尾 / anything missing from the order list goes last
    seen = set(order)
    order += [s for s in quotes if s not in seen]
    return order, quotes, updated


def get_all() -> list[dict]:
    """全站报价快照。**配了 Redis 时是阻塞调用**，协程里用 get_all_async。
    Site-wide snapshot. Blocking with Redis on; coroutines use get_all_async."""
    if shared_state.enabled():
        order, quotes, _ = _all_redis()
        return [quotes[s] for s in order if s in quotes]
    return list(_quotes.values())


async def get_all_async() -> list[dict]:
    """同 get_all，协程里用 / same as get_all, for coroutines."""
    if not shared_state.enabled():
        return get_all()
    return await run_in_threadpool(get_all)


def get_digits(symbol: str) -> int | None:
    """该品种最近一次上报的价格小数位数（EA `FeedQuote.digits`），从未收到过
    这个品种的报价则返回 None。
    Most recently reported decimal-digit count for this symbol; None if never seen."""
    if shared_state.enabled():
        raw = shared_state._redis().hget(shared_state._k(_KEY_QUOTES), symbol)
        return json.loads(raw).get("digits") if raw else None
    q = _quotes.get(symbol)
    return q.get("digits") if q else None


# 品种"当前活跃"的判定窗口（秒）：EA 报价推送间隔默认 2 秒，30 秒足够容忍
# 几次推送丢失/延迟，又能在 EA 端 InpSymbols 增删品种后的半分钟内跟上——
# 不需要 EA 显式上报"我现在配置了哪些品种"，谁在推谁就是活跃品种，谁停推
# 谁就在这个窗口后自然掉出列表。/ Freshness window (seconds) for "currently
# active": the EA's default quote-push interval is 2s, so 30s comfortably
# tolerates a few missed/delayed pushes while still catching an InpSymbols
# add/remove on the EA side within half a minute.
ACTIVE_WINDOW_SECONDS = 30


def get_active_symbols() -> list[str]:
    """当前仍在被 EA 推送的品种（近 ACTIVE_WINDOW_SECONDS 秒内有报价更新），
    顺序对齐 EA 的 InpSymbols 输入顺序，而不是按字母排序。
    进程内靠 dict 的插入顺序（某品种第一次被写入的位置 = 它在 InpSymbols 里的
    位置，之后重新赋值不改顺序）；Redis 侧 hash 不保序，所以另记一张"首次出现
    顺序"的 list。
    Symbols the EA is currently pushing, in InpSymbols order rather than
    alphabetical: dict insertion order in-process, an explicit first-seen list
    in Redis (hashes don't preserve order).
    """
    cutoff = time.time() - ACTIVE_WINDOW_SECONDS
    if shared_state.enabled():
        order, _quotes_r, updated = _all_redis()
        return [sym for sym in order if updated.get(sym, 0) >= cutoff]
    return [sym for sym in _quotes if _updated_at.get(sym, 0) >= cutoff]


async def get_active_symbols_async() -> list[str]:
    """同 get_active_symbols，协程里用（配了 Redis 时挪到线程池）。
    Same as get_active_symbols, for coroutines (offloaded with Redis on)."""
    if not shared_state.enabled():
        return get_active_symbols()
    return await run_in_threadpool(get_active_symbols)
