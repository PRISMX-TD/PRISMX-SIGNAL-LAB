// 图表引擎：lightweight-charts 实例、主图序列、主图/副图指标 series 的建与拆、指标重算、
// pane 高度分配、图例数据。它持有所有 ref，页面与数据 hook 通过返回值使用。
// 2026-09-06 从 pages/ChartsPage.tsx 搬出。2026-09-08 指标层泛化：不再为每个指标
// 写一套 ref / effect，而是按 indicatorCatalog 的描述统一建 series、算数值、读图例
// ——主图叠加按目录逐个对账（条数变了才重建，否则只改选项），副图按开关顺序
// 整体拆掉重建（移除后空 pane 会被库自动删除，追加时用 panes().length 当下标）。
// 2026-11-25 对标 TradingView（阶段 0/1）：主图从内置蜡烛序列换成常驻的自定义序列
// （mainSeries.ts），图表类型只是 applyOptions；K 线经 barTransforms 变换（平均 K 线、
// 砖形等）后再上图；画布颜色、坐标轴、十字线、水印都由 view（来自 chartv2 偏好）驱动。
// 数据写入统一走 renderAll / renderTail：candlesRef 永远是原始 K 线，barTimesRef 永远是
// 图上实际显示的时间（变换后可能不一一对应），画线层按它做时间 ⇄ 坐标换算。
// Chart engine. Moved out of ChartsPage 2026-09-06; indicator layer generalised over
// indicatorCatalog 2026-09-08. 2026-11-25 (TradingView parity, phases 0/1): the main series
// is now one permanent custom series (mainSeries.ts) so a chart-type change is applyOptions;
// bars pass through barTransforms (Heikin Ashi, Renko…) before reaching it; canvas colours,
// scales, crosshair and watermark are driven by `view` (from the chartv2 prefs). All data
// writes go through renderAll / renderTail: candlesRef always holds raw candles, barTimesRef
// always holds the times actually on screen (not 1:1 once transformed), which the draw layer
// uses for time ⇄ coordinate conversion.
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import {
  createChart,
  createTextWatermark,
  ColorType,
  CrosshairMode,
  LineStyle,
  LineSeries,
  HistogramSeries,
  createSeriesMarkers,
  type ISeriesMarkersPluginApi,
  type ITextWatermarkPluginApi,
  type SeriesMarker,
  type Time,
  type IChartApi,
  type ISeriesApi,
  type IPriceLine,
  type UTCTimestamp,
  type LineWidth,
  type WhitespaceData,
  type DeepPartial,
} from 'lightweight-charts'
import type { Candle } from '../../api/types'
import { toLinePoints } from '../../utils/chartSeries'
import type { IndicatorSettings } from './indicatorSettings'
import {
  MAIN_IDS, SUB_IDS, PANE_SIZE_WEIGHT, computeIndicator, lineStyleOf, refLines, seriesSpecs,
  type IndicatorId, type SeriesSpec,
} from './indicatorCatalog'
import { markChartDisposed } from './chartLifecycle'
import { ZonePrimitive, type BarStrip, type ZoneRect } from './zonePrimitive'
import { EMPTY_LEGEND, toHistPoints, type CandleColors, type IndicatorFlags, type LegendValues } from './chartConfig'
import { createLegendStore } from './legendStore'
import { createOhlcStore } from './ohlcStore'
import { MainSeriesView, isCloseOnlyStyle, type MainBar, type MainSeriesOptions, type MainStyle } from './mainSeries'
import { runTransform, transformKindOf } from './chartTransform'
import type { ChartPrefs, ChartType, CrosshairMode as CrossPref, GridMode, LineDash, ScaleMode } from './chartPrefs'
import type { ChartPalette } from './chartTheme'
import type { TimeFormatters } from './chartTime'

export type MainSeriesApi = ISeriesApi<'Custom', Time, MainBar | WhitespaceData<Time>, MainSeriesOptions, DeepPartial<MainSeriesOptions>>

type LineApi = ISeriesApi<'Line'>
type HistApi = ISeriesApi<'Histogram'>
interface Handle { spec: SeriesSpec; api: LineApi | HistApi }
interface SubEntry { handles: Handle[]; refLines: IPriceLine[] }

// 引擎的外观输入（全部来自 chartv2 偏好 + 主题色板）/ the engine's look inputs (chartv2 prefs + palette)
export interface ChartView {
  chartType: ChartType
  palette: ChartPalette
  candle: ChartPrefs['candle']
  lineWidth: number
  lineColor: string
  scaleMode: ScaleMode
  invertScale: boolean
  grid: GridMode
  crosshair: CrossPref
  crossStyle: LineDash
  rightOffset: number
  lastPrice: boolean
  indicatorLabels: boolean
  transform: ChartPrefs['transform']
  watermark: string | null
  time: TimeFormatters
}

