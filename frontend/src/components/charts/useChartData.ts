// 图表数据：切品种/周期时拉历史快照、往左翻页、轮询最新价、日内统计与延迟标记。
// 2026-09-06 从 pages/ChartsPage.tsx 搬出，内容逐行原样；所有 ref 来自 useChartEngine。
// Chart data: history snapshot on symbol/interval change, backward paging, the
// latest-price poll, day stats and the stale flag. Moved out of ChartsPage
// verbatim on 2026-09-06; every ref comes from useChartEngine.
import { useEffect, useState } from 'react'
import { chartApi } from '../../api/client'
import type { Candle } from '../../api/types'
import type { DayStats } from './SymbolHeader'
import {
  FOLLOW_LIVE_SLACK_BARS,
  HISTORY_FIRST_PAGE, HISTORY_PAGE_SIZE, HISTORY_PREFETCH_BARS, MAX_CLIENT_BARS, POLL_MS, POLL_SLOW_MS, STALE_MS, WS_FRESH_MS,
  BOUNDARY_RETRIES, BOUNDARY_RETRY_MS, nextBoundaryPollDelayMs, TAIL_REFILL_MIN_GAP_MS, barSpacingSeconds,
  computeDayStats, toLwPoint,
} from './chartConfig'
import type { ChartEngine } from './useChartEngine'
import { keepIfEqual } from '../../store/keepIfEqual'
import { netQuality } from '../../store/netQuality'
import { isAppHidden } from '../../utils/appVisibility'
import { startPolling } from '../../utils/usePollWhileVisible'

// digits：价格轴小数位，由 ChartsPage 按「券商报价 digits 优先、兜底表其次」解析好
// 后传入（以前这里自己查那张 7 条的写死表，表外品种的价格轴 minMove 被压成 0.01，
// 外汇 K 线画出来是阶梯）。
// digits: the price-scale precision, resolved by ChartsPage (broker-reported
// Quote.digits first, table fallback second). This used to be looked up here from
// a 7-entry table, which flattened FX candles into stairs.
// liveBidRef：当前品种的券商实时买价（由 ChartsPage 的叶子组件 LiveBarSync 写入）。
// K 线库与券商报价是两条链路，收盘价常差几个点；最新一根的 close 统一钉在券商 bid 上，
// 报价条大字、图表最新价标签、下单面板 SELL 价就是同一个数。
// liveBidRef: the broker's live bid for this symbol (written by LiveBarSync). The
// candle store and broker quotes are separate feeds; pinning the forming bar's
// close to the bid makes header, chart price label and ticket SELL one number.
export function withLiveClose(b: Candle, bid: number | null | undefined): Candle {
  if (bid == null || !(bid > 0)) return b
  return { ...b, c: bid, h: Math.max(b.h, bid), l: Math.min(b.l, bid) }
}

// 每个「品种|周期」最近一次看到的尾部 K 线（含形成中那根），进程内常驻。
// 再次打开图表 / 切回刚看过的品种时先用它秒出画面，历史与最新价并行回来后无缝替换，
// 不再出现「空白 → 旧 K 线 → 几秒后才补上最新一根」的卡顿。
// The last tail of bars (forming bar included) seen per "symbol|interval", kept in memory.
// Reopening the chart or returning to a recent symbol paints from it instantly; history and
// latest (fetched in parallel) then replace it seamlessly — no blank → stale → late-bar stutter.
const SNAPSHOT_BARS = HISTORY_FIRST_PAGE + 10
const SNAPSHOT_KEYS = 16
const snapshotCache = new Map<string, Candle[]>()
function saveSnapshot(key: string, bars: Candle[]) {
  if (bars.length === 0) return
  snapshotCache.delete(key)
  snapshotCache.set(key, bars.slice(-SNAPSHOT_BARS))
  while (snapshotCache.size > SNAPSHOT_KEYS) snapshotCache.delete(snapshotCache.keys().next().value as string)
}

