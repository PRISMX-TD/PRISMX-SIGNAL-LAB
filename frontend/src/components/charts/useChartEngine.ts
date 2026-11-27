// 图表引擎：lightweight-charts 实例、主图序列、指标 series 的建与拆、指标重算、窗格高度、图例数据。
// 它持有所有 ref，页面与数据 hook 通过返回值使用。
// 2026-09-06 从 pages/ChartsPage.tsx 搬出。2026-11-25 对标 TradingView（阶段 0/1）：主图换成常驻的
// 自定义序列（mainSeries.ts），图表类型只是 applyOptions；K 线经 barTransforms 变换后再上图；
// 画布颜色、坐标轴、十字线、水印都由 view 驱动。数据写入统一走 renderAll / renderTail：candlesRef
// 永远是原始 K 线，barTimesRef 永远是图上实际显示的时间，画线层按它做时间 ⇄ 坐标换算。
// 2026-11-25 阶段 4：指标改成实例列表（ind/）。同一种指标可加多次；每个实例在主图或某个窗格，
// 窗格顺序、高度、折叠、最大化由页面传入。结构（实例、所在窗格、线型、价格轴）一变就把指标
// series 全部拆掉按窗格顺序重建——空窗格会被库自动删掉，按顺序追加正好得到想要的窗格下标；
// 只改颜色 / 线宽 / 显隐时 applyOptions。
// Chart engine. Moved out of ChartsPage 2026-09-06; main series became a permanent custom series
// in phases 0/1 (2026-11-25). Phase 4 (2026-11-25): indicators are an instance list (ind/). A kind
// can be added many times; each instance sits on the main pane or a sub-pane whose order, height,
// collapsed / maximised state come from the page. Any structural change (instances, panes, plot
// types, price scales) tears every indicator series down and rebuilds them pane by pane — the
// library drops empty panes, so appending in order yields the intended pane indices; colour /
// width / visibility changes are applyOptions.
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import {
  createChart,
  createTextWatermark,
  ColorType,
  CrosshairMode,
  PriceScaleMode,
  LineStyle,
  LineSeries,
  LineType,
  HistogramSeries,
  AreaSeries,
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
  type SeriesType,
} from 'lightweight-charts'
import type { Candle } from '../../api/types'
import { isChartAlive, markChartDisposed } from './chartLifecycle'
import { ZonePrimitive, type BarStrip, type ZoneRect } from './zonePrimitive'
import { EMPTY_LEGEND, dirColorsOf, type CandleColors, type LegendValues } from './chartConfig'
import { createLegendStore } from './legendStore'
import { createOhlcStore } from './ohlcStore'
import { MainSeriesView, isCloseOnlyStyle, type MainBar, type MainSeriesOptions, type MainStyle } from './mainSeries'
import { runTransform, transformKindOf } from './chartTransform'
import type { ChartPrefs, ChartType, CrosshairMode as CrossPref, GridMode, LineDash, ScaleMode } from './chartPrefs'
import type { ChartPalette } from './chartTheme'
import type { TimeFormatters } from './chartTime'
import { computeAll, maxFuture, visibleOnInterval, latestValue, type InstResult } from './ind/compute'
import { defOf } from './ind/registry'
import { fillStyle, hlineStyle, plotStyle, resolveColor } from './ind/style'
import { IndFillPrimitive, type FillBetween, type FillBand } from './ind/fillPrimitive'
import { EMPTY_SCENE, IndShapePrimitive, type ShapeScene } from './ind/shapePrimitive'
import { otherBars, subscribeOtherBars } from './ind/otherBars'
import { intrabarBars, subscribeIntrabar } from './draw/intrabar'
import type { IndDef, IndExtras, IndInstance, IndPane, PlotKind } from './ind/types'

export type MainSeriesApi = ISeriesApi<'Custom', Time, MainBar | WhitespaceData<Time>, MainSeriesOptions, DeepPartial<MainSeriesOptions>>

type PlotApi = ISeriesApi<'Line'> | ISeriesApi<'Histogram'> | ISeriesApi<'Area'>
interface PlotHandle { key: string; kind: PlotKind; api: PlotApi }
interface InstHandle {
  uid: string
  pane: string
  plots: PlotHandle[]
  // 填充层挂在哪条 series 上（没有线的实例挂在主序列上）/ series carrying the fill layer (main series for plotless ones)
  host: ISeriesApi<SeriesType> | null
  prim: IndFillPrimitive | null
  // 第三批的图形层（箱体、分布、标签、表格、仪表）/ batch 3 shape layer
  shp: IndShapePrimitive | null
  lines: IPriceLine[]
}

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

// 指标输入：已经按会员过滤过的实例列表、窗格、高度权重、当前最大化的窗格。
// Indicator input: the instance list (already filtered by membership), panes, height weights, maximised pane.
export interface IndView {
  list: IndInstance[]
  panes: IndPane[]
  mainH: number
  maxPane: string | null
  interval: string
  digits: number
  // 当前品种（52 周高低、区间表现取本品种日线用）/ the chart's symbol (daily bars for 52w H/L, performance)
  symbol: string
}

// 窗格在容器里的位置（图例、窗格按钮、拖指标换窗格都用）/ pane boxes inside the container
export type PaneBoxes = Record<string, { top: number; height: number }>

// 用户拖窗格分隔条后回报新高度（像素）/ reported after the user drags a pane separator (px)
export type PaneResize = (mainPx: number, panes: Record<string, number>) => void

// 阶段 6：排在指标窗格后面的「尾部窗格」（对比品种的 pane 模式）。引擎重建指标时先 detach、建完指标再
// attach(第一个空闲窗格下标)；attach 返回它占用的窗格 id（按顺序，一个 id 一个窗格）。
// Phase 6: "tail panes" placed after the indicator panes (compare symbols in pane mode). On an
// indicator rebuild the engine calls detach first and attach(first free pane index) after the
// indicators; attach returns the pane ids it occupies, in order, one pane per id.
export interface TailPaneHost {
  attach: (firstPane: number) => string[]
  detach: () => void
}

const DASH: Record<LineDash, LineStyle> = { solid: LineStyle.Solid, dashed: LineStyle.Dashed, dotted: LineStyle.Dotted }
const COLLAPSED_PX = 28

