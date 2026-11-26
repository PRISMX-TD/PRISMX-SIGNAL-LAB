// 对比品种（TradingView 的「比较」）：每个条目一条线，按 CompareEntry.mode 放：
//   · percent：主图右轴，有可见的就把主价格轴切到百分比（compareModel.nextScaleForce，用户设置不写）；
//   · scale：第一个用左轴（指标没占时），其余各一条叠加轴；
//   · pane：自己的窗格，接在指标窗格后面（引擎的 TailPaneHost，指标重建时一起拆建，高度 / 图例位置照常）。
// 线的数据按主图显示的 K 线时间对齐（alignCloses），所以回放时自动截到回放那根、换图表类型也跟着。
// 主序列数据一变（轮询 / 回放一步 / 翻页）按帧合并重对齐：只动了尾巴就 update 最后一两点，否则整段 setData。
// 条目由页面持有（PaneState.compare），本 hook 只读 props。
// Compare symbols (TradingView's "Compare"): one line per entry, placed by CompareEntry.mode:
//   · percent: the main right scale; while any is visible the main scale goes to percent
//     (compareModel.nextScaleForce; the user's setting is never written);
//   · scale: the first takes the left scale (when indicators don't), the rest an overlay scale each;
//   · pane: its own pane after the indicator panes (the engine's TailPaneHost, torn down and rebuilt
//     with the indicators so heights / legend boxes stay right).
// Line data is aligned to the main chart's displayed bar times (alignCloses), so a replay cuts it at
// the replay bar and chart-type switches follow. Whenever the main series data changes (poll /
// replay step / paging) a frame-coalesced realign runs: a tail-only change updates the last point
// or two, anything else is a full setData. The page owns the entries (PaneState.compare); this hook
// only reads props.
import { useEffect, useRef, useState } from 'react'
import { LineSeries, type ISeriesApi, type LineWidth, type MouseEventParams, type Time, type UTCTimestamp } from 'lightweight-charts'
import type { ChartEngine, TailPaneHost } from '../useChartEngine'
import type { ScaleMode } from '../chartPrefs'
import type { CompareEntry, CompareMode } from '../layout/paneState'
import { barSpacingSeconds } from '../chartConfig'
import { CompareData, type CompareStatus } from './compareData'
import {
  MAX_COMPARE, SCALE_FORCE_IDLE, alignCloses, comparePaneId, guessDigits, nextScaleForce, placeEntries,
  scaleOverrideOf, type Placement, type ScaleForce,
} from './compareModel'

export interface CompareRow {
  symbol: string
  color: string
  mode: CompareMode
  hidden: boolean
  // 十字线所在那根的收盘（没悬停时是最新一根）/ close at the crosshair bar (latest when not hovering)
  value: number | null
  digits: number
  status: CompareStatus
}

// 图例的快照：各行 + 左侧价格轴宽度（左轴显示时图例往右让开）
// Legend snapshot: the rows + the left price-scale width (the legend moves right while the left scale shows)
export interface CompareSnapshot { rows: CompareRow[]; leftInset: number }

// 图例行的小仓库（CompareLegend 订阅，十字线拖动只重渲染图例）/ a tiny store for legend rows
export interface CompareRowsStore {
  subscribe: (fn: () => void) => () => void
  get: () => CompareSnapshot
}

const EMPTY_SNAPSHOT: CompareSnapshot = { rows: [], leftInset: 0 }

function createRowsStore() {
  let snap: CompareSnapshot = EMPTY_SNAPSHOT
  const subs = new Set<() => void>()
  return {
    subscribe: (fn: () => void) => { subs.add(fn); return () => { subs.delete(fn) } },
    get: () => snap,
    set: (next: CompareRow[], leftInset = 0) => {
      const rows = snap.rows
      if (leftInset === snap.leftInset && next.length === rows.length && next.every((r, i) => {
        const o = rows[i]
        return o.symbol === r.symbol && o.value === r.value && o.color === r.color && o.hidden === r.hidden && o.mode === r.mode && o.status === r.status && o.digits === r.digits
      })) return
      snap = next.length === 0 && leftInset === 0 ? EMPTY_SNAPSHOT : { rows: next, leftInset }
      subs.forEach((f) => f())
    },
  }
}

