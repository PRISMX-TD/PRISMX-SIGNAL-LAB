"""网关主循环：串起连接、取数、聚合、上报。
Gateway main loop: connection, retrieval, aggregation and pushing.

单线程按时间片轮转，不用多线程：Manager API 是原生 DLL，跨线程调用的安全性没有保证，
而各条链路的间隔都是秒级，单线程完全够用。

Single-threaded time-slicing rather than threads: Manager API is a native DLL with
no cross-thread guarantees, and every interval here is seconds-scale, so one thread
is plenty.
"""
from __future__ import annotations

import logging
import time

from manager_feed.aggregate import (
    CANDLE_INTERVALS,
    INTERVAL_SECONDS,
    TREND_INTERVALS,
    aggregate,
    drop_forming_bar,
)
from manager_feed.backend_client import BackendClient
from manager_feed.config import Config
from manager_feed.manager_client import ManagerClient
from manager_feed.trend import compute_trends

logger = logging.getLogger(__name__)

# 增量推送时带上最近这么多根，给后端的合并留重叠余量。
# Bars included in an incremental push, giving the backend overlap to merge on.
TICK_BARS = 3

# 趋势的取数跨度：最长周期是 H4，EMA30+3 根斜率需要 33 根，30 天 ≈ 180 根 H4，余量充足。
# Trend fetch span: the longest interval is H4 and EMA30 plus a 3-bar slope needs 33
# bars; 30 days is ~180 H4 bars, ample headroom.
TREND_SPAN_SECONDS = 30 * 24 * 3600

# 趋势重算间隔。
#
# 与推送间隔（cfg.trend_interval，5 秒）分开：取 30 天 M1 实测 2.35 秒，7 个品种约 16
# 秒，每 5 秒重算一遍跟不上。而趋势本身是慢变量——H4 的 EMA30 方向不会在一分钟内翻转，
# 每 5 秒重算得到的结果与几分钟前几乎总是相同。
#
# 所以按 3 分钟重算、结果缓存复用；推送仍按 cfg.trend_interval 进行，前端拿到的更新
# 频率不变。
#
# How often trends are recomputed.
#
# Separate from the push interval (cfg.trend_interval, 5s): a 30-day M1 fetch measures
# 2.35s, so seven symbols run about 16s and a 5-second recompute can't keep up. Trends
# are slow-moving anyway — an H4 EMA30 direction doesn't flip within a minute, and a
# 5-second recompute almost always reproduces the value from minutes earlier.
#
# Recomputed every 3 minutes with the result cached; pushing still follows
# cfg.trend_interval, so the frontend's update rate is unchanged.
TREND_RECOMPUTE_SECONDS = 180

# 单次 ChartRequest 的时间跨度上限（秒）。
#
# 实测 XAUUSD.s（服务器缓存预热后）：
#   7 天 6893 根 0.71s ｜ 30 天 2.96 万根 2.35s ｜ 90 天 8.76 万根 3.13s
#   200 天 19.3 万根 4.21s ｜ 400 天 38.8 万根 17.71s
# 返回的覆盖天数与请求一致，没有服务器端条数上限。
#
# 需要注意的是首次请求明显更慢：同样的 200 天请求，冷启动测得 81 秒，预热后只要 4.21
# 秒——服务器要先把历史从磁盘载入。所以启动后的第一轮回补会比稳态慢一个数量级，这是
# 正常现象，不是故障。
#
# 90 天作为上限：3.13 秒，且 90 天足够覆盖所有周期的展示需求（= 12.9 万根 M1 = 2.6 万
# 根 M5 = 2160 根 H1 = 540 根 H4 = 64 根 D1）。再往上收益很小而首次加载代价明显上升。
#
# Cap on a single ChartRequest's span, in seconds.
#
# Measured on XAUUSD.s with the server cache warm:
#   7d = 6,893 bars 0.71s | 30d = 29,642 2.35s | 90d = 87,594 3.13s
#   200d = 193,421 4.21s | 400d = 388,324 17.71s
# Coverage matches the request; there's no server-side row cap.
#
# Note that a first request is markedly slower: the same 200-day call measured 81s cold
# against 4.21s warm, as the server loads history from disk. The first backfill after a
# start is therefore an order of magnitude slower than steady state — expected, not a
# fault.
#
# 90 days is the cap: 3.13s, and it covers the display needs of every interval
# (= 129k M1 = 26k M5 = 2,160 H1 = 540 H4 = 64 D1). Beyond that the gain is small while
# the cold-load cost climbs sharply.
MAX_FETCH_SPAN_SECONDS = 90 * 24 * 3600