// 图表类型 → 主序列的绘制样式（平均 K 线 = 蜡烛 + 变换）/ chart type → main series style
function styleOf(t: ChartType): MainStyle {
  if (t === 'heikinAshi') return 'candles'
  if (t === 'pnf') return 'pnf'
  return t as MainStyle
}

function seriesTypeOf(kind: PlotKind) {
  if (kind === 'hist' || kind === 'columns') return HistogramSeries
  if (kind === 'area') return AreaSeries
  return LineSeries
}

// 实例窗格 → 窗格下标。没有线的实例（分形、交易时段）只能在主图。
// Instance pane → pane index. Plotless instances (fractals, sessions) live on the main pane only.
function usedPanes(list: IndInstance[], panes: IndPane[]): IndPane[] {
  return panes.filter((p) => list.some((i) => i.pane === p.id && (defOf(i.type)?.plots.length ?? 0) > 0))
}

function scaleIdOf(inst: IndInstance, def: IndDef): string {
  const pin = inst.scale ?? (inst.pane === 'main' && !def.overlay ? 'none' : 'right')
  if (pin === 'none') return `ind-${inst.uid}`
  return pin
}

function priceFormatOf(inst: IndInstance, def: IndDef, digits: number) {
  if (inst.precision != null) return { type: 'price' as const, precision: inst.precision, minMove: Math.pow(10, -inst.precision) }
  if (def.digits === 'volume') return { type: 'volume' as const }
  const p = def.digits === 'price' || def.digits == null ? digits : def.digits
  return { type: 'price' as const, precision: p, minMove: Math.pow(10, -p) }
}

