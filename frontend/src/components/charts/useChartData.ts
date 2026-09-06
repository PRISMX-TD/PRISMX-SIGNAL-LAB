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
  HISTORY_FIRST_PAGE, HISTORY_PAGE_SIZE, HISTORY_PREFETCH_BARS, MAX_CLIENT_BARS, POLL_MS, STALE_MS,
  SYMBOL_DECIMALS, computeDayStats, toLwPoint,
} from './chartConfig'
import type { ChartEngine } from './useChartEngine'

export function useChartData(symbol: string, interval: string, engine: ChartEngine) {
  const {
    chartRef, seriesRef, candlesRef, lastTimeRef, barTimesRef,
    loadingOlderRef, hasMoreHistoryRef, isFollowingLiveRef, recomputeIndicators,
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

  // 切品种/周期：拉历史快照 + 起轮询最新价 / on symbol or interval change: fetch history + poll latest
  useEffect(() => {
    const series = seriesRef.current
    if (!series || !symbol) return // symbol 为空说明 activeSymbols 还没校正出有效值，等下一轮
                                    // empty symbol means activeSymbols hasn't resolved a valid value yet
    let alive = true
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
    // 追加并按 MAX_CLIENT_BARS 截断——语义上镜像后端 chart_store.merge_bars。
    // Merge one bar into candlesRef: same timestamp overwrites (bar still
    // forming), newer timestamp appends and gets trimmed to
    // MAX_CLIENT_BARS — mirrors the backend's chart_store.merge_bars semantics.
    const mergeCandle = (b: Candle) => {
      const arr = candlesRef.current
      const lastT = arr.length ? arr[arr.length - 1].t : -Infinity
      if (b.t < lastT) return
      if (b.t === lastT) arr[arr.length - 1] = b
      else {
        arr.push(b)
        if (arr.length > MAX_CLIENT_BARS) arr.shift()
      }
    }

    // 按品种设置价格轴小数位数，否则默认按 2 位显示，外汇对（如 EURUSD）
    // 会把 1.08543 截断成 1.09 这种不可用的精度。
    // Set the price-scale precision per symbol; otherwise it defaults to 2
    // digits, truncating FX pairs (e.g. EURUSD) to an unusable 1.08543 -> 1.09.
    const decimals = SYMBOL_DECIMALS[symbol] ?? 2
    series.applyOptions({
      priceFormat: { type: 'price', precision: decimals, minMove: Math.pow(10, -decimals) },
    })

    chartApi.history(symbol, interval, HISTORY_FIRST_PAGE).then((r) => {
      if (!alive) return
      if (r.bars.length > 0) {
        series.setData(r.bars.map(toLwPoint))
        lastTimeRef.current = r.bars[r.bars.length - 1].t
        setLastPrice(r.bars[r.bars.length - 1].c)
        barTimesRef.current = r.bars.map((b) => b.t)
        candlesRef.current = r.bars.slice(-MAX_CLIENT_BARS)
        hasMoreHistoryRef.current = r.hasMore
        recomputeIndicators()
        setDayStats(computeDayStats(candlesRef.current))
        chartRef.current?.timeScale().fitContent()
        setHasData(true)
      } else {
        hasMoreHistoryRef.current = false
        setHasData(false)
      }
    }).catch(() => {
      if (alive) setHasData(false)
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
        const merged = [...r.bars, ...candlesRef.current].slice(-MAX_CLIENT_BARS)
        candlesRef.current = merged
        barTimesRef.current = merged.map((b) => b.t)
        series.setData(merged.map(toLwPoint))
        recomputeIndicators()
        // 往左插了 r.bars.length 根，原来的逻辑下标整体右移同样的量。
        // Inserting r.bars.length bars on the left shifts every logical index right.
        if (range) {
          chartRef.current?.timeScale().setVisibleLogicalRange({
            from: range.from + r.bars.length,
            to: range.to + r.bars.length,
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
      // 跟踪用户是否在最新 bar 附近：右边缘距最新 bar 不到 5 分钟算"跟随实时"
      // Track whether viewport is near the live edge (~5 min from latest bar)
      if (range && range.to !== null && lastTimeRef.current > 0) {
        isFollowingLiveRef.current = (lastTimeRef.current - range.to) < 300
      }
    }
    chartRef.current?.timeScale().subscribeVisibleLogicalRangeChange(onRangeChange)

    const poll = () => {
      chartApi.latest(symbol, interval).then((r) => {
        if (!alive) return
        for (const b of r.bars) applyBar(b)
        for (const b of r.bars) mergeCandle(b)
        // 追加新出现的 bar 时间，保持 barTimesRef 与图表同步 / keep bar times in sync
        for (const b of r.bars) {
          const arr = barTimesRef.current
          if (arr.length && b.t > arr[arr.length - 1]) arr.push(b.t)
        }
        if (r.bars.length > 0) {
          setHasData(true)
          setLastPrice(r.bars[r.bars.length - 1].c)
          recomputeIndicators()
          setDayStats(computeDayStats(candlesRef.current))
          // 自动跟踪最新 bar：仅在用户未手动离开实时位置时跟随滚动
          // Auto-follow the latest bar only when the user hasn't scrolled away
          if (isFollowingLiveRef.current) {
            chartRef.current?.timeScale().scrollToRealTime()
          }
        }
        const fresh = r.updatedAt != null && Date.now() / 1000 - r.updatedAt < STALE_MS / 1000
        setStale(r.updatedAt != null && !fresh)
      }).catch(() => {})
    }

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
    const timer = window.setInterval(() => {
      if (!document.hidden) poll()
    }, POLL_MS)
    const onVisible = () => { if (!document.hidden) poll() }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)

    return () => {
      alive = false
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
      chartRef.current?.timeScale().unsubscribeVisibleLogicalRangeChange(onRangeChange)
    }
  }, [symbol, interval, recomputeIndicators])

  return { hasData, stale, lastPrice, dayStats }
}
