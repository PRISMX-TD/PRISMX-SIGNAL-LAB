// 一张图（多图布局里的一格，阶段 6 从 pages/ChartsPage.tsx 拆出）：图表容器、引擎、数据、实时收盘、
// 画线层、图上各浮层、交易日分隔线、区域放大、测量、跳转 / 区间快捷键，以及这一格自己的品种 / 周期 /
// 指标窗格最大化。页面保留账户与交易、两套外壳、自选、弹窗与图表偏好；页面级的工具条、快捷键、
// 右键菜单经 ChartPaneHandle 作用在「当前格」上。单图时页面只挂一格，外观与行为和拆分前一样。
// One chart (one cell of a multi-chart layout; split out of pages/ChartsPage.tsx in phase 6): the chart
// container, engine, data, live close, drawing layer, the on-chart overlays, session breaks, zoom-in area,
// measure, go-to / range presets, and the cell's own symbol / interval / maximised indicator pane. The
// page keeps accounts and trading, both shells, the watchlist, dialogs and the chart prefs; its toolbars,
// hotkeys and context menu act on the active cell through ChartPaneHandle. With one chart the page mounts
// a single cell that looks and behaves exactly as before the split.
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, useSyncExternalStore, type ComponentProps, type ReactNode } from 'react'
import type { IChartApi, LogicalRange, Time } from 'lightweight-charts'
import { useTranslation } from 'react-i18next'
import type { Order, Quote } from '../../api/types'
import { brokerSymbol, localizeApiError } from '../../api/utils'
import { useAccountQuotesSelect, useGlobalQuote, useGlobalQuotesSelect, usePendingOrders, usePositions } from '../../store/live'
import { useBackToClose } from '../../utils/useBackToClose'
import { isAppHidden } from '../../utils/appVisibility'
import { serverNowMs } from '../../utils/serverClock'
import type { SymbolSpec } from '../order/orderMath'
import DrawLayer, { type DrawLayerHandle } from './DrawLayer'
import PositionOverlay, { type DraftRequest } from './PositionOverlay'
import ExecutionMarkers from './trade/ExecutionMarkers'
import TradeButtons from './trade/TradeButtons'
import PlusOrderButton from './trade/PlusOrderButton'
import type { ChartPlace, ChartPlaceReq } from './trade/useTradeActions'
import BarCountdown from './BarCountdown'
import ChartLegend from './ChartLegend'
import PaneLegends, { type LegendActions } from './ind/PaneLegends'
import { defOf } from './ind/registry'
import { duplicateInstance, moveInstance, movePane, removeInstance, removePane, setPane, updateInstance } from './ind/store'
import type { IndLayout } from './ind/types'
import type { IndLayoutUpdate } from './ind/useIndLayout'
import ChartPriceLines from './ChartPriceLines'
import AlertLines from './alert/AlertLines'
import type { AlertInit } from './alert/AlertDialog'
import MeasureOverlay from './MeasureOverlay'
import BackToLatest from './BackToLatest'
import { ProZoomBox } from './pro/ProZoom'
import type { CtxState } from './ChartContextMenu'
import { RANGE_INTERVAL, rangeFrom, type RangeKey } from './ChartBottomBar'
import { SessionBreaks } from './sessionBreaks'
import { composeScreenshot, copyScreenshot, saveScreenshot, type ShotResult } from './chartScreenshot'
import type { ChartPalette, ChartThemeName } from './chartTheme'
import { makeTimeFormatters } from './chartTime'
import { PRICE_BASED_TYPES, type ChartPrefs, type ChartType } from './chartPrefs'
import { intervalKind, intervalLabel } from './intervals'
import { useChartEngine, type ChartView, type IndView } from './useChartEngine'
import { useChartData, withLiveClose } from './useChartData'
import { FALLBACK_DECIMALS, MAX_CLIENT_BARS, intervalSeconds, resolvePriceDigits, type CandleColors } from './chartConfig'
import type { DayStats } from './SymbolHeader'
import type { CompareEntry } from './layout/paneState'
import type { SyncBus } from './layout/syncBus'
import type { IndInstance } from './ind/types'
import type { LegendStore } from './legendStore'
import type { OhlcStore } from './ohlcStore'
import type { ReplayApi } from './useChartData'
import ReplayBar from './replay/ReplayBar'
import ReplaySelectOverlay from './replay/ReplaySelectOverlay'
import { useCompare, type CompareHandle } from './compare/useCompare'
import CompareLegend from './compare/CompareLegend'
import EconEventsLayer from './events/EconEventsLayer'
import { useChartSpec } from './pro/symbolMeta'

// ── 按账户过滤的持仓 / 挂单（页面的停靠区也用）/ positions / pending orders scoped to an account (the page's dock uses them too) ──
export function useScopedPositions(scopeLogin: string | null) {
  const positions = usePositions()
  return useMemo(
    () => (scopeLogin ? positions.filter((p) => String(p.login ?? '') === String(scopeLogin)) : positions),
    [positions, scopeLogin],
  )
}
export function useScopedPendingOrders(scopeLogin: string | null) {
  const pendingOrders = usePendingOrders()
  return useMemo(
    () => (scopeLogin ? pendingOrders.filter((o) => String(o.login ?? '') === String(scopeLogin)) : pendingOrders),
    [pendingOrders, scopeLogin],
  )
}

// 下单账户这个品种的券商合约规格（拖动读数、盈亏换算用）。只订阅三个数拼成的字符串，跳价不重渲染。
// The trading account's contract spec for the symbol (readouts, P/L maths). Subscribes to a
// string of the three numbers only, so ticks don't re-render.
export function useSymbolSpec(login: string | null, symbol: string): SymbolSpec {
  const key = useAccountQuotesSelect((m) => {
    if (!login) return ''
    const q = m[login]?.[symbol] ?? m[login]?.[brokerSymbol(symbol)]
    return q && q.tickSize && q.tickValue ? `${q.contractSize ?? 0}|${q.tickSize}|${q.tickValue}` : ''
  })
  // 账户报价里没有规格时退回 /chart/spec（每个品种只拉一次，见 pro/symbolMeta.ts）
  // Without an account-quote spec, fall back to /chart/spec (fetched once per symbol, see pro/symbolMeta.ts)
  const { data: chartSpec } = useChartSpec(key || !symbol ? null : symbol)
  return useMemo(() => {
    if (!key) {
      const s = chartSpec
      if (!s || !s.tickSize || !s.tickValue) return undefined
      return { contractSize: s.contractSize && s.contractSize > 0 ? s.contractSize : undefined, tickSize: s.tickSize, tickValue: s.tickValue }
    }
    const [c, ts, tv] = key.split('|').map(Number)
    return { contractSize: c > 0 ? c : undefined, tickSize: ts, tickValue: tv }
  }, [key, chartSpec])
}

