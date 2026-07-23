// 图表画图层：对标 TradingView 的绘制体验。
// 使用 lightweight-charts ISeriesPrimitive API 将每条画线注册为图表原生
// primitive，由图表引擎负责渲染和 hit-testing。不再使用 canvas 叠加层。
//
// Chart drawing layer: TradingView-style drawing experience.
// Uses lightweight-charts ISeriesPrimitive API — each drawing is a native
// chart primitive rendered & hit-tested by the engine. No canvas overlay.
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, type PointerEvent as RPointerEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { CanvasRenderingTarget2D } from 'fancy-canvas'
import type {
  IChartApi, ISeriesApi, UTCTimestamp, IPrimitivePaneView,
  IPrimitivePaneRenderer, PrimitiveHoveredItem, AutoscaleInfo,
  Logical, PrimitivePaneViewZOrder,
} from 'lightweight-charts'
import { usePrefs } from '../../store/prefs'
import ConfirmModal from '../ConfirmModal'
import { useBackToClose } from '../../utils/useBackToClose'

export type Tool = 'cursor' | 'cross' | 'trend' | 'hline' | 'vline' | 'ray' | 'crossline' | 'rect' | 'fib'
type DrawType = 'trend' | 'hline' | 'vline' | 'ray' | 'crossline' | 'rect' | 'fib'

export interface DrawLayerHandle {
  tool: Tool
  setTool: (t: Tool) => void
  color: string
  setColor: (c: string) => void
  selectedId: string | null
  drawCount: number
  lockedCount: number

  stayInDraw: boolean
  setStayInDraw: (s: boolean) => void
  visible: boolean
  setVisible: (v: boolean) => void
  deleteSelected: () => void
  clearAll: () => void
  applyColor: (c: string) => void
  toggleLock: () => void
  lockAll: () => void
  unlockAll: () => void
  undo: () => void
  redo: () => void
}

// ──── 工具分组定义 / tool group definitions ────
interface ToolGroup {
  key: string
  tools: { id: Tool; svg: JSX.Element }[]
}