interface Handle {
  api: ISeriesApi<'Line'>
  key: string
  // 已应用的对比数据版本、主图时间的长度 / 首尾（判断能不能只改尾巴）
  // applied compare-data version and main-time length / ends (decides tail-only updates)
  ver: number
  len: number
  firstT: number
  lastT: number
  lastVal: number | null
}

export interface UseCompareOptions {
  symbol: string
  interval: string
  entries: readonly CompareEntry[]
  // 用户设置里的价格轴模式（百分比覆盖据此恢复）/ the user's scale mode (the percent override restores to it)
  scaleMode: ScaleMode
  // 券商小数位（没有时按价位猜）/ broker digits (guessed from the price when absent)
  digitsFor?: (symbol: string) => number | undefined
  // false = 暂停（条目照留，线全撤）/ false = suspended (entries kept, lines removed)
  enabled?: boolean
}

export interface CompareHandle {
  rows: CompareRowsStore
  // 可见的 pane 模式条目占的窗格 id（engine.paneBoxes 里的键）/ pane ids of visible pane-mode entries (keys in engine.paneBoxes)
  paneIds: string[]
}

const placeKey = (p: Placement) => `${p.pane ? 'pane' : 'main'}|${p.scaleId}`

export function useCompare(engine: ChartEngine, opts: UseCompareOptions): CompareHandle {
  const { symbol, interval, scaleMode, enabled = true } = opts
  const { chartRef, seriesRef, barTimesRef, drawReady } = engine
  const engineRef = useRef(engine)
  engineRef.current = engine
  const list = enabled ? opts.entries.filter((e) => e.symbol && e.symbol !== symbol).slice(0, MAX_COMPARE) : []
  const listRef = useRef(list)
  listRef.current = list
  const digitsForRef = useRef(opts.digitsFor)
  digitsForRef.current = opts.digitsFor
  const scaleModeRef = useRef(scaleMode)
  scaleModeRef.current = scaleMode

  const [rows] = useState(createRowsStore)
  const dataRef = useRef<CompareData | null>(null)
  const mainRef = useRef(new Map<string, Handle>())
  const paneRef = useRef(new Map<string, Handle>())
  const paneKeyRef = useRef('')
  const forceRef = useRef<ScaleForce>(SCALE_FORCE_IDLE)
  const hoverRef = useRef<MouseEventParams<Time> | null>(null)
  const rafRef = useRef<number | undefined>(undefined)

  // ── 线的样式 / line style ──
  const lineOptions = (e: CompareEntry, p: Placement) => {
    const h = mainRef.current.get(e.symbol) ?? paneRef.current.get(e.symbol)
    const d = digitsForRef.current?.(e.symbol) ?? guessDigits(h?.lastVal)
    return {
      color: e.color,
      lineWidth: 2 as LineWidth,
      visible: !e.hidden,
      priceScaleId: p.scaleId,
      priceLineVisible: false,
      // 叠加轴没有刻度，价格标签也不画 / overlay scales draw no ticks, so no axis label either
      lastValueVisible: !p.scaleId.startsWith('cmp-'),
      crosshairMarkerVisible: true,
      crosshairMarkerRadius: 3,
      priceFormat: { type: 'price' as const, precision: d, minMove: Math.pow(10, -d) },
    }
  }

  // ── 图例 / legend ──
  const publishRows = () => {
    const data = dataRef.current
    const hover = hoverRef.current
    let leftInset = 0
    try {
      const chart = chartRef.current
      if (chart && chart.options().leftPriceScale.visible) leftInset = chart.priceScale('left').width()
    } catch { /* 图表已销毁 / disposed */ }
    rows.set(listRef.current.map((e) => {
      const h = mainRef.current.get(e.symbol) ?? paneRef.current.get(e.symbol)
      let value = h?.lastVal ?? null
      if (hover && hover.time != null && h) {
        const d = hover.seriesData.get(h.api) as { value?: number } | undefined
        value = d?.value ?? null
      }
      return {
        symbol: e.symbol, color: e.color, mode: e.mode, hidden: !!e.hidden, value,
        digits: digitsForRef.current?.(e.symbol) ?? guessDigits(h?.lastVal ?? value),
        status: data?.status(e.symbol) ?? 'loading',
      }
    }), leftInset)
  }

  // ── 数据对齐到主图时间 / align data to the main bar times ──
  const syncOne = (sym: string, h: Handle) => {
    const data = dataRef.current
    if (!data) return
    const times = barTimesRef.current
    const bars = data.bars(sym)
    const ver = data.version(sym)
    const spacing = barSpacingSeconds(interval)
    const keyOf = data.spec ? data.spec.bucketKey : undefined
    if (!bars || times.length === 0) {
      if (h.len !== 0 || h.ver !== ver) { try { h.api.setData([]) } catch { /* noop */ } }
      Object.assign(h, { ver, len: 0, firstT: NaN, lastT: NaN, lastVal: null })
      return
    }
    const tailOnly = h.ver === ver && h.len > 0 && times[0] === h.firstT && times[h.len - 1] === h.lastT
      && (times.length === h.len || times.length === h.len + 1)
    if (tailOnly) {
      const from = h.len - 1
      const seg = times.slice(from)
      const vals = alignCloses(seg, bars, spacing, keyOf)
      try {
        seg.forEach((t, i) => {
          const v = vals[i]
          h.api.update((v == null ? { time: t as UTCTimestamp } : { time: t as UTCTimestamp, value: v }) as never)
        })
      } catch {
        h.len = 0
        return syncOne(sym, h)
      }
      const last = vals[vals.length - 1]
      if (last != null) h.lastVal = last
    } else {
      const vals = alignCloses(times, bars, spacing, keyOf)
      const pts = times.map((t, i) => (vals[i] == null ? { time: t as UTCTimestamp } : { time: t as UTCTimestamp, value: vals[i] as number }))
      try { h.api.setData(pts as never) } catch { /* 切换中 / switching */ }
      let lv: number | null = null
      for (let i = vals.length - 1; i >= 0; i--) if (vals[i] != null) { lv = vals[i]; break }
      h.lastVal = lv
    }
    h.ver = ver
    h.len = times.length
    h.firstT = times[0]
    h.lastT = times[times.length - 1]
  }

  const syncData = () => {
    mainRef.current.forEach((h, s) => syncOne(s, h))
    paneRef.current.forEach((h, s) => syncOne(s, h))
    dataRef.current?.ensureCoverage(barTimesRef.current[0])
    publishRows()
  }
  const scheduleSync = () => {
    if (rafRef.current !== undefined) return
    rafRef.current = requestAnimationFrame(() => { rafRef.current = undefined; syncData() })
  }

  // ── 主图价格轴模式 / main scale mode ──
  const updateScaleForce = () => {
    const percentVisible = listRef.current.some((e) => e.mode === 'percent' && !e.hidden)
    forceRef.current = nextScaleForce(forceRef.current, percentVisible, scaleModeRef.current)
    engineRef.current.setScaleOverride(scaleOverrideOf(forceRef.current, scaleModeRef.current))
  }

  const newHandle = (api: ISeriesApi<'Line'>, key: string): Handle => ({ api, key, ver: -1, len: 0, firstT: NaN, lastT: NaN, lastVal: null })

  // ── 结构：主图上的线（percent / scale）就地建删；窗格线交给引擎的尾部窗格 ──
  // ── Structure: main-pane lines (percent / scale) are added / removed in place; pane lines go through the engine's tail panes ──
  const syncStructure = () => {
    const chart = chartRef.current
    const eng = engineRef.current
    if (!chart) return
    const cur = listRef.current
    const { place, wantsLeft, panes } = placeEntries(cur, eng.indicatorsUseLeft())
    const main = mainRef.current
    for (const [sym, h] of [...main]) {
      const p = place.get(sym)
      if (!p || p.pane || placeKey(p) !== h.key) {
        try { chart.removeSeries(h.api) } catch { /* noop */ }
        main.delete(sym)
      }
    }
    for (const e of cur) {
      const p = place.get(e.symbol)!
      if (p.pane) continue
      let h = main.get(e.symbol)
      if (!h) {
        const api = chart.addSeries(LineSeries, lineOptions(e, p), 0)
        h = newHandle(api, placeKey(p))
        main.set(e.symbol, h)
        if (p.scaleId.startsWith('cmp-')) api.priceScale().applyOptions({ scaleMargins: { top: 0.12, bottom: 0.12 } })
      } else {
        h.api.applyOptions(lineOptions(e, p))
      }
    }
    eng.setLeftScaleClaim(wantsLeft)
    const pk = panes.join(',')
    if (pk !== paneKeyRef.current) {
      eng.relayoutTailPanes()
    } else {
      for (const e of cur) {
        const h = paneRef.current.get(e.symbol)
        if (h) h.api.applyOptions(lineOptions(e, { scaleId: 'right', pane: true }))
      }
    }
    updateScaleForce()
    syncData()
  }
  const syncStructureRef = useRef(syncStructure)
  syncStructureRef.current = syncStructure

  // 尾部窗格宿主：可见的 pane 条目各占一个窗格 / tail-pane host: one pane per visible pane-mode entry
  const [host] = useState<TailPaneHost>(() => ({
    attach: (first: number) => {
      const chart = engineRef.current.chartRef.current
      if (!chart) return []
      const cur = listRef.current
      const { panes } = placeEntries(cur, engineRef.current.indicatorsUseLeft())
      paneKeyRef.current = panes.join(',')
      const ids: string[] = []
      panes.forEach((sym, j) => {
        const e = cur.find((x) => x.symbol === sym)!
        const api = chart.addSeries(LineSeries, lineOptions(e, { scaleId: 'right', pane: true }), first + j)
        paneRef.current.set(sym, newHandle(api, 'pane|right'))
        ids.push(comparePaneId(sym))
      })
      paneRef.current.forEach((h, s) => syncOne(s, h))
      return ids
    },
    detach: () => {
      const chart = engineRef.current.chartRef.current
      paneRef.current.forEach((h) => { try { chart?.removeSeries(h.api) } catch { /* noop */ } })
      paneRef.current.clear()
      paneKeyRef.current = ''
    },
  }))

  // 数据源：按周期建，换周期重建 / data source per interval
  useEffect(() => {
    if (!drawReady) return
    const data = new CompareData(interval, () => scheduleSync())
    dataRef.current = data
    data.setSymbols(listRef.current.map((e) => e.symbol))
    data.startPolling()
    // 主图数据一变就重对齐（按帧合并）/ realign whenever the main data changes (frame-coalesced)
    const series = seriesRef.current
    const onData = () => scheduleSync()
    series?.subscribeDataChanged(onData)
    const chart = chartRef.current
    const onMove = (p: MouseEventParams<Time>) => { hoverRef.current = p.time != null ? p : null; publishRows() }
    chart?.subscribeCrosshairMove(onMove)
    engineRef.current.setTailPaneHost(host)
    syncStructureRef.current()
    return () => {
      data.dispose()
      dataRef.current = null
      try { series?.unsubscribeDataChanged(onData) } catch { /* 图表已销毁 / disposed */ }
      try { chart?.unsubscribeCrosshairMove(onMove) } catch { /* disposed */ }
      if (rafRef.current !== undefined) cancelAnimationFrame(rafRef.current)
      rafRef.current = undefined
      // 拆掉所有线；图表还在才动它 / remove every line, only if the chart still exists
      const eng = engineRef.current
      const live = eng.chartRef.current === chart && chart != null
      if (live) {
        mainRef.current.forEach((h) => { try { chart.removeSeries(h.api) } catch { /* noop */ } })
      }
      const hadPanes = paneRef.current.size > 0
      if (live) host.detach()
      else { paneRef.current.clear(); paneKeyRef.current = '' }
      mainRef.current.clear()
      eng.setTailPaneHost(null)
      if (live) {
        if (hadPanes) eng.relayoutTailPanes()
        eng.setLeftScaleClaim(false)
        eng.setScaleOverride(null)
      }
      forceRef.current = SCALE_FORCE_IDLE
      hoverRef.current = null
      rows.set([])
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- rebuilt per interval / chart instance; everything else goes through refs
  }, [interval, drawReady, host, rows])

  // 条目变了（增删、模式、颜色、显隐）/ entries changed (add / remove, mode, colour, visibility)
  const entriesKey = JSON.stringify(list.map((e) => [e.symbol, e.mode, e.color, !!e.hidden]))
  useEffect(() => {
    if (!drawReady || !dataRef.current) return
    dataRef.current.setSymbols(listRef.current.map((e) => e.symbol))
    syncStructureRef.current()
  }, [entriesKey, drawReady])

  // 用户换了价格轴模式：按 nextScaleForce 放开或保持覆盖 / the user changed the scale mode
  useEffect(() => {
    if (!drawReady) return
    updateScaleForce()
  // eslint-disable-next-line react-hooks/exhaustive-deps -- refs only
  }, [scaleMode, drawReady])

  return { rows, paneIds: list.filter((e) => e.mode === 'pane' && !e.hidden).map((e) => comparePaneId(e.symbol)) }
}