type OverlayProps = Omit<ComponentProps<typeof PositionOverlay>, 'positions' | 'pendingOrders' | 'spec'> & { scopeLogin: string | null }
function LiveOverlay({ scopeLogin, ...rest }: OverlayProps) {
  const positions = useScopedPositions(scopeLogin)
  const pendingOrders = useScopedPendingOrders(scopeLogin)
  const spec = useSymbolSpec(rest.login, rest.symbol)
  return <PositionOverlay {...rest} spec={spec} positions={positions} pendingOrders={pendingOrders} />
}

type ExecProps = Omit<ComponentProps<typeof ExecutionMarkers>, 'positions'> & { scopeLogin: string | null }
function LiveExecutions({ scopeLogin, ...rest }: ExecProps) {
  const positions = useScopedPositions(scopeLogin)
  return <ExecutionMarkers {...rest} positions={positions} />
}

// 实时 K 线收盘：券商 bid 一跳，最新一根的 close 立刻跟着动，并把 bid 留给轮询用。
// 跨过 K 线边界后的第一跳直接在本地开新 bar（o=h=l=c=bid），不再等开盘后 ~3.3 秒的边界补拉
// 才"卡一下"冒出来；零额外请求，随后的轮询按同一时间戳覆盖校正 O/H/L。只对按 epoch 对齐的
// 周期（intervalSeconds）做，4H / 日线边界取决于券商时区，仍靠轮询。
// Live bar close: each broker bid tick moves the forming bar's close and is kept for the poll.
// The first tick past a bar boundary opens the new bar locally (o=h=l=c=bid) instead of waiting
// ~3.3s for the boundary poll (the visible "hitch"); no extra requests, and the next poll
// overwrites it by timestamp. Epoch-aligned intervals only; 4H / daily still rely on the poll.
// dataKeyRef：图表里现有 K 线属于哪个「品种|周期」（useChartData 写）。切品种时本组件（子）的
// effect 先于页面清空旧数据执行，不比对的话新品种的 bid 会被钉到旧品种最后一根上，拉出一根巨柱。
// dataKeyRef: which "symbol|interval" the loaded candles belong to (written by useChartData). On a
// symbol switch this child's effect runs before the page clears the old data; without the check the
// new symbol's bid was stamped onto the old symbol's last bar, drawing one giant candle.
function LiveBarSync({ symbol, interval, engine, liveBidRef, dataKeyRef }: { symbol: string; interval: string; engine: ReturnType<typeof useChartEngine>; liveBidRef: { current: number | null }; dataKeyRef: { current: string } }) {
  const bid = useGlobalQuote(symbol)?.bid ?? null
  // 上一次处理过的 bid。engine 每次渲染都是新对象，页面一重渲染本 effect 就重跑——只有 bid 真的
  // 变了才算一跳。以前重跑也照样开新 bar：页面在后台时全站报价不更新（live.tsx 丢弃后台帧），
  // 可页面仍在重渲染，每过一个边界就拿过期 bid 开一根 o=h=l=c 的 bar，图上一排横线、刷新才好
  // （2026-11-25 用户截图）。
  // The last bid handled. engine is a new object every render, so this effect re-runs whenever
  // the page re-renders; only a real bid change counts as a tick. Re-runs used to open bars too:
  // while hidden the site-wide quotes freeze (live.tsx drops background frames) but the page still
  // re-renders, so each boundary opened an o=h=l=c bar from the stale bid — a row of flat dashes
  // until refresh (2026-11-25 user report).
  const handledBidRef = useRef<number | null>(null)
  useEffect(() => { liveBidRef.current = null; handledBidRef.current = null }, [symbol, liveBidRef])
  useEffect(() => {
    liveBidRef.current = bid
    const isTick = bid !== handledBidRef.current
    handledBidRef.current = bid
    if (!isTick || isAppHidden()) return
    const arr = engine.candlesRef.current
    const series = engine.seriesRef.current
    if (bid == null || !series || arr.length === 0 || dataKeyRef.current !== `${symbol}|${interval}`) return
    const last = arr[arr.length - 1]
    if (last.t !== engine.lastTimeRef.current) return
    const iv = intervalSeconds(interval)
    if (iv != null) {
      // 用服务器校准过的时钟：手机时间不准时，Date.now() 会把新 bar 开早 / 开晚。
      // Server-calibrated clock: a skewed device clock opened bars early / late with Date.now().
      const openT = Math.floor(serverNowMs() / 1000 / iv) * iv
      // 只开紧挨着的下一根：差太多说明数据断档 / 休市，交给轮询。
      // Only the immediately next bar; a bigger gap means a data hole / closed market — leave it to the poll.
      if (openT === last.t + iv) {
        // 开盘价取上一根的收盘（边界前最后一跳），而不是边界后这一跳：报价是连续的，真实开盘价
        // 几乎就是它；用 bid 做 o=h=l=c 会画出一条悬空的横线，等轮询回来再"跳"成正常蜡烛。
        // Open at the previous close (the last tick before the boundary), not this tick: quotes
        // are continuous, so that is ~the real open. o=h=l=c=bid drew a floating dash that then
        // "jumped" into a normal candle when the poll landed.
        const o = last.c
        const bar = { t: openT, o, h: Math.max(o, bid), l: Math.min(o, bid), c: bid, v: 0 }
        arr.push(bar)
        if (arr.length > MAX_CLIENT_BARS) arr.shift()
        engine.lastTimeRef.current = openT
        engine.renderTail()
        engine.recomputeIndicators()
        // 不自动滚回最新：最新一根在屏幕内时图表库自己右移 / no auto scroll-back: the library shifts while the last bar is visible
        return
      }
      // 最后一根已经是好几根之前的了（App 冻在后台刚回来）：别把现价钉到它身上——那会把一根旧蜡烛
      // 拉成一根几十点的大阳线，看着像跳空（2026-10-08 100502 截图）。等轮询发现缺口、重拉尾部历史。
      // The last bar is several bars old (the app just came back from being frozen): don't pin the
      // live bid onto it — that stretched an old candle into a tall bar that looked like a gap
      // (2026-10-08, login 100502). The poll spots the hole and refills the tail.
      if (openT > last.t + iv) return
    }
    const next = withLiveClose(last, bid)
    if (next.c === last.c && next.h === last.h && next.l === last.l) return
    arr[arr.length - 1] = next
    engine.renderTail()
  }, [bid, symbol, interval, engine, liveBidRef, dataKeyRef])
  return null
}

