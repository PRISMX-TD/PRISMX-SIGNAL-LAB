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
  IChartApi, UTCTimestamp, IPrimitivePaneView,
  IPrimitivePaneRenderer, PrimitiveHoveredItem, AutoscaleInfo,
  Logical, PrimitivePaneViewZOrder, MouseEventParams,
} from 'lightweight-charts'
import type { MainSeriesApi } from './useChartEngine'
import { usePrefs } from '../../store/prefs'
import { chartApi } from '../../api/client'
import { onChartDrawingsUpdate } from '../../utils/chartDrawingsEvents'
import ConfirmModal from '../ConfirmModal'
import { useBackToClose } from '../../utils/useBackToClose'
import { isChartAlive } from './chartLifecycle'

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
  // 磁吸：画线时把点吸到 K 线的开高低收上（weak = 靠近才吸，strong = 总是吸）
  // Magnet: snap points to the bar's OHLC while drawing (weak = when close, strong = always)
  magnet: MagnetMode
  setMagnet: (m: MagnetMode) => void
}

export type MagnetMode = 'off' | 'weak' | 'strong'
const MAGNET_WEAK_PX = 18
const SAVE_DEBOUNCE_MS = 800

// 工具分组与竖排工具栏已随 hideToolbar 一起删除；工具由图表页的工具栏经 ref 切换。
// Tool groups / the vertical toolbar were removed with hideToolbar; the page's own toolbar drives tools via the ref.

// ──── 常量 / constants ────
interface Point { t: number; p: number }
interface Drawing { id: string; type: DrawType; pts: Point[]; color: string; locked?: boolean; lineWidth?: number; lineStyle?: 'solid' | 'dashed' | 'dotted' }
// 每个品种最近一次的画线（本次会话内的内存缓存）：切回来先秒显示，再后台核对云端。
// Latest drawings per symbol (in-memory for this session): shown at once on switching back,
// then checked against the cloud in the background.
const drawCache = new Map<string, Drawing[]>()
interface Props {
  chart: IChartApi; series: MainSeriesApi; host: HTMLDivElement; symbol: string; barTimes: () => number[]; digits?: number
  // 句柄上的状态（当前工具 / 选中 / 数量…）提交后通知外部工具栏重渲染。外部点按钮时页面会先于
  // 本组件重渲染、读到旧句柄，按下态就慢一拍；画完自动回到光标也不会反映到工具栏上。
  // Fires after the handle's state (tool / selection / counts…) commits, so external toolbars
  // re-render. A toolbar click re-renders the page before this layer, reading the stale handle —
  // the pressed state lagged one click, and the auto-return to cursor after drawing never showed.
  onStateChange?: () => void
}

const TOL_DESKTOP = 12
const TOL_MOBILE = 24
const HANDLE_DESKTOP = 10
const HANDLE_MOBILE = 20
// 挪线 / 拉手柄的起拖阈值：点一下选中、手指按住时的自然抖动都不该把线挪走。
// Move / handle drag threshold: a tap to select, or a resting finger's jitter, must not move the line.
const DRAG_SLOP_MOUSE = 6
const DRAG_SLOP_TOUCH = 10
// 长按出菜单：手指偏离起点超过这么远才算「在拖」、取消长按。
// Long-press: only a finger that strays this far from its start cancels the timer.
const LONG_PRESS_SLOP = 10
const UNDO_MAX = 30
const COLORS = ['#22d3ee', '#a78bfa', '#2ee07e', '#ff4d67', '#f5c451']
const LINE_WIDTHS = [1, 2, 3, 4]
const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1]

