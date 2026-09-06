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
    """合并一批报价，仅返回相对上次发生变化的条目。
    Merge a batch of quotes; return only entries changed since last time."""
    changed: list[dict] = []
    now = time.time()
    if shared_state.enabled():
        r = shared_state._redis()
        kq, kt, ko = shared_state._k(_KEY_QUOTES), shared_state._k(_KEY_TS), shared_state._k(_KEY_ORDER)
        for q in quotes or []:
            sym = q.get("symbol")
            if not sym:
                continue
            raw = r.hget(kq, sym)
            old = json.loads(raw) if raw else None
            if old is None:
                r.rpush(ko, sym)
            if _changed(old, q):
                r.hset(kq, sym, json.dumps(q, default=str))
                changed.append(q)
            r.hset(kt, sym, str(now))
        return changed
    for q in quotes or []:
        sym = q.get("symbol")
        if not sym:
            continue
        if _changed(_quotes.get(sym), q):
            _quotes[sym] = q
            changed.append(q)
        _updated_at[sym] = now
    return changed


def _all_redis() -> tuple[list[str], dict[str, dict], dict[str, float]]:
    r = shared_state._redis()
    order = list(r.lrange(shared_state._k(_KEY_ORDER), 0, -1))
    raw = r.hgetall(shared_state._k(_KEY_QUOTES))
    ts = r.hgetall(shared_state._k(_KEY_TS))
    quotes = {sym: json.loads(v) for sym, v in raw.items()}
    updated = {sym: float(v) for sym, v in ts.items()}
    # 顺序表里没有的（理论上不会有）补到末尾 / anything missing from the order list goes last
    seen = set(order)
    order += [s for s in quotes if s not in seen]
    return order, quotes, updated


def get_all() -> list[dict]:
    if shared_state.enabled():
        order, quotes, _ = _all_redis()
        return [quotes[s] for s in order if s in quotes]
    return list(_quotes.values())


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