// 一格报给页面的动态状态（页面的报价条、下单票、画线栏、底栏按当前格显示）。
// The dynamic state a cell reports to the page (the page's quote strip, ticket, draw bar and bottom bar follow the active cell).
export interface PaneInfo {
  hasData: boolean
  stale: boolean
  lastPrice: number
  dayStats: DayStats | null
  drawReady: boolean
  canZoomOut: boolean
  rangeBusy: boolean
  // 阶段 6：回放、对比、数据窗口要用的（页面的顶栏按钮 / 右栏数据窗口按当前格显示）
  // Phase 6: replay, compare and the data window (the page's top-bar buttons / data widget follow the active cell)
  replay: ReplayApi | null
  compare: CompareHandle | null
  ohlcStore: OhlcStore | null
  legendStore: LegendStore | null
  // 实际画在图上的指标（会员过滤后）/ the indicators actually drawn (after the membership filter)
  list: IndInstance[]
  symbol: string
  interval: string
  decimals: number
}
export const EMPTY_PANE_INFO: PaneInfo = {
  hasData: false, stale: false, lastPrice: 0, dayStats: null, drawReady: false, canZoomOut: false, rangeBusy: false,
  replay: null, compare: null, ohlcStore: null, legendStore: null, list: [], symbol: '', interval: '', decimals: FALLBACK_DECIMALS,
}
export const samePaneInfo = (a: PaneInfo, b: PaneInfo) =>
  (Object.keys(a) as (keyof PaneInfo)[]).every((k) => a[k] === b[k])

// 页面对当前格下的命令 / what the page can ask of a cell
export interface ChartPaneHandle {
  container: () => HTMLDivElement | null
  drawLayer: () => DrawLayerHandle | null
  chart: () => IChartApi | null
  focus: () => void
  resetView: () => void
  autoScale: () => void
  goToTime: (ts: number) => Promise<void>
  applyRange: (k: RangeKey) => void
  takeShot: (mode: 'save' | 'copy') => Promise<void>
  zoomOut: () => void
  openDraft: (side: 'BUY' | 'SELL', price: number, sl?: number | null, tp?: number | null) => void
}

// 多空仓位工具「下单」需要的这一格的上下文 / the cell context the long/short tool's order button needs
export interface DrawOrderCtx {
  symbol: string
  exactDigits: number | null
  decimals: number
  openDraft: ChartPaneHandle['openDraft']
}
export type DrawOrderReq = { side: 'BUY' | 'SELL'; price: number; sl: number; tp: number; volume: number | null }

// 各格共用的环境（页面算好一次传下来）/ the environment shared by every cell (computed once by the page)
export interface PaneEnv {
  cprefs: ChartPrefs
  candleColors: CandleColors
  dirColors: { up: string; down: string }
  palette: ChartPalette
  themeName: ChartThemeName
  lang: string
  markerText: Record<string, string>
  isPro: boolean
  isDesktop: boolean
  pro: boolean
  // 买卖按钮（不含全屏这一项，全屏只在当前格）/ buy / sell buttons (fullscreen is added for the active cell only)
  tradeButtons: boolean
  showPositions: boolean
  setShowPositions: (v: boolean) => void
  showCountdown: boolean
  scopeLogin: string | null
  tradeLogin: string | null
  accountLogin: string | null
  balance: number | null
  currency: string
  accountOrders: Order[]
  quotesDown: boolean
  peekQuotes: () => Record<string, Quote>
  showToast: (msg: string, kind?: 'success' | 'error' | 'info') => void
  place: (symbol: string, r: ChartPlaceReq) => Promise<Order | void>
  drawToOrder: (ctx: DrawOrderCtx, o: DrawOrderReq) => void
  openAlert: (init: AlertInit) => void
  bumpDraw: () => void
  onContextMenu: (ctx: CtxState) => void
  // 打开指标设置（图例上的齿轮）/ open an indicator's settings (the legend's gear)
  onEditInd: (uid: string) => void
  syncBus: SyncBus | null
  // 打开某一格的对比设置（图例上的齿轮 / 双击）/ open a cell's compare settings (legend gear / double-click)
  openCompare: (idx: number) => void
}

interface Props {
  idx: number
  env: PaneEnv
  symbol: string
  interval: string
  // 这一格的图表类型（不填 = 跟全局）/ this cell's chart type (absent = the global one)
  chartType?: ChartType
  ind: IndLayout
  updateInd: (u: IndLayoutUpdate) => void
  // 区间快捷键要先换周期 / range presets switch the interval first
  onInterval: (code: string) => void
  active: boolean
  multi: boolean
  hidden: boolean
  // 多图时这一格的 grid-area / this cell's grid-area in a multi-chart grid
  area?: string
  maximised: boolean
  fullscreen: boolean
  measureOn: boolean
  zoomOn: boolean
  onMeasureDone: () => void
  onZoomEnd: () => void
  onActivate: (idx: number) => void
  onToggleMax: (idx: number) => void
  onInfo: (idx: number, info: PaneInfo) => void
  // 只挂在当前格里的页面部件：top 排在图表容器前，end 排在最后（与拆分前的 DOM 顺序一致）
  // Page parts mounted in the active cell only: top before the chart container, end last (the pre-split DOM order)
  extrasTop?: ReactNode
  extrasEnd?: ReactNode
  // 对比品种（对比模块负责画，这里只透传与持久化）/ compare symbols (drawn by the compare module; passed through / persisted here)
  compare?: CompareEntry[]
  onCompareChange?: (idx: number, c: CompareEntry[]) => void
  // 专业版右栏「对象树」面板的容器（只给当前格）/ the pro right panel's object-tree host (active cell only)
  treeHost?: HTMLElement | null
}
const NO_COMPARE: CompareEntry[] = []

