// 图表画图层：对标 TradingView 的绘制体验。在 lightweight-charts 之上叠加
// canvas，支持趋势线/水平线/垂直线/射线/十字线/矩形/斐波那契的绘制、选中、
// 拖动、锁定与删除。画线锚定在 (时间, 价格) 数据坐标上，随图表平移/缩放自动
// 重绘；按品种保存到用户云端偏好，跨设备同步。
// 支持磁吸模式、连续绘制、撤销/重做、右键菜单、浮动属性栏、矩形四角手柄。
//
// Chart drawing layer: TradingView-style drawing experience on top of
// lightweight-charts. Supports trend/horizontal/vertical/ray/cross/rect/fib.
// Magnet mode, stay-in-draw, undo/redo, right-click menu, floating props panel.
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, type PointerEvent as RPointerEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { IChartApi, ISeriesApi, UTCTimestamp } from 'lightweight-charts'
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
  magnet: MagnetMode
  setMagnet: (m: MagnetMode) => void
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

type MagnetMode = 'off' | 'weak'

// ──── 工具分组定义 / tool group definitions ────
interface ToolGroup {
  key: string
  tools: { id: Tool; svg: JSX.Element }[]
}

const TOOL_GROUPS: ToolGroup[] = [
  {
    key: 'cursors',
    tools: [
      {
        id: 'cursor',
        svg: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 3l7 17 2.5-6.5L20 11 4 3z" /></svg>,
      },
      {
        id: 'cross',
        svg: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><line x1="12" y1="3" x2="12" y2="21" /><line x1="3" y1="12" x2="21" y2="12" /></svg>,
      },
    ],
  },
  {
    key: 'lines',
    tools: [
      {
        id: 'trend',
        svg: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 20L20 4" /><circle cx="4" cy="20" r="2" /><circle cx="20" cy="4" r="2" /></svg>,
      },
      {
        id: 'hline',
        svg: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12h18" /><circle cx="12" cy="12" r="2" /></svg>,
      },
      {
        id: 'vline',
        svg: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v18" /><circle cx="12" cy="12" r="2" /></svg>,
      },
      {
        id: 'ray',
        svg: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="6" y1="18" x2="18" y2="6" /><line x1="18" y1="6" x2="22" y2="2" /><circle cx="6" cy="18" r="2" /></svg>,
      },
      {
        id: 'crossline',
        svg: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12h18" /><path d="M12 3v18" /><circle cx="12" cy="12" r="2" /></svg>,
      },
    ],
  },
  {
    key: 'fib',
    tools: [
      {
        id: 'fib',
        svg: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 5h18M3 10h18M3 14h18M3 19h18" /><path d="M4 19L20 5" opacity="0.5" /></svg>,
      },
    ],
  },
  {
    key: 'shapes',
    tools: [
      {
        id: 'rect',
        svg: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="6" width="16" height="12" rx="1" /></svg>,
      },
    ],
  },
]

// ──── 常量 / constants ────
interface Point { t: number; p: number }
interface Drawing { id: string; type: DrawType; pts: Point[]; color: string; locked?: boolean; lineWidth?: number; lineStyle?: 'solid' | 'dashed' | 'dotted' }
interface Props { chart: IChartApi; series: ISeriesApi<'Candlestick'>; host: HTMLDivElement; symbol: string; lastPrice: number; barTimes: () => number[]; digits?: number; hideToolbar?: boolean }

const TOL_DESKTOP = 12
const TOL_MOBILE = 18
const HANDLE_DESKTOP = 10
const HANDLE_MOBILE = 14
const UNDO_MAX = 30
const COLORS = ['#22d3ee', '#a78bfa', '#2ee07e', '#ff4d67', '#f5c451']
const LINE_WIDTHS = [1, 2, 3, 4]
const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1]
const SNAP_DIST = 8

// 检测触屏设备 / detect touch device
const isTouchDevice = typeof window !== 'undefined' && (window.matchMedia?.('(pointer: coarse)').matches || navigator.maxTouchPoints > 0)

const uid = () => 'dw_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)

function distToSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