export function useChartData(symbol: string, interval: string, digits: number, engine: ChartEngine, liveBidRef?: { current: number | null }, dataKeyRef?: { current: string }) {
  const {
    chartRef, seriesRef, candlesRef, lastTimeRef, barTimesRef,
    loadingOlderRef, hasMoreHistoryRef, isFollowingLiveRef, recomputeIndicators,
    drawReady,
  } = engine

  // 数据状态：加载中 / 有数据 / 空（该品种周期暂无数据）/延迟
  // data status: loading / has data / empty (no data for this symbol+interval) / stale
  const [hasData, setHasData] = useState(false)
  const [stale, setStale] = useState(false)

  // 最新收盘价：喂给画图层做重绘侦测，并作为无实时报价时的下单参考价
  // latest close: feeds the draw layer's repaint detection and the order modal's fallback price
  const [lastPrice, setLastPrice] = useState(0)
  // 品种行情头的日内高低 + 涨跌幅：从已加载的 K 线窗口现算（首根开盘为基准），
  // 不需要新后端。切品种时清空，历史/轮询到数据后更新。
  // Symbol-header day range + change%: computed from the loaded candle window
  // (first open as the reference), no new backend. Cleared on symbol change,
  // updated once history/poll data lands.
  const [dayStats, setDayStats] = useState<DayStats | null>(null)

  // 价格轴小数位单独一个 effect：不设的话库默认 2 位，外汇对（如 EURUSD）会把
  // 1.08543 截断成 1.09 这种不可用的精度。刻意**不**放进下面那个大 effect——
  // digits 会在首笔报价到达时从兜底值变成券商真值，混在一起会让整段历史被重拉。
  // Price-scale precision in its own effect: without it the library defaults to
  // 2 digits and truncates FX pairs to an unusable 1.09. Deliberately kept out of
  // the big effect below: digits flips from the fallback to the broker's real
  // value when the first quote lands, which would otherwise refetch all history.
  useEffect(() => {
    const series = seriesRef.current
    if (!series) return
    series.applyOptions({
      priceFormat: { type: 'price', precision: digits, minMove: Math.pow(10, -digits) },
    })
    // drawReady 进依赖：series 是在引擎建图那一拍才出现的，它翻 true 就是"图表
    // 已就绪"的信号。/ drawReady is a dependency because the series only exists
    // once the engine has built the chart.
  }, [digits, drawReady, seriesRef])

  // 切品种/周期：拉历史快照 + 起轮询最新价 / on symbol or interval change: fetch history + poll latest
  useEffect(() => {
    const series = seriesRef.current
    if (!series || !symbol) return // symbol 为空说明 activeSymbols 还没校正出有效值，等下一轮
                                    // empty symbol means activeSymbols hasn't resolved a valid value yet
    let alive = true
    if (dataKeyRef) dataKeyRef.current = ''
    setHasData(false)
    setStale(false)
    setLastPrice(0)
    setDayStats(null)
    lastTimeRef.current = 0
    barTimesRef.current = []
    candlesRef.current = []
    loadingOlderRef.current = false
    hasMoreHistoryRef.current = true
    isFollowingLiveRef.current = true

    // 把一根 bar 应用到图表：只在其时间 >= 已应用的最新时间时更新，避免
    // lightweight-charts 对更早时间抛错而中断实时刷新。
    // Apply one bar to the chart, but only when its time >= the newest applied
    // time — otherwise lightweight-charts throws on an older time and the live
    // refresh stalls.
    const applyBar = (b: Candle) => {
      if (b.t < lastTimeRef.current) return
      const point = toLwPoint(b)
      // series 还没被 setData 初始化过时（history 返回空，例如该周期数据库里
      // 尚无数据），update() 会静默失败，图表永远空着。用 setData 冷启动。
      // Before setData has initialised the series (empty history, e.g. the
      // database holds nothing for this interval yet), update() fails silently
      // and the chart stays blank forever. Cold-start it with setData.
      if (lastTimeRef.current === 0) series.setData([point])
      else series.update(point)
      lastTimeRef.current = b.t
    }

    // 把一根 bar 合并进 candlesRef：相同时间戳覆盖（形成中的 bar），新时间戳
    // 追加并按 MAX_CLIENT_BARS 截断；乱序到达的（比当前最后一根更早、且不等于
    // 它）按时间插回原位，而不是像以前那样直接丢掉——后端聚合延迟或切周期时
    // 残留的上一次响应都会造成乱序，丢掉会让指标窗口与真实行情错位。
    // 注意：图表 series 那边（applyBar）仍然只能追加，lightweight-charts 的
    // update() 对更早的时间会抛错；乱序 bar 只补进 candlesRef 供指标重算。
    // Merge one bar into candlesRef: same timestamp overwrites (bar still
    // forming), newer appends and trims to MAX_CLIENT_BARS, and an out-of-order
    // bar is now inserted at its time position instead of being dropped (backend
    // aggregation lag or a leftover response from the previous interval both
    // produce these, and dropping them skews the indicator windows). The chart
    // series itself (applyBar) still only appends — update() throws on older
    // times — so an out-of-order bar only reaches the indicator input.
    const mergeCandle = (b: Candle) => {
      const arr = candlesRef.current
      const lastT = arr.length ? arr[arr.length - 1].t : -Infinity
      if (b.t > lastT) {
        arr.push(b)
        if (arr.length > MAX_CLIENT_BARS) arr.shift()
        return
      }
      if (b.t === lastT) {
        arr[arr.length - 1] = b
        return
      }
      // 乱序：从尾部往前找落点（乱序一般只差一两根，线性回扫比二分更划算）。
      // Out of order: scan back from the tail (usually only a bar or two behind).
      for (let i = arr.length - 2; i >= 0; i--) {
        if (arr[i].t === b.t) { arr[i] = b; return }
        if (arr[i].t < b.t) { arr.splice(i + 1, 0, b); return }
      }
      arr.unshift(b)
    }

    const snapKey = `${symbol}|${interval}`
    // 历史库不含形成中那根，最新价若等轮询首拍（3–10 秒）才到，最右侧就会空等。
    // 这里与历史并行立即请求，历史一落地就接上。
    // History excludes the forming bar; waiting for the poll's first tick (3–10s) left the right
    // edge stale. Request latest in parallel right away and join it as soon as history lands.
    let historyApplied = false
    let pendingLatest: Awaited<ReturnType<typeof chartApi.latest>> | null = null

    // 秒开：有快照先画出来。/ Instant paint from the snapshot when we have one.
    const snap = snapshotCache.get(snapKey)
    if (snap && snap.length > 0) {
      series.setData(snap.map(toLwPoint))
      if (dataKeyRef) dataKeyRef.current = snapKey
      lastTimeRef.current = snap[snap.length - 1].t
      barTimesRef.current = snap.map((b) => b.t)
      candlesRef.current = snap.slice()
      setLastPrice(snap[snap.length - 1].c)
      recomputeIndicators()
      setDayStats(computeDayStats(candlesRef.current))
      chartRef.current?.timeScale().fitContent()
      setHasData(true)
    }

    chartApi.history(symbol, interval, HISTORY_FIRST_PAGE).then((r) => {
      if (!alive) return
      historyApplied = true
      if (r.bars.length > 0) {
        series.setData(r.bars.map(toLwPoint))
        if (dataKeyRef) dataKeyRef.current = `${symbol}|${interval}`
        lastTimeRef.current = r.bars[r.bars.length - 1].t
        setLastPrice(r.bars[r.bars.length - 1].c)
        barTimesRef.current = r.bars.map((b) => b.t)
        candlesRef.current = r.bars.slice(-MAX_CLIENT_BARS)
        hasMoreHistoryRef.current = r.hasMore
        recomputeIndicators()
        setDayStats(computeDayStats(candlesRef.current))
        // 快照已画过就不再 fitContent，免得视窗跳一下。/ Skip refit if the snapshot already framed it.
        if (!snap) chartRef.current?.timeScale().fitContent()
        setHasData(true)
        saveSnapshot(snapKey, candlesRef.current)
      } else {
        // 空历史：图上不再是旧品种的 K 线，标成本品种，让首跳报价之后的轮询冷启动。
        // Empty history: mark as this symbol so later data belongs to it.
        series.setData([])
        if (dataKeyRef) dataKeyRef.current = `${symbol}|${interval}`
        hasMoreHistoryRef.current = false
        setHasData(false)
      }
      if (pendingLatest) handleLatest(pendingLatest)
    }).catch(() => {
      if (!alive) return
      historyApplied = true
      if (!snap) setHasData(false)
      if (pendingLatest) handleLatest(pendingLatest)
    })

    // 往左拖到接近最早一根时，用 before 游标向数据库要更早的一页。
    // 必须 setData 整段重设而不是 update()：lightweight-charts 的 update() 只接受
    // 时间 >= 当前最后一根的点，往前插入历史会抛错。
    // 重设后要恢复原来的可视范围，否则图表会跳回默认位置，用户拖动的手感会断。
    // When the user scrolls near the earliest bar, ask the database for an older
    // page via the `before` cursor. This must use setData to replace the whole
    // series rather than update(): lightweight-charts' update() only accepts
    // times >= the last applied one and throws when prepending history.
    // The visible range is restored afterwards, otherwise the chart jumps back to
    // its default position and the scroll gesture feels broken.
    const loadOlder = () => {
      if (!alive || loadingOlderRef.current || !hasMoreHistoryRef.current) return
      const arr = candlesRef.current
      if (arr.length === 0) return
      loadingOlderRef.current = true
      const before = arr[0].t
      chartApi.history(symbol, interval, HISTORY_PAGE_SIZE, before).then((r) => {
        if (!alive) return
        hasMoreHistoryRef.current = r.hasMore
        if (r.bars.length === 0) return
        const range = chartRef.current?.timeScale().getVisibleLogicalRange()
        // 前置分页要保留**最早**的 MAX_CLIENT_BARS 根，不是最后那些。
        // 原来写的是 slice(-MAX)：缓存已经满 20000 根时，新取回来的一页会被整段
        // 切掉（merged 与原数组相同），可下面仍按 r.bars.length 平移视窗，图表就
        // 凭空右跳 500 根「自己弹回去」；而且 hasMore 还是 true，下一次拖动继续
        // 请求同一页，流量白烧。按实际插入量平移，才与真实结果一致。
        // Keep the *earliest* MAX_CLIENT_BARS when prepending, not the last ones:
        // slice(-MAX) dropped the entire freshly fetched page once the cache was
        // full, yet the viewport was still shifted by r.bars.length, so the chart
        // jumped 500 bars right ("it snapped back") and re-requested the same page
        // on every further drag. Shift by what was actually inserted.
        const merged = [...r.bars, ...candlesRef.current].slice(0, MAX_CLIENT_BARS)
        const inserted = merged.length - candlesRef.current.length
        candlesRef.current = merged
        barTimesRef.current = merged.map((b) => b.t)
        series.setData(merged.map(toLwPoint))
        recomputeIndicators()
        // 一根都没插进去 = 客户端缓存已满，再往左拉也放不下，停止预取。
        // Nothing fitted: the client cache is full, so stop prefetching.
        if (inserted <= 0) hasMoreHistoryRef.current = false
        // 往左插了 inserted 根，原来的逻辑下标整体右移同样的量。
        // Inserting `inserted` bars on the left shifts every logical index right.
        if (range && inserted > 0) {
          chartRef.current?.timeScale().setVisibleLogicalRange({
            from: range.from + inserted,
            to: range.to + inserted,
          })
        }
      }).catch(() => {
        // 失败不置 hasMore=false：网络抖动不代表没有更早数据，下次拖动会再试。
        // Don't clear hasMore on failure: a network blip doesn't mean there's no
        // older data, and the next scroll will retry.
      }).finally(() => {
        if (alive) loadingOlderRef.current = false
      })
    }

    const onRangeChange = (range: { from: number; to: number } | null) => {
      if (range && range.from < HISTORY_PREFETCH_BARS) loadOlder()
      // 跟踪用户是否还贴在最新那根上：range.to 是**逻辑下标**，所以要和"总根数"
      // 比，不是和时间戳比。这里原先写的是 `lastTimeRef.current - range.to < 300`
      // ——左边是 epoch 秒（约 1.7e9）、右边是几十到几百的下标，差值恒为天文数字，
      // 于是第一次可视范围变化之后 isFollowingLive 就被钉死在 false，
      // scrollToRealTime() 再也不会执行：图表不再自动跟随新 K 线。
      // Track whether the viewport still sits at the live edge. range.to is a
      // logical index, so it must be compared against the bar count — the old
      // code subtracted it from an epoch timestamp, which is never small, so
      // auto-follow silently switched itself off on the first range change.
      if (range && range.to != null) {
        const barCount = candlesRef.current.length
        isFollowingLiveRef.current =
          barCount === 0 || range.to >= barCount - FOLLOW_LIVE_SLACK_BARS
      }
    }
    chartRef.current?.timeScale().subscribeVisibleLogicalRangeChange(onRangeChange)

    // 尾部重拉：App 在后台被冻住（安卓 WebView 停 JS）几十分钟后回来，轮询只拿最新两根，
    // 而 applyBar 只能往后追加，中间缺的 bar 永远补不上，图上就是一段「跳空」（2026-10-08
    // 100502 截图）。发现缺口就重拉最近一页历史、整段 setData，再补拉最新价接上形成中那根。
    // Tail refill: after the app sat frozen in the background (Android WebView pauses JS) for tens
    // of minutes, the poll only fetches the newest two bars and applyBar can only append, so the
    // bars in between never arrive and the chart shows a fake gap (2026-10-08, login 100502). On a
    // hole, refetch the newest history page, setData the whole series, then fetch latest again to
    // join the forming bar.
    let refilling = false
    let lastRefillAt = -Infinity
    const refillTail = (): boolean => {
      if (refilling || Date.now() - lastRefillAt < TAIL_REFILL_MIN_GAP_MS) return false
      refilling = true
      lastRefillAt = Date.now()
      chartApi.history(symbol, interval, HISTORY_FIRST_PAGE).then((r) => {
        if (!alive || r.bars.length === 0) return
        const firstT = r.bars[0].t
        // 比这页更早的本地 bar 保留（用户可能往左翻过很多页）；这页之后的本地 bar 丢掉，
        // 由下面的 latest 补回。/ Keep local bars older than this page (the user may have paged
        // far left); drop newer local ones — the latest call below brings them back.
        const merged = [...candlesRef.current.filter((b) => b.t < firstT), ...r.bars].slice(-MAX_CLIENT_BARS)
        const range = chartRef.current?.timeScale().getVisibleLogicalRange()
        candlesRef.current = merged
        barTimesRef.current = merged.map((b) => b.t)
        lastTimeRef.current = merged[merged.length - 1].t
        series.setData(merged.map(toLwPoint))
        recomputeIndicators()
        setDayStats((prev) => keepIfEqual(prev, computeDayStats(candlesRef.current)))
        if (isFollowingLiveRef.current) chartRef.current?.timeScale().scrollToRealTime()
        else if (range) chartRef.current?.timeScale().setVisibleLogicalRange(range)
        saveSnapshot(snapKey, candlesRef.current)
        void chartApi.latest(symbol, interval, 10).then(handleLatest).catch(() => {})
      }).catch(() => {}).finally(() => {
        refilling = false
      })
      return true
    }

    const handleLatest = (r: Awaited<ReturnType<typeof chartApi.latest>>) => {
        if (!alive) return
        // 历史还没回来：先记下，历史 setData 之后再接上（否则会被整段覆盖掉）。
        // History not back yet: stash it and join after history's setData (which would wipe it).
        pendingLatest = r
        if (!historyApplied) return
        // 响应里最早那根与本地最后一根之间隔着整根以上的 bar：中间有洞，重拉尾部。
        // A whole bar or more between our last bar and the response's first: a hole — refill.
        const spacing = barSpacingSeconds(interval)
        if (spacing != null && lastTimeRef.current > 0 && r.bars.length > 0 && r.bars[0].t > lastTimeRef.current + spacing) {
          if (refillTail()) return
        }
        // 最新一根用券商 bid 做收盘价，免得每 2 秒被 K 线库的收盘价拽回去。
        // The newest bar takes the broker bid as close so the poll doesn't yank it back.
        // 本地已按报价开了新 bar 时，响应里的上一根别再被钉上当前 bid。
        // Once a tick has opened the next bar locally, don't stamp the current bid onto the previous one.
        const bars = r.bars.map((b, i) => (i === r.bars.length - 1 && b.t >= lastTimeRef.current ? withLiveClose(b, liveBidRef?.current) : b))
        for (const b of bars) applyBar(b)
        for (const b of bars) mergeCandle(b)
        // 追加新出现的 bar 时间，保持 barTimesRef 与图表同步 / keep bar times in sync
        for (const b of r.bars) {
          const arr = barTimesRef.current
          if (arr.length && b.t > arr[arr.length - 1]) arr.push(b.t)
        }
        if (r.bars.length > 0) {
          setHasData(true)
          setLastPrice(bars[bars.length - 1].c)
          recomputeIndicators()
          // 同值不换引用：每 2 秒一轮询，K 线没动时别让报价条与整页白白重渲染。
          // Keep the reference when unchanged, so a quiet 2s poll re-renders nothing.
          setDayStats((prev) => keepIfEqual(prev, computeDayStats(candlesRef.current)))
          // 自动跟踪最新 bar：仅在用户未手动离开实时位置时跟随滚动
          // Auto-follow the latest bar only when the user hasn't scrolled away
          if (isFollowingLiveRef.current) {
            chartRef.current?.timeScale().scrollToRealTime()
          }
        }
        const fresh = r.updatedAt != null && Date.now() / 1000 - r.updatedAt < STALE_MS / 1000
        setStale(r.updatedAt != null && !fresh)
    }
    const poll = (): Promise<void> => chartApi.latest(symbol, interval).then(handleLatest).catch(() => {})
    // 首拍多要 10 根：库里已收盘 bar 落后一两根时，用缓存尾部把缺口补齐。
    // First call asks for 10 bars so a DB lagging a bar or two behind has its gap filled.
    void chartApi.latest(symbol, interval, 10).then(handleLatest).catch(() => {})

    // 页面在后台时不轮询。这是全站频率最高的一个轮询（每 2 秒），而站内其它所有
    // 轮询——个人胜率卡、纪律分卡、订单页已平仓明细、策略页信号、live.tsx 里的
    // 账号状态与活跃品种——早就都带了这个判断，唯独这里漏了。
    // 代价是实打实的：一个用户把图表页丢在后台标签里，就是 30 次/分钟的纯浪费；
    // 按运维手册里「安全并发 150 人」的基线，其中三分之一挂着图表页就是约 25
    // 请求/秒空转，全落在 2 核单进程的后端上，手机端还白耗电。
    // 切回前台立刻补一次，不让用户盯着一根最长 2 秒的陈旧蜡烛等下一拍。
    // Don't poll while the page is backgrounded. This is the highest-frequency
    // poll in the app (every 2s), and every other one — the win-rate card, the
    // discipline card, the orders page's closed trades, the strategies page's
    // signals, and live.tsx's account-status and active-symbol polls — has had
    // this guard all along; only this one was missed.
    // The cost is real: one user leaving the charts page in a background tab is
    // 30 wasted requests a minute, and at the ops manual's "150 concurrent users"
    // baseline, a third of them idling here is ~25 req/s of pure waste against a
    // 2-core single-process backend, plus needless battery drain on mobile.
    // Refetch immediately on return so the user never stares at a candle up to
    // 2 seconds stale waiting for the next tick.
    // 自适应节奏（原来固定每 2 秒，每次还要为鉴权查一次用户表）：
    //   · 有 WS 报价（在线、最近 5 秒有帧、且已有该品种的实时买价）→ 10 秒一次，只做 H/L 校正；
    //     形成中那根 bar 的 close/high/low 由 WS 逐帧维护（withLiveClose），不靠轮询。
    //   · 否则（WS 断线 / 报价不新鲜 / 休市没帧）→ 3 秒，与 EA 推 K 线的节奏对齐。
    //   · 慢档下新 bar 靠「K 线边界补拉」发现，见 scheduleBoundary。
    //   页面 / App 在后台跳过，回前台立即补一次（2 秒去重）——startPolling 都管了。
    // Adaptive cadence (it was a flat 2s, each poll costing a users-table auth query):
    //   · live WS quotes (online, a frame in the last 5s, and a live bid for this symbol) → every
    //     10s, only correcting H/L; the forming bar's close/high/low ride the WS per frame
    //     (withLiveClose), not the poll.
    //   · otherwise (WS down / quotes not fresh / market closed) → 3s, aligned with the EA's
    //     candle push.
    //   · in the slow mode new bars are found by the boundary catch-up (scheduleBoundary).
    // Background skipping and the return-to-foreground refetch (2s de-dupe) come from startPolling.
    const wsLive = () => liveBidRef?.current != null && netQuality.hasRecentFrame(WS_FRESH_MS)
    const stopPolling = startPolling(() => { void poll() }, () => (wsLive() ? POLL_SLOW_MS : POLL_MS), false)

    // K 线边界补拉：慢档下，每根 bar 开盘后约 3.3 秒拉一次，拉不到新 bar 就每 3 秒再试（最多 2 次）。
    // Boundary catch-up in the slow mode: ~3.3s after each bar opens, then retry every 3s (at most
    // twice) until the new bar appears.
    let boundaryTimer: number | undefined
    const scheduleBoundary = () => {
      const delay = nextBoundaryPollDelayMs(interval, Date.now())
      if (delay == null) return
      const expectT = Math.floor((Date.now() + delay - 3300) / 1000)
      boundaryTimer = window.setTimeout(() => {
        const attempt = (left: number) => {
          if (!alive) return
          if (isAppHidden() || !wsLive()) { scheduleBoundary(); return }
          void poll().then(() => {
            if (!alive) return
            if (lastTimeRef.current < expectT && left > 0) {
              boundaryTimer = window.setTimeout(() => attempt(left - 1), BOUNDARY_RETRY_MS)
            } else {
              scheduleBoundary()
            }
          })
        }
        attempt(BOUNDARY_RETRIES)
      }, delay)
    }
    scheduleBoundary()

    return () => {
      alive = false
      if (historyApplied || snap) saveSnapshot(snapKey, candlesRef.current)
      stopPolling()
      if (boundaryTimer !== undefined) window.clearTimeout(boundaryTimer)
      chartRef.current?.timeScale().unsubscribeVisibleLogicalRangeChange(onRangeChange)
    }
    // drawReady 必须在依赖里：本 effect 第一行就要 seriesRef.current，而 series 是
    // useChartEngine 的建图 effect 造出来的。现在能跑通只是因为两个 Hook 在同一个
    // 组件里、建图那个先注册先执行；一旦有人调换 useChartData / useChartEngine 的
    // 调用顺序，或图表因容器尚未挂载而延后创建，这里就会静默 return，页面永久空白
    // 且没有任何报错路径。drawReady 翻 true 时重跑一次，才是显式的就绪信号。
    // drawReady must be a dependency: this effect needs seriesRef.current on its
    // first line, and the series is created by useChartEngine's effect. It only
    // works today because that hook is registered first in the same component —
    // swap the call order (or delay chart creation until the container mounts)
    // and this silently returns, leaving a permanently blank page with no error
    // path. Re-running when drawReady flips is the explicit readiness signal.
  }, [symbol, interval, drawReady, recomputeIndicators])

  return { hasData, stale, lastPrice, dayStats }
}