const isTouchDevice = typeof window !== 'undefined' && (window.matchMedia?.('(pointer: coarse)').matches || navigator.maxTouchPoints > 0)
// 触摸、以及粗指针设备上的笔，都没有「悬停」，改走「点一下选中」（见 subscribeClick）。
// Touch, and a pen on a coarse-pointer device, have no hover; they use tap-to-select.
const isTouchLike = (pointerType: string) => pointerType === 'touch' || (pointerType === 'pen' && isTouchDevice)

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
// 每个图表实例各自的 bar 时间访问器。以前是一个模块级变量，同一页面若有两个图表
// 会互相覆盖；按 chart 对象存进 WeakMap，实例之间互不干扰，图表销毁后自动回收。
// Per-chart accessor for bar times. Used to be one module-level variable, which
// two charts on the same page would overwrite; keyed by the chart object instead.
const barTimesByChart = new WeakMap<IChartApi, () => number[]>()
const barTimesOf = (chart: IChartApi): number[] => barTimesByChart.get(chart)?.() ?? []

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
  const lg = timeToLogical(barTimesOf(chart), t)
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
  return logicalToTime(barTimesOf(chart), lg)
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
  private _series: MainSeriesApi | null = null
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
  attached(p: { chart: IChartApi; series: MainSeriesApi; requestUpdate: () => void }) {
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
      ctx.fillStyle = '#09090b'; ctx.strokeStyle = '#ffffff'
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
function DrawLayer({ chart, series, host, symbol, barTimes, digits = 2, onStateChange }: Props, ref: React.Ref<DrawLayerHandle>) {
  const { t } = useTranslation()
  const { getPref, setPref } = usePrefs()

  // 把 bar 时间访问器按本图表登记，供 primitive 渲染与坐标外推读取（见文件顶部
  // timeToX/xToTime）。必须在 effect 里写，不能写在渲染函数体里：那是渲染期副作用，
  // Strict Mode 双渲染 / 并发渲染下语义不确定，而这行是画线坐标外推的唯一数据来源，
  // 出问题的表现就是"画线位置错乱"。
  // Register the bar-times accessor for this chart (read by the primitive renderer
  // and by timeToX/xToTime). It lives in an effect rather than the render body:
  // writing to a module-level map during render is a render-phase side effect with
  // undefined semantics under StrictMode double-rendering and concurrent
  // rendering — and this line is the only source for drawing coordinates.
  useEffect(() => {
    barTimesByChart.set(chart, barTimes)
  }, [chart, barTimes])

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
  const visibleRef = useRef(true)
  visibleRef.current = visible
  const [magnet, setMagnetState] = useState<MagnetMode>(() => {
    const m = getPref<string>('charts', 'drawMagnet', 'off')
    return m === 'weak' || m === 'strong' ? m : 'off'
  })
  const magnetRef = useRef(magnet)
  magnetRef.current = magnet
  const setMagnet = useCallback((m: MagnetMode) => { setMagnetState(m); setPref('charts', 'drawMagnet', m) }, [setPref])

  // undo/redo
  const undoStackRef = useRef<Drawing[][]>([])
  const redoStackRef = useRef<Drawing[][]>([])

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
  // pointerId：只认按下的那根手指。slop / active：move 与 handle 过了起拖阈值才算真拖。
  // pointerId: only the pressing pointer counts. slop / active: a move or handle drag
  // only starts once past the threshold.
  const dragRef = useRef<
    | { mode: 'create'; type: DrawType; startX: number; startY: number; pointerId: number }
    | { mode: 'move'; id: string; startX: number; startY: number; origPts: Point[]; pointerId: number; slop: number; active: boolean }
    | { mode: 'handle'; id: string; handle: number; startX: number; startY: number; origPts: Point[]; pointerId: number; slop: number; active: boolean }
    | null
  >(null)
  const appliedRef = useRef(''); const symRef = useRef(symbol)
  const lastClickRef = useRef<{ id: string; time: number } | null>(null)
  const tempPrimRef = useRef<DrawPrimitive | null>(null)
  // 选中是手指点出来的：选中期间交互层保持接管指针（下一次按在线上就能拖）。
  // lastTouchRef：最近一次按下是不是触摸，subscribeClick 的回调里拿不到 pointerType。
  // The selection came from a tap: while it lasts the layer keeps the pointer so the next
  // press on the line drags it. lastTouchRef: whether the latest press was touch, since
  // subscribeClick's callback has no pointerType.
  const touchSelRef = useRef(false)
  const lastTouchRef = useRef(false)

  toolRef.current = tool; colorRef.current = color
  selectedRef.current = selectedId; drawingsRef.current = drawings; stayInDrawRef.current = stayInDraw

  // ──── attach/detach primitives to/from series ────
  const syncPrims = useCallback((list: Drawing[]) => {
    const map = primsRef.current
    // 「隐藏全部」：真正把 primitive 摘掉（以前只藏了交互层，线还画在图上）。
    // "Hide all" really detaches the primitives (it used to hide only the interaction layer).
    const keep = new Set(visibleRef.current ? list.map((d) => d.id) : [])

    // detach removed
    for (const [id, prim] of map) {
      if (!keep.has(id)) {
        series.detachPrimitive(prim as any)
        map.delete(id)
      }
    }

    // attach new or update existing
    for (const d of visibleRef.current ? list : []) {
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
  }, [])

  // ──── 云端保存（rev 55 chart_drawings 表）/ cloud save (rev 55 chart_drawings table) ────
  // 防抖后整组覆盖保存；lastSavedAtRef 记住自己最近一次保存的 updatedAt，WS 推回来的同一次
  // 保存就不再重拉。切品种 / 卸载 / 退到后台时立即发出未保存的那份。
  // Debounced whole-array save; lastSavedAtRef remembers our latest save's updatedAt so the WS
  // echo of that save doesn't trigger a refetch. Pending saves flush on symbol switch /
  // unmount / backgrounding.
  const pendingRef = useRef<{ symbol: string; list: Drawing[] } | null>(null)
  const saveTimerRef = useRef<number | undefined>(undefined)
  const lastSavedAtRef = useRef<string | null>(null)
  const flushSave = useCallback(() => {
    window.clearTimeout(saveTimerRef.current)
    saveTimerRef.current = undefined
    const job = pendingRef.current
    if (!job) return
    pendingRef.current = null
    chartApi.saveDrawings(job.symbol, job.list)
      .then((r) => { lastSavedAtRef.current = r.updatedAt ?? null })
      .catch(() => { /* 下次改动会再存；本机缓存里还有 / the next edit saves again; the cache still has it */ })
  }, [])
  const scheduleSave = useCallback((sym: string, list: Drawing[]) => {
    drawCache.set(sym, list)
    pendingRef.current = { symbol: sym, list }
    window.clearTimeout(saveTimerRef.current)
    saveTimerRef.current = window.setTimeout(flushSave, SAVE_DEBOUNCE_MS)
  }, [flushSave])
  useEffect(() => {
    const onHide = () => { if (document.visibilityState === 'hidden') flushSave() }
    document.addEventListener('visibilitychange', onHide)
    window.addEventListener('pagehide', flushSave)
    return () => { document.removeEventListener('visibilitychange', onHide); window.removeEventListener('pagehide', flushSave); flushSave() }
  }, [flushSave])

  const commitNoHistory = useCallback((next: Drawing[]) => {
    appliedRef.current = JSON.stringify(next)
    drawingsRef.current = next
    setDrawings(next); setDrawCount(next.length)
    scheduleSave(symbol, next)
    syncPrims(next)
    // refresh selected renderer states
    for (const [id, prim] of primsRef.current) {
      prim._pv._renderer._selected = id === selectedRef.current
    }
  }, [scheduleSave, symbol, syncPrims])

  const commit = useCallback((next: Drawing[]) => {
    pushUndo(drawingsRef.current)
    commitNoHistory(next)
  }, [pushUndo, commitNoHistory])

  const undo = useCallback(() => {
    const stack = undoStackRef.current; if (stack.length === 0) return
    const prev = stack.pop()!
    redoStackRef.current.push(drawingsRef.current)
    commitNoHistory(prev)
    setSelectedId(null); setPropsPanel(null)
  }, [commitNoHistory])

  const redo = useCallback(() => {
    const stack = redoStackRef.current; if (stack.length === 0) return
    const next = stack.pop()!
    undoStackRef.current.push(drawingsRef.current)
    commitNoHistory(next)
    setSelectedId(null); setPropsPanel(null)
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
    toggleLock, lockAll, unlockAll, undo, redo, magnet, setMagnet,
  }), [tool, color, selectedId, drawCount, lockedCount, stayInDraw, visible, deleteSelected, clearAll, applyColor, toggleLock, lockAll, unlockAll, undo, redo, magnet, setMagnet])
  const onStateChangeRef = useRef(onStateChange)
  onStateChangeRef.current = onStateChange
  useEffect(() => { onStateChangeRef.current?.() }, [tool, color, selectedId, drawCount, lockedCount, stayInDraw, visible, magnet])

  // 显示 / 隐藏全部：重新对账 primitive；隐藏时顺带取消选中。
  // Show / hide all: re-reconcile the primitives; hiding also clears the selection.
  useEffect(() => {
    if (!visible) { setSelectedId(null); setPropsPanel(null) }
    syncPrims(drawingsRef.current)
  }, [visible, syncPrims])

  // ──── 加载 / load ────
  // 2026-11-25 起画线存在 chart_drawings 表（每品种一行，GET/PUT /chart/drawings），不再放进
  // prefs 的 chartDraw 命名空间——那份文档每次登录整份下发。先显示本机缓存（或旧 chartDraw
  // 里的那份），再拉云端；云端还没有这一行而旧数据里有，就把旧数据搬上去（一次性迁移）。
  // 旧 chartDraw 数据原样保留不删，旧 App 包仍读得到。
  // Since 2026-11-25 drawings live in the chart_drawings table (a row per symbol, GET/PUT
  // /chart/drawings) instead of the prefs chartDraw namespace, a document shipped whole on
  // every login. Show the local cache (or the legacy chartDraw copy) first, then fetch the
  // cloud; when the cloud has no row but the legacy data does, upload it (one-off migration).
  // Legacy chartDraw data is left untouched so old App bundles still read it.
  const legacyOf = useCallback((sym: string): Drawing[] => {
    const saved = getPref<Drawing[]>('chartDraw', sym, [])
    return Array.isArray(saved) ? saved : []
  }, [getPref])
  const legacyRef = useRef(legacyOf)
  legacyRef.current = legacyOf
  const applyList = useCallback((arr: Drawing[], resetSel: boolean) => {
    const json = JSON.stringify(arr)
    if (json === appliedRef.current) return
    appliedRef.current = json
    drawingsRef.current = arr
    setDrawings(arr); setDrawCount(arr.length)
    if (resetSel) { setSelectedId(null); setPropsPanel(null) }
    syncPrims(arr)
  }, [syncPrims])
  const fetchCloud = useCallback((sym: string, migrate: boolean) => {
    chartApi.getDrawings(sym).then((r) => {
      if (symRef.current !== sym || pendingRef.current?.symbol === sym) return
      const cloud = Array.isArray(r.drawings) ? (r.drawings as Drawing[]) : []
      if (r.updatedAt == null && migrate) {
        const legacy = legacyRef.current(sym)
        if (legacy.length > 0) { scheduleSave(sym, legacy); flushSave(); applyList(legacy, false); return }
      }
      lastSavedAtRef.current = r.updatedAt ?? null
      drawCache.set(sym, cloud)
      applyList(cloud, false)
    }).catch(() => { /* 离线 / 未登录：保持本机显示 / offline or signed out: keep the local copy */ })
  }, [applyList, scheduleSave, flushSave])
  const loadedSymRef = useRef<string | null>(null)
  useEffect(() => {
    if (loadedSymRef.current === symbol) return
    // 切品种前把上一个品种没存的发出去 / flush the previous symbol's pending save first
    if (pendingRef.current && pendingRef.current.symbol !== symbol) flushSave()
    loadedSymRef.current = symbol
    symRef.current = symbol
    undoStackRef.current = []; redoStackRef.current = []
    const arr = drawCache.get(symbol) ?? legacyRef.current(symbol)
    // detach all then re-sync
    for (const [, prim] of primsRef.current) {
      try { series.detachPrimitive(prim as any) } catch { /* may already be detached */ }
    }
    primsRef.current.clear()
    appliedRef.current = ''
    applyList(arr, true)
    // 品种列表还没到时 symbol 是空串，不去拉（后端会回 422）。
    // symbol is '' until the symbol list arrives; don't fetch then (the backend would 422).
    if (symbol) fetchCloud(symbol, !drawCache.has(symbol))
  }, [symbol, series, applyList, fetchCloud, flushSave])
  // 别的设备改了这个品种的画线：重拉（自己这次保存的回声跳过）。
  // Another device changed this symbol's drawings: refetch (skip the echo of our own save).
  useEffect(() => onChartDrawingsUpdate((d) => {
    if (d.symbol !== symRef.current || d.updatedAt === lastSavedAtRef.current || pendingRef.current) return
    if (dragRef.current) return
    fetchCloud(d.symbol, false)
  }), [fetchCloud])

  // 卸载时把所有 primitive 从 series 上摘掉。切品种那条路径早就 detach 了，唯独
  // 卸载没有——现在不暴雷只是因为父组件紧接着就 chart.remove() 把整张图连锅端了，
  // 两个同类层（PositionOverlay 有完整的 attach/detach + isChartAlive 守卫）生命
  // 周期处理不对称，后面谁改动谁踩。isChartAlive 的理由见 chartLifecycle.ts：
  // chart 已销毁时 detach 只会排出一帧在 disposed 对象上的重绘。
  // Detach every primitive on unmount. The symbol-switch path already did this;
  // unmount didn't, and only gets away with it because the parent's cleanup runs
  // chart.remove() right after. PositionOverlay has the symmetric attach/detach
  // with an isChartAlive guard (see chartLifecycle.ts: detaching from a disposed
  // chart only schedules a repaint on a dead object).
  useEffect(() => () => {
    if (!isChartAlive(chart)) { primsRef.current.clear(); return }
    for (const [, prim] of primsRef.current) {
      try { series.detachPrimitive(prim as never) } catch { /* 已 detach / already detached */ }
    }
    primsRef.current.clear()
  }, [chart, series])

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
      // 必须判 null 而不是 falsy：坐标 0 是完全合法的（贴着左边缘 / 贴着顶边的
      // 手柄），用 !a.x 会把它当成"拿不到坐标"，那个角的手柄就抓不住。本文件其它
      // 命中判定处都用的是 == null，只有这里漏了。
      // Null checks, not falsy ones: 0 is a legal coordinate (a handle flush with
      // the left or top edge), and `!a.x` would read it as "no coordinate",
      // making that corner ungrabbable. Every other hit test here uses == null.
      if (a.x == null || a.y == null || b.x == null || b.y == null) return -1
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
  // 触摸没有悬停，交互层平时不接管指针，手指点到画线时点击落在图表上：在这里做一次画线
  // 命中，选中它，并让交互层在选中期间接管（下一次按在线上就能拖 / 拉手柄 / 长按出菜单）。
  // 坐标用 sourceEvent 减交互层的 rect，与 onDown 的 localXY 同一坐标系。
  // Touch has no hover, so the layer is not armed and a tap on a drawing lands on the
  // chart: hit-test drawings here, select the hit, and keep the layer armed while it is
  // selected (the next press drags / resizes / long-presses it). sourceEvent minus the
  // layer's rect is the same space localXY uses in onDown.
  useEffect(() => {
    const onClick = (p: MouseEventParams) => {
      if (toolRef.current !== 'cursor' && toolRef.current !== 'cross') return
      if (!p.hoveredObjectId && !p.point) {
        setSelectedId(null); setPropsPanel(null)
        return
      }
      if (!lastTouchRef.current || p.paneIndex !== 0) return
      const el = overlayRef.current
      const src = p.sourceEvent
      if (!el || !src) return
      const r = el.getBoundingClientRect()
      const hit = hitDrawing(src.clientX - r.left, src.clientY - r.top, true)
      if (!hit) return
      touchSelRef.current = true
      el.style.pointerEvents = 'auto'
      setSelectedId(hit.id); setPropsPanel({ drawingId: hit.id })
    }
    chart.subscribeClick(onClick)
    return () => chart.unsubscribeClick(onClick)
  }, [chart, hitDrawing])

  // 磁吸：把 (x, y) 吸到最近一根 K 线的开高低收上。strong 总是吸（x 也对到 K 线中心），
  // weak 只在离某个价位 MAGNET_WEAK_PX 以内时吸。
  // Magnet: snap (x, y) to the nearest bar's OHLC. strong always snaps (x to the bar centre
  // too); weak only within MAGNET_WEAK_PX of a level.
  const snap = useCallback((x: number, y: number): { x: number; y: number } => {
    const m = magnetRef.current
    if (m === 'off') return { x, y }
    const ts = chart.timeScale()
    const lg = ts.coordinateToLogical(x)
    if (lg == null) return { x, y }
    const idx = Math.round(lg)
    const bar = series.dataByIndex(idx) as { open?: number; high?: number; low?: number; close?: number } | null
    if (!bar || bar.high == null || bar.low == null || bar.open == null || bar.close == null) return { x, y }
    let best: number | null = null
    let dist = Infinity
    for (const p of [bar.open, bar.high, bar.low, bar.close]) {
      const py = series.priceToCoordinate(p)
      if (py == null) continue
      const d = Math.abs(py - y)
      if (d < dist) { dist = d; best = py }
    }
    if (best == null || (m === 'weak' && dist > MAGNET_WEAK_PX)) return { x, y }
    const cx = ts.logicalToCoordinate(idx as Logical)
    return { x: m === 'strong' && cx != null ? cx : x, y: best }
  }, [chart, series])

  const onDown = useCallback((e: RPointerEvent<HTMLDivElement>) => {
    // 第二根手指：画到一半就作废这一笔（否则临时线留在图上成了「幽灵线」）；挪动 / 拉手柄
    // 时不理它，继续只跟第一根手指（onMove / onUp / onCancel 按 pointerId 过滤）。
    // A second finger voids a stroke in progress (else its temp line is left behind as a
    // ghost); during a move / handle drag it is ignored and the first finger keeps control
    // (onMove / onUp / onCancel filter by pointerId).
    if (!e.isPrimary) {
      if (dragRef.current?.mode === 'create') { dragRef.current = null; removeTempPrim() }
      return
    }
    let { x, y } = localXY(e)
    const cur = toolRef.current
    // 抓住指针：交互层只有 inset-1.5 那么大，不捕获的话指针一拖出这个矩形，
    // pointerup 就落不到它身上，dragRef 永远非空 → 上面那段 onHover 会把
    // pointerEvents 永久钉在 auto，图表的拖动平移与滚轮缩放全部失效，只能按 Esc
    // 解套。SlideToConfirm 与 PositionOverlay 都做了捕获，这里漏了。
    // Capture the pointer: the layer is only inset-1.5, so without capture a drag
    // that leaves the rect never delivers pointerup, dragRef stays non-null and
    // the hover handler pins pointerEvents to 'auto' forever — the chart's own
    // pan/zoom die until the user presses Esc. Both SlideToConfirm and
    // PositionOverlay already capture; this one didn't.
    e.currentTarget.setPointerCapture?.(e.pointerId)

    // drawing tool active
    if (cur !== 'cursor' && cur !== 'cross') {
      ;({ x, y } = snap(x, y))
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
      dragRef.current = { mode: 'create', type: dtype, startX: x, startY: y, pointerId: e.pointerId }
      return
    }

    // cursor mode
    const h = hitDrawing(x, y, true)
    const slop = isTouchLike(e.pointerType) ? DRAG_SLOP_TOUCH : DRAG_SLOP_MOUSE
    if (h) {
      touchSelRef.current = isTouchLike(e.pointerType)
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
        dragRef.current = { mode: 'handle', id: h.id, handle: hi, startX: x, startY: y, origPts: h.pts.map((p) => ({ t: p.t, p: p.p })), pointerId: e.pointerId, slop, active: false }
        return
      }
      const now = Date.now()
      if (lastClickRef.current && lastClickRef.current.id === h.id && now - lastClickRef.current.time < 350) {
        setPropsPanel({ drawingId: h.id }); lastClickRef.current = null; return
      }
      lastClickRef.current = { id: h.id, time: now }
      setSelectedId(h.id); setPropsPanel({ drawingId: h.id })
      dragRef.current = { mode: 'move', id: h.id, startX: x, startY: y, origPts: h.pts.map((p) => ({ t: p.t, p: p.p })), pointerId: e.pointerId, slop, active: false }
    } else {
      touchSelRef.current = false
      setSelectedId(null); setPropsPanel(null)
    }
  }, [chart, series, commit, hitDrawing, hitHandle, digits, removeTempPrim, snap])

  const onMove = useCallback((e: RPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || e.pointerId !== drag.pointerId) return
    let { x, y } = localXY(e)
    if (drag.mode !== 'move') ({ x, y } = snap(x, y))
    // 起拖阈值：挪线 / 拉手柄要先走出 slop（鼠标 6px、手指 10px）。过了阈值后仍按原始按下点
    // 1:1 跟随，线停在手指按住它的位置上。
    // Threshold: a move / handle drag waits until the pointer leaves the slop (6px mouse,
    // 10px touch); after that it tracks 1:1 from the original press point.
    if (drag.mode !== 'create' && !drag.active) {
      if (Math.hypot(x - drag.startX, y - drag.startY) < drag.slop) return
      drag.active = true
    }

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
  }, [chart, series, syncPrims, snap])

  const onUp = useCallback((e?: RPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (drag && e && e.pointerId !== drag.pointerId) return   // 第二根手指抬起 / a second finger lifting
    dragRef.current = null
    if (e && e.currentTarget.hasPointerCapture?.(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }

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
        const pts = prim.pts.map((p) => ({ t: p.t, p: p.p }))
        // 没真的动过就不压撤销记录：点一下选中也会走到这里，连点几下就把上限 30
        // 的撤销栈塞满无操作记录，真正的上一步被挤出去，Ctrl+Z 撤不回东西。
        // Don't push an undo entry when nothing moved: a plain click to select
        // lands here too, and a few clicks would fill the 30-deep undo stack with
        // no-ops, evicting the step the user actually wants back.
        const same = pts.length === drag.origPts.length
          && pts.every((p, i) => p.t === drag.origPts[i].t && p.p === drag.origPts[i].p)
        if (!same) {
          const next = drawingsRef.current.map((d) => d.id === drag.id ? { ...d, pts } : d)
          commit(next)
        }
      }
    }
  }, [chart, series, commit, removeTempPrim])

  // 系统取消（边缘返回手势、掌心误触、来电）：放弃这一笔。画到一半的临时线移除；挪动 / 拉手柄中
  // 的画线按 drawingsRef 原样画回去（拖动中从没 commit 过），不提交、不压撤销栈。
  // A system cancel (edge back gesture, palm, incoming call) abandons the stroke: a
  // half-drawn temp line is removed; a drawing mid move / resize is repainted from
  // drawingsRef (never committed during the drag). Nothing is committed or pushed to undo.
  const onCancel = useCallback((e: RPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (drag && e.pointerId !== drag.pointerId) return
    dragRef.current = null
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    removeTempPrim()
    if (drag && drag.mode !== 'create') syncPrims(drawingsRef.current)
  }, [removeTempPrim, syncPrims])

  // ──── 右键菜单点击外部关闭 / context-menu click-outside ────
  useEffect(() => {
    if (!ctxMenu) return
    const onDocClick = () => setCtxMenu(null)
    const tmr = setTimeout(() => document.addEventListener('click', onDocClick), 100)
    return () => { clearTimeout(tmr); document.removeEventListener('click', onDocClick) }
  }, [ctxMenu])

  // 手机长按 / mobile long-press
  // 手指偏离起点超过 LONG_PRESS_SLOP 才取消：按住不动时也有亚像素抖动，以前任何一次
  // touchmove 都取消，长按几乎出不来。touchcancel（系统接管手势）同样取消。
  // Only a finger that strays past LONG_PRESS_SLOP cancels: a resting finger still jitters,
  // and cancelling on any touchmove made the long-press nearly impossible. touchcancel
  // (the system taking the gesture) cancels too.
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!isTouchDevice) return
    const el = overlayRef.current; if (!el) return
    let sx = 0, sy = 0
    const clear = () => { if (longPressTimer.current) { clearTimeout(longPressTimer.current); longPressTimer.current = null } }
    const onStart = (e: TouchEvent) => {
      clear()
      if (e.touches.length !== 1) return
      const touch = e.touches[0]
      sx = touch.clientX; sy = touch.clientY
      longPressTimer.current = setTimeout(() => {
        longPressTimer.current = null
        if (toolRef.current !== 'cursor' && toolRef.current !== 'cross') return
        const r = el.getBoundingClientRect()
        const hit = hitDrawing(sx - r.left, sy - r.top, true)
        if (hit) { setSelectedId(hit.id); setCtxMenu({ x: sx, y: sy, drawingId: hit.id }) }
      }, 500)
    }
    const onMoveTouch = (e: TouchEvent) => {
      const touch = e.touches[0]
      if (!touch || Math.hypot(touch.clientX - sx, touch.clientY - sy) > LONG_PRESS_SLOP) clear()
    }
    el.addEventListener('touchstart', onStart, { passive: true })
    el.addEventListener('touchmove', onMoveTouch, { passive: true })
    el.addEventListener('touchend', clear, { passive: true })
    el.addEventListener('touchcancel', clear, { passive: true })
    return () => {
      clear()
      el.removeEventListener('touchstart', onStart)
      el.removeEventListener('touchmove', onMoveTouch)
      el.removeEventListener('touchend', clear)
      el.removeEventListener('touchcancel', clear)
    }
  }, [hitDrawing])

  // ──── 键盘 / keyboard ────
  useEffect(() => {
    // 焦点在输入框里时，这些快捷键一概不接管——用户在下单票的手数 / 止损框里按
    // Ctrl+Z 想撤销刚打的字，撤销的却是图表上的画线。Delete 分支本来就排除了输入
    // 框，Ctrl+Z 漏了。/ Never hijack these while a text field has focus: Ctrl+Z in
    // the ticket's volume or SL field used to undo a drawing instead of the typing.
    // The Delete branch already excluded inputs; Ctrl+Z didn't.
    const inTextField = (target: EventTarget | null): boolean => {
      const el = target as HTMLElement | null
      if (!el) return false
      return !!el.closest?.('input,textarea,select,[contenteditable="true"]')
    }
    // 单键快捷键（1-8 换工具、Delete / Backspace 删选中的画线）只在焦点落在图表区里时
    // 生效。图表区 = .term-cv（画线竖轨 + 工具条 + 图表）；ChartsPage 给图表容器加了
    // tabIndex，点一下图表焦点就进来了。以前挂在 window 上全页生效：在自选栏、下单票的
    // 按钮上按一下数字就悄悄换了画线工具，选中画线后在别处按退格会把画线删掉（WCAG
    // 2.1.4 单字符快捷键）。数字分支原来只排除 input / textarea / select，漏了
    // contenteditable，现在和别的分支一样用 inTextField。Esc 和 Ctrl+Z 不受这条限制：
    // Esc 只是取消，Ctrl+Z 带修饰键。
    // Single-key shortcuts (1-8 pick a tool, Delete / Backspace remove the selected
    // drawing) only act while focus is inside the chart area: .term-cv (draw rail +
    // toolbar + chart); ChartsPage gives the chart container a tabIndex, so one click on
    // the chart brings focus in. They used to listen page-wide on window: a digit pressed
    // on a watchlist or ticket button silently switched the drawing tool, and Backspace
    // elsewhere deleted the selected drawing (WCAG 2.1.4, character key shortcuts). The
    // digit branch excluded only input / textarea / select and missed contenteditable; it
    // now uses inTextField like the other branches. Esc and Ctrl+Z are not gated: Esc only
    // cancels, Ctrl+Z carries a modifier.
    const inChartArea = (): boolean => {
      const scope = host.closest('.term-cv') || host.parentElement
      const active = document.activeElement
      return !!scope && !!active && scope.contains(active)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (dragRef.current) { dragRef.current = null; removeTempPrim() }
        setTool('cursor'); setSelectedId(null); setCtxMenu(null); setPropsPanel(null)
      } else if (e.key === 'z' && (e.ctrlKey || e.metaKey)) {
        if (inTextField(e.target)) return
        e.preventDefault()
        if (e.shiftKey) redo(); else undo()
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedRef.current) {
        if (inTextField(e.target) || !inChartArea()) return
        commit(drawingsRef.current.filter((d) => d.id !== selectedRef.current))
        setSelectedId(null); setPropsPanel(null)
      } else if (!inTextField(e.target) && inChartArea() && e.altKey && !e.ctrlKey && !e.metaKey) {
        // 2026-11-25 起同 TradingView：数字 / 字母键留给快速输入（周期 / 品种），画线工具改用
        // Alt+字母。按 e.code 认键：Mac 上 Option 会把 e.key 变成特殊字符。
        // Since 2026-11-25, as in TradingView: digits / letters go to quick input (interval /
        // symbol) and tools use Alt+letter. Matched on e.code: Option changes e.key on a Mac.
        const map: Record<string, Tool> = e.shiftKey
          ? { KeyR: 'rect', KeyT: 'ray' }
          : { KeyT: 'trend', KeyH: 'hline', KeyV: 'vline', KeyC: 'crossline', KeyF: 'fib' }
        const tool = map[e.code]
        if (tool) { e.preventDefault(); setTool(tool); setSelectedId(null) }
      }
    }
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey)
  }, [commit, undo, redo, removeTempPrim, host])

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
    // 命中判定按帧合并：这是常驻的捕获期全局监听，鼠标一动就要遍历全部画线做命中
    // 判定并 setState。高刷屏 / 高回报率鼠标一帧能来好几个 pointermove，逐个算纯属
    // 浪费——同一帧里只有最后一次的结果会被画出来。
    // Coalesce hit-testing per frame: an always-on capture-phase listener that
    // walks every drawing and calls setState. Several pointermove events can
    // arrive within one frame and only the last one can possibly be painted.
    let frame = 0
    let last: { x: number; y: number } | null = null
    const evaluate = () => {
      frame = 0
      const p = last
      if (!p) return
      if (dragRef.current) { el.style.pointerEvents = 'auto'; return }
      if (toolRef.current !== 'cursor' && toolRef.current !== 'cross') {
        el.style.pointerEvents = 'auto'; setCursorStyle('crosshair'); return
      }
      const r = el.getBoundingClientRect()
      const x = p.x - r.left, y = p.y - r.top
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
    const onHover = (e: PointerEvent) => {
      // 拖拽中 / 画图工具激活时必须立刻接管指针，不能等到下一帧才切 auto。
      // Mid-drag or with a tool active, the layer must claim the pointer at once.
      if (dragRef.current || (toolRef.current !== 'cursor' && toolRef.current !== 'cross')) {
        el.style.pointerEvents = 'auto'
        if (!dragRef.current) setCursorStyle('crosshair')
        return
      }
      // 触摸没有悬停：平移时擦过画线不能武装交互层（否则它带着 touch-none 留在那里，下一次
      // 平移被吃掉）。触摸改走 subscribeClick 里的「点一下选中」。
      // Touch has no hover: a pan brushing a drawing must not arm the layer (it would stay
      // armed with touch-none and eat the next pan). Touch uses tap-to-select instead.
      if (isTouchLike(e.pointerType)) return
      last = { x: e.clientX, y: e.clientY }
      if (frame === 0) frame = window.requestAnimationFrame(evaluate)
    }
    const onPress = (e: PointerEvent) => { lastTouchRef.current = isTouchLike(e.pointerType) }
    // 冒泡期：在 React 挂在根节点上的 onPointerUp 之后才跑，这时 dragRef 已经清空。触摸抬起后，
    // 不在拖、没有激活画图工具、也没有点选中的画线，就把交互层还给图表。
    // Bubble phase: runs after React's root-level onPointerUp, when dragRef is cleared.
    // After a touch lifts with no drag, no active tool and no tap selection, hand the
    // pointer back to the chart.
    const onRelease = (e: PointerEvent) => {
      if (!isTouchLike(e.pointerType) || dragRef.current || touchSelRef.current) return
      if (toolRef.current !== 'cursor' && toolRef.current !== 'cross') return
      el.style.pointerEvents = 'none'
    }
    window.addEventListener('pointermove', onHover, true)
    window.addEventListener('pointerdown', onPress, true)
    window.addEventListener('pointerup', onRelease)
    window.addEventListener('pointercancel', onRelease)
    return () => {
      window.removeEventListener('pointermove', onHover, true)
      window.removeEventListener('pointerdown', onPress, true)
      window.removeEventListener('pointerup', onRelease)
      window.removeEventListener('pointercancel', onRelease)
      if (frame !== 0) window.cancelAnimationFrame(frame)
    }
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

  // 选中被别的路径清掉（Esc、删除、属性面板、撤销、切工具）时，手指点选带来的接管也一并撤掉，
  // 否则交互层继续 touch-none 盖着图表，下一次平移会被吃掉。
  // When the selection is cleared some other way (Escape, delete, the props panel, undo,
  // a tool switch), drop the tap-selection arming too, or the layer keeps covering the
  // chart with touch-none and eats the next pan.
  useEffect(() => {
    if (selectedId) return
    touchSelRef.current = false
    const el = overlayRef.current
    if (el && !dragRef.current && (toolRef.current === 'cursor' || toolRef.current === 'cross')) el.style.pointerEvents = 'none'
  }, [selectedId])

  return (
    <>
      {/* 叠加交互层 / transparent interaction layer */}
      <div
        ref={overlayRef}
        className="pointer-events-none absolute inset-1.5 z-10 touch-none"
        style={{ display: visible ? '' : 'none', cursor: cursorStyle || (tool !== 'cursor' && tool !== 'cross' ? 'crosshair' : 'default') }}
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onCancel}
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
      {/* 左侧竖排工具栏已删除：图表页始终传 hideToolbar，这 90 行从未渲染过；工具
          选择由图表页自己的工具栏经 ref 调用。/ The left-hand vertical toolbar is
          gone: the chart page always hid it, so it never rendered; tools are driven
          through the ref by the page's own toolbar. */}

      {/* 浮动属性栏 */}
      {propsPanel && selectedId && (() => { const d = drawings.find((dw) => dw.id === selectedId); if (!d) return null; return (
        <div className={`absolute right-3 top-3 z-30 flex items-center gap-1 rounded-lg float-panel px-2 py-1.5 sm:gap-2.5 sm:px-3 sm:py-2.5`}>
          {LINE_WIDTHS.map((w) => (
            <button key={w} type="button" title={`${w}px`} onClick={() => applyLineWidth(w)}
              aria-label={String(t('charts.draw.lineWidth', { w }))}
              aria-pressed={(d.lineWidth || 1) === w}
              className={`term-dl-btn flex items-center justify-center rounded border transition sm:w-7 sm:h-7 ${(d.lineWidth || 1) === w ? 'border-prism-500/60 bg-prism-600/25' : 'border-white/10 hover:border-white/20'}`}
              style={{ width: 28, height: 28 }}
            ><span aria-hidden="true" style={{ display: 'block', width: w * 4 + 4, height: w, background: d.color, borderRadius: 1 }} /></button>
          ))}
          <span className="w-px h-5 sm:h-6 bg-white/10" />
          {(['solid', 'dashed', 'dotted'] as const).map((s) => (
            <button key={s} type="button" title={String(t(`charts.draw.${s}`))} onClick={() => applyLineStyle(s)}
              aria-label={String(t(`charts.draw.${s}`))}
              aria-pressed={(d.lineStyle || 'solid') === s}
              className={`term-dl-btn flex items-center justify-center rounded border transition ${(d.lineStyle || 'solid') === s ? 'border-prism-500/60 bg-prism-600/25 text-prism-200' : 'border-white/10 text-neutral-500 hover:text-neutral-300'}`}
              style={{ height: isTouchDevice ? 28 : 26, width: isTouchDevice ? 32 : 36, fontSize: isTouchDevice ? 10 : 12 }}
            ><span aria-hidden="true">{s === 'solid' ? '━━' : s === 'dashed' ? '┅┅' : '┅'}</span></button>
          ))}
          <span className="w-px h-5 sm:h-6 bg-white/10" />
          <button type="button" onClick={toggleLock}
            title={String(t('charts.draw.lock'))}
            aria-label={String(t('charts.draw.lock'))}
            aria-pressed={!!d.locked}
            className={`term-dl-btn rounded border px-1.5 transition sm:px-2 ${d.locked ? 'border-warn/60 text-warn' : 'border-white/10 text-neutral-400 hover:text-neutral-100'}`}
            style={{ height: isTouchDevice ? 28 : 26, minWidth: 28, fontSize: isTouchDevice ? 10 : 12 }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0110 0v4" />{d.locked && <line x1="12" y1="15" x2="12" y2="17" />}</svg>
          </button>
          <button type="button" onClick={deleteSelected}
            title={String(t('charts.draw.delete'))}
            aria-label={String(t('charts.draw.delete'))}
            className="term-dl-btn rounded border border-white/10 px-1.5 text-neutral-400 hover:text-down sm:px-2"
            style={{ height: isTouchDevice ? 28 : 26, minWidth: 28, fontSize: isTouchDevice ? 10 : 12 }}
          ><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" /></svg></button>
        </div>
      )})()}

      {/* 右键菜单 */}
      {ctxMenu && (
        <div className="fixed z-menu min-w-[140px] rounded-lg float-panel p-1" style={{ left: ctxMenu.x, top: ctxMenu.y }} onClick={(e) => e.stopPropagation()}>
          <button onClick={() => { const d = drawings.find((dw) => dw.id === ctxMenu.drawingId); if (d) commit(drawings.map((dw) => dw.id === ctxMenu.drawingId ? { ...dw, locked: !dw.locked } : dw)); setCtxMenu(null) }}
            className="flex w-full items-center gap-2 rounded px-3 py-1.5 text-xs text-neutral-300 hover:bg-white/10"
          ><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0110 0v4" /></svg> {drawings.find((d) => d.id === ctxMenu.drawingId)?.locked ? t('charts.draw.unlock') : t('charts.draw.lock')}</button>
          <button onClick={ctxOpenSettings} className="flex w-full items-center gap-2 rounded px-3 py-1.5 text-xs text-neutral-300 hover:bg-white/10"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3" /><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" /></svg> {t('charts.draw.settings')}</button>
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