const TOOL_GROUPS: ToolGroup[] = [
  {
    key: 'cursors',
    tools: [
      { id: 'cursor', svg: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 3l7 17 2.5-6.5L20 11 4 3z" /></svg> },
      { id: 'cross', svg: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><line x1="12" y1="3" x2="12" y2="21" /><line x1="3" y1="12" x2="21" y2="12" /></svg> },
    ],
  },
  {
    key: 'lines',
    tools: [
      { id: 'trend', svg: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 20L20 4" /><circle cx="4" cy="20" r="2" /><circle cx="20" cy="4" r="2" /></svg> },
      { id: 'hline', svg: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12h18" /><circle cx="12" cy="12" r="2" /></svg> },
      { id: 'vline', svg: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v18" /><circle cx="12" cy="12" r="2" /></svg> },
      { id: 'ray', svg: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="6" y1="18" x2="18" y2="6" /><line x1="18" y1="6" x2="22" y2="2" /><circle cx="6" cy="18" r="2" /></svg> },
      { id: 'crossline', svg: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12h18" /><path d="M12 3v18" /><circle cx="12" cy="12" r="2" /></svg> },
    ],
  },
  {
    key: 'fib',
    tools: [
      { id: 'fib', svg: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 5h18M3 10h18M3 14h18M3 19h18" /><path d="M4 19L20 5" opacity="0.5" /></svg> },
    ],
  },
  {
    key: 'shapes',
    tools: [
      { id: 'rect', svg: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="6" width="16" height="12" rx="1" /></svg> },
    ],
  },
]

// ──── 常量 / constants ────
interface Point { t: number; p: number }
interface Drawing { id: string; type: DrawType; pts: Point[]; color: string; locked?: boolean; lineWidth?: number; lineStyle?: 'solid' | 'dashed' | 'dotted' }
interface Props { chart: IChartApi; series: ISeriesApi<'Candlestick'>; host: HTMLDivElement; symbol: string; lastPrice: number; barTimes: () => number[]; digits?: number; hideToolbar?: boolean }

const TOL_DESKTOP = 12
const TOL_MOBILE = 24
const HANDLE_DESKTOP = 10
const HANDLE_MOBILE = 20
const UNDO_MAX = 30
const COLORS = ['#22d3ee', '#a78bfa', '#2ee07e', '#ff4d67', '#f5c451']
const LINE_WIDTHS = [1, 2, 3, 4]
const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1]

const isTouchDevice = typeof window !== 'undefined' && (window.matchMedia?.('(pointer: coarse)').matches || navigator.maxTouchPoints > 0)

const uid = () => 'dw_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)

function distToSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

// ──── 时间 ⇄ 像素坐标转换（支持超出最新 K 线的空白区）────
// lightweight-charts 的 timeToCoordinate/coordinateToTime 只在有数据的区间内
// 有效——在最新 K 线右侧（或最早 K 线左侧）的空白区会返回 null，导致画线无法
// 画到、也无法渲染到未来区域。这里改用「逻辑索引 Logical」通道：逻辑索引与
// 像素坐标是线性且无界的，配合已加载的 bar 时间数组做外推，就能把时间映射到
// 空白区、并反向还原，既能画到未来又能稳定持久化（存的仍是真实/外推时间）。
// The engine's time<->coordinate conversions only work within the data range;
// they return null in the whitespace to the right of the last bar (or left of
// the first), so drawings can't be placed or rendered in the future area. We
// bridge through the Logical index instead — logical<->coordinate is linear and
// unbounded — extrapolating with the loaded bar-time array. This lets drawings
// extend past the latest candle while still persisting stable time values.

// 模块级 bar 时间访问器，由 DrawLayer 组件挂上；primitive 渲染时读取。
// Module-level bar-times accessor, set by the DrawLayer component; read by the
// primitive during rendering.
let _barTimesGetter: () => number[] = () => []

function barInterval(bt: number[]): number {
  const n = bt.length
  if (n < 2) return 0
  return bt[n - 1] - bt[n - 2]
}

// 时间 → 逻辑索引（可外推到数据范围之外，返回小数/负数）。
function timeToLogical(bt: number[], t: number): number | null {
  const n = bt.length
  if (n === 0) return null
  if (n === 1) return 0
  const iv = barInterval(bt)
  if (t <= bt[0]) return iv ? (t - bt[0]) / iv : 0
  if (t >= bt[n - 1]) return iv ? (n - 1) + (t - bt[n - 1]) / iv : n - 1
  let lo = 0, hi = n - 1
  while (lo < hi) { const mid = (lo + hi) >> 1; if (bt[mid] < t) lo = mid + 1; else hi = mid }
  if (bt[lo] === t) return lo
  const prev = lo - 1
  const span = bt[lo] - bt[prev] || 1
  return prev + (t - bt[prev]) / span
}

// 逻辑索引 → 时间（同样支持外推）。
function logicalToTime(bt: number[], logical: number): number | null {
  const n = bt.length
  if (n === 0) return null
  if (n === 1) return bt[0]
  const iv = barInterval(bt)
  if (logical <= 0) return Math.round(bt[0] + logical * iv)
  if (logical >= n - 1) return Math.round(bt[n - 1] + (logical - (n - 1)) * iv)
  const lo = Math.floor(logical), hi = Math.ceil(logical)
  if (lo === hi) return bt[lo]
  return Math.round(bt[lo] + (bt[hi] - bt[lo]) * (logical - lo))
}

// 时间 → x 像素：先走原生转换（快路径），落空则经逻辑索引外推。
function timeToX(chart: IChartApi, t: number): number | null {
  const ts = chart.timeScale()
  const c = ts.timeToCoordinate(t as UTCTimestamp) as number | null
  if (c != null) return c
  const lg = timeToLogical(_barTimesGetter(), t)
  if (lg == null) return null
  return ts.logicalToCoordinate(lg as Logical) as number | null
}

// x 像素 → 时间：先走原生转换，落空则经逻辑索引外推。
function xToTime(chart: IChartApi, x: number): number | null {
  const ts = chart.timeScale()
  const t = ts.coordinateToTime(x) as number | null
  if (t != null) return t
  const lg = ts.coordinateToLogical(x) as number | null
  if (lg == null) return null
  return logicalToTime(_barTimesGetter(), lg)
}

// ──── ISeriesPrimitive 画线基类 / drawing primitive base ────
class DrawPrimitive {
  id: string
  type: DrawType
  color: string
  lineWidth: number
  lineStyle: 'solid' | 'dashed' | 'dotted'
  locked: boolean
  pts: Point[]

  private _chart: IChartApi | null = null
  private _series: ISeriesApi<'Candlestick'> | null = null
  private _ru: (() => void) | null = null
  _pv: PaneViewImpl
  digits: number

  constructor(d: Drawing, digits: number) {
    this.id = d.id
    this.type = d.type
    this.color = d.color
    this.lineWidth = d.lineWidth || 1
    this.lineStyle = d.lineStyle || 'solid'
    this.locked = !!d.locked
    this.pts = d.pts.map((p) => ({ t: p.t, p: p.p }))
    this.digits = digits
    this._pv = new PaneViewImpl(this)
  }

  // ISeriesPrimitive lifecycle
  attached(p: { chart: IChartApi; series: ISeriesApi<'Candlestick'>; requestUpdate: () => void }) {
    this._chart = p.chart
    this._series = p.series
    this._ru = p.requestUpdate
  }

  detached() {
    this._chart = null
    this._series = null
    this._ru = null
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return [this._pv]
  }

  updateAllViews() { /* no-op, renderer reads live state */ }

  autoscaleInfo(_start: Logical, _end: Logical): AutoscaleInfo | null {
    // 画线不参与价格轴自动缩放：否则一条画到远离行情的线会把价格范围强行
    // 撑大，导致 K 线被压扁。画线只是叠加物，应随图表缩放，而非反向影响它。
    // Drawings opt out of price autoscale: otherwise a line drawn far from the
    // current price forces the range to expand and squashes the candles.
    // Drawings are overlays — they should follow the chart's scale, not drive it.
    return null
  }

  hitTest(x: number, y: number): PrimitiveHoveredItem | null {
    if (!this._chart || !this._series) return null
    const px = this._toPixel()
    if (!px) return null
    const d = this._testHit(px, x, y)
    if (d != null) {
      return {
        externalId: this.id,
        cursorStyle: this.locked ? 'default' : 'move',
        hitTestPriority: 1,
        distance: d,
        zOrder: 'normal' as PrimitivePaneViewZOrder,
      }
    }
    return null
  }

  requestUpdate() {
    this._ru?.()
  }

  // pixel conversion using chart APIs (tx 经逻辑索引外推，支持空白区渲染)
  _toPixel(): { x: number; y: number }[] | null {
    if (!this._chart || !this._series) return null
    const tx = (t: number) => timeToX(this._chart!, t)
    const ty = (p: number) => this._series!.priceToCoordinate(p) as number | null

    if (this.type === 'hline') { const y = ty(this.pts[0].p); return y != null ? [{ x: 0, y }] : null }
    if (this.type === 'vline') { const x = tx(this.pts[0].t); return x != null ? [{ x, y: 0 }] : null }
    if (this.type === 'crossline') {
      const x = tx(this.pts[0].t), y = ty(this.pts[0].p)
      return (x != null && y != null) ? [{ x, y }] : null
    }
    const a = { x: tx(this.pts[0].t), y: ty(this.pts[0].p) }
    const b = { x: tx(this.pts[1].t), y: ty(this.pts[1].p) }
    if (a.x == null || a.y == null || b.x == null || b.y == null) return null
    return [a as { x: number; y: number }, b as { x: number; y: number }]
  }

  _testHit(px: { x: number; y: number }[], mx: number, my: number): number | null {
    const tol = isTouchDevice ? TOL_MOBILE : TOL_DESKTOP
    if (this.type === 'hline') return Math.abs(my - px[0].y) <= tol ? Math.abs(my - px[0].y) : null
    if (this.type === 'vline') return Math.abs(mx - px[0].x) <= tol ? Math.abs(mx - px[0].x) : null
    if (this.type === 'crossline') {
      const d = Math.min(Math.abs(mx - px[0].x), Math.abs(my - px[0].y))
      return d <= tol ? d : null
    }
    if (this.type === 'trend' || this.type === 'ray') {
      const d = distToSeg(mx, my, px[0].x, px[0].y, px[1].x, px[1].y)
      if (d <= tol) return d
      if (Math.hypot(mx - px[0].x, my - px[0].y) <= tol) return Math.hypot(mx - px[0].x, my - px[0].y)
      if (Math.hypot(mx - px[1].x, my - px[1].y) <= tol) return Math.hypot(mx - px[1].x, my - px[1].y)
      return null
    }
    if (this.type === 'fib') {
      const xL = Math.min(px[0].x, px[1].x), xR = Math.max(px[0].x, px[1].x)
      if (mx >= xL - tol && mx <= xR + tol) {
        const yA = px[0].y, yB = px[1].y
        for (const lv of FIB_LEVELS) {
          const d = Math.abs(my - (yB + (yA - yB) * lv))
          if (d <= tol) return d
        }
      }
      const d = distToSeg(mx, my, px[0].x, px[0].y, px[1].x, px[1].y)
      return d <= tol ? d : null
    }
    if (this.type === 'rect') {
      const x1 = Math.min(px[0].x, px[1].x), x2 = Math.max(px[0].x, px[1].x)
      const y1 = Math.min(px[0].y, px[1].y), y2 = Math.max(px[0].y, px[1].y)
      const onBorderX = (mx >= x1 - tol && mx <= x2 + tol) && (Math.abs(my - y1) <= tol || Math.abs(my - y2) <= tol)
      const onBorderY = (my >= y1 - tol && my <= y2 + tol) && (Math.abs(mx - x1) <= tol || Math.abs(mx - x2) <= tol)
      if (onBorderX || onBorderY) return 0
      return null
    }
    return null
  }

  // render helper - called by the pane view renderer
  _render(ctx: CanvasRenderingContext2D, w: number, h: number, selected: boolean) {
    const px = this._toPixel()
    if (!px) return
    const col = this.color
    const lw = this.lineWidth || (selected ? 2 : 1.5)
    const alpha = this.locked ? 0.35 : 0.8
    const handleSz = isTouchDevice ? HANDLE_MOBILE : HANDLE_DESKTOP

    ctx.globalAlpha = 1

    const setDash = () => {
      if (this.lineStyle === 'dashed') ctx.setLineDash([8, 4])
      else if (this.lineStyle === 'dotted') ctx.setLineDash([2, 4])
      else ctx.setLineDash([])
    }

    const paintHandle = (cx: number, cy: number) => {
      if (!selected || this.locked) return
      ctx.fillStyle = '#0a0710'; ctx.strokeStyle = '#ffffff'
      ctx.lineWidth = 1.5; ctx.setLineDash([])
      ctx.beginPath()
      ctx.rect(cx - handleSz / 2, cy - handleSz / 2, handleSz, handleSz)
      ctx.fill(); ctx.stroke()
      setDash()
    }

    ctx.globalAlpha = alpha

    switch (this.type) {
      case 'hline': {
        const y = px[0].y
        ctx.strokeStyle = col; ctx.lineWidth = lw; setDash()
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke()
        paintHandle(w / 2, y)
        break
      }
      case 'vline': {
        const x = px[0].x
        ctx.strokeStyle = col; ctx.lineWidth = lw; setDash()
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke()
        paintHandle(x, h / 2)
        break
      }
      case 'crossline': {
        const cx = px[0].x, cy = px[0].y
        ctx.globalAlpha = this.locked ? 0.12 : 0.35
        ctx.strokeStyle = col; ctx.lineWidth = lw; setDash()
        ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, h); ctx.stroke()
        ctx.beginPath(); ctx.moveTo(0, cy); ctx.lineTo(w, cy); ctx.stroke()
        ctx.globalAlpha = alpha
        paintHandle(cx, cy)
        break
      }
      case 'ray': {
        const dx = px[1].x - px[0].x, dy = px[1].y - px[0].y
        const len = Math.hypot(dx, dy) || 1
        const ext = Math.max(w * 2, h * 2)
        ctx.strokeStyle = col; ctx.lineWidth = lw; setDash()
        ctx.beginPath(); ctx.moveTo(px[0].x, px[0].y)
        ctx.lineTo(px[0].x + (dx / len) * ext, px[0].y + (dy / len) * ext)
        ctx.stroke()
        paintHandle(px[0].x, px[0].y); paintHandle(px[1].x, px[1].y)
        break
      }
      case 'trend': {
        ctx.strokeStyle = col; ctx.lineWidth = lw; setDash()
        ctx.beginPath(); ctx.moveTo(px[0].x, px[0].y)
        ctx.lineTo(px[1].x, px[1].y); ctx.stroke()
        paintHandle(px[0].x, px[0].y); paintHandle(px[1].x, px[1].y)
        break
      }
      case 'fib': {
        const xL = Math.min(px[0].x, px[1].x), xR = Math.max(px[0].x, px[1].x)
        const yA = px[0].y, yB = px[1].y
        ctx.globalAlpha = this.locked ? 0.12 : 0.35
        ctx.setLineDash([])
        ctx.strokeStyle = col; ctx.lineWidth = lw
        ctx.beginPath(); ctx.moveTo(px[0].x, px[0].y); ctx.lineTo(px[1].x, px[1].y); ctx.stroke()
        ctx.globalAlpha = alpha
        setDash()
        ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace'
        ctx.textBaseline = 'middle'
        let prevY: number | null = null
        for (const lv of FIB_LEVELS) {
          const ly = yB + (yA - yB) * lv
          if (prevY != null) {
            ctx.fillStyle = col + (this.locked ? '08' : '14')
            ctx.fillRect(xL, Math.min(prevY, ly), xR - xL, Math.abs(ly - prevY))
          }
          prevY = ly
          ctx.strokeStyle = col; ctx.lineWidth = 1; ctx.setLineDash([])
          ctx.beginPath(); ctx.moveTo(xL, ly); ctx.lineTo(xR, ly); ctx.stroke()
          setDash()
          const price = this._series?.coordinateToPrice(ly)
          ctx.fillStyle = col
          ctx.fillText(`${(lv * 100).toFixed(1)}%${price != null ? '  ' + (price as number).toFixed(this.digits) : ''}`, xR + 4, ly)
        }
        paintHandle(px[0].x, px[0].y); paintHandle(px[1].x, px[1].y)
        break
      }
      case 'rect': {
        const x = Math.min(px[0].x, px[1].x), y = Math.min(px[0].y, px[1].y)
        const rw = Math.abs(px[1].x - px[0].x), rh = Math.abs(px[1].y - px[0].y)
        ctx.fillStyle = col + (this.locked ? '0a' : '22')
        ctx.fillRect(x, y, rw, rh)
        ctx.strokeStyle = col; ctx.lineWidth = lw; setDash()
        ctx.strokeRect(x, y, rw, rh)
        paintHandle(x, y); paintHandle(x + rw, y); paintHandle(x, y + rh); paintHandle(x + rw, y + rh)
        break
      }
    }

    // lock icon (drawn as SVG shapes to avoid emoji font issues)
    if (this.locked) {
      const cx = this.type === 'hline' ? w / 2 : this.type === 'vline' ? px[0].x : (px[0].x + (px.length > 1 ? px[1].x : px[0].x)) / 2
      const cy = this.type === 'hline' ? px[0].y - 10 : this.type === 'vline' ? h / 2 : Math.min(px[0].y, px.length > 1 ? px[1].y : px[0].y) - 10
      ctx.globalAlpha = 0.6; ctx.setLineDash([])
      ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1; ctx.fillStyle = '#ffffff'
      const lx = cx - 4, ly = cy - 5
      // lock body
      ctx.fillRect(lx, ly + 3, 8, 6)
      // lock shackle
      ctx.beginPath(); ctx.arc(lx + 4, ly + 3, 3, Math.PI, 0, false); ctx.stroke()
    }
    ctx.globalAlpha = 1; ctx.setLineDash([])
  }
}

// ──── IPrimitivePaneView & IPrimitivePaneRenderer ────
class PaneViewImpl implements IPrimitivePaneView {
  _renderer: RendererImpl

  constructor(prim: DrawPrimitive) {
    this._renderer = new RendererImpl(prim)
  }

  renderer(): IPrimitivePaneRenderer | null {
    return this._renderer
  }
}

class RendererImpl implements IPrimitivePaneRenderer {
  private _prim: DrawPrimitive
  _selected: boolean = false

  constructor(prim: DrawPrimitive) {
    this._prim = prim
  }

  draw(target: CanvasRenderingTarget2D): void {
    target.useMediaCoordinateSpace((scope) => {
      this._prim._render(scope.context, scope.mediaSize.width, scope.mediaSize.height, this._selected)
    })
  }
}

// ──── 组件 / component ────
function DrawLayer({ chart, series, host, symbol, barTimes, digits = 2, hideToolbar }: Props, ref: React.Ref<DrawLayerHandle>) {
  const { t } = useTranslation()
  const { getPref, setPref } = usePrefs()

  // 把 bar 时间访问器挂到模块级，供 primitive 渲染与坐标外推读取（见文件顶部
  // timeToX/xToTime）。/ Expose the bar-times accessor at module scope for the
  // primitive renderer and coordinate extrapolation (see timeToX/xToTime above).
  _barTimesGetter = barTimes

  const tol = isTouchDevice ? TOL_MOBILE : TOL_DESKTOP
  const handleSz = isTouchDevice ? HANDLE_MOBILE : HANDLE_DESKTOP

  // core state
  const [tool, setTool] = useState<Tool>('cursor')
  const [color, setColor] = useState<string>(COLORS[0])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [drawings, setDrawings] = useState<Drawing[]>([])
  const [drawCount, setDrawCount] = useState(0)
  const [stayInDraw, setStayInDraw] = useState(false)
  const [visible, setVisible] = useState(true)

  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({ fib: true, shapes: true })

  // undo/redo
  const undoStackRef = useRef<Drawing[][]>([])
  const redoStackRef = useRef<Drawing[][]>([])
  const [canUndo, setCanUndo] = useState(false)
  const [canRedo, setCanRedo] = useState(false)

  // context menu
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; drawingId: string } | null>(null)
  useBackToClose(!!ctxMenu, () => setCtxMenu(null))

  // floating props panel
  const [propsPanel, setPropsPanel] = useState<{ drawingId: string } | null>(null)

  // confirm modal
  const [confirmOpen, setConfirmOpen] = useState(false)
  useBackToClose(confirmOpen, () => setConfirmOpen(false))

  // ──── 画线原语映射 / primitive map ────
  const primsRef = useRef<Map<string, DrawPrimitive>>(new Map())

  // refs
  const toolRef = useRef(tool); const colorRef = useRef(color)
  const selectedRef = useRef<string | null>(selectedId)
  const drawingsRef = useRef<Drawing[]>([])
  const stayInDrawRef = useRef(false)
  const dragRef = useRef<{ mode: 'create'; type: DrawType; startX: number; startY: number } | { mode: 'move'; id: string; startX: number; startY: number; origPts: Point[] } | { mode: 'handle'; id: string; handle: number; origPts: Point[] } | null>(null)
  const appliedRef = useRef(''); const symRef = useRef(symbol)
  const lastClickRef = useRef<{ id: string; time: number } | null>(null)
  const tempPrimRef = useRef<DrawPrimitive | null>(null)

  toolRef.current = tool; colorRef.current = color
  selectedRef.current = selectedId; drawingsRef.current = drawings; stayInDrawRef.current = stayInDraw

  // ──── attach/detach primitives to/from series ────
  const syncPrims = useCallback((list: Drawing[]) => {
    const map = primsRef.current
    const keep = new Set(list.map((d) => d.id))

    // detach removed
    for (const [id, prim] of map) {
      if (!keep.has(id)) {
        series.detachPrimitive(prim as any)
        map.delete(id)
      }
    }

    // attach new or update existing
    for (const d of list) {
      let prim = map.get(d.id)
      if (!prim) {
        prim = new DrawPrimitive(d, digits)
        map.set(d.id, prim)
        series.attachPrimitive(prim as any)
      } else {
        // update in place
        prim.pts = d.pts.map((p) => ({ t: p.t, p: p.p }))
        prim.color = d.color
        prim.lineWidth = d.lineWidth || 1
        prim.lineStyle = d.lineStyle || 'solid'
        prim.locked = !!d.locked
        prim.digits = digits
        prim.requestUpdate()
      }
    }

    // sync selected state on renderers
    for (const [id, prim] of map) {
      prim._pv._renderer._selected = id === selectedRef.current
    }
  }, [series, digits])

  // ──── commit / pushUndo ────
  const pushUndo = useCallback((current: Drawing[]) => {
    undoStackRef.current.push(current)
    if (undoStackRef.current.length > UNDO_MAX) undoStackRef.current.shift()
    redoStackRef.current = []
    setCanUndo(true); setCanRedo(false)
  }, [])

  const commitNoHistory = useCallback((next: Drawing[]) => {
    appliedRef.current = JSON.stringify(next)
    drawingsRef.current = next
    setDrawings(next); setDrawCount(next.length)
    setPref('chartDraw', symbol, next)
    syncPrims(next)
    // refresh selected renderer states
    for (const [id, prim] of primsRef.current) {
      prim._pv._renderer._selected = id === selectedRef.current
    }
  }, [setPref, symbol, syncPrims])

  const commit = useCallback((next: Drawing[]) => {
    pushUndo(drawingsRef.current)
    commitNoHistory(next)
  }, [pushUndo, commitNoHistory])

  const undo = useCallback(() => {
    const stack = undoStackRef.current; if (stack.length === 0) return
    const prev = stack.pop()!
    redoStackRef.current.push(drawingsRef.current)
    commitNoHistory(prev)
    setCanUndo(stack.length > 0); setCanRedo(true); setSelectedId(null); setPropsPanel(null)
  }, [commitNoHistory])

  const redo = useCallback(() => {
    const stack = redoStackRef.current; if (stack.length === 0) return
    const next = stack.pop()!
    undoStackRef.current.push(drawingsRef.current)
    commitNoHistory(next)
    setCanUndo(true); setCanRedo(stack.length > 0); setSelectedId(null); setPropsPanel(null)
  }, [commitNoHistory])

  // ──── 操作 / actions ────
  const lockedCount = drawings.filter((d) => d.locked).length

  const toggleLock = useCallback(() => {
    if (!selectedId) return
    const next = drawings.map((d) => d.id === selectedId ? { ...d, locked: !d.locked } : d)
    commit(next)
    if (next.find((d) => d.id === selectedId)?.locked) { setSelectedId(null); setPropsPanel(null) }
  }, [selectedId, drawings, commit])

  const lockAll = useCallback(() => { commit(drawings.map((d) => ({ ...d, locked: true }))); setSelectedId(null); setPropsPanel(null) }, [drawings, commit])
  const unlockAll = useCallback(() => { commit(drawings.map((d) => ({ ...d, locked: false }))) }, [drawings, commit])

  const deleteSelected = useCallback(() => {
    if (!selectedId) return
    commit(drawings.filter((d) => d.id !== selectedId)); setSelectedId(null); setPropsPanel(null)
  }, [selectedId, drawings, commit])

  const clearAll = useCallback(() => { if (drawings.length > 0) setConfirmOpen(true) }, [drawings.length])
  const doClearAll = useCallback(() => { setConfirmOpen(false); commit([]); setSelectedId(null); setPropsPanel(null) }, [commit])

  const applyColor = useCallback((c: string) => {
    setColor(c)
    if (selectedId) commit(drawings.map((d) => (d.id === selectedId ? { ...d, color: c } : d)))
  }, [selectedId, drawings, commit])

  const applyLineWidth = useCallback((w: number) => {
    if (!selectedId) return
    commit(drawings.map((d) => (d.id === selectedId ? { ...d, lineWidth: w } : d)))
  }, [selectedId, drawings, commit])

  const applyLineStyle = useCallback((s: 'solid' | 'dashed' | 'dotted') => {
    if (!selectedId) return
    commit(drawings.map((d) => (d.id === selectedId ? { ...d, lineStyle: s } : d)))
  }, [selectedId, drawings, commit])

  const ctxDeleteDrawing = useCallback(() => {
    if (!ctxMenu) return
    commit(drawings.filter((d) => d.id !== ctxMenu.drawingId))
    if (selectedId === ctxMenu.drawingId) { setSelectedId(null); setPropsPanel(null) }
    setCtxMenu(null)
  }, [ctxMenu, drawings, selectedId, commit])

  const ctxOpenSettings = useCallback(() => {
    if (!ctxMenu) return
    setSelectedId(ctxMenu.drawingId)
    setPropsPanel({ drawingId: ctxMenu.drawingId })
    setCtxMenu(null)
  }, [ctxMenu])

  useImperativeHandle(ref, () => ({
    tool, setTool, color, setColor, selectedId, drawCount, lockedCount,
    stayInDraw, setStayInDraw, visible, setVisible,
    deleteSelected, clearAll, applyColor,
    toggleLock, lockAll, unlockAll, undo, redo,
  }), [tool, color, selectedId, drawCount, lockedCount, stayInDraw, visible, deleteSelected, clearAll, applyColor, toggleLock, lockAll, unlockAll, undo, redo])

  // ──── 加载 / load ────
  useEffect(() => {
    const saved = getPref<Drawing[]>('chartDraw', symbol, [])
    const arr = Array.isArray(saved) ? saved : []
    const json = JSON.stringify(arr)
    if (symRef.current === symbol && json === appliedRef.current) return
    symRef.current = symbol; appliedRef.current = json
    setDrawings(arr); setDrawCount(arr.length); setSelectedId(null); setPropsPanel(null)
    // detach all then re-sync
    for (const [, prim] of primsRef.current) {
      try { series.detachPrimitive(prim as any) } catch { /* may already be detached */ }
    }
    primsRef.current.clear()
    syncPrims(arr)
  }, [symbol, getPref, series, syncPrims])

  // ──── 移除临时 primitive / remove temp primitive ────
  const removeTempPrim = useCallback(() => {
    if (tempPrimRef.current) {
      try { series.detachPrimitive(tempPrimRef.current as any) } catch { /* ok */ }
      tempPrimRef.current = null
    }
  }, [series])

  // ──── 指针事件：交互层 / pointer events: interaction ────
  const overlayRef = useRef<HTMLDivElement>(null)

  const getDrawType = (t: Tool): DrawType => {
    if (t === 'trend') return 'trend'; if (t === 'hline') return 'hline'; if (t === 'vline') return 'vline'
    if (t === 'ray') return 'ray'; if (t === 'crossline') return 'crossline'; if (t === 'rect') return 'rect'
    return 'fib'
  }

  const localXY = (e: RPointerEvent<HTMLDivElement> | PointerEvent) => {
    const el = overlayRef.current!
    const r = el.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  const hitHandle = useCallback((d: Drawing, x: number, y: number): number => {
    if (d.locked) return -1
    const toPx = (pt: Point) => ({ x: timeToX(chart, pt.t), y: series.priceToCoordinate(pt.p) })
    const check = (cx: number | null, cy: number | null) => cx != null && cy != null && Math.abs(x - cx) <= handleSz + 2 && Math.abs(y - cy) <= handleSz + 2

    if (d.type === 'hline') {
      const py = series.priceToCoordinate(d.pts[0].p)
      return check(host.clientWidth / 2, py) ? 0 : -1
    }
    if (d.type === 'vline') {
      const px = timeToX(chart, d.pts[0].t)
      return check(px, host.clientHeight / 2) ? 0 : -1
    }
    if (d.type === 'crossline') {
      const px = timeToX(chart, d.pts[0].t)
      const py = series.priceToCoordinate(d.pts[0].p)
      return check(px, py) ? 0 : -1
    }
    if (d.type === 'rect') {
      const a = toPx(d.pts[0]), b = toPx(d.pts[1])
      if (!a.x || !a.y || !b.x || !b.y) return -1
      const x1 = Math.min(a.x, b.x), y1 = Math.min(a.y, b.y), x2 = Math.max(a.x, b.x), y2 = Math.max(a.y, b.y)
      const corners = [{ x: x1, y: y1 }, { x: x2, y: y1 }, { x: x1, y: y2 }, { x: x2, y: y2 }]
      for (let i = 0; i < 4; i++) { if (check(corners[i].x, corners[i].y)) return i }
      return -1
    }
    const px = d.pts.map(toPx)
    for (let i = 0; i < px.length; i++) { if (check(px[i].x, px[i].y)) return i }
    return -1
  }, [chart, series, host, handleSz])

  const hitSingle = useCallback((x: number, y: number, d: Drawing): Drawing | null => {
    const toPx = (pt: Point) => ({ x: timeToX(chart, pt.t), y: series.priceToCoordinate(pt.p) })
    if (d.type === 'hline') {
      const py = series.priceToCoordinate(d.pts[0].p)
      if (py != null && Math.abs(y - py) <= tol) return d
      return null
    }
    if (d.type === 'vline') {
      const px = timeToX(chart, d.pts[0].t)
      if (px != null && Math.abs(x - px) <= tol) return d
      return null
    }
    if (d.type === 'crossline') {
      const px = timeToX(chart, d.pts[0].t)
      const py = series.priceToCoordinate(d.pts[0].p)
      if ((px != null && Math.abs(x - px) <= tol) || (py != null && Math.abs(y - py) <= tol)) return d
      return null
    }
    const a = toPx(d.pts[0]), b = toPx(d.pts[1])
    if (a.x == null || a.y == null || b.x == null || b.y == null) return null
    if (d.type === 'trend' || d.type === 'ray') {
      if (distToSeg(x, y, a.x, a.y, b.x, b.y) <= tol) return d
      if (Math.hypot(x - a.x, y - a.y) <= tol || Math.hypot(x - b.x, y - b.y) <= tol) return d
      return null
    }
    if (d.type === 'fib') {
      const xL = Math.min(a.x, b.x), xR = Math.max(a.x, b.x)
      if (x >= xL - tol && x <= xR + tol) {
        const yA = a.y, yB = b.y
        for (const lv of FIB_LEVELS) { if (Math.abs(y - (yB + (yA - yB) * lv)) <= tol) return d }
      }
      if (distToSeg(x, y, a.x, a.y, b.x, b.y) <= tol) return d
      return null
    }
    // rect
    const x1 = Math.min(a.x, b.x), x2 = Math.max(a.x, b.x), y1 = Math.min(a.y, b.y), y2 = Math.max(a.y, b.y)
    if (((x >= x1 - tol && x <= x2 + tol) && (Math.abs(y - y1) <= tol || Math.abs(y - y2) <= tol)) ||
        ((y >= y1 - tol && y <= y2 + tol) && (Math.abs(x - x1) <= tol || Math.abs(x - x2) <= tol))) return d
    return null
  }, [chart, series, tol])

  const hitDrawing = useCallback((x: number, y: number, includeLocked = false): Drawing | null => {
    const list = drawingsRef.current, sel = selectedRef.current
    if (sel) { const sd = list.find((d) => d.id === sel); if (sd && (includeLocked || !sd.locked)) { const h = hitSingle(x, y, sd); if (h) return h } }
    for (let i = list.length - 1; i >= 0; i--) {
      const d = list[i]; if (!includeLocked && d.locked) continue; if (d.id === sel) continue
      const h = hitSingle(x, y, d); if (h) return h
    }
    return null
  }, [hitSingle])

  // chart click subscription for cursor-mode selection
  useEffect(() => {
    const onClick = (p: any) => {
      if (toolRef.current !== 'cursor' && toolRef.current !== 'cross') return
      if (!p.hoveredObjectId && !p.point) {
        setSelectedId(null); setPropsPanel(null)
      }
    }
    chart.subscribeClick(onClick)
    return () => chart.unsubscribeClick(onClick)
  }, [chart])

  const onDown = useCallback((e: RPointerEvent<HTMLDivElement>) => {
    let { x, y } = localXY(e)
    const cur = toolRef.current

    // drawing tool active
    if (cur !== 'cursor' && cur !== 'cross') {
      // single-click tools
      if (cur === 'hline' || cur === 'vline' || cur === 'crossline') {
        const p = series.coordinateToPrice(y) as number | null
        const tm = xToTime(chart, x)
        if (cur === 'hline') {
          if (p == null) return
          const d: Drawing = { id: uid(), type: 'hline', pts: [{ t: 0, p }], color: colorRef.current }
          commit([...drawingsRef.current, d]); setSelectedId(d.id)
          if (!stayInDrawRef.current) setTool('cursor')
        } else if (cur === 'vline') {
          if (tm == null) return
          const d: Drawing = { id: uid(), type: 'vline', pts: [{ t: tm, p: 0 }], color: colorRef.current }
          commit([...drawingsRef.current, d]); setSelectedId(d.id)
          if (!stayInDrawRef.current) setTool('cursor')
        } else if (cur === 'crossline') {
          if (tm == null || p == null) return
          const d: Drawing = { id: uid(), type: 'crossline', pts: [{ t: tm, p }], color: colorRef.current }
          commit([...drawingsRef.current, d]); setSelectedId(d.id)
          if (!stayInDrawRef.current) setTool('cursor')
        }
        return
      }
      // drag-to-draw tools: create temp primitive for preview
      const dtype = getDrawType(cur)
      const tempId = uid()
      const tempD: Drawing = {
        id: tempId, type: dtype,
        pts: [{ t: 0, p: 0 }, { t: 0, p: 0 }],
        color: colorRef.current,
      }
      const tempPrim = new DrawPrimitive(tempD, digits)
      tempPrimRef.current = tempPrim
      series.attachPrimitive(tempPrim as any)
      dragRef.current = { mode: 'create', type: dtype, startX: x, startY: y }
      return
    }

    // cursor mode
    const h = hitDrawing(x, y, true)
    if (h) {
      if (h.locked) {
        setSelectedId(h.id); setPropsPanel({ drawingId: h.id })
        const now = Date.now()
        if (lastClickRef.current && lastClickRef.current.id === h.id && now - lastClickRef.current.time < 350) {
          commit(drawingsRef.current.map((d) => d.id === h.id ? { ...d, locked: false } : d))
          lastClickRef.current = null
          return
        }
        lastClickRef.current = { id: h.id, time: now }
        return
      }
      // check handle hit first
      const hi = hitHandle(h, x, y)
      if (hi >= 0) {
        dragRef.current = { mode: 'handle', id: h.id, handle: hi, origPts: h.pts.map((p) => ({ t: p.t, p: p.p })) }
        return
      }
      const now = Date.now()
      if (lastClickRef.current && lastClickRef.current.id === h.id && now - lastClickRef.current.time < 350) {
        setPropsPanel({ drawingId: h.id }); lastClickRef.current = null; return
      }
      lastClickRef.current = { id: h.id, time: now }
      setSelectedId(h.id); setPropsPanel({ drawingId: h.id })
      dragRef.current = { mode: 'move', id: h.id, startX: x, startY: y, origPts: h.pts.map((p) => ({ t: p.t, p: p.p })) }
    } else {
      setSelectedId(null); setPropsPanel(null)
    }
  }, [chart, series, commit, hitDrawing, hitHandle, digits])

  const onMove = useCallback((e: RPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag) return
    const { x, y } = localXY(e)

    if (drag.mode === 'create') {
      const temp = tempPrimRef.current
      if (!temp) return
      const p = series.coordinateToPrice(y) as number | null
      const tm = xToTime(chart, x)
      const p0 = series.coordinateToPrice(drag.startY) as number | null
      const tm0 = xToTime(chart, drag.startX)
      if (drag.type === 'hline') {
        if (p != null) temp.pts = [{ t: 0, p }]
      } else if (drag.type === 'vline') {
        if (tm != null) temp.pts = [{ t: tm, p: 0 }]
      } else if (drag.type === 'crossline') {
        if (tm != null && p != null) temp.pts = [{ t: tm, p }]
      } else {
        if (tm != null && p != null && tm0 != null && p0 != null) {
          temp.pts = [{ t: tm0, p: p0 }, { t: tm, p }]
        }
      }
      temp.requestUpdate()
    } else if (drag.mode === 'move') {
      const dx = x - drag.startX, dy = y - drag.startY
      const newPts = drag.origPts.map((pt) => {
        const origX = timeToX(chart, pt.t)
        const origY = series.priceToCoordinate(pt.p)
        if (origX == null || origY == null) return pt
        const newX = origX + dx, newY = origY + dy
        const newT = xToTime(chart, newX)
        const newP = series.coordinateToPrice(newY) as number | null
        if (newT == null || newP == null) return pt
        return { t: newT, p: newP }
      })
      // update drawing in place without commit (visual only)
      const list = drawingsRef.current
      const d = list.find((d) => d.id === drag.id)
      if (d) {
        const next = list.map((d) => d.id === drag.id ? { ...d, pts: (d.type === 'hline' || d.type === 'vline' || d.type === 'crossline') ? [newPts[0]] : newPts } : d)
        syncPrims(next)
      }
    } else if (drag.mode === 'handle') {
      const p = series.coordinateToPrice(y) as number | null
      const tm = xToTime(chart, x)
      if (p == null || tm == null) return
      const list = drawingsRef.current
      const d = list.find((d) => d.id === drag.id)
      if (!d) return
      const newPts = drag.origPts.map((pt, i) => i === drag.handle ? { t: tm, p } : pt)
      if (d.type === 'hline') {
        syncPrims(list.map((d) => d.id === drag.id ? { ...d, pts: [{ t: 0, p }] } : d))
      } else if (d.type === 'vline') {
        syncPrims(list.map((d) => d.id === drag.id ? { ...d, pts: [{ t: tm, p: 0 }] } : d))
      } else {
        syncPrims(list.map((d) => d.id === drag.id ? { ...d, pts: newPts } : d))
      }
    }
  }, [chart, series, syncPrims])

  const onUp = useCallback(() => {
    const drag = dragRef.current
    dragRef.current = null

    if (!drag) {
      removeTempPrim()
      return
    }

    if (drag.mode === 'create') {
      const temp = tempPrimRef.current
      removeTempPrim()
      if (!temp || temp.pts.length < 2 || (temp.type !== 'hline' && temp.type !== 'vline' && temp.type !== 'crossline' && temp.pts.length < 2)) return
      // validate points
      const valid = temp.pts.every((pt) => pt.t !== 0 || temp.type === 'hline')
      if (!valid && temp.type !== 'hline') return
      if (temp.type === 'hline' && temp.pts[0].p === 0) return
      if (temp.type === 'vline' && temp.pts[0].t === 0) return
      const d: Drawing = {
        id: temp.id, type: temp.type, pts: temp.pts.map((p) => ({ t: p.t, p: p.p })),
        color: temp.color, lineWidth: temp.lineWidth, lineStyle: temp.lineStyle,
      }
      if (d.type !== 'hline' && d.type !== 'vline' && d.type !== 'crossline') {
        // check min drag distance
        const a = timeToX(chart, d.pts[0].t)
        const b = timeToX(chart, d.pts[1].t)
        const ay = series.priceToCoordinate(d.pts[0].p)
        const by = series.priceToCoordinate(d.pts[1].p)
        if (a != null && b != null && ay != null && by != null && Math.hypot(b - a, by - ay) < 4) return
      }
      commit([...drawingsRef.current, d]); setSelectedId(d.id)
      if (!stayInDrawRef.current) setTool('cursor')
      setPropsPanel({ drawingId: d.id })
      return
    }

    // move or handle: commit the current state
    if (drag.mode === 'move' || drag.mode === 'handle') {
      // The live-updated state from syncPrims is already "dirty" in drawingsRef
      // but not committed to the persistent store yet. We need to read back the current
      // primitive state and commit it.
      const prim = primsRef.current.get(drag.id)
      if (prim) {
        const next = drawingsRef.current.map((d) => d.id === drag.id ? {
          ...d,
          pts: prim.pts.map((p) => ({ t: p.t, p: p.p })),
        } : d)
        commit(next)
      }
    }
  }, [chart, series, commit, removeTempPrim])

  // ──── 右键菜单点击外部关闭 / context-menu click-outside ────
  useEffect(() => {
    if (!ctxMenu) return
    const onDocClick = () => setCtxMenu(null)
    const tmr = setTimeout(() => document.addEventListener('click', onDocClick), 100)
    return () => { clearTimeout(tmr); document.removeEventListener('click', onDocClick) }
  }, [ctxMenu])

  // 手机长按 / mobile long-press
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!isTouchDevice) return
    const el = overlayRef.current; if (!el) return
    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return
      const touch = e.touches[0]
      longPressTimer.current = setTimeout(() => {
        if (toolRef.current !== 'cursor' && toolRef.current !== 'cross') return
        const r = el.getBoundingClientRect()
        const x = touch.clientX - r.left, y = touch.clientY - r.top
        const hit = hitDrawing(x, y, true)
        if (hit) { setSelectedId(hit.id); setCtxMenu({ x: touch.clientX, y: touch.clientY, drawingId: hit.id }) }
      }, 500)
    }
    const onEnd = () => { if (longPressTimer.current) { clearTimeout(longPressTimer.current); longPressTimer.current = null } }
    el.addEventListener('touchstart', onStart, { passive: true })
    el.addEventListener('touchend', onEnd, { passive: true })
    el.addEventListener('touchmove', onEnd, { passive: true })
    return () => { el.removeEventListener('touchstart', onStart); el.removeEventListener('touchend', onEnd); el.removeEventListener('touchmove', onEnd) }
  }, [hitDrawing])

  // ──── 键盘 / keyboard ────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (dragRef.current) { dragRef.current = null; removeTempPrim() }
        setTool('cursor'); setSelectedId(null); setCtxMenu(null); setPropsPanel(null)
      } else if (e.key === 'z' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        if (e.shiftKey) redo(); else undo()
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedRef.current) {
        const el = e.target as HTMLElement | null
        if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return
        commit(drawingsRef.current.filter((d) => d.id !== selectedRef.current))
        setSelectedId(null); setPropsPanel(null)
      } else if (!(e.target as HTMLElement)?.closest?.('input,textarea,select') && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const map: Record<string, Tool> = { '1': 'cursor', '2': 'trend', '3': 'hline', '4': 'vline', '5': 'rect', '6': 'fib', '7': 'ray', '8': 'crossline' }
        if (map[e.key]) { setTool(map[e.key]); setSelectedId(null) }
      }
    }
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey)
  }, [commit, undo, redo, removeTempPrim])

  // ──── 悬停光标样式 + 动态 pointer-events / hover cursor + dynamic pointer-events ────
  // 叠加层默认不接管指针事件(pointer-events: none),只有真的"有事可做"时
  // (正在拖拽 / 画图工具已激活 / 悬停在某条画线或手柄上)才切成 auto 去抢
  // 事件——不然它常驻盖住整块图表,原生的拖动平移/滚轮缩放永远传不到底下
  // 真正的图表 canvas 上。这是 ISeriesPrimitive 重写(f2a6f1b)时被误删的
  // 一段逻辑,重写前的 canvas 叠加层本来就是这么做的,这里原样恢复。
  // The overlay defaults to not capturing pointer events (pointer-events:
  // none), only switching to auto when there's actually something to do
  // (mid-drag / a drawing tool is active / hovering a drawing or its handle)
  // — otherwise it permanently sits on top of the whole chart and the native
  // drag-to-pan / wheel-to-zoom gestures never reach the real chart canvas
  // underneath. This logic was accidentally dropped during the
  // ISeriesPrimitive rewrite (f2a6f1b); the pre-rewrite canvas overlay did
  // exactly this, restored here as-is.
  const [cursorStyle, setCursorStyle] = useState<string>('')
  useEffect(() => {
    const el = overlayRef.current; if (!el) return
    const onHover = (e: PointerEvent) => {
      if (dragRef.current) { el.style.pointerEvents = 'auto'; return }
      if (toolRef.current !== 'cursor' && toolRef.current !== 'cross') {
        el.style.pointerEvents = 'auto'; setCursorStyle('crosshair'); return
      }
      const r = el.getBoundingClientRect()
      const x = e.clientX - r.left, y = e.clientY - r.top
      if (x < 0 || y < 0 || x > r.width || y > r.height) { el.style.pointerEvents = 'none'; setCursorStyle(''); return }
      const h = hitDrawing(x, y, true)
      if (h) {
        el.style.pointerEvents = 'auto'
        if (h.locked) { setCursorStyle('default'); return }
        const hi = hitHandle(h, x, y)
        if (hi >= 0) {
          if (h.type === 'rect') { setCursorStyle(hi === 0 || hi === 3 ? 'nwse-resize' : 'nesw-resize') }
          else { setCursorStyle('grab') }
        } else { setCursorStyle('move') }
      } else {
        el.style.pointerEvents = 'none'
        setCursorStyle(toolRef.current === 'cross' ? 'crosshair' : '')
      }
    }
    window.addEventListener('pointermove', onHover, true)
    return () => window.removeEventListener('pointermove', onHover, true)
  }, [hitDrawing, hitHandle])

  // 切换工具时立即同步一次,不用等下一次 pointermove 才生效(比如从画图工具
  // 切回光标,鼠标没动过的话之前的 onHover 判定还停留在"auto")。
  // Sync immediately on tool switch instead of waiting for the next
  // pointermove (e.g. switching from a drawing tool back to cursor without
  // moving the mouse would otherwise leave the last onHover verdict at "auto").
  useEffect(() => {
    const el = overlayRef.current; if (!el) return
    if (tool !== 'cursor' && tool !== 'cross') { el.style.pointerEvents = 'auto'; setCursorStyle('crosshair') }
    else { el.style.pointerEvents = 'none'; setCursorStyle('') }
  }, [tool])

  // ──── 工具栏 UI helpers ────
  const toolBtn = (id: Tool, icon: JSX.Element, label: string) => (
    <button type="button" title={label} aria-label={label} onClick={() => { setTool(id); if (id !== 'cursor' && id !== 'cross') setSelectedId(null) }}
      className={`flex h-8 w-8 items-center justify-center rounded-md border transition ${tool === id ? 'border-prism-500/60 bg-prism-600/25 text-prism-200' : 'border-white/10 bg-ink-800/60 text-slate-400 hover:text-slate-100'}`}
    >{icon}</button>
  )

  const toggleCollapse = (key: string) => setCollapsed((p) => ({ ...p, [key]: !p[key] }))

  return (
    <>
      {/* 叠加交互层 / transparent interaction layer */}
      <div
        ref={overlayRef}
        className="pointer-events-none absolute inset-1.5 z-10 touch-none"
        style={{ display: visible ? '' : 'none', cursor: cursorStyle || (tool !== 'cursor' && tool !== 'cross' ? 'crosshair' : 'default') }}
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
        onContextMenu={(e) => {
          e.preventDefault()
          if (tool !== 'cursor' && tool !== 'cross') return
          const el = overlayRef.current!; const r = el.getBoundingClientRect()
          const x = e.clientX - r.left, y = e.clientY - r.top
          const hit = hitDrawing(x, y, true)
          if (hit) { setSelectedId(hit.id); setCtxMenu({ x: e.clientX, y: e.clientY, drawingId: hit.id }) }
        }}
      />

      {/* 左侧浮动工具栏 */}
      {!hideToolbar && (
        <div className="absolute left-3 top-3 z-20 flex flex-col overflow-y-auto rounded-xl border border-white/10 bg-ink-900/80 p-1.5 backdrop-blur" style={{ maxHeight: 'calc(100dvh - 80px)' }}>
          <div className="flex flex-col gap-1 -mx-0.5 px-0.5 pb-1 border-b border-white/10 mb-1">
            <button type="button" title={t('charts.draw.stayInDraw')} aria-label={t('charts.draw.stayInDraw')}
              onClick={() => setStayInDraw(!stayInDraw)}
              className={`flex h-8 w-8 items-center justify-center rounded-md border transition ${stayInDraw ? 'border-prism-500/60 bg-prism-600/25 text-prism-200' : 'border-white/10 bg-ink-800/60 text-slate-400 hover:text-slate-100'}`}
            ><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3l4 4-4 4" /><path d="M3 17l4 4-4 4" /><line x1="21" y1="7" x2="7" y2="21" /><line x1="7" y1="3" x2="21" y2="17" /></svg></button>
            <button type="button" title={visible ? t('charts.draw.hideAll') : t('charts.draw.showAll')} aria-label={visible ? t('charts.draw.hideAll') : t('charts.draw.showAll')}
              onClick={() => setVisible(!visible)}
              className={`flex h-8 w-8 items-center justify-center rounded-md border transition ${!visible ? 'border-amber-400/60 bg-amber-400/15 text-amber-300' : 'border-white/10 bg-ink-800/60 text-slate-400 hover:text-slate-100'}`}
            ><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{visible ? <><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" /></> : <><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24" /><line x1="1" y1="1" x2="23" y2="23" /></>}</svg></button>
          </div>

          {/* 工具分组 / tool groups */}
          {TOOL_GROUPS.map((group) => {
            const isCollapsed = collapsed[group.key]
            return (
              <div key={group.key}>
                {isCollapsed ? (
                  <button type="button" onClick={() => toggleCollapse(group.key)}
                    title={String(t(`charts.draw.${group.key}`))} aria-label={String(t(`charts.draw.${group.key}`))}
                    className="flex h-8 w-8 items-center justify-between rounded-md border border-white/10 bg-ink-800/60 px-1.5 text-slate-400 transition hover:text-slate-100"
                  >
                    <span className="scale-75">{group.tools[0].svg}</span>
                    <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="opacity-40"><polyline points="6 9 12 15 18 9" /></svg>
                  </button>
                ) : (
                  <>
                    <div className="flex items-center gap-1 mb-1">
                      <div className="h-px flex-1 bg-white/10" />
                      <button type="button" onClick={() => toggleCollapse(group.key)} className="text-[9px] text-slate-500 hover:text-slate-300 px-1">{t(`charts.draw.${group.key}`)} <svg width="7" height="7" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" className="inline -mt-px"><polyline points="18 15 12 9 6 15" /></svg></button>
                      <div className="h-px flex-1 bg-white/10" />
                    </div>
                    <div className="flex flex-col gap-1">
                      {group.tools.map((ti) => toolBtn(ti.id, ti.svg, String(t(`charts.draw.${ti.id}`))))}
                    </div>
                    <div className="my-0.5 h-px w-full bg-white/10" />
                  </>
                )}
              </div>
            )
          })}

          {/* 颜色 / colors */}
          <div className="flex flex-col items-center gap-1">
            {COLORS.map((c) => (
              <button key={c} type="button" title={t('charts.draw.color')} aria-label={t('charts.draw.color')}
                onClick={() => { setColor(c); if (selectedId) commit(drawings.map((d) => (d.id === selectedId ? { ...d, color: c } : d))) }}
                className={`h-4 w-4 rounded-full border transition ${color === c ? 'border-white scale-110' : 'border-white/20'}`}
                style={{ background: c }}
              />
            ))}
          </div>
          <div className="my-0.5 h-px w-full bg-white/10" />

          {/* 锁定 / lock */}
          <button type="button" title={selectedId && drawings.find((d) => d.id === selectedId)?.locked ? t('charts.draw.unlock') : t('charts.draw.lock')} aria-label={t('charts.draw.lock')}
            onClick={toggleLock} disabled={!selectedId}
            className={`flex h-8 w-8 items-center justify-center rounded-md border transition ${selectedId && drawings.find((d) => d.id === selectedId)?.locked ? 'border-amber-400/60 bg-amber-400/15 text-amber-300' : 'border-white/10 bg-ink-800/60 text-slate-400 hover:text-slate-100'} disabled:opacity-30`}
          ><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0110 0v4" /></svg></button>
          <button type="button" title={t('charts.draw.lockAll')} aria-label={t('charts.draw.lockAll')} onClick={lockAll} disabled={drawCount === 0}
            className="flex h-8 w-8 items-center justify-center rounded-md border border-white/10 bg-ink-800/60 text-slate-400 hover:text-amber-300 disabled:opacity-30"
          ><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0110 0v4" /><line x1="12" y1="15" x2="12" y2="18" /></svg></button>
          <button type="button" title={t('charts.draw.unlockAll')} aria-label={t('charts.draw.unlockAll')} onClick={unlockAll} disabled={lockedCount === 0}
            className="flex h-8 w-8 items-center justify-center rounded-md border border-white/10 bg-ink-800/60 text-slate-400 hover:text-slate-100 disabled:opacity-30"
          ><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 019.9-1" /><line x1="12" y1="15" x2="12" y2="18" /></svg></button>
          <div className="my-0.5 h-px w-full bg-white/10" />

          {/* 撤销/重做 */}
          <button type="button" title={t('charts.draw.undo')} aria-label={t('charts.draw.undo')} onClick={undo} disabled={!canUndo}
            className="flex h-8 w-8 items-center justify-center rounded-md border border-white/10 bg-ink-800/60 text-slate-400 hover:text-slate-100 disabled:opacity-30"
          ><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="1 4 1 10 7 10" /><path d="M3.51 15a9 9 0 102.13-9.36L1 10" /></svg></button>
          <button type="button" title={t('charts.draw.redo')} aria-label={t('charts.draw.redo')} onClick={redo} disabled={!canRedo}
            className="flex h-8 w-8 items-center justify-center rounded-md border border-white/10 bg-ink-800/60 text-slate-400 hover:text-slate-100 disabled:opacity-30"
          ><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10" /></svg></button>
          <div className="my-0.5 h-px w-full bg-white/10" />

          {/* 删除 */}
          <button type="button" title={t('charts.draw.delete')} aria-label={t('charts.draw.delete')} onClick={deleteSelected} disabled={!selectedId}
            className="flex h-8 w-8 items-center justify-center rounded-md border border-white/10 bg-ink-800/60 text-slate-400 hover:text-down disabled:opacity-30"
          ><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" /></svg></button>
          <button type="button" title={t('charts.draw.clear')} aria-label={t('charts.draw.clear')} onClick={clearAll} disabled={drawCount === 0}
            className="flex h-8 w-8 items-center justify-center rounded-md border border-white/10 bg-ink-800/60 text-slate-400 hover:text-down disabled:opacity-30"
          ><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M19 5L5 19M5 5l14 14" /></svg></button>
        </div>
      )}

      {/* 浮动属性栏 */}
      {propsPanel && selectedId && (() => { const d = drawings.find((dw) => dw.id === selectedId); if (!d) return null; return (
        <div className={`absolute right-3 top-3 z-30 flex items-center gap-1.5 rounded-lg border border-white/10 bg-ink-900/90 px-2 py-1.5 backdrop-blur shadow-lg sm:gap-2.5 sm:px-3 sm:py-2.5`}>
          {LINE_WIDTHS.map((w) => (
            <button key={w} type="button" title={`${w}px`} onClick={() => applyLineWidth(w)}
              className={`flex items-center justify-center rounded border transition sm:w-7 sm:h-7 ${(d.lineWidth || 1) === w ? 'border-prism-500/60 bg-prism-600/25' : 'border-white/10 hover:border-white/20'}`}
              style={{ width: isTouchDevice ? 20 : 28, height: isTouchDevice ? 20 : 28 }}
            ><span style={{ display: 'block', width: w * 4 + 4, height: w, background: d.color, borderRadius: 1 }} /></button>
          ))}
          <span className="w-px h-5 sm:h-6 bg-white/10" />
          {(['solid', 'dashed', 'dotted'] as const).map((s) => (
            <button key={s} type="button" title={String(t(`charts.draw.${s}`))} onClick={() => applyLineStyle(s)}
              className={`flex items-center justify-center rounded border transition ${(d.lineStyle || 'solid') === s ? 'border-prism-500/60 bg-prism-600/25 text-prism-200' : 'border-white/10 text-slate-500 hover:text-slate-300'}`}
              style={{ height: isTouchDevice ? 20 : 26, width: isTouchDevice ? 28 : 36, fontSize: isTouchDevice ? 9 : 12 }}
            >{s === 'solid' ? '━━' : s === 'dashed' ? '┅┅' : '┅'}</button>
          ))}
          <span className="w-px h-5 sm:h-6 bg-white/10" />
          <button type="button" onClick={toggleLock}
            className={`rounded border px-1.5 transition sm:px-2 ${d.locked ? 'border-amber-400/60 text-amber-300' : 'border-white/10 text-slate-400 hover:text-slate-100'}`}
            style={{ height: isTouchDevice ? 20 : 26, fontSize: isTouchDevice ? 10 : 12 }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0110 0v4" />{d.locked && <line x1="12" y1="15" x2="12" y2="17" />}</svg>
          </button>
          <button type="button" onClick={deleteSelected}
            className="rounded border border-white/10 px-1.5 text-slate-400 hover:text-down sm:px-2"
            style={{ height: isTouchDevice ? 20 : 26, fontSize: isTouchDevice ? 10 : 12 }}
          ><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" /></svg></button>
        </div>
      )})()}

      {/* 右键菜单 */}
      {ctxMenu && (
        <div className="fixed z-50 min-w-[140px] rounded-lg border border-white/10 bg-ink-900/95 p-1 shadow-xl backdrop-blur" style={{ left: ctxMenu.x, top: ctxMenu.y }} onClick={(e) => e.stopPropagation()}>
          <button onClick={() => { const d = drawings.find((dw) => dw.id === ctxMenu.drawingId); if (d) commit(drawings.map((dw) => dw.id === ctxMenu.drawingId ? { ...dw, locked: !dw.locked } : dw)); setCtxMenu(null) }}
            className="flex w-full items-center gap-2 rounded px-3 py-1.5 text-xs text-slate-300 hover:bg-white/10"
          ><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0110 0v4" /></svg> {drawings.find((d) => d.id === ctxMenu.drawingId)?.locked ? t('charts.draw.unlock') : t('charts.draw.lock')}</button>
          <button onClick={ctxOpenSettings} className="flex w-full items-center gap-2 rounded px-3 py-1.5 text-xs text-slate-300 hover:bg-white/10"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3" /><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" /></svg> {t('charts.draw.settings')}</button>
          <button onClick={ctxDeleteDrawing} className="flex w-full items-center gap-2 rounded px-3 py-1.5 text-xs text-down hover:bg-white/10"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" /></svg> {t('charts.draw.delete')}</button>
        </div>
      )}

      {/* 清空确认弹窗 */}
      {confirmOpen && (
        <ConfirmModal title={t('charts.draw.clear')} message={t('charts.draw.clearConfirm', { symbol })} confirmLabel={t('charts.draw.clear')} danger center
          onConfirm={doClearAll} onCancel={() => setConfirmOpen(false)} />
      )}
    </>
  )
}

export default forwardRef(DrawLayer)