const DASH: Record<LineDash, LineStyle> = { solid: LineStyle.Solid, dashed: LineStyle.Dashed, dotted: LineStyle.Dotted }

// 图表类型 → 主序列的绘制样式（平均 K 线 = 蜡烛 + 变换）/ chart type → main series style
function styleOf(t: ChartType): MainStyle {
  if (t === 'heikinAshi') return 'candles'
  if (t === 'pnf') return 'pnf'
  return t as MainStyle
}

// 线型 series 的选项：颜色 / 线宽 / 虚实来自指标设置，SAR 走「只画点不画线」。
// crosshairMarkerVisible:false 去掉十字准线悬停时每条线上的圆点（用户反馈是噪音）。
// Line-series options from the indicator settings; SAR draws points only.
// crosshairMarkerVisible:false removes the per-line hover dots (user feedback: noise).
function lineOptions(spec: SeriesSpec, st: { width: number; dash: 'solid' | 'dashed' }, visible: boolean, labels: boolean) {
  return {
    color: spec.color,
    lineWidth: st.width as LineWidth,
    lineStyle: spec.dashed || st.dash === 'dashed' ? LineStyle.Dashed : LineStyle.Solid,
    priceLineVisible: false,
    // 价格轴上的指标数值标签（设置 → 坐标与线）/ indicator value labels on the price axis
    lastValueVisible: labels,
    crosshairMarkerVisible: false,
    visible,
    ...(spec.kind === 'points' ? { lineVisible: false, pointMarkersVisible: true, pointMarkersRadius: 1.8 } : { lineVisible: true, pointMarkersVisible: false }),
  }
}