// 所有窗格的价格轴回到自动缩放（某个窗格没有左轴就跳过）/ auto-scale every pane's price scales (a pane without a side is skipped)
function autoAllScales(c: IChartApi) {
  c.panes().forEach((_, i) => {
    for (const side of ['right', 'left'] as const) {
      try { c.priceScale(side, i).applyOptions({ autoScale: true }) } catch { /* 该窗格没有这一侧 / no such scale */ }
    }
  })
}

function ChartPane(p: Props, ref: React.Ref<ChartPaneHandle>) {
  const { idx, env, symbol, interval, ind, updateInd, active, multi } = p
  const { t } = useTranslation()
  const { cprefs, palette, isDesktop } = env
  const containerRef = useRef<HTMLDivElement>(null)
  const chartBoxRef = useRef<HTMLDivElement>(null)
  const drawLayerRef = useRef<DrawLayerHandle>(null)

  // 这一格品种的价格精度（只订阅这个原始值，跳价不重渲染）/ this cell's precision (a raw value; ticks don't re-render)
  const exactDigits = useGlobalQuotesSelect((q) => resolvePriceDigits(symbol, symbol ? q[symbol] : undefined))
  const decimals = exactDigits ?? FALLBACK_DECIMALS
  const chartType = (p.chartType as ChartType | undefined) ?? cprefs.chartType

  // 指标：按会员过滤 + 这一格自己的最大化窗格 / indicators: membership filter + this cell's maximised pane
  const shownList = useMemo(
    () => (env.isPro ? ind.list : ind.list.filter((i) => !defOf(i.type)?.pro)),
    [ind.list, env.isPro],
  )
  const [maxPane, setMaxPane] = useState<string | null>(null)
  useBackToClose(maxPane != null, () => setMaxPane(null))
  // 指标全删了 / 窗格没了：最大化跟着取消 / all indicators removed or the pane gone: drop the maximise
  useEffect(() => {
    if (maxPane == null) return
    if (ind.list.length === 0 || (maxPane !== 'main' && !ind.panes.some((x) => x.id === maxPane))) setMaxPane(null)
  }, [maxPane, ind.list.length, ind.panes])

  const ivKind = intervalKind(interval)
  const timeFmt = useMemo(() => makeTimeFormatters(cprefs.timezone, ivKind, env.lang), [cprefs.timezone, ivKind, env.lang])
  const drawFmtTime = useCallback((x: number) => timeFmt.crosshair(x as Time), [timeFmt])
  const drawTheme = useMemo(() => ({ bg: palette.bg, text: palette.text }), [palette.bg, palette.text])
  const watermark = cprefs.canvas.watermark && symbol ? `${symbol} · ${intervalLabel(interval)}` : null
  const view = useMemo<ChartView>(() => ({
    chartType,
    palette,
    candle: cprefs.candle,
    lineWidth: cprefs.lineWidth,
    lineColor: cprefs.lineColor,
    scaleMode: cprefs.scaleMode,
    invertScale: cprefs.invertScale,
    grid: cprefs.canvas.grid,
    crosshair: cprefs.canvas.crosshair,
    crossStyle: cprefs.canvas.crossStyle,
    rightOffset: cprefs.canvas.rightOffset,
    lastPrice: cprefs.lines.lastPrice,
    indicatorLabels: cprefs.lines.indicatorLabels,
    transform: cprefs.transform,
    watermark,
    time: timeFmt,
  }), [chartType, palette, cprefs.candle, cprefs.lineWidth, cprefs.lineColor, cprefs.scaleMode, cprefs.invertScale, cprefs.canvas.grid, cprefs.canvas.crosshair, cprefs.canvas.crossStyle, cprefs.canvas.rightOffset, cprefs.lines.lastPrice, cprefs.lines.indicatorLabels, cprefs.transform, watermark, timeFmt])
  const priceBased = PRICE_BASED_TYPES.has(chartType)
  // 多图时只有当前格显示买卖按钮（四套太挤）/ with several charts only the active cell shows the buy / sell buttons (four sets is too busy)
  const showTradeBtns = (env.tradeButtons && (!multi || active)) || (p.fullscreen && cprefs.trading.buttons)

  const indView = useMemo<IndView>(() => ({
    list: shownList, panes: ind.panes, mainH: ind.mainH, maxPane, interval, digits: decimals, symbol,
  }), [shownList, ind.panes, ind.mainH, maxPane, interval, decimals, symbol])
  // 拖窗格分隔条后把像素高度存成权重（比例不变，换屏幕尺寸照样成立）
  // After a separator drag, store the pixel heights as weights (ratios survive other screen sizes)
  const onPaneResize = useCallback((mainPx: number, panes: Record<string, number>) => {
    updateInd((l) => ({ ...l, mainH: Math.max(0.1, mainPx / 100), panes: l.panes.map((x) => (panes[x.id] != null ? { ...x, h: Math.max(0.1, panes[x.id] / 100) } : x)) }))
  }, [updateInd])
  const { onEditInd } = env
  const engine = useChartEngine(containerRef, indView, p.fullscreen, env.candleColors, env.markerText, view, onPaneResize)
  const { chartRef, seriesRef, getBarTimes, legendStore, paneBoxes, drawReady, syncLegendAt } = engine
  const legendActions = useMemo<LegendActions>(() => ({
    toggleHidden: (uid) => updateInd((l) => updateInstance(l, uid, (i) => ({ ...i, hidden: !i.hidden || undefined }))),
    settings: (uid) => onEditInd(uid),
    remove: (uid) => updateInd((l) => removeInstance(l, uid)),
    duplicate: (uid) => updateInd((l) => duplicateInstance(l, uid)),
    moveTo: (uid, target) => updateInd((l) => moveInstance(l, uid, target)),
    scale: (uid, pin) => updateInd((l) => updateInstance(l, uid, { scale: pin })),
    saveDefault: (uid) => updateInd((l) => {
      const i = l.list.find((x) => x.uid === uid)
      return i ? { ...l, defaults: { ...l.defaults, [i.type]: { inputs: i.inputs, styles: i.styles } } } : l
    }),
    paneMove: (id, dir) => updateInd((l) => movePane(l, id, dir)),
    paneMax: (id) => setMaxPane(id),
    paneCollapse: (id, collapsed) => updateInd((l) => setPane(l, id, { collapsed: collapsed || undefined })),
    paneRemove: (id) => { updateInd((l) => removePane(l, id)); setMaxPane((m) => (m === id ? null : m)) },
  }), [updateInd, onEditInd])
  const liveBidRef = useRef<number | null>(null)
  const dataKeyRef = useRef('')
  const data = useChartData(symbol, interval, decimals, engine, liveBidRef, dataKeyRef)
  const { hasData, stale, lastPrice, dayStats, ensureHistory, replay, replayActive } = data
  // 回放接返回手势：选起点、加载、回放中都算一层——返回先取消选点 / 退出回放，再轮到下一层。
  // 三个状态合成一个开关，选点 → 开始回放之间不来回弹出 / 压入历史记录。
  // Replay claims the back gesture: picking, loading and replaying are one layer — back cancels the pick or
  // exits the replay before anything below. One flag for all three, so pick → play doesn't pop / push history.
  useBackToClose(replay.selecting || replay.loading || replayActive, () => {
    if (replay.selecting) replay.cancelSelect()
    else replay.exit()
  })

  // ── 对比品种（compare/useCompare）：条目在布局 JSON 的 PaneState.compare，这里只画 ──
  // ── compare symbols (compare/useCompare): entries live in PaneState.compare (layout JSON); drawn here ──
  const entries = p.compare ?? NO_COMPARE
  const { peekQuotes: peekQ } = env
  const cmpDigits = useCallback((s: string) => peekQ()[s]?.digits ?? undefined, [peekQ])
  const compareRaw = useCompare(engine, { symbol, interval, entries, scaleMode: cprefs.scaleMode, digitsFor: cmpDigits })
  // useCompare 每次渲染都返回新对象：按行仓库 + 窗格 id 稳住，报给页面时才不会来回触发重渲染
  // useCompare returns a new object per render: keep it stable by the row store + pane ids, or reporting it to the page loops
  const cmpPaneKey = compareRaw.paneIds.join('|')
  // eslint-disable-next-line react-hooks/exhaustive-deps -- identity follows the row store and the pane ids
  const compare = useMemo<CompareHandle>(() => compareRaw, [compareRaw.rows, cmpPaneKey])
  // 「新价格轴」模式开了左轴：状态行 / 买卖按钮 / 指标图例跟着右移（CSS 变量 --lsw）
  // A "new price scale" compare turns the left axis on: the status line / trade buttons / indicator legends shift right (CSS var --lsw)
  const cmpLeft = useSyncExternalStore(compare.rows.subscribe, () => compare.rows.get().leftInset)
  const { onCompareChange, } = p
  const cmpToggle = useCallback((sym: string) => {
    onCompareChange?.(idx, entries.map((e) => (e.symbol === sym ? { ...e, hidden: !e.hidden || undefined } : e)))
  }, [onCompareChange, idx, entries])
  const cmpRemove = useCallback((sym: string) => { onCompareChange?.(idx, entries.filter((e) => e.symbol !== sym)) }, [onCompareChange, idx, entries])
  const { openCompare } = env
  const cmpSettings = useCallback(() => openCompare(idx), [openCompare, idx])

  // 读一眼这一格品种的买卖价，不订阅（回调里用）/ peek this cell's bid / ask without subscribing
  const { peekQuotes } = env
  const quoteNow = useCallback(() => {
    const q = peekQuotes()[symbol]
    return { bid: q?.bid ?? null, ask: q?.ask ?? null }
  }, [peekQuotes, symbol])
  const alertBid = useCallback(() => quoteNow().bid, [quoteNow])
  // 图上下单一律带上这一格自己的品种（多图时绝不能按「当前格」下错品种）
  // Chart orders always carry this cell's own symbol (with several charts never the "active" one's)
  const { place } = env
  const chartPlace = useCallback<ChartPlace>((r) => place(symbol, r), [place, symbol])
  const drawSpec = useSymbolSpec(env.tradeLogin, symbol)

  // 图上投影单：右键菜单、价格轴边的「+」、多空仓位工具的「转为订单」都从这里开一张。
  // The projected order: opened from the context menu, the "+" button or a long/short drawing.
  const [draftReq, setDraftReq] = useState<DraftRequest | null>(null)
  const { setShowPositions } = env
  const openDraft = useCallback((side: 'BUY' | 'SELL', price: number, sl?: number | null, tp?: number | null) => {
    const f = exactDigits != null ? Math.pow(10, exactDigits) : null
    const r = (v: number | null | undefined) => (v == null ? null : f != null ? Math.round(v * f) / f : v)
    setShowPositions(true)
    setDraftReq({ nonce: Date.now(), side, price: r(price) as number, sl: r(sl), tp: r(tp) })
  }, [exactDigits, setShowPositions])
  const { drawToOrder } = env
  const onToOrder = useCallback((o: DrawOrderReq) => {
    drawToOrder({ symbol, exactDigits, decimals, openDraft }, o)
  }, [drawToOrder, symbol, exactDigits, decimals, openDraft])

  // 交易日分隔线 primitive / session-break primitive
  const breaksOn = cprefs.lines.sessionBreaks && ivKind === 'intraday' && !priceBased
  useEffect(() => {
    const series = seriesRef.current
    if (!drawReady || !series || !breaksOn) return
    const sb = new SessionBreaks()
    sb.enabled = true
    sb.color = palette.sessionBreak
    series.attachPrimitive(sb)
    return () => { try { series.detachPrimitive(sb) } catch { /* 图表已销毁 / chart gone */ } }
  }, [drawReady, seriesRef, breaksOn, palette.sessionBreak])

  // 区域放大的退回栈（每放大一次记下之前的范围）/ the zoom-in area's back stack (the range before each zoom)
  const [zoomStack, setZoomStack] = useState<LogicalRange[]>([])
  useEffect(() => { setZoomStack([]) }, [symbol, interval])

  // 时间范围快捷键：先切到对应周期，等新数据到了再补历史、设可见范围。
  // Range presets: switch to the matching interval, then once its data is in, page history
  // as needed and set the visible range.
  const [rangeBusy, setRangeBusy] = useState(false)
  const pendingRangeRef = useRef<{ k: RangeKey; tries: number } | null>(null)
  const [rangeTick, setRangeTick] = useState(0)
  const { onInterval } = p
  const applyRange = useCallback((k: RangeKey) => {
    pendingRangeRef.current = { k, tries: 0 }
    const iv = RANGE_INTERVAL[k]
    if (iv !== interval) onInterval(iv)
    setRangeTick((x) => x + 1)
  }, [interval, onInterval])
  useEffect(() => {
    const job = pendingRangeRef.current
    if (!job) return
    const c = chartRef.current
    if (!c || dataKeyRef.current !== `${symbol}|${interval}` || engine.candlesRef.current.length === 0) {
      // 新周期的数据还没到：稍后再看（最多约 10 秒）/ new data not in yet: look again (≤ ~10s)
      if (job.tries++ > 40) { pendingRangeRef.current = null; return }
      const id = window.setTimeout(() => setRangeTick((x) => x + 1), 250)
      return () => window.clearTimeout(id)
    }
    pendingRangeRef.current = null
    const from = rangeFrom(job.k)
    if (from == null) { c.timeScale().fitContent(); return }
    let alive = true
    setRangeBusy(true)
    ensureHistory(from).finally(() => {
      if (!alive) return
      setRangeBusy(false)
      const to = Math.floor(Date.now() / 1000)
      try { chartRef.current?.timeScale().setVisibleRange({ from: from as never, to: to as never }) } catch { /* 无数据 / no data */ }
    })
    return () => { alive = false; setRangeBusy(false) }
  }, [rangeTick, symbol, interval, hasData, chartRef, engine.candlesRef, ensureHistory])

  // 跳转到日期：补够历史后把那一根放到屏幕中间。/ Go to date: page enough history, then centre that bar.
  const { showToast } = env
  const goToTime = useCallback(async (ts: number) => {
    setRangeBusy(true)
    try { await ensureHistory(ts) } finally { setRangeBusy(false) }
    const c = chartRef.current
    if (!c) return
    const times = engine.barTimesRef.current
    if (times.length === 0) return
    let lo = 0
    let hi = times.length - 1
    while (lo < hi) { const mid = (lo + hi) >> 1; if (times[mid] < ts) lo = mid + 1; else hi = mid }
    const ts2 = c.timeScale()
    const r = ts2.getVisibleLogicalRange()
    const half = r ? Math.max(10, (r.to - r.from) / 2) : 60
    ts2.setVisibleLogicalRange({ from: lo - half, to: lo + half })
    if (lo === 0 && times[0] > ts) showToast(t('charts.goto.earliest'), 'error')
  }, [ensureHistory, chartRef, engine.barTimesRef, showToast, t])

  // 截图 / screenshot
  const takeShot = useCallback(async (mode: 'save' | 'copy') => {
    const c = chartRef.current
    if (!c) return
    const now = Math.floor(Date.now() / 1000)
    const canvas = composeScreenshot(c, `${symbol} · ${intervalLabel(interval)} · ${timeFmt.crosshair(now as never)}`, palette.bg, palette.text)
    const d = new Date()
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}_${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`
    const r: ShotResult = mode === 'copy' ? await copyScreenshot(canvas) : await saveScreenshot(canvas, `${symbol}_${intervalLabel(interval)}_${stamp}`)
    if (r === 'saved') showToast(t('charts.shot.saved'), 'success')
    else if (r === 'copied') showToast(t('charts.shot.copied'), 'success')
    else if (r === 'unsupported') showToast(t('charts.shot.unsupported'), 'error')
    else showToast(t('charts.shot.failed'), 'error')
  }, [chartRef, symbol, interval, timeFmt, palette, showToast, t])

  useImperativeHandle(ref, () => ({
    container: () => containerRef.current,
    drawLayer: () => drawLayerRef.current,
    chart: () => chartRef.current,
    focus: () => { chartBoxRef.current?.focus({ preventScroll: true }) },
    resetView: () => {
      const c = chartRef.current
      if (!c) return
      c.timeScale().resetTimeScale()
      autoAllScales(c)
    },
    // 每个窗格的左右价格轴都回到自动（滚轮可以单独拉伸副图的轴）/ every pane's scales back to auto (the wheel can stretch sub-pane axes)
    autoScale: () => { const c = chartRef.current; if (c) autoAllScales(c) },
    goToTime,
    applyRange,
    takeShot,
    zoomOut: () => {
      setZoomStack((st) => {
        const prev = st[st.length - 1]
        if (prev) chartRef.current?.timeScale().setVisibleLogicalRange(prev)
        return st.slice(0, -1)
      })
    },
    openDraft,
  }), [chartRef, goToTime, applyRange, takeShot, openDraft])

  // 把动态状态报给页面（只有当前格的会被页面用到）/ report the dynamic state (the page uses the active cell's)
  const { onInfo } = p
  const canZoomOut = zoomStack.length > 0
  useEffect(() => {
    if (!active) return
    onInfo(idx, {
      hasData, stale, lastPrice, dayStats, drawReady, canZoomOut, rangeBusy,
      replay, compare, ohlcStore: engine.ohlcStore, legendStore, list: shownList, symbol, interval, decimals,
    })
  }, [active, idx, onInfo, hasData, stale, lastPrice, dayStats, drawReady, canZoomOut, rangeBusy, replay, compare, engine.ohlcStore, legendStore, shownList, symbol, interval, decimals])

  // 登记到多图同步（十字线 / 可见范围）/ register with the multi-chart sync (crosshair / visible range)
  const symRef = useRef(symbol)
  symRef.current = symbol
  const priceBasedRef = useRef(priceBased)
  priceBasedRef.current = priceBased
  const bus = env.syncBus
  useEffect(() => {
    const chart = chartRef.current
    const series = seriesRef.current
    if (!bus || !drawReady || !chart || !series) return
    return bus.register(idx, {
      chart,
      series: series as never,
      barTimes: getBarTimes,
      symbol: () => symRef.current,
      timeBased: () => !priceBasedRef.current,
      legendAt: syncLegendAt,
    })
  }, [bus, drawReady, idx, chartRef, seriesRef, getBarTimes, syncLegendAt])

  // 右键菜单（桌面）/ context menu (desktop)
  const { onContextMenu } = env
  const onChartContextMenu = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!isDesktop || e.defaultPrevented) return
    const c = chartRef.current
    const s = seriesRef.current
    const host = containerRef.current
    if (!c || !s || !host) return
    e.preventDefault()
    const r = host.getBoundingClientRect()
    const x = e.clientX - r.left
    const y = e.clientY - r.top
    const zone = x > c.timeScale().width() ? 'price' : 'pane'
    const price = s.coordinateToPrice(y)
    onContextMenu({ x: e.clientX, y: e.clientY, zone, price: price == null ? null : Number(price) })
  }, [isDesktop, chartRef, seriesRef, onContextMenu])

  // 多图：标题栏（状态行的品种名）双击最大化 / 还原 / multi: double-click the title (status line symbol) to maximise / restore
  const { onActivate, onToggleMax } = p
  const onDoubleClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!multi) return
    if ((e.target as HTMLElement).closest?.('.term-status-ttl, .cg-ptools')) onToggleMax(idx)
  }, [multi, onToggleMax, idx])

  const legend = useMemo(() => (multi ? { ...cprefs.legend, title: true } : cprefs.legend), [multi, cprefs.legend])
  const ready = drawReady && chartRef.current && seriesRef.current
  return (
    <div
      ref={chartBoxRef}
      className={`term-chart ${p.fullscreen ? 'chart-fullscreen-container' : ''} ${legend.title || legend.ohlc || legend.change || legend.volume ? 'has-status' : ''} ${cprefs.legend.indicators ? '' : 'no-ind-legend'} ${showTradeBtns ? 'has-tbtns' : ''} ${maxPane && maxPane !== 'main' && ind.panes.some((x) => x.id === maxPane) ? 'main-min' : ''}${multi ? ` cg-cell${active ? ' cg-active' : ''}${p.hidden ? ' cg-hidden' : ''}` : ''}`}
      style={{ ...(multi && p.area && !p.maximised ? { gridArea: p.area } : {}), ...(cmpLeft ? { ['--lsw' as string]: `${cmpLeft}px` } : {}) }}
      data-ctheme={env.themeName}
      tabIndex={0}
      role="group"
      aria-label={multi ? `${t('nav.charts')} · ${symbol} ${intervalLabel(interval)}` : t('nav.charts')}
      onContextMenu={onChartContextMenu}
      onPointerDownCapture={multi ? () => onActivate(idx) : undefined}
      onFocusCapture={multi ? () => onActivate(idx) : undefined}
      onPointerEnter={bus ? () => bus.setHover(idx) : undefined}
      onPointerLeave={bus ? () => bus.setHover(null) : undefined}
      onDoubleClick={multi ? onDoubleClick : undefined}
    >
      {p.extrasTop}
      {/* 回放中这些「实时」部件一律不挂 / none of the live parts mount during a replay */}
      {!replayActive && <LiveBarSync symbol={symbol} interval={interval} engine={engine} liveBidRef={liveBidRef} dataKeyRef={dataKeyRef} />}

      <div ref={containerRef} className="h-full w-full" />
      {/* 持仓标记层：入场价/止损/止盈线 + 拖动改单。刻意排在画图层之前——两层
          都用「悬停到自己的目标才抢指针事件」的策略，DOM 上后者在上，于是画线
          操作天然优先于拖止损线，不会互相抢。/ Position markers: entry/SL/TP
          lines + drag-to-modify. Deliberately mounted before the draw layer:
          both only capture pointer events while hovering their own targets, and
          being later in the DOM puts the draw layer on top, so drawing
          naturally takes precedence over dragging an SL line. */}
      {ready && !replayActive && (
        <LiveOverlay
          chart={chartRef.current!}
          series={seriesRef.current!}
          scopeLogin={env.scopeLogin}
          symbol={symbol}
          digits={decimals}
          exactDigits={exactDigits}
          refPrice={lastPrice}
          visible={env.showPositions}
          onToast={env.showToast}
          trading={cprefs.trading}
          balance={env.balance}
          currency={env.currency}
          login={env.tradeLogin}
          quote={quoteNow}
          onPlace={chartPlace}
          draftRequest={draftReq}
        />
      )}
      {ready && cprefs.trading.executions && !priceBased && !replayActive && (
        <LiveExecutions
          chart={chartRef.current!}
          series={seriesRef.current!}
          scopeLogin={env.scopeLogin}
          symbol={symbol}
          login={env.accountLogin}
          orders={env.accountOrders}
          barTimes={getBarTimes}
          dataKey={`${interval}|${hasData}|${lastPrice}`}
          visible={env.showPositions}
        />
      )}
      {ready && isDesktop && !replayActive && (
        <PlusOrderButton chart={chartRef.current!} series={seriesRef.current!} digits={decimals} quote={quoteNow}
          onPick={env.showPositions && env.tradeLogin ? openDraft : null} onAlert={(price) => env.openAlert({ price })} />
      )}
      {env.showCountdown && !priceBased && hasData && ready && !replayActive && (
        <BarCountdown
          chart={chartRef.current!}
          series={seriesRef.current!}
          interval={interval}
          candlesRef={engine.candlesRef}
          colors={env.dirColors}
          stale={stale}
        />
      )}
      {ready && containerRef.current && (
        <DrawLayer
          ref={drawLayerRef}
          chart={chartRef.current!}
          series={seriesRef.current!}
          host={containerRef.current}
          symbol={symbol}
          barTimes={getBarTimes}
          digits={decimals}
          interval={interval}
          fmtTime={drawFmtTime}
          theme={drawTheme}
          onStateChange={env.bumpDraw}
          onToOrder={onToOrder}
          spec={drawSpec}
          onAlert={(d) => env.openAlert({ drawing: d })}
          keys={!multi || active}
          treeHost={p.treeHost}
        />
      )}
      {!hasData && <div className="term-chart-empty">{t('charts.empty')}</div>}

      {/* 主图状态行：品种 · 周期 · OHLC · 涨跌（多图时品种名就是这一格的标题）/ main status line (the cell's title in a multi-chart grid) */}
      <ChartLegend store={engine.ohlcStore} symbol={symbol} interval={interval} chartType={chartType} decimals={decimals} legend={legend} colors={env.dirColors} />
      {/* 对比品种的图例行（主图状态行下面；pane 模式的在自己窗格顶上）/ compare legend rows */}
      <CompareLegend compare={compare} boxes={paneBoxes} onToggle={cmpToggle} onRemove={cmpRemove} onSettings={cmpSettings} />
      {/* 买卖按钮（桌面，或手机全屏横屏时）/ buy & sell buttons (desktop, or phone fullscreen) */}
      {showTradeBtns && !replayActive && (
        <TradeButtons symbol={symbol} digits={decimals} login={env.tradeLogin} oneClick={cprefs.trading.oneClick} touch={!isDesktop} onPlace={chartPlace} quotesDown={env.quotesDown} />
      )}
      {/* 指标图例（主图叠加 + 各副图）/ indicator legends (main-pane overlays + each sub-pane) */}
      <PaneLegends layout={ind} list={shownList} boxes={paneBoxes} legendStore={legendStore} digits={decimals} candle={env.candleColors}
        axisW={chartRef.current ? chartRef.current.priceScale('right').width() : 56} maxPane={maxPane} actions={legendActions} showRows={cprefs.legend.indicators} />

      {ready && (
        <ChartPriceLines
          chart={chartRef.current!}
          series={seriesRef.current!}
          symbol={symbol}
          interval={interval}
          candlesRef={engine.candlesRef}
          palette={palette}
          bidAsk={cprefs.lines.bidAsk}
          highLow={cprefs.lines.highLow}
          prevClose={cprefs.lines.prevClose && !priceBased}
          labels={{ bid: String(t('charts.lines.bid')), ask: String(t('charts.lines.ask')), high: String(t('charts.lines.high')), low: String(t('charts.lines.low')), prev: String(t('charts.lines.prev')) }}
        />
      )}
      {ready && (
        <AlertLines
          chart={chartRef.current!}
          series={seriesRef.current!}
          symbol={symbol}
          digits={decimals}
          bid={alertBid}
          label={String(t('charts.alert.lineTitle'))}
          dragTip={String(t('charts.alert.dragTip'))}
          onEdit={(a) => env.openAlert({ edit: a })}
          onError={(m) => env.showToast(m ? localizeApiError(m) : String(t('charts.alert.err.save')), 'error')}
        />
      )}
      {ready && containerRef.current && (
        <MeasureOverlay chart={chartRef.current!} series={seriesRef.current!} host={containerRef.current} armed={p.measureOn} onDone={p.onMeasureDone} decimals={decimals} barTimes={getBarTimes} colors={env.dirColors} />
      )}
      {drawReady && chartRef.current && <BackToLatest chart={chartRef.current} />}
      {/* 财经事件徽章（主图底部；悬停 / 点按出卡片，卡片走 body portal）/ econ event badges (card in a body portal) */}
      {drawReady && (
        <EconEventsLayer
          chart={chartRef.current}
          series={seriesRef.current as never}
          symbol={symbol}
          enabled={cprefs.events.econ}
          minImportance={cprefs.events.minImp}
          timezone={cprefs.timezone}
          theme={env.themeName}
          getBarTimes={getBarTimes}
          colors={env.dirColors}
        />
      )}
      {p.zoomOn && drawReady && (
        <ProZoomBox
          chartRef={chartRef}
          hostRef={containerRef}
          onZoom={(prev) => { setZoomStack((st) => [...st, prev]); p.onZoomEnd() }}
          onCancel={p.onZoomEnd}
        />
      )}
      {/* K 线回放：选起点遮罩 + 底部控制条（Shift+→ / Shift+↓ 只在焦点在这一格时生效）
          Bar replay: the start-picking overlay + the bottom control bar (hotkeys only while focus is in this cell) */}
      {replay.selecting && drawReady && chartRef.current && (
        <ReplaySelectOverlay chart={chartRef.current} getBarTimes={getBarTimes} replay={replay} fmtTime={drawFmtTime} timezone={cprefs.timezone} />
      )}
      {replayActive && <ReplayBar replay={replay} fmtTime={drawFmtTime} scopeRef={chartBoxRef} />}

      {/* 多图：每格右上角的最大化 / 还原（标题双击同效）/ multi: maximise / restore at each cell's top right (same as double-clicking the title) */}
      {multi && (
        <div className="cg-ptools">
          <button
            type="button"
            className={p.maximised ? 'on' : undefined}
            onClick={() => onToggleMax(idx)}
            title={String(t(p.maximised ? 'charts.layout.restore' : 'charts.layout.maximize'))}
            aria-label={String(t(p.maximised ? 'charts.layout.restore' : 'charts.layout.maximize'))}
            aria-pressed={p.maximised}
          >
            {p.maximised
              ? <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7" /></svg>
              : <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" /></svg>}
          </button>
        </div>
      )}
      {p.extrasEnd}
    </div>
  )
}

export default forwardRef(ChartPane)
