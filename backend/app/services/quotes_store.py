"""全局报价内存缓存：EA 写入，前端读取。

进程重启即空，靠 EA 的持续推送自愈——与 chart_store.py 是同一套设计取舍。
不落库：报价是可重新拉取的实时派生数据，没有持久化的必要。这是全站统一的
一份报价（不区分用户），供仪表盘/报价表/图表等展示用途；下单确认页用的是
按交易商账户区分的报价，见 connection_manager.py 的 _quotes。

In-memory global quote cache: written by the EA, read by the frontend.
Cleared on restart; the EA's continuous push re-populates it — same design
tradeoff as chart_store.py. Not persisted — quotes are re-fetchable derived
data. This is one site-wide snapshot (not per-user), used for display
surfaces (dashboard/quotes table/charts). The order-confirmation page uses
per-broker-account quotes instead; see connection_manager.py's _quotes.
"""
import time

# symbol -> {"symbol","bid","ask","digits"}
_quotes: dict[str, dict] = {}

# symbol -> 最近一次被 EA 写入的 epoch 秒 / epoch seconds of the last EA write
_updated_at: dict[str, float] = {}


def update(quotes: list[dict]) -> list[dict]:
    """合并一批报价，仅返回相对上次发生变化的条目。
    Merge a batch of quotes; return only entries changed since last time."""
    changed: list[dict] = []
    now = time.time()
    for q in quotes or []:
        sym = q.get("symbol")
        if not sym:
            continue
        old = _quotes.get(sym)
        if old is None or old.get("bid") != q.get("bid") or old.get("ask") != q.get("ask"):
            _quotes[sym] = q
            changed.append(q)
        _updated_at[sym] = now
    return changed


def get_all() -> list[dict]:
    return list(_quotes.values())


# 品种"当前活跃"的判定窗口（秒）：EA 报价推送间隔默认 2 秒，30 秒足够容忍
# 几次推送丢失/延迟，又能在 EA 端 InpSymbols 增删品种后的半分钟内跟上——
# 不需要 EA 显式上报"我现在配置了哪些品种"，谁在推谁就是活跃品种，谁停推
# 谁就在这个窗口后自然掉出列表。/ Freshness window (seconds) for "currently
# active": the EA's default quote-push interval is 2s, so 30s comfortably
# tolerates a few missed/delayed pushes while still catching an InpSymbols
# add/remove on the EA side within half a minute — no need for the EA to
# explicitly report its configured symbol list; whoever is actively pushing
# is active, and a symbol that stops falls out after this window.
ACTIVE_WINDOW_SECONDS = 30


def get_active_symbols() -> list[str]:
    """当前仍在被 EA 推送的品种（近 ACTIVE_WINDOW_SECONDS 秒内有报价更新）。
    Symbols the EA is currently pushing (had a quote update within the last
    ACTIVE_WINDOW_SECONDS seconds)."""
    cutoff = time.time() - ACTIVE_WINDOW_SECONDS
    return sorted(sym for sym, ts in _updated_at.items() if ts >= cutoff)