export function useChartEngine(
  containerRef: RefObject<HTMLDivElement>,
  ind: IndView,
  refitKey: unknown,
  candleColors: CandleColors,
  // 指标信号标记的文字（做多 / 做空），由页面按当前语言传入 / marker texts, localized by the page
  markerText: Record<string, string> = { buy: 'BUY', sell: 'SELL' },
  view?: ChartView,
  onPaneResize?: PaneResize,
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

  const instRef = useRef<Map<string, InstHandle>>(new Map())
  const resultsRef = useRef<Map<string, InstResult>>(new Map())

  const latestLegendRef = useRef<LegendValues>(EMPTY_LEGEND)
  const hoveringRef = useRef(false)

  const [legendStore] = useState(() => createLegendStore())
  const [ohlcStore] = useState(() => createOhlcStore())
  const [paneBoxes, setPaneBoxes] = useState<PaneBoxes>({})
  const [drawReady, setDrawReady] = useState(false)

  const indRef = useRef(ind)
  indRef.current = ind
  const candleColorsRef = useRef(candleColors)
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null)
  const watermarkRef = useRef<ITextWatermarkPluginApi<Time> | null>(null)
  const zonesRef = useRef<ZonePrimitive | null>(null)
  const markerTextRef = useRef(markerText)
  markerTextRef.current = markerText
  const viewRef = useRef(view)
  viewRef.current = view
  const onPaneResizeRef = useRef(onPaneResize)
  onPaneResizeRef.current = onPaneResize

  // ──── 阶段 6：对比品种用的挂钩 / phase-6 hooks for compare symbols ────
  // 价格轴模式临时覆盖（有百分比对比时切到百分比；null = 用设置里的）/ temporary scale-mode override (null = the user's setting)
  const scaleOverrideRef = useRef<ScaleMode | null>(null)
  // 左侧价格轴：指标占用 / 对比品种认领 / left price scale: used by indicators / claimed by compare
  const indLeftRef = useRef(false)
  const leftClaimRef = useRef(false)
  // 尾部窗格 / tail panes
  const syncAtRef = useRef<((logical: number | null) => void) | null>(null)
  const syncLegendAt = useCallback((logical: number | null) => { syncAtRef.current?.(logical) }, [])
  const tailHostRef = useRef<TailPaneHost | null>(null)
  const tailIdsRef = useRef<string[]>([])
  const tailWeightRef = useRef<Map<string, number>>(new Map())
  const indPaneCountRef = useRef(0)

  // ──── 主图数据 / main-series data ────
  // 变换后的显示数据缓存（平均 K 线要靠上一根算下一根，增量更新用）。
  // Cache of the displayed bars (Heikin Ashi needs the previous one for incremental updates).
  const shownRef = useRef<MainBar[]>([])
  const lastFullRenderRef = useRef(0)
  const fullRenderTimerRef = useRef<number | undefined>(undefined)

  // 每根 bar 的 color 只用来给价格轴上的最新价标签 / 最新价线上色（K 线本身按序列选项画）：
  // 用涨跌提示色，不用自选的 K 线颜色（见 dirColorsOf）。
  // A bar's color only paints the last-price label / line on the axis (candles draw from the series
  // options): use the up/down cue colours, not the custom candle colours (see dirColorsOf).
  const colorOf = useCallback((o: number, c: number, dir?: 1 | -1): string => {
    const v = viewRef.current
    const cc = dirColorsOf(candleColorsRef.current)
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
    // 价格类图表：每跳都可能改写最后几块砖，节流到每 300ms 一次全量；指标按砖算，跟着重算。
    // Price-based types: any tick may rewrite the last bricks; full redraw throttled to 300ms,
    // and indicators (computed on the bricks) follow.
    const full = () => { renderAll(); recomputeRef.current() }
    const since = performance.now() - lastFullRenderRef.current
    if (since >= 300) { full(); return }
    if (fullRenderTimerRef.current === undefined) fullRenderTimerRef.current = window.setTimeout(full, 300 - since)
  }, [renderAll, colorOf, publishOhlc])
  const recomputeRef = useRef<() => void>(() => {})

  // ──── 指标 / indicators ────
  const priceBasedNow = () => {
    const vt = viewRef.current?.chartType ?? 'candles'
    return transformKindOf(vt) !== 'none' && vt !== 'heikinAshi'
  }

  // 一个实例当前是否显示（自己隐藏、按周期的可见性规则）/ whether an instance shows right now
  const instShown = (inst: IndInstance) => !inst.hidden && visibleOnInterval(inst, indRef.current.interval)

  const plotOptions = useCallback((inst: IndInstance, def: IndDef, key: string) => {
    const p = def.plots.find((x) => x.key === key)!
    const st = plotStyle(inst, p)
    const cc = candleColorsRef.current
    const color = resolveColor(st.color, cc, st.opacity)
    const labels = inst.labels ?? viewRef.current?.indicatorLabels ?? false
    const common = {
      visible: instShown(inst) && st.visible,
      priceLineVisible: false,
      lastValueVisible: labels,
      priceScaleId: scaleIdOf(inst, def),
      priceFormat: priceFormatOf(inst, def, indRef.current.digits),
    }
    if (st.kind === 'hist' || st.kind === 'columns') return { ...common, color }
    if (st.kind === 'area') {
      return { ...common, lineColor: color, topColor: resolveColor(st.color, cc, Math.min(st.opacity, 40)), bottomColor: resolveColor(st.color, cc, 2), lineWidth: st.width as LineWidth, lineStyle: DASH[st.dash], crosshairMarkerVisible: false }
    }
    const pts = st.kind === 'points' || st.kind === 'cross'
    return {
      ...common,
      color,
      lineWidth: st.width as LineWidth,
      lineStyle: DASH[st.dash],
      lineType: st.kind === 'step' ? LineType.WithSteps : LineType.Simple,
      // 十字线悬停时不在每条线上画圆点（用户反馈是噪音）/ no per-line hover dots (user feedback: noise)
      crosshairMarkerVisible: false,
      lineVisible: !pts,
      pointMarkersVisible: pts,
      ...(pts ? { pointMarkersRadius: st.kind === 'cross' ? 1.6 + st.width * 0.4 : 1.4 + st.width * 0.4 } : {}),
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- refs only
  }, [])

  // 建序列的线数（只当图形样式的不算）/ plots that get a series (style-only shape plots don't)
  const seriesPlots = (def: IndDef) => def.plots.filter((p) => !p.shape).length

  // 未来时间：一目云图这类往右平移的线要画到最新 K 线右边，按最近的 K 线间距往后推。
  // Future times for plots shifted right (Ichimoku cloud), extrapolated from the recent bar spacing.
  const futureTimes = (times: number[], k: number): number[] => {
    if (k <= 0 || times.length < 2) return []
    const n = times.length
    const diffs: number[] = []
    for (let i = Math.max(1, n - 12); i < n; i++) diffs.push(times[i] - times[i - 1])
    diffs.sort((a, b) => a - b)
    const step = Math.max(1, diffs[diffs.length >> 1])
    return Array.from({ length: k }, (_, i) => times[n - 1] + step * (i + 1))
  }

  // 第三批图形：把颜色（'f:<填充>'、'up' / 'down'、#hex）和文字（'mk.*'）解析好交给图形层；没有图形时返回 null。
  // Batch 3 shapes: resolve colours ('f:<fill>', 'up' / 'down', #hex) and texts ('mk.*') for the shape layer; null when none.
  const shapeScene = (inst: IndInstance, def: IndDef, x: IndExtras, bars: Candle[]): ShapeScene | null => {
    if (!x.rects && !x.segs && !x.labels && !x.profiles && !x.vpVisible && !x.tpos && !x.table && !x.gauge) return null
    const cc = candleColorsRef.current
    const txt = markerTextRef.current
    // 'p:<key>' 跟图形线样式（颜色、透明度、显隐；线宽线型在 segs 里取）/ 'p:<key>' follows a shape plot's style
    const shapePlot = (c?: string | null) => {
      if (!c?.startsWith('p:')) return null
      const p = def.plots.find((k) => k.key === c.slice(2))
      return p ? plotStyle(inst, p) : null
    }
    const col = (c?: string | null): string | null => {
      if (!c) return null
      if (c.startsWith('p:')) {
        const ps = shapePlot(c)
        return ps?.visible ? resolveColor(ps.color, cc, ps.opacity) : null
      }
      if (c.startsWith('f:')) {
        const f = def.fills?.find((k) => k.key === c.slice(2))
        if (!f) return null
        const fs = fillStyle(inst, f)
        return fs.visible ? resolveColor(fs.color, cc, fs.opacity) : null
      }
      return resolveColor(c, cc, 100)
    }
    const clear = 'rgba(0,0,0,0)'
    const tx = (t: string) => (t.startsWith('mk.') ? txt[t] ?? t.slice(3) : t)
    const prof = <T extends { up: string; dn: string; vaUp: string; vaDn: string; poc: string; vah?: string; val?: string; box?: string }>(p: T): T => {
      const lines: Record<string, { width: number; dash: LineDash }> = {}
      for (const k of ['poc', 'vah', 'val'] as const) { const ps = shapePlot(p[k]); if (ps) lines[k] = { width: ps.width, dash: ps.dash } }
      return {
        ...p, up: col(p.up) ?? clear, dn: col(p.dn) ?? clear, vaUp: col(p.vaUp) ?? clear, vaDn: col(p.vaDn) ?? clear, poc: col(p.poc) ?? '',
        vah: col(p.vah) ?? undefined, val: col(p.val) ?? undefined, box: col(p.box) ?? undefined, lines,
      }
    }
    const pal = viewRef.current?.palette
    return {
      rects: (x.rects ?? []).flatMap((r) => {
        const fill = col(r.fill) ?? undefined
        const stroke = col(r.stroke) ?? undefined
        return fill || stroke ? [{ ...r, fill, stroke }] : []
      }),
      segs: (x.segs ?? []).flatMap((g) => {
        const c = col(g.color)
        if (!c) return []
        const ps = shapePlot(g.color)
        return [ps ? { ...g, color: c, width: ps.width, dash: ps.dash } : { ...g, color: c }]
      }),
      labels: (x.labels ?? []).flatMap((l) => { const c = col(l.color); return c ? [{ ...l, text: tx(l.text), color: c, bg: col(l.bg) ?? undefined }] : [] }),
      profiles: (x.profiles ?? []).map(prof),
      vp: x.vpVisible ? { ...prof(x.vpVisible), bars } : null,
      tpos: (x.tpos ?? []).map((t) => ({ ...t, color: col(t.color) ?? clear, vaColor: col(t.vaColor) ?? clear, poc: col(t.poc) ?? clear, ib: col(t.ib) })),
      table: x.table ? { pos: x.table.pos, rows: x.table.rows.map((r) => ({ k: tx(r.k), v: tx(r.v), color: col(r.color) ?? undefined })) } : null,
      gauge: x.gauge ? { value: x.gauge.value, text: tx(x.gauge.text), color: col(x.gauge.color) ?? '#e4e4e7' } : null,
      theme: pal ? { bg: resolveColor(pal.bg, cc, 92), text: pal.text, border: pal.border } : EMPTY_SCENE.theme,
    }
  }

  // 按当前 candlesRef 重算全部实例并写回，同时刷新图例的「最新值」。价格类图表（砖形等）横轴不是
  // 时间：指标改按图上的砖算（同 TradingView），否则原始 K 线的时间会混进时间轴、把砖撑开。
  // Recompute every instance and write the data back; refresh the latest-value legend. On
  // price-based types (Renko…) indicators run on the bricks, as on TradingView.
  const recomputeIndicators = useCallback(() => {
    const onBricks = priceBasedNow()
    const bars: Candle[] = onBricks
      ? shownRef.current.map((b) => ({ t: b.time as number, o: b.open, h: b.high, l: b.low, c: b.close, v: b.volume ?? 0 }))
      : candlesRef.current
    const iv = indRef.current
    const handles = instRef.current
    if (bars.length === 0 || handles.size === 0) {
      resultsRef.current = new Map()
      markersRef.current?.setMarkers([])
      zonesRef.current?.setZones([], [])
      handles.forEach((h) => { if (h.shp && h.shp.scene !== EMPTY_SCENE) h.shp.set(EMPTY_SCENE) })
      latestLegendRef.current = {}
      if (!hoveringRef.current) legendStore.set({})
      return
    }
    const list = iv.list.filter((i) => handles.has(i.uid))
    // 小周期 K 线（周期成交量分布用）：与画线的成交量分布共用一份缓存 / lower-timeframe bars (periodic volume profile), shared with the drawing tools' cache
    const intrabar = (code: string, t0: number, key: string) => intrabarBars(iv.symbol, iv.interval, t0, Infinity, key, code)?.bars ?? null
    const results = computeAll({ list, bars, interval: iv.interval, digits: iv.digits, priceBased: onBricks, symbol: iv.symbol, other: otherBars, intrabar })
    resultsRef.current = results
    const n = bars.length
    const times = bars.map((b) => b.t)
    const fut = futureTimes(times, maxFuture(results))
    const timeAt = (idx: number) => (idx < n ? times[idx] : fut[idx - n])
    const cc = candleColorsRef.current
    const next: LegendValues = {}
    const marks: SeriesMarker<UTCTimestamp>[] = []
    const zones: ZoneRect[] = []
    const strips: BarStrip[] = []
    const lastT = times[n - 1] as UTCTimestamp
    const txt = markerTextRef.current
    for (const inst of list) {
      const h = handles.get(inst.uid)!
      const r = results.get(inst.uid)
      if (!r) continue
      const def = r.def
      const shown = instShown(inst)
      const fillColor = (c: string) => {
        if (!c.startsWith('f:')) return c
        const f = def.fills?.find((x) => x.key === c.slice(2))
        return f ? fillStyle(inst, f).color : '#888888'
      }
      const row: Record<string, number | null> = {}
      for (const ph of h.plots) {
        const p = def.plots.find((x) => x.key === ph.key)!
        const st = plotStyle(inst, p)
        const vals = r.out[ph.key] ?? []
        const cIdx = r.out[`${ph.key}#c`]
        const off = r.offsets[ph.key] ?? 0
        const pal = st.colors.map((c) => resolveColor(c, cc, st.opacity))
        const data: { time: UTCTimestamp; value?: number; color?: string }[] = []
        let started = false
        for (let i = 0; i < vals.length; i++) {
          const idx = i + off
          if (idx < 0 || idx >= n + fut.length) continue
          const v = vals[i]
          const t = timeAt(idx) as UTCTimestamp
          if (v == null) {
            if (p.gaps && started) data.push({ time: t })
            continue
          }
          started = true
          const ci = cIdx?.[i]
          data.push(ci != null && pal.length ? { time: t, value: v, color: pal[ci] ?? pal[0] } : { time: t, value: v })
        }
        try { (ph.api as ISeriesApi<'Line'>).setData(data as never) } catch { /* 切换中 / switching */ }
        row[ph.key] = latestValue(r, ph.key, n)
      }
      next[inst.uid] = row
      // 参考线 / 填充 / 背景 / reference lines, fills, backgrounds
      if (h.prim) {
        const fills: FillBetween[] = []
        const bands: FillBand[] = []
        if (shown) {
          for (const f of def.fills ?? []) {
            if (!f.a || !f.b) continue
            const fs = fillStyle(inst, f)
            if (!fs.visible) continue
            const color = resolveColor(fs.color, cc, fs.opacity)
            const colorB = resolveColor(fs.colorB, cc, fs.opacity)
            if (f.a.startsWith('h:') && f.b.startsWith('h:')) {
              const ha = def.hlines?.find((x) => x.key === f.a.slice(2))
              const hb = def.hlines?.find((x) => x.key === f.b.slice(2))
              if (ha && hb) bands.push({ a: hlineStyle(inst, ha).value, b: hlineStyle(inst, hb).value, color })
              continue
            }
            const pa = def.plots.find((x) => x.key === f.a)
            const pb = def.plots.find((x) => x.key === f.b)
            if (!pa || !pb || !plotStyle(inst, pa).visible || !plotStyle(inst, pb).visible) continue
            const total = n + fut.length
            const A = new Array<number | null>(total).fill(null)
            const B = new Array<number | null>(total).fill(null)
            const oa = r.offsets[f.a] ?? 0
            const ob = r.offsets[f.b] ?? 0
            const va = r.out[f.a] ?? []
            const vb = r.out[f.b] ?? []
            for (let i = 0; i < n; i++) {
              if (i + oa >= 0 && i + oa < total) A[i + oa] = va[i] ?? null
              if (i + ob >= 0 && i + ob < total) B[i + ob] = vb[i] ?? null
            }
            fills.push({ t: [...times, ...fut], a: A, b: B, color, colorB })
          }
        }
        const bgKeys = r.extras.bg
        const bg = shown && bgKeys && bgKeys.length === n
          ? { t: times, color: bgKeys.map((k) => (k ? resolveColor(fillColor(`f:${k}`), cc, fillStyle(inst, def.fills!.find((x) => x.key === k)!).opacity) : null)) }
          : null
        h.prim.set(fills, bands, bg, !shown)
      }
      if (h.shp) {
        const scene = shown && !onBricks ? shapeScene(inst, def, r.extras, bars) : null
        if (scene) h.shp.set(scene)
        else if (h.shp.scene !== EMPTY_SCENE) h.shp.set(EMPTY_SCENE)
      }
      if (!shown) continue
      // 标记、区域、竖条只能挂在主序列上 / markers, zones and strips live on the main series
      for (const m of r.extras.markers ?? []) {
        if (m.i < 0 || m.i >= n) continue
        marks.push({ time: times[m.i] as UTCTimestamp, position: m.position, shape: m.shape, color: m.color, ...(m.price != null ? { price: m.price } : {}), text: m.text ? txt[m.text] ?? '' : '' } as SeriesMarker<UTCTimestamp>)
      }
      for (const z of r.extras.zones ?? []) if (z.i >= 0 && z.i < n) zones.push({ from: times[z.i] as UTCTimestamp, to: lastT, top: z.top, bottom: z.bottom, color: fillColor(z.color) })
      for (const s of r.extras.strips ?? []) if (s.i >= 0 && s.i < n) strips.push({ time: times[s.i] as UTCTimestamp, top: s.top, bottom: s.bottom, color: fillColor(s.color) })
    }
    // 价格类图表上信号标记的时间对不上砖块，不画（TradingView 也不在砖形图上画信号）。
    // Signal markers don't line up with bricks on price-based types; skip them there.
    marks.sort((a, b) => a.time - b.time)
    markersRef.current?.setMarkers(onBricks ? [] : marks)
    zonesRef.current?.setZones(onBricks ? [] : zones, onBricks ? [] : strips)
    latestLegendRef.current = next
    if (!hoveringRef.current) legendStore.set(next)
  // eslint-disable-next-line react-hooks/exhaustive-deps -- refs only
  }, [legendStore])
  recomputeRef.current = recomputeIndicators

  // 别的品种 / 日线到了就重算 / recompute when another symbol's or the daily bars arrive
  useEffect(() => subscribeOtherBars(() => recomputeRef.current?.()), [])
  useEffect(() => subscribeIntrabar(() => recomputeRef.current?.()), [])

  // 窗格高度：主图与各副图按权重分；折叠的固定 28px；最大化时其余全部折叠。
  // Pane heights: main and sub-panes split by weight; collapsed ones are 28px; a maximised pane
  // collapses all the others.
  const appliedRef = useRef<{ main: number; panes: Record<string, number> } | null>(null)
  const measurePanes = useCallback(() => {
    const chart = chartRef.current
    const host = containerRef.current
    if (!chart || !host) return
    const hostTop = host.getBoundingClientRect().top
    const panes = chart.panes()
    const iv = indRef.current
    const used = usedPanes(iv.list.filter((i) => instRef.current.has(i.uid)), iv.panes)
    const boxes: PaneBoxes = {}
    const box = (idx: number) => {
      const el = panes[idx]?.getHTMLElement()
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { top: Math.round(r.top - hostTop), height: Math.round(r.height) }
    }
    const m = box(0)
    if (m) boxes.main = m
    used.forEach((p, i) => { const b = box(i + 1); if (b) boxes[p.id] = b })
    tailIdsRef.current.forEach((id, j) => { const b = box(used.length + 1 + j); if (b) boxes[id] = b })
    setPaneBoxes((prev) => (JSON.stringify(prev) === JSON.stringify(boxes) ? prev : boxes))
  // eslint-disable-next-line react-hooks/exhaustive-deps -- refs only
  }, [])

  const applyPaneHeights = useCallback(() => {
    const chart = chartRef.current
    const host = containerRef.current
    if (!chart || !host) return
    const panes = chart.panes()
    const total = host.clientHeight
    const iv = indRef.current
    const used = usedPanes(iv.list.filter((i) => instRef.current.has(i.uid)), iv.panes)
    const tail = tailIdsRef.current
    if (panes.length <= 1 || total <= 0 || (used.length === 0 && tail.length === 0)) {
      appliedRef.current = null
      requestAnimationFrame(measurePanes)
      return
    }
    const max = iv.maxPane && (iv.maxPane === 'main' || used.some((p) => p.id === iv.maxPane)) ? iv.maxPane : null
    const collapsed = (id: string) => (max ? id !== max : id !== 'main' && !!used.find((p) => p.id === id)?.collapsed)
    // 尾部窗格（对比品种）排在指标窗格后面，权重默认 1，拖过分隔条后记住（不持久化）
    // Tail panes (compare) follow the indicator panes; weight 1 by default, remembered after a drag (not persisted)
    const ids = ['main', ...used.map((p) => p.id), ...tail]
    const weight = (id: string) => (id === 'main' ? iv.mainH : used.find((p) => p.id === id)?.h ?? tailWeightRef.current.get(id) ?? 1)
    const fixed = ids.filter(collapsed).length * COLLAPSED_PX
    const flex = ids.filter((id) => !collapsed(id))
    const wsum = flex.reduce((a, id) => a + weight(id), 0) || 1
    const avail = Math.max(0, total - fixed - (ids.length - 1))
    const px: Record<string, number> = {}
    for (const id of ids) px[id] = collapsed(id) ? COLLAPSED_PX : Math.max(id === 'main' ? 80 : 40, Math.floor((avail * weight(id)) / wsum))
    // 用伸缩系数而不是 setHeight：逐个 setHeight 会从相邻窗格借高度，前面设好的又被挤掉。
    // 系数取像素值本身，按比例分配后正好是这些像素。
    // Stretch factors rather than setHeight: setting heights one by one borrows from the
    // neighbouring pane and undoes the earlier ones. Using the pixel values as factors yields them.
    ids.forEach((id, i) => panes[i]?.setStretchFactor(px[id]))
    appliedRef.current = { main: px.main, panes: Object.fromEntries(used.map((p) => [p.id, px[p.id]])) }
    requestAnimationFrame(measurePanes)
  }, [containerRef, measurePanes])

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
        // 关闭库自带的 logo / library logo off
        attributionLogo: false,
        panes: { separatorColor: pal?.border ?? 'rgba(255, 255, 255, 0.07)', separatorHoverColor: 'rgba(124, 92, 255, 0.35)', enableResize: true },
      },
      grid: {
        vertLines: { color: pal?.grid ?? 'rgba(255, 255, 255, 0.045)' },
        horzLines: { color: pal?.grid ?? 'rgba(255, 255, 255, 0.045)' },
      },
      // entireTextOnly：贴着窗格上下边、会被切掉半截的刻度字不画——主图底和副图顶的两个刻度以前会叠在一起
      // entireTextOnly: skip edge tick labels that would be cut off — the main pane's bottom and a sub-pane's top label used to overlap
      rightPriceScale: { borderColor: pal?.border ?? 'rgba(255, 255, 255, 0.07)', entireTextOnly: true },
      leftPriceScale: { borderColor: pal?.border ?? 'rgba(255, 255, 255, 0.07)', visible: false, entireTextOnly: true },
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
      const next: LegendValues = {}
      instRef.current.forEach((h) => {
        const row: Record<string, number | null> = {}
        for (const p of h.plots) {
          const d = param.seriesData.get(p.api) as { value?: number } | undefined
          row[p.key] = d?.value ?? null
        }
        next[h.uid] = row
      })
      legendStore.set(next)
      const bar = param.seriesData.get(series) as MainBar | undefined
      if (bar && bar.close !== undefined) {
        const prev = param.logical != null ? (series.dataByIndex((param.logical as number) - 1) as MainBar | null) : null
        ohlcStore.set({ t: bar.time, o: bar.open, h: bar.high, l: bar.low, c: bar.close, v: bar.volume ?? 0, prev: prev && prev.close !== undefined ? prev.close : null, hovering: true })
      }
    }
    chart.subscribeCrosshairMove(onCrosshairMove)
    // 多图同步：别的格子用 setCrosshairPosition 把十字线放到这张图上时图表库不发 crosshairMove，
    // 状态行 / 指标图例要靠这里按逻辑下标补一次（null = 十字线离开）。
    // Multi-chart sync: setCrosshairPosition (driven from another cell) fires no crosshairMove, so the
    // status line / indicator legends are filled here by logical index (null = the crosshair left).
    syncAtRef.current = (logical) => {
      if (logical == null) {
        hoveringRef.current = false
        legendStore.set(latestLegendRef.current)
        publishOhlc(shownRef.current)
        return
      }
      const bar = series.dataByIndex(logical) as MainBar | null
      if (!bar || bar.close === undefined) return
      hoveringRef.current = true
      const next: LegendValues = {}
      instRef.current.forEach((h) => {
        const row: Record<string, number | null> = {}
        for (const pl of h.plots) {
          const d = pl.api.dataByIndex(logical) as { value?: number; time?: unknown } | null
          row[pl.key] = d && d.time === bar.time ? d.value ?? null : null
        }
        next[h.uid] = row
      })
      legendStore.set(next)
      const prev = series.dataByIndex(logical - 1) as MainBar | null
      ohlcStore.set({ t: bar.time, o: bar.open, h: bar.high, l: bar.low, c: bar.close, v: bar.volume ?? 0, prev: prev && prev.close !== undefined ? prev.close : null, hovering: true })
    }

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

    // 鼠标滚轮停在价格轴上 = 纵向拉伸 / 压缩那个窗格的价格轴（以可见区间中点为轴心，对数坐标按对数算），
    // 不再横向缩放时间轴；双击价格轴或右键「自动缩放」恢复。挂在外层捕获阶段：轴上叠着的警报标签、
    // 画线层也算在内；落在菜单 / 弹窗 / 输入框上的滚轮不管。
    // The wheel over a price axis stretches / squeezes that pane's price scale (around the visible
    // range's midpoint, in log space for log scales) instead of zooming time; double-clicking the axis
    // or "auto scale" restores it. Captured on the host so tags / the draw layer over the axis count too;
    // wheels over menus, dialogs and inputs are left alone.
    const wheelHost = el.parentElement ?? el
    const onAxisWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.deltaY === 0 || !isChartAlive(chart)) return
      const tgt = e.target as HTMLElement | null
      if (tgt?.closest?.('[role="menu"], [role="dialog"], .indl-menu, input, textarea, select')) return
      const r = el.getBoundingClientRect()
      const x = e.clientX - r.left
      let y = e.clientY - r.top
      if (x < 0 || x > r.width || y < 0) return
      const rw = chart.priceScale('right').width()
      const lw = chart.priceScale('left').width()
      const side = rw > 0 && x >= r.width - rw ? 'right' : lw > 0 && x <= lw ? 'left' : null
      if (!side) return
      const panes = chart.panes()
      let idx = -1
      for (let i = 0; i < panes.length; i++) {
        const h = panes[i].getHeight()
        if (y < h) { idx = i; break }
        y -= h + 1
      }
      if (idx < 0 || panes[idx].getHeight() < 8) return
      let ps: ReturnType<typeof chart.priceScale>
      try { ps = chart.priceScale(side, idx) } catch { return }
      const vr = ps.getVisibleRange()
      if (!vr || !Number.isFinite(vr.from) || !Number.isFinite(vr.to) || vr.to === vr.from) return
      e.preventDefault()
      e.stopPropagation()
      const px = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY
      // 往下滚 = 压缩（区间变大），往上滚 = 拉伸；单次夹在 ×0.7–×1.4 / down squeezes, up stretches; clamped per event
      const k = Math.min(1.4, Math.max(0.7, Math.exp(px * 0.002)))
      const log = ps.options().mode === PriceScaleMode.Logarithmic && vr.from > 0 && vr.to > 0
      const f = log ? Math.log : (v: number) => v
      const g = log ? Math.exp : (v: number) => v
      const a = f(vr.from), b = f(vr.to), mid = (a + b) / 2, half = ((b - a) / 2) * k
      if (!Number.isFinite(half) || Math.abs(half) < 1e-12) return
      ps.setAutoScale(false)
      ps.setVisibleRange({ from: g(mid - half), to: g(mid + half) })
    }
    wheelHost.addEventListener('wheel', onAxisWheel, { capture: true, passive: false })

    // 用户拖了窗格分隔条：读回各窗格高度，交给页面存成新的权重。
    // The user dragged a pane separator: read the heights back and let the page store new weights.
    const onUp = () => {
      requestAnimationFrame(() => {
        const applied = appliedRef.current
        const iv = indRef.current
        if (!applied || iv.maxPane) return
        const panes = chart.panes()
        const used = usedPanes(iv.list.filter((i) => instRef.current.has(i.uid)), iv.panes)
        const main = panes[0]?.getHeight() ?? applied.main
        const now: Record<string, number> = {}
        used.forEach((p, i) => { now[p.id] = panes[i + 1]?.getHeight() ?? applied.panes[p.id] })
        // 尾部窗格的高度只记在引擎里（权重 = 像素 / 100，与页面存指标窗格的口径一致）
        // Tail pane heights stay in the engine (weight = px / 100, the page's scale for indicator panes)
        tailIdsRef.current.forEach((id, j) => {
          const hpx = panes[used.length + 1 + j]?.getHeight()
          if (hpx && hpx > 0) tailWeightRef.current.set(id, Math.max(0.1, hpx / 100))
        })
        const moved = Math.abs(main - applied.main) > 2 || used.some((p) => !p.collapsed && Math.abs(now[p.id] - applied.panes[p.id]) > 2)
        if (!moved) return
        appliedRef.current = { main, panes: now }
        onPaneResizeRef.current?.(main, Object.fromEntries(used.filter((p) => !p.collapsed).map((p) => [p.id, now[p.id]])))
        measurePanes()
      })
    }
    el.addEventListener('pointerup', onUp)

    return () => {
      ro.disconnect()
      wheelHost.removeEventListener('wheel', onAxisWheel, { capture: true })
      el.removeEventListener('pointerup', onUp)
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
      instRef.current = new Map()
      tailIdsRef.current = []
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
      layout: { background: { type: ColorType.Solid, color: pal.bg }, textColor: pal.text, panes: { separatorColor: pal.border } },
      grid: {
        vertLines: { color: pal.grid, visible: view.grid === 'both' || view.grid === 'vert' },
        horzLines: { color: pal.grid, visible: view.grid === 'both' || view.grid === 'horz' },
      },
      crosshair: { mode: cross === 'magnet' ? CrosshairMode.Magnet : cross === 'hidden' ? CrosshairMode.Hidden : CrosshairMode.Normal, vertLine: lineOpts, horzLine: lineOpts },
      rightPriceScale: { borderColor: pal.border, mode: scaleOverrideRef.current ?? view.scaleMode, invertScale: view.invertScale },
      leftPriceScale: { borderColor: pal.border },
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

  // 换图表类型 / 变换参数：全量重画 + 指标重算。进出砖形等价格类图表时根数会变很多，旧的可见范围
  // 会把新数据挤在最右边，这时重置到最后 150 根；根数很少时按 60 根的宽度靠右放（同 TradingView）。
  // Chart type / transform parameters: full redraw + recompute. Entering or leaving price-based
  // types changes the bar count a lot, so the view resets to the last 150 bars; very few bars are
  // laid out at a 60-bar width aligned right, as TradingView does.
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

  // ── 指标结构：实例、所在窗格、线型、价格轴。变了就全部重建。──
  // ── Indicator structure: instances, panes, plot kinds, price scales. Any change rebuilds all. ──
  const structKey = (() => {
    const used = usedPanes(ind.list, ind.panes)
    return JSON.stringify([
      used.map((p) => p.id),
      ind.list.map((i) => {
        const def = defOf(i.type)
        if (!def) return null
        return [i.uid, i.pane, scaleIdOf(i, def), def.plots.map((p) => plotStyle(i, p).kind)]
      }),
    ])
  })()
  useEffect(() => {
    const chart = chartRef.current
    const main = seriesRef.current
    if (!chart || !main) return
    // 拆（尾部窗格先拆，免得指标窗格被删后它挪到指标的下标上）
    // Tear down (tail panes first, so they don't slide into the indicator pane indices)
    tailHostRef.current?.detach()
    instRef.current.forEach((h) => {
      if (h.prim && h.host) { try { h.host.detachPrimitive(h.prim) } catch { /* 已随 series 删除 / gone with its series */ } }
      if (h.shp && h.host) { try { h.host.detachPrimitive(h.shp) } catch { /* 同上 / same */ } }
      h.plots.forEach((p) => { try { chart.removeSeries(p.api) } catch { /* noop */ } })
    })
    instRef.current = new Map()
    const iv = indRef.current
    const used = usedPanes(iv.list, iv.panes)
    const order: { inst: IndInstance; pane: number }[] = []
    for (const inst of iv.list) {
      const def = defOf(inst.type)
      if (!def) continue
      if (inst.pane === 'main' || !seriesPlots(def) || !used.some((p) => p.id === inst.pane)) order.push({ inst, pane: 0 })
    }
    used.forEach((p, k) => { for (const inst of iv.list) { const d = defOf(inst.type); if (inst.pane === p.id && d && seriesPlots(d)) order.push({ inst, pane: k + 1 }) } })
    let anyLeft = false
    for (const { inst, pane } of order) {
      const def = defOf(inst.type)!
      // 只当图形样式用的线不建序列 / style-only shape plots get no series
      const plots: PlotHandle[] = def.plots.filter((p) => !p.shape).map((p) => {
        const kind = plotStyle(inst, p).kind
        const api = chart.addSeries(seriesTypeOf(kind) as typeof LineSeries, plotOptions(inst, def, p.key) as never, pane) as unknown as PlotApi
        return { key: p.key, kind, api }
      })
      if (scaleIdOf(inst, def) === 'none' || scaleIdOf(inst, def).startsWith('ind-')) {
        // 自己的价格轴：叠在主图的副图指标贴底，占下面四分之一 / own scale: oscillators on main hug the bottom quarter
        const first = plots[0]?.api
        if (first) first.priceScale().applyOptions({ entireTextOnly: true, scaleMargins: inst.pane === 'main' && !def.overlay ? { top: 0.75, bottom: 0 } : { top: 0.1, bottom: 0.1 } })
      }
      if (scaleIdOf(inst, def) === 'left') anyLeft = true
      const host: ISeriesApi<SeriesType> = plots[0]?.api ?? main
      const prim = new IndFillPrimitive()
      host.attachPrimitive(prim)
      const shp = new IndShapePrimitive()
      host.attachPrimitive(shp)
      instRef.current.set(inst.uid, { uid: inst.uid, pane: pane === 0 ? 'main' : inst.pane, plots, host, prim, shp, lines: [] })
    }
    indLeftRef.current = anyLeft
    chart.applyOptions({ leftPriceScale: { visible: anyLeft || leftClaimRef.current } })
    indPaneCountRef.current = used.length
    tailIdsRef.current = tailHostRef.current?.attach(used.length + 1) ?? []
    applyStyles()
    applyPaneHeights()
    recomputeIndicators()
  // eslint-disable-next-line react-hooks/exhaustive-deps -- structKey encodes exactly what forces a rebuild
  }, [structKey, drawReady])

  // 只改样式：颜色、线宽、显隐、精度、参考线 / style-only updates: colours, widths, visibility, precision, hlines
  const applyStyles = useCallback(() => {
    const iv = indRef.current
    for (const inst of iv.list) {
      const h = instRef.current.get(inst.uid)
      const def = defOf(inst.type)
      if (!h || !def) continue
      for (const p of h.plots) {
        try { (p.api as ISeriesApi<'Line'>).applyOptions(plotOptions(inst, def, p.key) as never) } catch { /* noop */ }
      }
      const host = h.plots[0]?.api
      if (host) {
        h.lines.forEach((l) => { try { host.removePriceLine(l) } catch { /* noop */ } })
        h.lines = []
        if (instShown(inst)) {
          // 不占价格轴（叠加在主图上）时参考线不在轴上标数字，免得和价格刻度混在一起
          // With no price scale (overlaid on the main pane) hlines get no axis label, so they don't mix with price ticks
          const onAxis = (inst.scale ?? (inst.pane === 'main' && !def.overlay ? 'none' : 'right')) !== 'none'
          for (const hd of def.hlines ?? []) {
            const st = hlineStyle(inst, hd)
            if (!st.visible) continue
            h.lines.push(host.createPriceLine({
              price: st.value, color: resolveColor(st.color, candleColorsRef.current, st.opacity), lineWidth: 1, lineStyle: DASH[st.dash], axisLabelVisible: onAxis, title: '',
            }))
          }
        }
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- refs only
  }, [plotOptions])

  const indicatorLabels = view?.indicatorLabels ?? false
  const styleKey = JSON.stringify(ind.list.map((i) => [i.styles, i.hidden, i.precision, i.labels, i.vis]))
  useEffect(() => {
    applyStyles()
    recomputeIndicators()
  }, [styleKey, indicatorLabels, ind.digits, ind.interval, applyStyles, recomputeIndicators])

  // 输入变了只重算 / inputs changed: recompute only
  const inputsKey = JSON.stringify(ind.list.map((i) => [i.inputs, i.tf, i.tfWait]))
  useEffect(() => { recomputeIndicators() }, [inputsKey, recomputeIndicators])

  // 窗格高度 / 折叠 / 最大化 / pane heights, collapse, maximise
  const heightKey = JSON.stringify([ind.mainH, ind.panes, ind.maxPane])
  useEffect(() => { applyPaneHeights() }, [heightKey, applyPaneHeights])

  // 换 K 线颜色：改主序列选项并重画（每根 bar 自带最新价标签颜色）；跟随涨跌色的指标一起换。
  // Candle colours: update the main series and redraw; indicators following up/down colours follow.
  const lineColorKey = view?.lineColor
  useEffect(() => {
    candleColorsRef.current = candleColors
    seriesRef.current?.applyOptions({
      upColor: candleColors.up, downColor: candleColors.down,
      wickUpColor: candleColors.up, wickDownColor: candleColors.down,
      borderUpColor: candleColors.up, borderDownColor: candleColors.down,
    })
    if (candlesRef.current.length > 0) renderAll()
    applyStyles()
    recomputeIndicators()
  }, [candleColors, lineColorKey, renderAll, recomputeIndicators, applyStyles])

  const markerKey = JSON.stringify(markerText)
  useEffect(() => {
    recomputeIndicators()
  }, [markerKey, recomputeIndicators])

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

  const getResults = useCallback(() => resultsRef.current, [])

  // ──── 阶段 6：对比品种 / phase 6: compare symbols ────
  // 主价格轴模式的临时覆盖（null = 回到设置里的模式）。不改用户设置，撤掉覆盖就是原样恢复。
  // Temporary override of the main price-scale mode (null = back to the setting). The user's
  // setting is never written, so dropping the override restores it exactly.
  const setScaleOverride = useCallback((m: ScaleMode | null) => {
    if (scaleOverrideRef.current === m) return
    scaleOverrideRef.current = m
    const mode = m ?? viewRef.current?.scaleMode ?? 0
    try { chartRef.current?.priceScale('right').applyOptions({ mode }) } catch { /* 图表已销毁 / disposed */ }
  }, [])
  // 认领 / 释放左侧价格轴（对比品种的 scale 模式）/ claim / release the left price scale (compare in scale mode)
  const setLeftScaleClaim = useCallback((on: boolean) => {
    if (leftClaimRef.current === on) return
    leftClaimRef.current = on
    try { chartRef.current?.applyOptions({ leftPriceScale: { visible: indLeftRef.current || on } }) } catch { /* disposed */ }
  }, [])
  const indicatorsUseLeft = useCallback(() => indLeftRef.current, [])
  // 登记尾部窗格的宿主（null = 撤销；撤销前宿主自己要先 detach）/ register the tail-pane host (null = unregister; detach first)
  const setTailPaneHost = useCallback((h: TailPaneHost | null) => { tailHostRef.current = h }, [])
  // 尾部窗格变了（增删 / 换顺序）：拆了按顺序重建，再重分高度 / tail panes changed: rebuild in order, then re-split heights
  const relayoutTailPanes = useCallback(() => {
    if (!chartRef.current) return
    const host = tailHostRef.current
    host?.detach()
    tailIdsRef.current = host?.attach(indPaneCountRef.current + 1) ?? []
    applyPaneHeights()
  }, [applyPaneHeights])

  return {
    chartRef, seriesRef, candlesRef, lastTimeRef, barTimesRef, getBarTimes,
    loadingOlderRef, hasMoreHistoryRef, isFollowingLiveRef,
    legendStore, ohlcStore, paneBoxes, drawReady, getResults,
    recomputeIndicators, applyPaneHeights, renderAll, renderTail,
    setScaleOverride, setLeftScaleClaim, indicatorsUseLeft, setTailPaneHost, relayoutTailPanes,
    syncLegendAt,
  }
}

function hexAlpha(hex: string, a: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex)
  if (!m) return hex
  const n = parseInt(m[1], 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`
}

export type ChartEngine = ReturnType<typeof useChartEngine>