# 增量推送只需要覆盖"最新几根"，取 6 小时足够算到 H4 的当前根，代价约 0.1 秒。
# An incremental push only needs the newest bars; 6 hours reaches the current H4 bar
# and costs about 0.1s.
TICK_SPAN_SECONDS = 6 * 3600

# 各周期的回补跨度与刷新间隔。
#
# 分级的理由是"没必要"，不是"太慢"：已收盘的 K 线不会再变。一根 D1 收盘后就固定了，
# 每分钟重拉 8.8 万根 M1 去重算同一批历史，除了徒增服务器负担没有任何收益。所以周期
# 越长、跨度越大但刷新越稀。
#
# 各档跨度都在实测的舒适区内（90 天 3.13 秒是最重的一档），选择依据是每个周期需要多少
# 根来支撑前端展示，而不是性能上限。
#
# Backfill span and refresh interval per interval.
#
# The tiering exists because it's unnecessary work, not because wide spans are slow: a
# closed bar never changes. Once a D1 bar closes it's fixed, so re-fetching 87k M1 bars
# every minute to recompute the same history buys nothing but server load. Longer
# intervals therefore get wider spans and rarer refreshes.
#
# Every tier sits inside the measured comfort zone (90 days at 3.13s is the heaviest),
# chosen by how many bars each interval needs for the frontend rather than by any
# performance ceiling.
BACKFILL_SPANS: dict[str, tuple[int, int]] = {
    # interval: (跨度秒数 / span, 刷新间隔秒数 / refresh interval)
    "M1": (2 * 3600, 60),                 # 2 小时 ≈ 120 根 / ~120 bars
    "M5": (12 * 3600, 60),                # 12 小时 ≈ 144 根 / ~144 bars
    "M15": (2 * 24 * 3600, 300),          # 2 天 ≈ 192 根 / ~192 bars
    "H1": (7 * 24 * 3600, 900),           # 7 天 ≈ 168 根 / ~168 bars
    "H4": (30 * 24 * 3600, 3600),         # 30 天 ≈ 180 根 / ~180 bars
    "D1": (90 * 24 * 3600, 6 * 3600),     # 90 天 ≈ 64 根 / ~64 bars
}