// ──── 组件 / component ────
function DrawLayer({ chart, series, host, symbol, lastPrice, barTimes, digits = 2, hideToolbar }: Props, ref: React.Ref<DrawLayerHandle>) {
  const { t } = useTranslation()
  const { getPref, setPref } = usePrefs()
  const canvasRef = useRef<HTMLCanvasElement>(null)

  // 触屏设备用更大的命中容差 / larger hit tolerance for touch devices
  const tol = isTouchDevice ? TOL_MOBILE : TOL_DESKTOP
  const handleSz = isTouchDevice ? HANDLE_MOBILE : HANDLE_DESKTOP

  // 核心状态 / core state
  const [tool, setTool] = useState<Tool>('cursor')
  const [color, setColor] = useState<string>(COLORS[0])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [drawings, setDrawings] = useState<Drawing[]>([])
  const [drawCount, setDrawCount] = useState(0)
  const [magnet, setMagnet] = useState<MagnetMode>('off')
  const [stayInDraw, setStayInDraw] = useState(false)
  const [visible, setVisible] = useState(true)

  // 可折叠分组 / collapsed groups
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({ fib: true, shapes: true })

  // 撤销/重做
  const undoStackRef = useRef<Drawing[][]>([])
  const redoStackRef = useRef<Drawing[][]>([])
  const [canUndo, setCanUndo] = useState(false)
  const [canRedo, setCanRedo] = useState(false)

  // 右键菜单
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; drawingId: string } | null>(null)
  useBackToClose(!!ctxMenu, () => setCtxMenu(null))

  // 浮动属性栏 / floating props panel
  const [propsPanel, setPropsPanel] = useState<{ drawingId: string } | null>(null)

  // 确认弹窗
  const [confirmOpen, setConfirmOpen] = useState(false)
  useBackToClose(confirmOpen, () => setConfirmOpen(false))

  // ──── 操作函数 / actions ────
  const pushUndo = useCallback((current: Drawing[]) => {
    undoStackRef.current.push(current)
    if (undoStackRef.current.length > UNDO_MAX) undoStackRef.current.shift()
    redoStackRef.current = []
    setCanUndo(true); setCanRedo(false)
  }, [])

  const undo = useCallback(() => {
    const stack = undoStackRef.current; if (stack.length === 0) return
    const prev = stack.pop()!
    redoStackRef.current.push(drawingsRef.current)
    commitNoHistory(prev)
    setCanUndo(stack.length > 0); setCanRedo(true); setSelectedId(null)
  }, [])

  const redo = useCallback(() => {
    const stack = redoStackRef.current; if (stack.length === 0) return
    const next = stack.pop()!
    undoStackRef.current.push(drawingsRef.current)
    commitNoHistory(next)
    setCanUndo(true); setCanRedo(stack.length > 0); setSelectedId(null)
  }, [])

  const lockedCount = drawings.filter((d) => d.locked).length

  const toggleLock = useCallback(() => {
    if (!selectedId) return
    const next = drawings.map((d) => d.id === selectedId ? { ...d, locked: !d.locked } : d)
    commit(next)
    if (next.find((d) => d.id === selectedId)?.locked) setSelectedId(null)
  }, [selectedId, drawings])

  const lockAll = useCallback(() => { commit(drawings.map((d) => ({ ...d, locked: true }))); setSelectedId(null) }, [drawings])
  const unlockAll = useCallback(() => { commit(drawings.map((d) => ({ ...d, locked: false }))) }, [drawings])

  const deleteSelected = useCallback(() => {
    if (!selectedId) return
    commit(drawings.filter((d) => d.id !== selectedId)); setSelectedId(null)
  }, [selectedId, drawings])

  const clearAll = useCallback(() => { if (drawings.length > 0) setConfirmOpen(true) }, [drawings.length])
  const doClearAll = useCallback(() => { setConfirmOpen(false); commit([]); setSelectedId(null) }, [])

  const applyColor = useCallback((c: string) => {
    setColor(c)
    if (selectedId) commit(drawings.map((d) => (d.id === selectedId ? { ...d, color: c } : d)))
  }, [selectedId, drawings])

  const applyLineWidth = useCallback((w: number) => {
    if (!selectedId) return
    commit(drawings.map((d) => (d.id === selectedId ? { ...d, lineWidth: w } : d)))
  }, [selectedId, drawings])

  const applyLineStyle = useCallback((s: 'solid' | 'dashed' | 'dotted') => {
    if (!selectedId) return
    commit(drawings.map((d) => (d.id === selectedId ? { ...d, lineStyle: s } : d)))
  }, [selectedId, drawings])

  const ctxDeleteDrawing = useCallback(() => {
    if (!ctxMenu) return
    commit(drawings.filter((d) => d.id !== ctxMenu.drawingId))
    if (selectedId === ctxMenu.drawingId) setSelectedId(null)
    setCtxMenu(null)
  }, [ctxMenu, drawings, selectedId])

  const ctxOpenSettings = useCallback(() => {
    if (!ctxMenu) return
    setSelectedId(ctxMenu.drawingId)
    setPropsPanel({ drawingId: ctxMenu.drawingId })
    setCtxMenu(null)
  }, [ctxMenu])

  useImperativeHandle(ref, () => ({
    tool, setTool, color, setColor, selectedId, drawCount, lockedCount,
    magnet, setMagnet, stayInDraw, setStayInDraw, visible, setVisible,
    deleteSelected, clearAll, applyColor,
    toggleLock, lockAll, unlockAll, undo, redo,
  }), [tool, color, selectedId, drawCount, lockedCount, magnet, stayInDraw, visible, deleteSelected, clearAll, applyColor, toggleLock, lockAll, unlockAll, undo, redo])

  // ──── 可变引用 / refs ────
  const toolRef = useRef(tool); const colorRef = useRef(color)
  const selectedRef = useRef<string | null>(selectedId)
  const drawingsRef = useRef<Drawing[]>([])
  const magnetRef = useRef<MagnetMode>(magnet)
  const stayInDrawRef = useRef(false)
  const workRef = useRef<{ type: DrawType; color: string; px: { x: number; y: number }[]; lineWidth?: number; lineStyle?: string } | null>(null)
  const dragRef = useRef<{ mode: 'create' } | { mode: 'move'; id: string; startX: number; startY: number; origPx: { x: number; y: number }[] } | { mode: 'handle'; id: string; handle: number } | null>(null)
  const appliedRef = useRef(''); const symRef = useRef(symbol)
  const lastClickRef = useRef<{ id: string; time: number } | null>(null)

  toolRef.current = tool; colorRef.current = color
  selectedRef.current = selectedId; drawingsRef.current = drawings
  magnetRef.current = magnet; stayInDrawRef.current = stayInDraw

  // ──── 坐标换算 / coordinate conversion ────
  const xOf = useCallback((tm: number): number | null => {
    const exact = chart.timeScale().timeToCoordinate(tm as UTCTimestamp)
    if (exact != null) return exact
    const times = barTimes(); if (times.length < 2) return null
    const ts = chart.timeScale()
    const lerp = (i0: number, i1: number): number | null => {
      const x0 = ts.timeToCoordinate(times[i0] as UTCTimestamp), x1 = ts.timeToCoordinate(times[i1] as UTCTimestamp)
      if (x0 == null || x1 == null || times[i1] === times[i0]) return null
      return x0 + ((tm - times[i0]) / (times[i1] - times[i0])) * (x1 - x0)
    }
    const last = times.length - 1
    if (tm <= times[0]) return lerp(0, 1)
    if (tm >= times[last]) return lerp(last - 1, last)
    let lo = 0, hi = last
    while (lo < hi) { const mid = (lo + hi) >> 1; if (times[mid] <= tm) lo = mid + 1; else hi = mid }
    return lerp(lo - 1, lo)
  }, [chart, barTimes])

  const yOf = useCallback((p: number) => series.priceToCoordinate(p), [series])

  const tOf = useCallback((x: number): number | null => {
    const ts = chart.timeScale(); const exact = ts.coordinateToTime(x) as number | null
    if (exact != null) return exact
    const times = barTimes(); if (times.length < 2) return exact
    const logical = ts.coordinateToLogical(x) as number | null; if (logical == null) return exact
    const last = times.length - 1; let i0: number
    if (logical <= 0) i0 = 0; else if (logical >= last) i0 = last - 1; else i0 = Math.floor(logical)
    const step = times[i0 + 1] - times[i0]
    return Math.round(times[i0] + (logical - i0) * step)
  }, [chart, barTimes])

  const pOf = useCallback((y: number) => series.coordinateToPrice(y) as number | null, [series])

  // 磁吸：将点击位置吸附到最近 K 线的 OHLC 价格 / snap click to nearest candle OHLC
  const snapOHLC = useCallback((x: number, y: number): number | null => {
    const tm = tOf(x); if (tm == null) return null
    const times = barTimes()
    let idx = -1; for (let i = 0; i < times.length; i++) { if (times[i] === tm || (i < times.length - 1 && tm > times[i] && tm < times[i + 1])) { idx = i; break } }
    if (idx < 0) return null
    const candle = (series as any)._data?.[idx] ?? (series as any)._bars?.[idx]
    if (!candle || candle.open == null) return null
    const ohlc = [candle.open, candle.high, candle.low, candle.close].filter((v: number) => v != null)
    if (ohlc.length === 0) return null
    // 找到距离点击 Y 最近的 OHLC 值，且在 SNAP_DIST 像素内
    let bestVal = ohlc[0], bestD = Infinity
    for (const v of ohlc) {
      const vy = yOf(v)
      if (vy == null) continue
      const d = Math.abs(y - vy)
      if (d < bestD && d <= SNAP_DIST) { bestD = d; bestVal = v }
    }
    return bestVal
  }, [tOf, yOf, barTimes, series])

  // ──── 加载/保存 / load & save ────
  useEffect(() => {
    const saved = getPref<Drawing[]>('chartDraw', symbol, [])
    const arr = Array.isArray(saved) ? saved : []
    const json = JSON.stringify(arr)
    if (symRef.current === symbol && json === appliedRef.current) return
    symRef.current = symbol; appliedRef.current = json
    setDrawings(arr); setDrawCount(arr.length); setSelectedId(null)
  }, [symbol, getPref])

  const commit = useCallback((next: Drawing[]) => {
    pushUndo(drawingsRef.current)
    appliedRef.current = JSON.stringify(next); drawingsRef.current = next
    setDrawings(next); setDrawCount(next.length)
    setPref('chartDraw', symbol, next)
  }, [setPref, symbol, pushUndo])

  const commitNoHistory = useCallback((next: Drawing[]) => {
    appliedRef.current = JSON.stringify(next); drawingsRef.current = next
    setDrawings(next); setDrawCount(next.length)
    setPref('chartDraw', symbol, next)
  }, [setPref, symbol])

  // ──── 画线像素端点 / to pixel ────
  const toPx = useCallback((d: Drawing): { x: number; y: number }[] | null => {
    if (d.type === 'hline' || d.type === 'vline') {
      const y = d.type === 'hline' ? yOf(d.pts[0].p) : null
      const x = d.type === 'vline' ? xOf(d.pts[0].t) : null
      if ((d.type === 'hline' && y == null) || (d.type === 'vline' && x == null)) return null
      return [{ x: d.type === 'vline' ? x! : 0, y: d.type === 'hline' ? y! : 0 }]
    }
    if (d.type === 'crossline') {
      const x = xOf(d.pts[0].t), y = yOf(d.pts[0].p)
      if (x == null || y == null) return null
      return [{ x, y }]
    }
    const a = { x: xOf(d.pts[0].t), y: yOf(d.pts[0].p) }
    const b = { x: xOf(d.pts[1].t), y: yOf(d.pts[1].p) }
    if (a.x == null || a.y == null || b.x == null || b.y == null) return null
    return [{ x: a.x, y: a.y }, { x: b.x, y: b.y }]
  }, [xOf, yOf])

  // ──── 渲染 / render ────
  const draw = useCallback(() => {
    const cv = canvasRef.current; if (!cv) return
    const ctx = cv.getContext('2d'); if (!ctx) return
    const dpr = window.devicePixelRatio || 1
    const w = host.clientWidth, h = host.clientHeight
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)

    const paintHandle = (x: number, y: number) => {
      ctx.globalAlpha = 1; ctx.fillStyle = '#0a0710'; ctx.strokeStyle = '#ffffff'
      ctx.lineWidth = 1.5; ctx.beginPath()
      ctx.rect(x - handleSz / 2, y - handleSz / 2, handleSz, handleSz); ctx.fill(); ctx.stroke()
    }

    const setLineDashStyle = (ls?: 'solid' | 'dashed' | 'dotted') => {
      if (ls === 'dashed') ctx.setLineDash([8, 4])
      else if (ls === 'dotted') ctx.setLineDash([2, 4])
    }

    const paint = (type: DrawType, px: { x: number; y: number }[], col: string, selected: boolean, locked: boolean, lw?: number, ls?: 'solid' | 'dashed' | 'dotted') => {
      ctx.strokeStyle = col; ctx.lineWidth = (lw || (selected ? 2 : 1.5))
      setLineDashStyle(ls)
      const alpha = locked ? 0.35 : 1; ctx.globalAlpha = alpha

      if (type === 'hline') {
        const y = px[0].y; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke()
        if (selected && !locked) paintHandle(w / 2, y)
      } else if (type === 'vline') {
        const x = px[0].x; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke()
        if (selected && !locked) paintHandle(x, h / 2)
      } else if (type === 'crossline') {
        const cx = px[0].x, cy = px[0].y; ctx.globalAlpha = locked ? 0.2 : 0.5
        ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, h); ctx.stroke()
        ctx.beginPath(); ctx.moveTo(0, cy); ctx.lineTo(w, cy); ctx.stroke()
        ctx.globalAlpha = alpha
        if (selected && !locked) paintHandle(cx, cy)
      } else if (type === 'ray') {
        const dx = px[1].x - px[0].x, dy = px[1].y - px[0].y
        const len = Math.hypot(dx, dy) || 1; const ext = Math.max(w * 2, h * 2)
        ctx.beginPath(); ctx.moveTo(px[0].x, px[0].y); ctx.lineTo(px[0].x + (dx / len) * ext, px[0].y + (dy / len) * ext); ctx.stroke()
        if (selected && !locked) { paintHandle(px[0].x, px[0].y); paintHandle(px[1].x, px[1].y) }
      } else if (type === 'trend') {
        ctx.beginPath(); ctx.moveTo(px[0].x, px[0].y); ctx.lineTo(px[1].x, px[1].y); ctx.stroke()
        if (selected && !locked) { paintHandle(px[0].x, px[0].y); paintHandle(px[1].x, px[1].y) }
      } else if (type === 'fib') {
        const xL = Math.min(px[0].x, px[1].x), xR = Math.max(px[0].x, px[1].x)
        const yA = px[0].y, yB = px[1].y
        ctx.globalAlpha = locked ? 0.18 : 0.45; ctx.setLineDash([])
        ctx.beginPath(); ctx.moveTo(px[0].x, px[0].y); ctx.lineTo(px[1].x, px[1].y); ctx.stroke()
        ctx.globalAlpha = alpha; setLineDashStyle(ls)
        ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace'; ctx.textBaseline = 'middle'
        let prevY: number | null = null
        for (const lv of FIB_LEVELS) {
          const ly = yB + (yA - yB) * lv
          if (prevY != null) { ctx.fillStyle = col + (locked ? '08' : '14'); ctx.fillRect(xL, Math.min(prevY, ly), xR - xL, Math.abs(ly - prevY)) }
          prevY = ly; ctx.strokeStyle = col; ctx.lineWidth = 1; ctx.setLineDash([])
          ctx.beginPath(); ctx.moveTo(xL, ly); ctx.lineTo(xR, ly); ctx.stroke()
          setLineDashStyle(ls)
          const price = pOf(ly); ctx.fillStyle = col
          ctx.fillText(`${(lv * 100).toFixed(1)}%${price != null ? '  ' + price.toFixed(digits) : ''}`, xR + 4, ly)
        }
        if (selected && !locked) { paintHandle(px[0].x, px[0].y); paintHandle(px[1].x, px[1].y) }
      } else {
        const x = Math.min(px[0].x, px[1].x), y = Math.min(px[0].y, px[1].y)
        const rw = Math.abs(px[1].x - px[0].x), rh = Math.abs(px[1].y - px[0].y)
        ctx.fillStyle = col + (locked ? '0a' : '22'); ctx.fillRect(x, y, rw, rh)
        ctx.strokeRect(x, y, rw, rh)
        if (selected && !locked) { paintHandle(x, y); paintHandle(x + rw, y); paintHandle(x, y + rh); paintHandle(x + rw, y + rh) }
      }
      // 锁定图标
      if (locked) {
        const cx = type === 'hline' ? w / 2 : type === 'vline' ? px[0].x : (px[0].x + (px.length > 1 ? px[1].x : px[0].x)) / 2
        const cy = type === 'hline' ? px[0].y - 10 : type === 'vline' ? h / 2 : Math.min(px[0].y, px.length > 1 ? px[1].y : px[0].y) - 10
        ctx.globalAlpha = 0.5; ctx.setLineDash([])
        ctx.fillStyle = '#ffffff'; ctx.font = '9px sans-serif'; ctx.textAlign = 'center'
        ctx.fillText('🔒', cx, cy); ctx.textAlign = 'start'
      }
      ctx.globalAlpha = 1; ctx.setLineDash([])
    }

    for (const d of drawingsRef.current) {
      if (workRef.current && dragRef.current && 'id' in dragRef.current && dragRef.current.id === d.id) continue
      const px = toPx(d); if (px) paint(d.type, px, d.color, d.id === selectedRef.current, !!d.locked, d.lineWidth, d.lineStyle)
    }
    if (workRef.current) paint(workRef.current.type, workRef.current.px, workRef.current.color, true, false, workRef.current.lineWidth, workRef.current.lineStyle as any)
  }, [host, toPx, pOf, digits])

  // ──── 画布尺寸自适应 / canvas resize ────
  useEffect(() => {
    const cv = canvasRef.current; if (!cv) return
    const resize = () => { const dpr = window.devicePixelRatio || 1; const w = host.clientWidth, h = host.clientHeight; cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); cv.style.width = w + 'px'; cv.style.height = h + 'px'; draw() }
    resize(); const ro = new ResizeObserver(resize); ro.observe(host); return () => ro.disconnect()
  }, [host, draw])

  // ──── rAF 重绘 / repaint loop ────
  useEffect(() => {
    let raf = 0, lastSig = ''
    const loop = () => {
      const range = chart.timeScale().getVisibleLogicalRange(), yRef = lastPrice ? yOf(lastPrice) : null
      const sig = `${range?.from ?? ''}_${range?.to ?? ''}_${yRef ?? ''}`
      if (sig !== lastSig) { lastSig = sig; draw() }
      raf = requestAnimationFrame(loop)
    }; raf = requestAnimationFrame(loop); return () => cancelAnimationFrame(raf)
  }, [chart, draw, yOf, lastPrice])

  useEffect(() => { draw() }, [drawings, selectedId, tool, color, draw, visible])

  // ──── 命中判定 / hit testing ────
  const hitHandle = useCallback((x: number, y: number): number => {
    const sel = drawingsRef.current.find((d) => d.id === selectedRef.current && !d.locked); if (!sel) return -1
    const px = toPx(sel); if (!px) return -1
    const checkCorner = (cx: number, cy: number) => Math.abs(x - cx) <= handleSz + 2 && Math.abs(y - cy) <= handleSz + 2
    if (sel.type === 'hline') return Math.hypot(x - host.clientWidth / 2, y - px[0].y) <= handleSz + 2 ? 0 : -1
    if (sel.type === 'vline') return Math.hypot(x - px[0].x, y - host.clientHeight / 2) <= handleSz + 2 ? 0 : -1
    if (sel.type === 'crossline') return (Math.abs(x - px[0].x) <= handleSz + 2 && Math.abs(y - px[0].y) <= handleSz + 2) ? 0 : -1
    if (sel.type === 'rect') {
      const x1 = Math.min(px[0].x, px[1].x), y1 = Math.min(px[0].y, px[1].y), x2 = Math.max(px[0].x, px[1].x), y2 = Math.max(px[0].y, px[1].y)
      const corners = [{ x: x1, y: y1 }, { x: x2, y: y1 }, { x: x1, y: y2 }, { x: x2, y: y2 }]
      for (let i = 0; i < 4; i++) { if (checkCorner(corners[i].x, corners[i].y)) return i }
      return -1
    }
    for (let i = 0; i < px.length; i++) { if (checkCorner(px[i].x, px[i].y)) return i }
    return -1
  }, [toPx, host])

  const hitSingle = useCallback((x: number, y: number, d: Drawing): Drawing | null => {
    const px = toPx(d); if (!px) return null
    if (d.type === 'hline') { if (Math.abs(y - px[0].y) <= tol) return d }
    else if (d.type === 'vline') { if (Math.abs(x - px[0].x) <= tol) return d }
    else if (d.type === 'crossline') { if (Math.abs(x - px[0].x) <= tol || Math.abs(y - px[0].y) <= tol) return d }
    else if (d.type === 'trend' || d.type === 'ray') {
      if (distToSeg(x, y, px[0].x, px[0].y, px[1].x, px[1].y) <= tol) return d
      if (Math.hypot(x - px[0].x, y - px[0].y) <= tol || Math.hypot(x - px[1].x, y - px[1].y) <= tol) return d
    } else if (d.type === 'fib') {
      const xL = Math.min(px[0].x, px[1].x), xR = Math.max(px[0].x, px[1].x)
      if (x >= xL - tol && x <= xR + tol) {
        const yA = px[0].y, yB = px[1].y
        for (const lv of FIB_LEVELS) { if (Math.abs(y - (yB + (yA - yB) * lv)) <= tol) return d }
      }
      if (distToSeg(x, y, px[0].x, px[0].y, px[1].x, px[1].y) <= tol) return d
    } else {
      const x1 = Math.min(px[0].x, px[1].x), x2 = Math.max(px[0].x, px[1].x), y1 = Math.min(px[0].y, px[1].y), y2 = Math.max(px[0].y, px[1].y)
      if (((x >= x1 - tol && x <= x2 + tol) && (Math.abs(y - y1) <= tol || Math.abs(y - y2) <= tol)) || ((y >= y1 - tol && y <= y2 + tol) && (Math.abs(x - x1) <= tol || Math.abs(x - x2) <= tol))) return d
    }
    return null
  }, [toPx, tol])

  const hitDrawing = useCallback((x: number, y: number, includeLocked = false): Drawing | null => {
    const list = drawingsRef.current, sel = selectedRef.current
    if (sel) { const sd = list.find((d) => d.id === sel); if (sd && (includeLocked || !sd.locked)) { const h = hitSingle(x, y, sd); if (h) return h } }
    for (let i = list.length - 1; i >= 0; i--) {
      const d = list[i]; if (!includeLocked && d.locked) continue; if (d.id === sel) continue
      const h = hitSingle(x, y, d); if (h) return h
    }
    return null
  }, [])

  // ──── 指针事件 / pointer events ────
  const localXY = (e: RPointerEvent<HTMLCanvasElement> | PointerEvent) => {
    const cv = canvasRef.current!; const r = cv.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  const getDrawType = (t: Tool): DrawType => {
    if (t === 'trend') return 'trend'; if (t === 'hline') return 'hline'; if (t === 'vline') return 'vline'
    if (t === 'ray') return 'ray'; if (t === 'crossline') return 'crossline'; if (t === 'rect') return 'rect'
    return 'fib'
  }

  const onDown = (e: RPointerEvent<HTMLCanvasElement>) => {
    let { x, y } = localXY(e); const cur = toolRef.current
    canvasRef.current?.setPointerCapture(e.pointerId)

    if (cur !== 'cursor' && cur !== 'cross') {
      // 磁吸 / snap
      if (magnetRef.current === 'weak') {
        const snapP = snapOHLC(x, y); if (snapP != null) { const sy = yOf(snapP); if (sy != null) y = sy }
      }
      // 可点击创建的工具 / single-click tools
      if (cur === 'hline' || cur === 'vline' || cur === 'crossline') {
        const p = pOf(y), tm = tOf(x)
        if (cur === 'hline') { if (p == null) return; const d: Drawing = { id: uid(), type: 'hline', pts: [{ t: 0, p }], color: colorRef.current }; commit([...drawingsRef.current, d]); setSelectedId(d.id); if (!stayInDrawRef.current) setTool('cursor') }
        else if (cur === 'vline') { if (tm == null) return; const d: Drawing = { id: uid(), type: 'vline', pts: [{ t: tm, p: 0 }], color: colorRef.current }; commit([...drawingsRef.current, d]); setSelectedId(d.id); if (!stayInDrawRef.current) setTool('cursor') }
        else if (cur === 'crossline') { if (tm == null || p == null) return; const d: Drawing = { id: uid(), type: 'crossline', pts: [{ t: tm, p }], color: colorRef.current }; commit([...drawingsRef.current, d]); setSelectedId(d.id); if (!stayInDrawRef.current) setTool('cursor') }
        return
      }
      // 拖动绘制 / drag-to-draw
      workRef.current = { type: getDrawType(cur), color: colorRef.current, px: [{ x, y }, { x, y }] }
      dragRef.current = { mode: 'create' }; draw(); return
    }

    // 光标模式
    const h = hitHandle(x, y)
    if (h >= 0) {
      dragRef.current = { mode: 'handle', id: selectedRef.current!, handle: h }
      const sel = drawingsRef.current.find((d) => d.id === selectedRef.current)!; workRef.current = { type: sel.type, color: sel.color, px: toPx(sel)!, lineWidth: sel.lineWidth, lineStyle: sel.lineStyle }; draw(); return
    }
    const hit = hitDrawing(x, y)
    if (hit) {
      // 锁定线：可选中、可解锁，但禁止拖动/删除 / locked: selectable, unlockable, but no drag/delete
      if (hit.locked) {
        setSelectedId(hit.id); setPropsPanel({ drawingId: hit.id })
        const now = Date.now()
        if (lastClickRef.current && lastClickRef.current.id === hit.id && now - lastClickRef.current.time < 350) {
          commit(drawingsRef.current.map((d) => d.id === hit.id ? { ...d, locked: false } : d))
          lastClickRef.current = null
          return
        }
        lastClickRef.current = { id: hit.id, time: now }
        return
      }
      const now = Date.now()
      if (lastClickRef.current && lastClickRef.current.id === hit.id && now - lastClickRef.current.time < 350) { setPropsPanel({ drawingId: hit.id }); lastClickRef.current = null; return }
      lastClickRef.current = { id: hit.id, time: now }
      setSelectedId(hit.id); setPropsPanel({ drawingId: hit.id })
      dragRef.current = { mode: 'move', id: hit.id, startX: x, startY: y, origPx: toPx(hit)! }; workRef.current = { type: hit.type, color: hit.color, px: toPx(hit)!, lineWidth: hit.lineWidth, lineStyle: hit.lineStyle }; draw()
    } else { setSelectedId(null); setPropsPanel(null) }
  }

  const onMove = (e: RPointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current; if (!drag || !workRef.current) return
    const { x, y } = localXY(e)
    if (drag.mode === 'create') { workRef.current.px[1] = { x, y } }
    else if (drag.mode === 'move') { const dx = x - drag.startX, dy = y - drag.startY; workRef.current.px = drag.origPx.map((p) => ({ x: p.x + dx, y: p.y + dy })) }
    else {
      const hi = drag.handle
      if (workRef.current.type === 'rect' && hi >= 0) {
        const x1 = Math.min(workRef.current.px[0].x, workRef.current.px[1].x), y1 = Math.min(workRef.current.px[0].y, workRef.current.px[1].y)
        const x2 = Math.max(workRef.current.px[0].x, workRef.current.px[1].x), y2 = Math.max(workRef.current.px[0].y, workRef.current.px[1].y)
        if (hi === 0) workRef.current.px = [{ x, y }, { x: x2, y: y2 }]
        else if (hi === 1) workRef.current.px = [{ x: x1, y }, { x, y: y2 }]
        else if (hi === 2) workRef.current.px = [{ x, y: y1 }, { x: x2, y }]
        else workRef.current.px = [{ x: x1, y: y1 }, { x, y }]
      } else { workRef.current.px[hi] = { x, y } }
    }
    draw()
  }

  const onUp = () => {
    const drag = dragRef.current, work = workRef.current
    dragRef.current = null; workRef.current = null
    if (!drag || !work) { draw(); return }
    const toPoint = (px: { x: number; y: number }): Point | null => {
      if (work.type === 'hline' || work.type === 'vline') { const p = pOf(px.y), tm = tOf(px.x); return work.type === 'hline' ? (p == null ? null : { t: 0, p }) : (tm == null ? null : { t: tm, p: 0 }) }
      if (work.type === 'crossline') { const p = pOf(px.y), tm = tOf(px.x); if (p == null || tm == null) return null; return { t: tm, p } }
      const p = pOf(px.y), tm = tOf(px.x); if (p == null || tm == null) return null; return { t: tm, p }
    }
    if (drag.mode === 'create') {
      if (Math.hypot(work.px[1].x - work.px[0].x, work.px[1].y - work.px[0].y) < 4) { draw(); return }
      const a = toPoint(work.px[0]), b = toPoint(work.px[1]); if (!a || !b) { draw(); return }
      const d: Drawing = { id: uid(), type: work.type, pts: [a, b], color: work.color, lineWidth: work.lineWidth, lineStyle: work.lineStyle as any }
      commit([...drawingsRef.current, d]); setSelectedId(d.id); if (!stayInDrawRef.current) setTool('cursor')
      setPropsPanel({ drawingId: d.id }); return
    }
    const pts = work.px.map(toPoint); if (pts.some((p) => p == null)) { draw(); return }
    const next = drawingsRef.current.map((d) => d.id === drag.id ? {
      ...d, pts: (work.type === 'hline' || work.type === 'vline' || work.type === 'crossline') ? [pts[0]!] as Point[] : (pts as Point[]),
    } : d)
    commit(next)
  }

  // ──── 悬停动态 pointer-events / hover-driven pointer-events ────
  useEffect(() => {
    const cv = canvasRef.current; if (!cv) return
    const onHover = (e: PointerEvent) => {
      if (dragRef.current) { cv.style.pointerEvents = 'auto'; return }
      if (toolRef.current !== 'cursor' && toolRef.current !== 'cross') { cv.style.pointerEvents = 'auto'; cv.style.cursor = 'crosshair'; return }
      const r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top
      if (x < 0 || y < 0 || x > r.width || y > r.height) { cv.style.pointerEvents = 'none'; return }
      const onHandle = hitHandle(x, y) >= 0, onBody = onHandle || hitDrawing(x, y) != null
      if (onBody) {
        cv.style.pointerEvents = 'auto'
        if (onHandle) { const sel = drawingsRef.current.find((d) => d.id === selectedRef.current); if (sel && sel.type === 'rect') { const h = hitHandle(x, y); cv.style.cursor = h === 0 || h === 3 ? 'nwse-resize' : 'nesw-resize' } else cv.style.cursor = 'grab' }
        else cv.style.cursor = 'move'
      } else { cv.style.pointerEvents = 'none'; cv.style.cursor = toolRef.current === 'cross' ? 'crosshair' : 'default' }
    }
    window.addEventListener('pointermove', onHover, true)
    return () => window.removeEventListener('pointermove', onHover, true)
  }, [hitHandle, hitDrawing])

  useEffect(() => {
    const cv = canvasRef.current; if (!cv) return
    if (tool !== 'cursor' && tool !== 'cross') { cv.style.pointerEvents = 'auto'; cv.style.cursor = 'crosshair' }
    else { cv.style.pointerEvents = 'none'; cv.style.cursor = tool === 'cross' ? 'crosshair' : 'default' }
  }, [tool])

  // ──── 右键菜单点击外部关闭 + 手机长按 / context-menu click-outside + mobile long-press ────
  useEffect(() => {
    if (!ctxMenu) return
    const onDocClick = () => setCtxMenu(null)
    const t = setTimeout(() => document.addEventListener('click', onDocClick), 100)
    return () => { clearTimeout(t); document.removeEventListener('click', onDocClick) }
  }, [ctxMenu])

  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!isTouchDevice) return
    const cv = canvasRef.current; if (!cv) return
    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return
      const touch = e.touches[0]
      longPressTimer.current = setTimeout(() => {
        if (toolRef.current !== 'cursor' && toolRef.current !== 'cross') return
        const r = cv.getBoundingClientRect()
        const x = touch.clientX - r.left, y = touch.clientY - r.top
        const hit = hitDrawing(x, y, true)
        if (hit) { setSelectedId(hit.id); setCtxMenu({ x: touch.clientX, y: touch.clientY, drawingId: hit.id }) }
      }, 500)
    }
    const onEnd = () => { if (longPressTimer.current) { clearTimeout(longPressTimer.current); longPressTimer.current = null } }
    cv.addEventListener('touchstart', onStart, { passive: true })
    cv.addEventListener('touchend', onEnd, { passive: true })
    cv.addEventListener('touchmove', onEnd, { passive: true })
    return () => { cv.removeEventListener('touchstart', onStart); cv.removeEventListener('touchend', onEnd); cv.removeEventListener('touchmove', onEnd) }
  }, [hitDrawing])

  // ──── 键盘 / keyboard ────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { if (dragRef.current) { dragRef.current = null; workRef.current = null; draw() }; setTool('cursor'); setSelectedId(null); setCtxMenu(null); setPropsPanel(null) }
      else if (e.key === 'z' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); if (e.shiftKey) redo(); else undo() }
      else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedRef.current) { const el = e.target as HTMLElement | null; if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return; commit(drawingsRef.current.filter((d) => d.id !== selectedRef.current)); setSelectedId(null); setPropsPanel(null) }
      // 数字键快速切换工具 / number keys for tools
      else if (!(e.target as HTMLElement)?.closest?.('input,textarea,select') && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const map: Record<string, Tool> = { '1': 'cursor', '2': 'trend', '3': 'hline', '4': 'vline', '5': 'rect', '6': 'fib', '7': 'ray', '8': 'crossline' }
        if (map[e.key]) { setTool(map[e.key]); setSelectedId(null) }
      }
    }
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey)
  }, [commit, draw, undo, redo])

  // ──── 工具按钮渲染 / tool button ────
  const toolBtn = (id: Tool, icon: JSX.Element, label: string) => (
    <button type="button" title={label} aria-label={label} onClick={() => { setTool(id); if (id !== 'cursor' && id !== 'cross') setSelectedId(null) }}
      className={`flex h-8 w-8 items-center justify-center rounded-md border transition ${tool === id ? 'border-prism-500/60 bg-prism-600/25 text-prism-200' : 'border-white/10 bg-ink-800/60 text-slate-400 hover:text-slate-100'}`}
    >{icon}</button>
  )

  // 切换分组折叠 / toggle group collapse
  const toggleCollapse = (key: string) => setCollapsed((p) => ({ ...p, [key]: !p[key] }))

  return (
    <>
      {/* 左侧浮动工具栏 / floating left toolbar */}
      {!hideToolbar && (
        <div className="absolute left-3 top-3 z-20 flex flex-col rounded-xl border border-white/10 bg-ink-900/80 p-1.5 backdrop-blur" style={{ maxHeight: 'calc(100% - 60px)' }}>
          {/* 可滚动工具区 / scrollable tools area */}
          <div className="flex flex-col gap-1 overflow-y-auto" style={{ flex: '1 1 auto', minHeight: 0 }}>
          {/* 可折叠分组 / collapsible groups */}
          {TOOL_GROUPS.map((group) => {
            const isCollapsed = collapsed[group.key]
            return (
              <div key={group.key}>
                {isCollapsed ? (
                  // 折叠态：只显示分组图标（第一个工具），带箭头
                  <button type="button" onClick={() => toggleCollapse(group.key)}
                    title={String(t(`charts.draw.${group.key}`))} aria-label={String(t(`charts.draw.${group.key}`))}
                    className="flex h-8 w-8 items-center justify-between rounded-md border border-white/10 bg-ink-800/60 px-1.5 text-slate-400 transition hover:text-slate-100"
                  >
                    <span className="scale-75">{group.tools[0].svg}</span>
                    <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="opacity-40"><polyline points="6 9 12 15 18 9" /></svg>
                  </button>
                ) : (
                  // 展开态：分隔线 + 全部工具
                  <>
                    <div className="flex items-center gap-1 mb-1">
                      <div className="h-px flex-1 bg-white/10" />
                      <button type="button" onClick={() => toggleCollapse(group.key)} className="text-[9px] text-slate-500 hover:text-slate-300 px-1">{t(`charts.draw.${group.key}`)} <svg width="7" height="7" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" className="inline -mt-px"><polyline points="18 15 12 9 6 15" /></svg></button>
                      <div className="h-px flex-1 bg-white/10" />
                    </div>
                    <div className="flex flex-col gap-1">
                      {group.tools.map((tool) => toolBtn(tool.id, tool.svg, String(t(`charts.draw.${tool.id}`))))}
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
          </div>{/* end scrollable tools */}

          <div className="my-0.5 h-px w-full bg-white/10" />

          {/* ──── 底部工具控制栏（始终可见） / bottom utility bar (always visible) ──── */}
          <div className="flex flex-col gap-1 shrink-0">
          {/* 磁吸 */}
          <button type="button" title={t('charts.draw.magnet')} aria-label={t('charts.draw.magnet')}
            onClick={() => setMagnet(magnet === 'off' ? 'weak' : 'off')}
            className={`flex h-8 w-8 items-center justify-center rounded-md border transition ${magnet !== 'off' ? 'border-prism-500/60 bg-prism-600/25 text-prism-200' : 'border-white/10 bg-ink-800/60 text-slate-400 hover:text-slate-100'}`}
          ><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 6l-2 2 2 2M6 6v6a4 4 0 004 4h4a4 4 0 004-4V6l2 2 2-2" /></svg></button>

          {/* 连续绘制 */}
          <button type="button" title={t('charts.draw.stayInDraw')} aria-label={t('charts.draw.stayInDraw')}
            onClick={() => setStayInDraw(!stayInDraw)}
            className={`flex h-8 w-8 items-center justify-center rounded-md border transition ${stayInDraw ? 'border-prism-500/60 bg-prism-600/25 text-prism-200' : 'border-white/10 bg-ink-800/60 text-slate-400 hover:text-slate-100'}`}
          ><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3l4 4-4 4" /><path d="M3 17l4 4-4 4" /><line x1="21" y1="7" x2="7" y2="21" /><line x1="7" y1="3" x2="21" y2="17" /></svg></button>

          {/* 显示/隐藏 */}
          <button type="button" title={visible ? t('charts.draw.hideAll') : t('charts.draw.showAll')} aria-label={visible ? t('charts.draw.hideAll') : t('charts.draw.showAll')}
            onClick={() => setVisible(!visible)}
            className={`flex h-8 w-8 items-center justify-center rounded-md border transition ${!visible ? 'border-amber-400/60 bg-amber-400/15 text-amber-300' : 'border-white/10 bg-ink-800/60 text-slate-400 hover:text-slate-100'}`}
          ><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{visible ? <><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" /></> : <><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24" /><line x1="1" y1="1" x2="23" y2="23" /></>}</svg></button>
          </div>{/* end sticky utility bar */}
        </div>
      )}

      {/* 叠加画布 */}
      <canvas ref={canvasRef} className="pointer-events-none absolute inset-1.5 z-10 touch-none" style={{ display: visible ? '' : 'none' }}
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
        onContextMenu={(e) => {
          e.preventDefault()
          if (tool !== 'cursor' && tool !== 'cross') return
          const cv = canvasRef.current!, r = cv.getBoundingClientRect()
          const x = e.clientX - r.left, y = e.clientY - r.top
          const hit = hitDrawing(x, y, true)
          if (hit) { setSelectedId(hit.id); setCtxMenu({ x: e.clientX, y: e.clientY, drawingId: hit.id }) }
        }}
      />

      {/* 浮动属性栏 / floating properties panel — 桌面版更大 */}
      {propsPanel && selectedId && (() => { const d = drawings.find((dw) => dw.id === selectedId); if (!d) return null; return (
        <div className={`absolute right-3 top-3 z-30 flex items-center gap-1.5 rounded-lg border border-white/10 bg-ink-900/90 px-2 py-1.5 backdrop-blur shadow-lg sm:gap-2.5 sm:px-3 sm:py-2.5`}>
          {/* 线宽 / line width */}
          {LINE_WIDTHS.map((w) => (
            <button key={w} type="button" title={`${w}px`} onClick={() => applyLineWidth(w)}
              className={`flex items-center justify-center rounded border transition sm:w-7 sm:h-7 ${(d.lineWidth || 1) === w ? 'border-prism-500/60 bg-prism-600/25' : 'border-white/10 hover:border-white/20'}`}
              style={{ width: isTouchDevice ? 20 : 28, height: isTouchDevice ? 20 : 28 }}
            ><span style={{ display: 'block', width: w * 4 + 4, height: w, background: d.color, borderRadius: 1 }} /></button>
          ))}
          <span className="w-px h-5 sm:h-6 bg-white/10" />
          {/* 线型 / line style */}
          {(['solid', 'dashed', 'dotted'] as const).map((s) => (
            <button key={s} type="button" title={String(t(`charts.draw.${s}`))} onClick={() => applyLineStyle(s)}
              className={`flex items-center justify-center rounded border transition ${(d.lineStyle || 'solid') === s ? 'border-prism-500/60 bg-prism-600/25 text-prism-200' : 'border-white/10 text-slate-500 hover:text-slate-300'}`}
              style={{ height: isTouchDevice ? 20 : 26, width: isTouchDevice ? 28 : 36, fontSize: isTouchDevice ? 9 : 12 }}
            >{s === 'solid' ? '━━' : s === 'dashed' ? '┅┅' : '┅'}</button>
          ))}
          <span className="w-px h-5 sm:h-6 bg-white/10" />
          {/* 锁定按钮 */}
          <button type="button" onClick={toggleLock}
            className={`rounded border px-1.5 transition sm:px-2 ${d.locked ? 'border-amber-400/60 text-amber-300' : 'border-white/10 text-slate-400 hover:text-slate-100'}`}
            style={{ height: isTouchDevice ? 20 : 26, fontSize: isTouchDevice ? 10 : 12 }}
          >{d.locked ? '�' : '��'}</button>
          {/* 删除按钮 */}
          <button type="button" onClick={deleteSelected}
            className="rounded border border-white/10 px-1.5 text-slate-400 hover:text-down sm:px-2"
            style={{ height: isTouchDevice ? 20 : 26, fontSize: isTouchDevice ? 10 : 12 }}
          >🗑</button>
        </div>
      )})()}

      {/* 右键上下文菜单 */}
      {ctxMenu && (
        <div className="fixed z-50 min-w-[140px] rounded-lg border border-white/10 bg-ink-900/95 p-1 shadow-xl backdrop-blur" style={{ left: ctxMenu.x, top: ctxMenu.y }} onClick={(e) => e.stopPropagation()}>
          <button onClick={() => { const d = drawings.find((dw) => dw.id === ctxMenu.drawingId); if (d) commit(drawings.map((dw) => dw.id === ctxMenu.drawingId ? { ...dw, locked: !dw.locked } : dw)); setCtxMenu(null) }}
            className="flex w-full items-center gap-2 rounded px-3 py-1.5 text-xs text-slate-300 hover:bg-white/10"
          >
            {drawings.find((d) => d.id === ctxMenu.drawingId)?.locked ? '🔓' : '🔒'}
            {drawings.find((d) => d.id === ctxMenu.drawingId)?.locked ? t('charts.draw.unlock') : t('charts.draw.lock')}
          </button>
          <button onClick={ctxOpenSettings} className="flex w-full items-center gap-2 rounded px-3 py-1.5 text-xs text-slate-300 hover:bg-white/10">⚙ {t('charts.draw.settings')}</button>
          <button onClick={ctxDeleteDrawing} className="flex w-full items-center gap-2 rounded px-3 py-1.5 text-xs text-down hover:bg-white/10">🗑 {t('charts.draw.delete')}</button>
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