export function useChartEngine(
  containerRef: RefObject<HTMLDivElement>,
  indicators: IndicatorFlags,
  indicatorSettings: IndicatorSettings,
  refitKey: unknown,
  candleColors: CandleColors,
  // 指标信号标记的文字（做多 / 做空），由页面按当前语言传入 / marker texts, localized by the page
  markerText: { buy: string; sell: string; closeBuy?: string; closeSell?: string; slBuy?: string; slSell?: string } = { buy: 'BUY', sell: 'SELL' },
  view?: ChartView,
) {
  const chartRef = useRef<IChartApi | null>(null)
  const seriesRef = useRef<MainSeriesApi | null>(null)
  const mainViewRef = useRef<MainSeriesView | null>(null)
  // 已应用到图表的最新一根**原始** K 线时间戳（epoch 秒）。数据层用它过滤更早到达的 bar。
  // Timestamp (epoch s) of the newest *raw* candle applied; the data layer filters older arrivals with it.
  const lastTimeRef = useRef<number>(0)
  // 图上实际显示的 K 线时间（升序）。画线层把非本周期锚点的时间插值成屏幕坐标。
  // Ascending times of the bars actually displayed; the draw layer interpolates anchors with them.
  const barTimesRef = useRef<number[]>([])
  const getBarTimes = useCallback(() => barTimesRef.current, [])
  // 往左翻页的状态。用 ref 而非 state：可视范围回调触发得非常频繁。
  // Paging state as refs: the visible-range callback fires every frame while dragging.
  const loadingOlderRef = useRef(false)
  const hasMoreHistoryRef = useRef(true)
  // 用户当前是否在跟踪实时行情（可视范围右边缘在最新 bar 附近）。
  // Whether the user is following live data (right edge near the latest bar).
  const isFollowingLiveRef = useRef(true)

  // 当前品种/周期的完整 OHLCV 历史（升序），指标计算与图表变换的唯一数据来源。
  // Full ascending OHLCV history — the sole input for indicator math and chart transforms.
  const candlesRef = useRef<Candle[]>([])

  const mainRef = useRef<Partial<Record<IndicatorId, Handle[]>>>({})
  const subRef = useRef<Partial<Record<IndicatorId, SubEntry>>>({})

  const latestLegendRef = useRef<LegendValues>(EMPTY_LEGEND)
  const hoveringRef = useRef(false)

  const [legendStore] = useState(() => createLegendStore())
  const [ohlcStore] = useState(() => createOhlcStore())
  const [paneOffsets, setPaneOffsets] = useState<Partial<Record<IndicatorId, number>>>({})
  const [drawReady, setDrawReady] = useState(false)

  const indicatorSettingsRef = useRef(indicatorSettings)
  useEffect(() => {
    indicatorSettingsRef.current = indicatorSettings
  }, [indicatorSettings])
  const candleColorsRef = useRef(candleColors)
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null)
  const watermarkRef = useRef<ITextWatermarkPluginApi<Time> | null>(null)
  const indicatorsRef = useRef(indicators)
  const zonesRef = useRef<ZonePrimitive | null>(null)
  indicatorsRef.current = indicators
  const markerTextRef = useRef(markerText)
  markerTextRef.current = markerText
  const viewRef = useRef(view)
  viewRef.current = view

  // ──── 主图数据 / main-series data ────
  // 变换后的显示数据缓存（平均 K 线要靠上一根算下一根，增量更新用）。
  // Cache of the displayed bars (Heikin Ashi needs the previous one for incremental updates).
  const shownRef = useRef<MainBar[]>([])
  const lastFullRenderRef = useRef(0)
  const fullRenderTimerRef = useRef<number | undefined>(undefined)

  const colorOf = useCallback((o: number, c: number, dir?: 1 | -1): string => {
    const v = viewRef.current
    const cc = candleColorsRef.current
    if (v && isCloseOnlyStyle(styleOf(v.chartType)) && v.chartType !== 'baseline' && v.chartType !== 'columns') return v.lineColor
    const up = dir != null ? dir > 0 : c >= o
    return up ? cc.up : cc.down
  }, [])

  const publishOhlc = useCallback((bars: MainBar[]) => {
    if (hoveringRef.current || bars.length === 0) {
      if (bars.length === 0) ohlcStore.set(null)
      return
    }
    const b = bars[bars.length - 1]
    const p = bars.length > 1 ? bars[bars.length - 2] : null
    ohlcStore.set({ t: b.time, o: b.open, h: b.high, l: b.low, c: b.close, v: b.volume ?? 0, prev: p ? p.close : null, hovering: false })
  }, [ohlcStore])

  // 按 candlesRef 全量重画主图：变换 → setData → 更新显示时间。
  // Full main-series redraw from candlesRef: transform → setData → displayed times.
  const renderAll = useCallback(() => {
    const series = seriesRef.current
    if (!series) return
    window.clearTimeout(fullRenderTimerRef.current)
    fullRenderTimerRef.current = undefined
    lastFullRenderRef.current = performance.now()
    const v = viewRef.current
    const src = candlesRef.current
    const kind = transformKindOf(v?.chartType ?? 'candles')
    const out = runTransform(kind, src, v?.transform)
    const bars: MainBar[] = out.map((b) => ({
      time: b.t as UTCTimestamp, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v ?? 0,
      dir: b.dir, thick: b.thick, box: b.box, boxes: b.boxes, color: colorOf(b.o, b.c, b.dir),
    }))
    shownRef.current = bars
    if (mainViewRef.current && v) mainViewRef.current.closeOnly = isCloseOnlyStyle(styleOf(v.chartType))
    try { series.setData(bars) } catch { /* 切换中 / switching */ }
    barTimesRef.current = bars.map((b) => b.time as number)
    publishOhlc(bars)
  }, [colorOf, publishOhlc])

  // 只动了最后一根（形成中那根变了，或刚追加一根）：能增量就增量，否则节流后全量。
  // Only the tail changed (forming bar updated or one appended): incremental when possible,
  // otherwise a throttled full redraw.
  const renderTail = useCallback(() => {
    const series = seriesRef.current
    const src = candlesRef.current
    if (!series || src.length === 0) return
    const v = viewRef.current
    const kind = transformKindOf(v?.chartType ?? 'candles')
    const shown = shownRef.current
    const last = src[src.length - 1]
    if (kind === 'none' || kind === 'heikinAshi') {
      const n = src.length
      // 显示数组与原始数组对不齐（乱序插入、翻页）就全量 / misaligned (inserts, paging) → full
      const aligned = shown.length === n || shown.length === n - 1
      const prevAligned = n < 2 || (shown[n - 2] && shown[n - 2].time === src[n - 2].t)
      if (!aligned || !prevAligned) { renderAll(); return }
      let bar: MainBar
      if (kind === 'none') {
        bar = { time: last.t as UTCTimestamp, open: last.o, high: last.h, low: last.l, close: last.c, volume: last.v ?? 0, color: colorOf(last.o, last.c) }
      } else {
        const prev = n >= 2 ? shown[n - 2] : null
        const c = (last.o + last.h + last.l + last.c) / 4
        const o = prev ? (prev.open + prev.close) / 2 : (last.o + last.c) / 2
        bar = { time: last.t as UTCTimestamp, open: o, high: Math.max(last.h, o, c), low: Math.min(last.l, o, c), close: c, volume: last.v ?? 0, color: colorOf(o, c) }
      }
      try { series.update(bar) } catch { renderAll(); return }
      if (shown.length === n) shown[n - 1] = bar
      else shown.push(bar)
      const bt = barTimesRef.current
      if (!bt.length || bt[bt.length - 1] < last.t) bt.push(last.t)
      publishOhlc(shown)
      return
    }
    // 价格类图表：每跳都可能改写最后几块砖，节流到每 300ms 一次全量。
    // Price-based types: any tick may rewrite the last bricks; full redraw throttled to 300ms.
    // 指标在价格类图表上按砖算，砖变了要跟着重算。
    // On price-based types indicators run on the bricks, so recompute after the redraw.
    const full = () => { renderAll(); recomputeRef.current() }
    const since = performance.now() - lastFullRenderRef.current
    if (since >= 300) { full(); return }
    if (fullRenderTimerRef.current === undefined) fullRenderTimerRef.current = window.setTimeout(full, 300 - since)
  }, [renderAll, colorOf, publishOhlc])
  const recomputeRef = useRef<() => void>(() => {})

  // 按当前 candlesRef 重算全部有 series 的指标并写回，同时刷新"最新值"图例缓存。
  // 价格类图表（砖形、新价线、卡吉、点数图）横轴不是时间：指标改按图上的砖算（同 TradingView），
  // 否则原始 K 线的时间点会混进时间轴，把砖之间撑出空档。
  // Recompute every indicator that has series and refresh the latest-value legend.
  // Price-based types (Renko, Line Break, Kagi, P&F) have no time x-axis: indicators run on the
  // displayed bricks (as TradingView does); raw candle times would otherwise enter the time
  // scale and open gaps between bricks.
  const recomputeIndicators = useCallback(() => {
    const vt = viewRef.current?.chartType ?? 'candles'
    const onBricks = transformKindOf(vt) !== 'none' && vt !== 'heikinAshi'
    const bars: Candle[] = onBricks
      ? shownRef.current.map((b) => ({ t: b.time as number, o: b.open, h: b.high, l: b.low, c: b.close, v: b.volume ?? 0 }))
      : candlesRef.current
    if (bars.length === 0) return
    const times = bars.map((b) => b.t as UTCTimestamp)
    const s = indicatorSettingsRef.current
    const next: LegendValues = {}
    const marks: SeriesMarker<UTCTimestamp>[] = []
    const zones: ZoneRect[] = []
    const strips: BarStrip[] = []
    const lastT = times[times.length - 1]
    const feed = (id: IndicatorId, handles: Handle[]) => {
      const out = computeIndicator(id, bars, s)
      const sig = out.sig
      if (out.resTop && indicatorsRef.current[id]) {
        const c = s[id] as { resColor?: string; supColor?: string }
        const push = (topK: string, botK: string, color: string) => out[topK]?.forEach((top, i) => {
          const bot = out[botK]?.[i]
          if (top != null && bot != null) zones.push({ from: times[i], to: lastT, top, bottom: bot, color })
        })
        push('resTop', 'resBot', c.resColor ?? '#2ee07e')
        push('supTop', 'supBot', c.supColor ?? '#ff4d67')
      }
      if (out.chKind && indicatorsRef.current[id]) {
        const c = s[id] as { upColor?: string; downColor?: string; sideColor?: string }
        out.beltTop?.forEach((top, i) => {
          const bot = out.beltBot?.[i]
          if (top != null && bot != null) strips.push({ time: times[i], top, bottom: bot, color: '#555555' })
        })
        out.chKind.forEach((kind, i) => {
          const top = out.chTop?.[i]
          const bot = out.chBot?.[i]
          if (kind == null || top == null || bot == null) return
          strips.push({ time: times[i], top, bottom: bot, color: (kind > 0 ? c.upColor : kind < 0 ? c.downColor : c.sideColor) ?? '#6b7280' })
        })
      }
      if (sig && indicatorsRef.current[id]) {
        const c = s[id] as { buyColor?: string; sellColor?: string }
        const txt = markerTextRef.current
        sig.forEach((v, i) => {
          if (v === 1) marks.push({ time: times[i], position: 'belowBar', shape: 'arrowUp', color: c.buyColor ?? '#facc15', text: txt.buy })
          else if (v === -1) marks.push({ time: times[i], position: 'aboveBar', shape: 'arrowDown', color: c.sellColor ?? '#f472b6', text: txt.sell })
          else if (v === 2) marks.push({ time: times[i], position: 'aboveBar', shape: 'circle', color: '#facc15', text: txt.closeBuy ?? '' })
          else if (v === -2) marks.push({ time: times[i], position: 'belowBar', shape: 'circle', color: '#facc15', text: txt.closeSell ?? '' })
          const slb = out.slBuy?.[i]
          const sls = out.slSell?.[i]
          if (slb != null) marks.push({ time: times[i], position: 'atPriceMiddle', price: slb, shape: 'square', color: c.buyColor ?? '#ff4d67', text: txt.slBuy ?? '' })
          if (sls != null) marks.push({ time: times[i], position: 'atPriceMiddle', price: sls, shape: 'square', color: c.sellColor ?? '#2ee07e', text: txt.slSell ?? '' })
        })
      }
      const row: Record<string, number | null> = {}
      for (const h of handles) {
        const values = out[h.spec.key] ?? []
        if (h.spec.kind === 'hist') {
          const api = h.api as HistApi
          if (h.spec.histColor === 'candle') {
            const up = (s[id] as { upColor?: string }).upColor ?? candleColorsRef.current.up
            const down = (s[id] as { downColor?: string }).downColor ?? candleColorsRef.current.down
            api.setData(bars.map((b, i) => ({ time: times[i], value: values[i] ?? 0, color: b.c >= b.o ? up : down })))
          } else {
            api.setData(toHistPoints(times, values, candleColorsRef.current.up, candleColorsRef.current.down))
          }
        } else {
          const dirs = h.spec.dirKey ? out[h.spec.dirKey] : undefined
          if (dirs) {
            const up = h.spec.color
            const dn = h.spec.downColor ?? up
            const pts: { time: UTCTimestamp; value: number; color: string }[] = []
            values.forEach((v, i) => { if (v != null) pts.push({ time: times[i], value: v, color: (dirs[i] ?? 1) < 0 ? dn : up }) })
            ;(h.api as LineApi).setData(pts)
          } else (h.api as LineApi).setData(toLinePoints(times, values, h.spec.gaps))
        }
        row[h.spec.key] = values[values.length - 1] ?? null
      }
      next[id] = row
    }
    for (const id of MAIN_IDS) {
      const handles = mainRef.current[id]
      if (handles) feed(id, handles)
    }
    for (const id of SUB_IDS) {
      const entry = subRef.current[id]
      if (entry) feed(id, entry.handles)
    }
    // 价格类图表上信号标记的时间对不上砖块，不画（TradingView 也不在砖形图上画信号）。
    // Signal markers don't line up with bricks on price-based types; skip them there.
    const priceBased = transformKindOf(viewRef.current?.chartType ?? 'candles') !== 'none' && viewRef.current?.chartType !== 'heikinAshi'
    marks.sort((a, b) => a.time - b.time)
    markersRef.current?.setMarkers(priceBased ? [] : marks)
    zonesRef.current?.setZones(priceBased ? [] : zones, priceBased ? [] : strips)
    latestLegendRef.current = next
    if (!hoveringRef.current) legendStore.set(next)
  }, [legendStore])
  recomputeRef.current = recomputeIndicators

  const applyPaneHeights = useCallback(() => {
    const chart = chartRef.current
    const host = containerRef.current
    if (!chart || !host) return
    const panes = chart.panes()
    const total = host.clientHeight
    const enabled = SUB_IDS.filter((id) => subRef.current[id])
    if (panes.length <= 1 || total <= 0 || enabled.length === 0) {
      setPaneOffsets({})
      return
    }
    const s = indicatorSettingsRef.current
    const weights = enabled.map((id) => PANE_SIZE_WEIGHT[(s[id] as { size?: 'sm' | 'md' | 'lg' }).size ?? 'md'])
    const wsum = weights.reduce((a, b) => a + b, 0)
    // 副图总占比随数量增长但封顶 60%，再按权重分；单个至少 60px。
    // Sub-pane share grows with count, capped at 60%; then split by weight, ≥ 60px each.
    const share = Math.min(0.6, 0.2 + 0.1 * enabled.length)
    const subTotal = Math.max(total * share, enabled.length * 60)
    const mainHeight = Math.max(total - subTotal, total * 0.4)
    const avail = total - mainHeight
    panes[0].setHeight(Math.floor(mainHeight))
    let offset = Math.floor(mainHeight)
    const offsets: Partial<Record<IndicatorId, number>> = {}
    enabled.forEach((id, i) => {
      const h = Math.max(60, Math.floor((avail * weights[i]) / wsum))
      panes[i + 1]?.setHeight(h)
      offsets[id] = offset
      offset += h
    })
    setPaneOffsets(offsets)
  // eslint-disable-next-line react-hooks/exhaustive-deps -- refs only
  }, [])

  // 建图（只建一次），容器尺寸变化时自适配 / build the chart once; auto-sizes with the container
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const v = viewRef.current
    const pal = v?.palette
    const chart = createChart(el, {
      layout: {
        background: { type: ColorType.Solid, color: pal?.bg ?? '#09090b' },
        textColor: pal?.text ?? '#94a3b8',
        // 关闭库自带的 logo；Apache-2.0 许可要求的署名在图表设置对话框底部（ChartSettingsDialog）。
        // Library logo off; the Apache-2.0 attribution sits at the bottom of the chart settings dialog.
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: pal?.grid ?? 'rgba(255, 255, 255, 0.045)' },
        horzLines: { color: pal?.grid ?? 'rgba(255, 255, 255, 0.045)' },
      },
      rightPriceScale: { borderColor: pal?.border ?? 'rgba(255, 255, 255, 0.07)' },
      timeScale: {
        borderColor: pal?.border ?? 'rgba(255, 255, 255, 0.07)',
        timeVisible: true,
        secondsVisible: false,
        // 最新 K 线右侧预留空白，便于把趋势线 / 斐波那契画到未来区域。
        // Whitespace right of the latest candle so drawings can extend into the future.
        rightOffset: v?.rightOffset ?? 8,
        ...(v ? { tickMarkFormatter: v.time.tick } : {}),
      },
      // 悬停时间与刻度必须用同一套时区，否则两边对不上（见 chartTime.ts）。
      // Hover time and axis ticks must share one timezone (see chartTime.ts).
      ...(v ? { localization: { timeFormatter: v.time.crosshair } } : {}),
      crosshair: { mode: CrosshairMode.Normal },
      // 纵向触摸拖动交给图表（2026-10-17）：价格轴也看这一项，关掉时手机上价格轴拉不动。
      // Vertical touch drags go to the chart (2026-10-17): the price axis reads this option too.
      handleScroll: { vertTouchDrag: true, horzTouchDrag: true, mouseWheel: true },
      width: el.clientWidth,
      height: el.clientHeight,
    })
    const mainView = new MainSeriesView()
    mainViewRef.current = mainView
    const cc = candleColorsRef.current
    const series = chart.addCustomSeries(mainView, {
      upColor: cc.up, downColor: cc.down, wickUpColor: cc.up, wickDownColor: cc.down, borderUpColor: cc.up, borderDownColor: cc.down,
    }) as MainSeriesApi
    chartRef.current = chart
    seriesRef.current = series
    markersRef.current = createSeriesMarkers(series, [])
    const zp = new ZonePrimitive()
    series.attachPrimitive(zp)
    zonesRef.current = zp
    setDrawReady(true)

    const onCrosshairMove: Parameters<typeof chart.subscribeCrosshairMove>[0] = (param) => {
      if (param.time == null) {
        hoveringRef.current = false
        legendStore.set(latestLegendRef.current)
        publishOhlc(shownRef.current)
        return
      }
      hoveringRef.current = true
      const read = (api: LineApi | HistApi): number | null => {
        const d = param.seriesData.get(api) as { value?: number } | undefined
        return d?.value ?? null
      }
      const next: LegendValues = {}
      const collect = (id: IndicatorId, handles: Handle[]) => {
        const row: Record<string, number | null> = {}
        for (const h of handles) row[h.spec.key] = read(h.api)
        next[id] = row
      }
      for (const id of MAIN_IDS) { const h = mainRef.current[id]; if (h) collect(id, h) }
      for (const id of SUB_IDS) { const e = subRef.current[id]; if (e) collect(id, e.handles) }
      legendStore.set(next)
      const bar = param.seriesData.get(series) as MainBar | undefined
      if (bar && bar.close !== undefined) {
        const prev = param.logical != null ? (series.dataByIndex((param.logical as number) - 1) as MainBar | null) : null
        ohlcStore.set({ t: bar.time, o: bar.open, h: bar.high, l: bar.low, c: bar.close, v: bar.volume ?? 0, prev: prev && prev.close !== undefined ? prev.close : null, hovering: true })
      }
    }
    chart.subscribeCrosshairMove(onCrosshairMove)

    const ro = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      const { width, height } = entry.contentRect
      if (width > 0 && height > 0) {
        chart.resize(width, height, true)
        applyPaneHeights()
      }
    })
    ro.observe(el)

    return () => {
      ro.disconnect()
      chart.unsubscribeCrosshairMove(onCrosshairMove)
      window.clearTimeout(fullRenderTimerRef.current)
      legendStore.dispose()
      chart.remove()
      markChartDisposed(chart)
      chartRef.current = null
      seriesRef.current = null
      mainViewRef.current = null
      markersRef.current = null
      watermarkRef.current = null
      zonesRef.current = null
      mainRef.current = {}
      subRef.current = {}
      setDrawReady(false)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- build the chart once
  }, [])

  // ──── 外观：画布、网格、十字线、坐标轴、时间格式 / look: canvas, grid, crosshair, scales, time ────
  const pal = view?.palette
  const timeFmt = view?.time
  useEffect(() => {
    const chart = chartRef.current
    if (!chart || !view || !pal || !timeFmt) return
    const cross = view.crosshair
    const lineOpts = { color: pal.crosshair, style: DASH[view.crossStyle], labelBackgroundColor: pal.crossLabelBg, visible: cross !== 'hidden', labelVisible: true }
    chart.applyOptions({
      layout: { background: { type: ColorType.Solid, color: pal.bg }, textColor: pal.text },
      grid: {
        vertLines: { color: pal.grid, visible: view.grid === 'both' || view.grid === 'vert' },
        horzLines: { color: pal.grid, visible: view.grid === 'both' || view.grid === 'horz' },
      },
      crosshair: { mode: cross === 'magnet' ? CrosshairMode.Magnet : cross === 'hidden' ? CrosshairMode.Hidden : CrosshairMode.Normal, vertLine: lineOpts, horzLine: lineOpts },
      rightPriceScale: { borderColor: pal.border, mode: view.scaleMode, invertScale: view.invertScale },
      timeScale: { borderColor: pal.border, rightOffset: view.rightOffset, tickMarkFormatter: timeFmt.tick },
      localization: { timeFormatter: timeFmt.crosshair },
    })
  }, [drawReady, view, pal, timeFmt])

  // 主序列样式（图表类型、K 线部件、线宽线色、最新价线）/ main series style
  const chartType = view?.chartType ?? 'candles'
  const transformKey = view ? JSON.stringify(view.transform) : ''
  useEffect(() => {
    const series = seriesRef.current
    if (!series || !view) return
    series.applyOptions({
      style: styleOf(view.chartType),
      bodyVisible: view.candle.body,
      borderVisible: view.candle.borders,
      wickVisible: view.candle.wick,
      lineColor: view.lineColor,
      lineWidth: view.lineWidth,
      areaTopColor: hexAlpha(view.lineColor, 0.28),
      areaBottomColor: hexAlpha(view.lineColor, 0.02),
      lastValueVisible: view.lastPrice,
      priceLineVisible: view.lastPrice,
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the listed fields are what the series reads
  }, [drawReady, view?.chartType, view?.candle.body, view?.candle.borders, view?.candle.wick, view?.lineColor, view?.lineWidth, view?.lastPrice])

  // 换图表类型 / 变换参数：全量重画（数据形状变了）+ 指标重算（信号标记的显隐跟类型走）。
  // 进出砖形 / 新价线 / 卡吉 / 点数图（或改它们的参数）时根数会变很多，原来的可见范围按旧根数算，
  // 新数据会挤在最右边一小条：这时把视图重置到最后 150 根。
  // Chart type / transform parameters: full redraw (data shape changed) + recompute. Entering or
  // leaving renko / line break / kagi / P&F (or changing their parameters) changes the bar count a
  // lot, and the old visible range would squeeze the new data into a sliver on the right, so the
  // view resets to the last 150 bars.
  // 根数很少（点数图常见只有几列）时 fitContent 会把它们摊在左边、每根宽得离谱：改成按 60 根的
  // 宽度靠右放，和 TradingView 一样。
  // With very few bars (P&F often has only a handful of columns) fitContent leaves them oddly wide
  // on the left, so they are laid out at a 60-bar width aligned right instead, as TradingView does.
  const shapeRef = useRef('')
  useEffect(() => {
    if (!seriesRef.current || candlesRef.current.length === 0) return
    renderAll()
    recomputeIndicators()
    const shape = transformKindOf(chartType) === 'none' || chartType === 'heikinAshi' ? 'time' : `${chartType}:${transformKey}`
    const prev = shapeRef.current
    shapeRef.current = shape
    const chart = chartRef.current
    if (!chart || !prev || prev === shape) return
    const n = barTimesRef.current.length
    const right = n - 1 + (viewRef.current?.rightOffset ?? 5)
    if (n < 60) chart.timeScale().setVisibleLogicalRange({ from: n - 60, to: right })
    else if (n <= 150) chart.timeScale().fitContent()
    else chart.timeScale().setVisibleLogicalRange({ from: n - 150, to: right })
  }, [chartType, transformKey, renderAll, recomputeIndicators])

  // 水印：品种 + 周期，画在主图正中（设置 → 画布）/ watermark: symbol + interval centred on the main pane
  const watermark = view?.watermark ?? null
  const watermarkColor = pal?.watermark
  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    watermarkRef.current?.detach()
    watermarkRef.current = null
    if (!watermark) return
    watermarkRef.current = createTextWatermark(chart.panes()[0], {
      horzAlign: 'center', vertAlign: 'center',
      lines: [{ text: watermark, color: watermarkColor ?? 'rgba(255,255,255,0.05)', fontSize: 48, fontStyle: '600' }],
    })
  }, [drawReady, watermark, watermarkColor])

  const indicatorLabels = view?.indicatorLabels ?? false
  // 主图叠加对账 / reconcile main-pane overlays
  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    for (const id of MAIN_IDS) {
      const specs = seriesSpecs(id, indicatorSettings)
      const st = lineStyleOf(id, indicatorSettings)
      const existing = mainRef.current[id]
      const same = existing && existing.length === specs.length && existing.every((h, i) => h.spec.kind === specs[i].kind)
      if (!same) {
        existing?.forEach((h) => chart.removeSeries(h.api))
        mainRef.current[id] = specs.map((spec) => ({ spec, api: chart.addSeries(LineSeries, lineOptions(spec, st, indicators[id], indicatorLabels)) }))
      } else {
        existing.forEach((h, i) => { h.spec = specs[i]; (h.api as LineApi).applyOptions(lineOptions(specs[i], st, indicators[id], indicatorLabels)) })
      }
    }
    recomputeIndicators()
  }, [indicators, indicatorSettings, recomputeIndicators, indicatorLabels, drawReady])

  // 副图开关 / sub-pane toggles
  const subKey = SUB_IDS.map((id) => (indicators[id] ? id : '')).join(',')
  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    const s = indicatorSettingsRef.current
    for (const id of SUB_IDS) {
      const e = subRef.current[id]
      if (!e) continue
      e.handles.forEach((h) => chart.removeSeries(h.api))
      delete subRef.current[id]
    }
    for (const id of SUB_IDS) {
      if (!indicators[id]) continue
      const paneIndex = chart.panes().length
      const st = lineStyleOf(id, s)
      const handles: Handle[] = seriesSpecs(id, s).map((spec) => ({
        spec,
        api: spec.kind === 'hist'
          ? chart.addSeries(HistogramSeries, { priceLineVisible: false, lastValueVisible: indicatorLabels, ...(id === 'volume' ? { priceFormat: { type: 'volume' as const } } : {}) }, paneIndex)
          : chart.addSeries(LineSeries, lineOptions(spec, st, true, indicatorLabels), paneIndex),
      }))
      const firstLine = handles.find((h) => h.spec.kind === 'line')?.api as LineApi | undefined
      const lines = firstLine ? refLines(id, s).map((r) => firstLine.createPriceLine({
        price: r.value, color: 'rgba(148,163,184,0.5)', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: r.label,
      })) : []
      subRef.current[id] = { handles, refLines: lines }
    }
    applyPaneHeights()
    recomputeIndicators()
  // eslint-disable-next-line react-hooks/exhaustive-deps -- subKey encodes exactly the toggles that matter
  }, [subKey, applyPaneHeights, recomputeIndicators, drawReady])

  // 参数 / 样式变化 / settings changes
  useEffect(() => {
    const s = indicatorSettings
    for (const id of SUB_IDS) {
      const e = subRef.current[id]
      if (!e) continue
      const st = lineStyleOf(id, s)
      const specs = seriesSpecs(id, s)
      e.handles.forEach((h, i) => {
        const spec = specs[i] ?? h.spec
        h.spec = spec
        if (spec.kind !== 'hist') (h.api as LineApi).applyOptions(lineOptions(spec, st, true, indicatorLabels))
        else (h.api as HistApi).applyOptions({ lastValueVisible: indicatorLabels })
      })
      const firstLine = e.handles.find((h) => h.spec.kind === 'line')?.api as LineApi | undefined
      if (firstLine) {
        e.refLines.forEach((pl) => firstLine.removePriceLine(pl))
        e.refLines = refLines(id, s).map((r) => firstLine.createPriceLine({
          price: r.value, color: 'rgba(148,163,184,0.5)', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: r.label,
        }))
      }
    }
    applyPaneHeights()
    recomputeIndicators()
  }, [indicatorSettings, applyPaneHeights, recomputeIndicators, indicatorLabels])

  // 换 K 线颜色：改主序列选项并重画（每根 bar 自带最新价标签颜色）。
  // Candle colours: update the main series and redraw (each bar carries its label colour).
  const lineColorKey = view?.lineColor
  useEffect(() => {
    candleColorsRef.current = candleColors
    seriesRef.current?.applyOptions({
      upColor: candleColors.up, downColor: candleColors.down,
      wickUpColor: candleColors.up, wickDownColor: candleColors.down,
      borderUpColor: candleColors.up, borderDownColor: candleColors.down,
    })
    if (candlesRef.current.length > 0) renderAll()
    recomputeIndicators()
  }, [candleColors, lineColorKey, renderAll, recomputeIndicators])

  useEffect(() => {
    recomputeIndicators()
  }, [markerText.buy, markerText.sell, markerText.closeBuy, markerText.closeSell, markerText.slBuy, markerText.slSell, recomputeIndicators])

  useEffect(() => {
    const el = containerRef.current
    const chart = chartRef.current
    if (!el || !chart) return
    const raf = requestAnimationFrame(() => {
      if (el.clientWidth > 0 && el.clientHeight > 0) {
        chart.resize(el.clientWidth, el.clientHeight, true)
        applyPaneHeights()
      }
    })
    return () => cancelAnimationFrame(raf)
  }, [refitKey, applyPaneHeights])

  return {
    chartRef, seriesRef, candlesRef, lastTimeRef, barTimesRef, getBarTimes,
    loadingOlderRef, hasMoreHistoryRef, isFollowingLiveRef,
    legendStore, ohlcStore, paneOffsets, drawReady,
    recomputeIndicators, applyPaneHeights, renderAll, renderTail,
  }
}

function hexAlpha(hex: string, a: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex)
  if (!m) return hex
  const n = parseInt(m[1], 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`
}

export type ChartEngine = ReturnType<typeof useChartEngine>