class Gateway:
    def __init__(self, cfg: Config):
        self.cfg = cfg
        self.manager = ManagerClient(cfg.server, cfg.login, cfg.password)
        self.backend = BackendClient(cfg.backend_url, cfg.ea_token, cfg.dry_run)

        self._next_quote = 0.0
        self._next_candle_tick = 0.0
        self._next_trend = 0.0
        # 各周期下次回补的时刻，初值 0 让启动后立刻补齐一轮完整历史
        # When each interval next backfills; 0 means a full history pass right at start
        self._next_backfill_at: dict[str, float] = {}
        self._next_trend_recompute = 0.0
        self._next_config_poll = 0.0
        self._reported_symbol_list = False
        # display -> {trends, high, low}，由 _recompute_trends 填充
        # display -> {trends, high, low}, filled by _recompute_trends
        self._trend_cache: dict[str, dict] = {}
        # 已成功推送过的趋势指纹，用于跳过无变化的推送
        # Fingerprints already pushed, to skip unchanged ones
        self._pushed_trend: dict[str, tuple] = {}
        self._subscribed: set[str] = set()
        # 每个品种最后一次 tick 变化的时刻，用于判断报价是否停滞（休市）
        # When each symbol's tick last changed, to judge a stale (closed) quote.
        self._last_tick_change: dict[str, float] = {}
        self._last_tick_value: dict[str, tuple[float, float]] = {}
        self._tz_sec = cfg.broker_gmt_offset * 3600

    # ---------- 生命周期 / lifecycle ----------

    def run_forever(self) -> None:
        logger.info(
            "网关启动：%d 个品种，dry_run=%s / gateway starting",
            len(self.cfg.enabled_symbols()), self.cfg.dry_run,
        )
        try:
            while True:
                self.tick()
                time.sleep(0.5)
        except KeyboardInterrupt:
            logger.info("收到中断，正在退出 / interrupted, shutting down")
        finally:
            self.manager.disconnect()

    def tick(self) -> None:
        """一次时间片：连接检查 + 到期的任务。
        One slice: check the link, then run whatever is due."""
        if not self.manager.connect():
            # 未连上就什么都不做。绝不推缓存价——报价链路没有停滞检测，
            # 推旧价会让前端显示一个僵死不动的价格。
            # Nothing happens while disconnected. Never push cached prices: the quote
            # path has no stall detection, so a stale price shows as a frozen quote.
            return

        if not self._reported_symbol_list:
            self._report_symbol_list()

        now = time.time()
        if now >= self._next_config_poll:
            self._next_config_poll = now + self.cfg.config_poll_interval
            self._poll_config()

        self._ensure_subscribed()

        if now >= self._next_quote:
            self._next_quote = now + self.cfg.quote_interval
            self._push_quotes()
        if now >= self._next_candle_tick:
            self._next_candle_tick = now + self.cfg.candle_tick_interval
            self._push_candles_tick()
        # 回补自己按周期分级排程，这里每轮都问一次，由它决定哪些到期
        # The backfill schedules itself per interval; asked every round, it decides
        self._push_candles_backfill()
        if now >= self._next_trend_recompute:
            self._next_trend_recompute = now + TREND_RECOMPUTE_SECONDS
            self._recompute_trends()
        if now >= self._next_trend:
            self._next_trend = now + self.cfg.trend_interval
            self._push_trends()

    def _ensure_subscribed(self) -> None:
        """把尚未订阅的品种加入订阅列表。重连后 _subscribed 会被清空并重订阅。
        Subscribe any symbols not yet subscribed; a reconnect clears and redoes this."""
        wanted = {s["broker"] for s in self.cfg.enabled_symbols()}
        missing = wanted - self._subscribed
        if not missing:
            return
        self.manager.subscribe(sorted(missing))
        self._subscribed |= missing
        for broker in sorted(missing):
            self.manager.digits(broker)  # 预热 digits 缓存 / warm the digits cache

    def on_reconnect(self) -> None:
        self._subscribed.clear()

    # ---------- 配置同步 / config sync ----------

    def _poll_config(self) -> None:
        """从后端拉品种配置，让后台改动无需重启网关即可生效。

        拉取失败时保留当前配置继续跑：后端重启、网络抖动、端点还没上线都不该让全站
        行情停掉。所以这里只在拿到有效列表时才替换。

        Pull the symbol config so admin changes take effect without a restart.

        On failure the current config keeps running: a backend restart, a network
        blip, or an endpoint that isn't deployed yet must not stop site-wide data.
        The list is replaced only when a valid one arrives.
        """
        remote = self.backend.fetch_symbols()
        if remote is None:
            return
        if not remote:
            logger.warning(
                "后端返回空品种列表，保留当前 %d 个品种"
                " / empty list from backend, keeping current %d symbol(s)",
                len(self.cfg.symbols), len(self.cfg.symbols),
            )
            return

        if remote == self.cfg.symbols:
            return

        old_brokers = {s["broker"] for s in self.cfg.enabled_symbols()}
        self.cfg.symbols = remote
        new_brokers = {s["broker"] for s in self.cfg.enabled_symbols()}
        # 只保留仍在列表里的订阅，被移除的品种下轮不再取数
        # Keep only still-listed subscriptions; removed symbols stop being fetched.
        self._subscribed &= new_brokers
        logger.info(
            "品种配置已更新：%d 个启用（新增 %d，移除 %d）"
            " / symbol config updated: %d enabled (+%d, -%d)",
            len(new_brokers), len(new_brokers - old_brokers), len(old_brokers - new_brokers),
            len(new_brokers), len(new_brokers - old_brokers), len(old_brokers - new_brokers),
        )

    def _report_symbol_list(self) -> None:
        """把券商全部可见品种上报一次，供后台下拉框使用。

        只在启动后成功上报一次：481 个条目几十 KB，而品种规格几乎不变，周期重传没有
        意义。失败则下个时间片重试。

        Report every visible broker symbol once, for the admin dropdown.

        Once per start: 481 entries run to tens of KB against specs that barely
        change, so resending periodically is pointless. A failure retries next slice.
        """
        symbols = self.manager.list_all_symbols()
        if not symbols:
            return
        if self.backend.report_broker_symbols(symbols):
            self._reported_symbol_list = True
            logger.info("已上报 %d 个券商品种 / reported %d broker symbols",
                        len(symbols), len(symbols))

    # ---------- 报价 / quotes ----------

    def _push_quotes(self) -> None:
        """报价快照。取不到的品种直接缺席，不用旧值占位。
        Quote snapshot; unavailable symbols are simply absent, never backfilled."""
        now = time.time()
        payload = []
        for item in self.cfg.enabled_symbols():
            broker, display = item["broker"], item["display"]
            t = self.manager.tick(broker)
            if t is None:
                continue

            # 报价是否停滞：EA 用 InpStaleQuoteSec=300 判休市，这里沿用同一语义，
            # 让前端"已休市"的显示逻辑在切换前后一致。
            # Stale quote: the EA judges closure with InpStaleQuoteSec=300; the same
            # semantics keep the frontend's "closed" display consistent across the switch.
            pair = (t["bid"], t["ask"])
            if self._last_tick_value.get(broker) != pair:
                self._last_tick_value[broker] = pair
                self._last_tick_change[broker] = now
            changed_at = self._last_tick_change.get(broker, now)
            closed = (now - changed_at) >= self.cfg.stale_quote_seconds

            payload.append({
                "symbol": display,
                "bid": t["bid"],
                "ask": t["ask"],
                "digits": self.manager.digits(broker),
                "closed": closed,
            })

        if payload:
            self.backend.push_quotes(payload)

    # ---------- K 线 / candles ----------

    def _fetch_m1_span(self, broker: str, span_seconds: int) -> list[dict] | None:
        """取最近 span_seconds 秒内的 M1，跨度受 MAX_FETCH_SPAN_SECONDS 限制。
        Fetch M1 for the last span_seconds, capped by MAX_FETCH_SPAN_SECONDS."""
        span = min(span_seconds, MAX_FETCH_SPAN_SECONDS)
        now = int(time.time())
        return self.manager.m1_bars(broker, now - span, now)

    def _push_candles_tick(self) -> None:
        """增量推送：一次取 6 小时 M1，聚合出所有周期的最新几根。

        长周期在这里也只推最新几根（H4 的当前根、D1 的当前根都在这 6 小时内），历史部分
        交给分级回补。这样每轮只有 7 次请求、每次约 0.1 秒。

        Incremental push: one 6-hour M1 fetch yields the newest bars of every interval.

        Long intervals get only their newest bars here (the current H4 and D1 bars both
        fall inside those 6 hours); history is left to the tiered backfill. That keeps a
        round at 7 requests of roughly 0.1s each.
        """
        now = int(time.time())
        series = []
        for item in self.cfg.enabled_symbols():
            broker, display = item["broker"], item["display"]
            m1 = self._fetch_m1_span(broker, TICK_SPAN_SECONDS)
            if m1 is None:
                continue  # 请求失败，已在客户端记日志 / failed, logged by the client
            if not m1:
                # 这段确实没有数据（休市/无成交）。这是正常情形，不是错误，更不该用
                # 上一根填充——历史上的垃圾 K 线正是这么来的。
                # The range genuinely holds no data (closed/untraded): normal, not an
                # error, and never a reason to fill from the previous bar — that's
                # exactly how the junk candles arose.
                continue

            for interval in CANDLE_INTERVALS:
                bars = drop_forming_bar(aggregate(m1, interval, self._tz_sec), interval, now, self._tz_sec)
                if not bars:
                    continue
                series.append({
                    "symbol": display,
                    "interval": interval,
                    "bars": bars[-TICK_BARS:],
                })

        if series:
            self.backend.push_candles("tick", series)

    def _push_candles_backfill(self) -> None:
        """分级回补：每个周期按自己的间隔刷新，只处理到期的那些。

        逐周期取数而不是一次取最长跨度：D1 需要 90 天，而 M1 只需要 2 小时，用同一个
        90 天窗口去算 M1 等于每次多传 4 万倍的数据。分级后单轮最重的一次是 H4 的 30 天
        （约 4.6 秒），且每小时才发生一次。

        Tiered backfill: each interval refreshes on its own schedule; only due ones run.

        Fetching per interval rather than once at the longest span: D1 needs 90 days
        while M1 needs 2 hours, and using one 90-day window for M1 would move 40,000x
        more data than necessary. Tiered, the heaviest single call is H4's 30 days
        (~4.6s) and it happens once an hour.
        """
        now = time.time()
        now_i = int(now)
        due = [i for i in CANDLE_INTERVALS if now >= self._next_backfill_at.get(i, 0.0)]
        if not due:
            return

        series = []
        for interval in due:
            span, refresh = BACKFILL_SPANS[interval]
            self._next_backfill_at[interval] = now + refresh
            for item in self.cfg.enabled_symbols():
                broker, display = item["broker"], item["display"]
                m1 = self._fetch_m1_span(broker, span)
                if not m1:
                    continue
                bars = drop_forming_bar(aggregate(m1, interval, self._tz_sec), interval, now_i, self._tz_sec)
                if not bars:
                    continue
                if len(bars) > self.cfg.max_backfill_bars:
                    bars = bars[-self.cfg.max_backfill_bars:]
                series.append({"symbol": display, "interval": interval, "bars": bars})

        if series:
            logger.debug("回补 %s / backfilling %s", ",".join(due), ",".join(due))
            self.backend.push_candles("backfill", series)

    # ---------- 趋势 / trends ----------

    def _recompute_trends(self) -> None:
        """重算所有品种的趋势并缓存。耗时操作，按 TREND_RECOMPUTE_SECONDS 调度。
        Recompute and cache every symbol's trends; expensive, so scheduled."""
        now = int(time.time())
        for item in self.cfg.enabled_symbols():
            broker, display = item["broker"], item["display"]

            # 每品种取一次，跨度够最长周期(H4)算 EMA30+斜率，同时覆盖 M1..H1。
            # One fetch per symbol, spanning enough H4 for EMA30 plus the slope while
            # also covering M1..H1.
            m1 = self._fetch_m1_span(broker, TREND_SPAN_SECONDS)
            if not m1:
                continue

            closes_by_interval: dict[str, list[float]] = {}
            m5_last_bar: dict | None = None
            for interval in TREND_INTERVALS:
                bars = drop_forming_bar(aggregate(m1, interval, self._tz_sec), interval, now, self._tz_sec)
                if not bars:
                    continue
                closes_by_interval[interval] = [b["c"] for b in bars]
                if interval == "M5":
                    m5_last_bar = bars[-1]

            trends = compute_trends(
                closes_by_interval,
                self.cfg.trend_fast_len,
                self.cfg.trend_slow_len,
                self.cfg.trend_slope_len,
            )
            if not trends:
                continue

            # high/low 只在拿到 M5 时才带：后端用它们判定未分胜负信号是否命中止盈/
            # 止损，宁可不传也不要传不可靠的值。EA 的指标挂在 5 分钟图上，这里取同一
            # 周期保持一致。
            # high/low only when M5 is available: the backend resolves pending signals
            # against TP/SL with them, so omitting beats sending something unreliable.
            # The EA's indicator sits on a 5-minute chart; matching that here.
            self._trend_cache[display] = {
                "trends": trends,
                "high": m5_last_bar["h"] if m5_last_bar else None,
                "low": m5_last_bar["l"] if m5_last_bar else None,
            }

    def _push_trends(self) -> None:
        """推送缓存里的趋势。方向没变就不推。

        后端每次收到都会 upsert 并广播 TREND_UPDATE，而趋势是慢变量，重复推送同一组
        方向只是徒增数据库写入和 WebSocket 广播。带上 high/low 的那次除外——它们每根
        M5 都在变，是后端判定信号胜负的输入。

        Push the cached trends, skipping unchanged directions.

        The backend upserts and broadcasts TREND_UPDATE on every receipt, and trends
        move slowly, so re-pushing identical directions only adds database writes and
        WebSocket traffic. Pushes carrying high/low are exempt: those change every M5
        bar and feed the backend's signal resolution.
        """
        for display, entry in self._trend_cache.items():
            trends = entry["trends"]
            high, low = entry["high"], entry["low"]
            fingerprint = (tuple(sorted(trends.items())), high, low)
            if self._pushed_trend.get(display) == fingerprint:
                continue
            if self.backend.push_trend(display, trends, high, low):
                self._pushed_trend[display] = fingerprint
