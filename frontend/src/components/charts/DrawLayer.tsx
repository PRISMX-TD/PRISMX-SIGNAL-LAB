// 图表画图层：在 lightweight-charts 之上叠加一个 canvas，支持趋势线 / 水平线 /
// 矩形的绘制、选中、拖动与删除。画线锚定在 (时间, 价格) 数据坐标上，随图表
// 平移/缩放自动重绘；按品种保存到用户云端偏好，跨设备同步（见 store/prefs）。
//
// Chart drawing layer: an overlay canvas on top of lightweight-charts that
// supports drawing / selecting / moving / deleting trend lines, horizontal
// lines and rectangles. Anchors are stored in (time, price) data coordinates
// and repainted as the chart pans/zooms; drawings are saved per symbol into
// the user's cloud prefs and synced across devices (see store/prefs).
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, type PointerEvent as RPointerEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { IChartApi, ISeriesApi, UTCTimestamp } from 'lightweight-charts'
import { usePrefs } from '../../store/prefs'
import ConfirmModal from '../ConfirmModal'
import { useBackToClose } from '../../utils/useBackToClose'

export type Tool = 'cursor' | 'trend' | 'hline' | 'rect' | 'fib'
type DrawType = 'trend' | 'hline' | 'rect' | 'fib'

export interface DrawLayerHandle {
  tool: Tool
  setTool: (t: Tool) => void
  color: string
  setColor: (c: string) => void
  selectedId: string | null
  drawCount: number
  deleteSelected: () => void
  clearAll: () => void
  applyColor: (c: string) => void
}

// 一个锚点：时间(epoch 秒) + 价格。水平线只用到 price。
// An anchor point: time (epoch seconds) + price. Horizontal lines use price only.
interface Point {
  t: number
  p: number
}

interface Drawing {
  id: string
  type: DrawType
  pts: Point[] // hline: [{t:0,p}]; trend/rect: [a, b]
  color: string
}

interface Props {
  chart: IChartApi
  series: ISeriesApi<'Candlestick'>
  host: HTMLDivElement
  symbol: string
  lastPrice: number
  barTimes: () => number[]
  digits?: number
  hideToolbar?: boolean
}

// 命中判定容差（屏幕像素）/ hit-test tolerance in screen pixels
const TOL = 8
const HANDLE = 9
const COLORS = ['#22d3ee', '#a78bfa', '#2ee07e', '#ff4d67', '#f5c451']
// 斐波那契回调价位 / Fibonacci retracement levels
const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1]

const uid = () => 'dw_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)

// 点到线段的最短距离 / shortest distance from a point to a segment
function distToSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax
  const dy = by - ay
  const len2 = dx * dx + dy * dy
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2
  t = Math.max(0, Math.min(1, t))
  const cx = ax + t * dx
  const cy = ay + t * dy
  return Math.hypot(px - cx, py - cy)
}

function DrawLayer({ chart, series, host, symbol, lastPrice, barTimes, digits = 2, hideToolbar }: Props, ref: React.Ref<DrawLayerHandle>) {
  const { t } = useTranslation()
  const { getPref, setPref } = usePrefs()
  const canvasRef = useRef<HTMLCanvasElement>(null)

  const [tool, setTool] = useState<Tool>('cursor')
  const [color, setColor] = useState<string>(COLORS[0])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [drawings, setDrawings] = useState<Drawing[]>([])
  const [drawCount, setDrawCount] = useState(0)

  // 清空确认弹窗：不用 window.confirm()，改用项目统一 ConfirmModal，
  // 避免原生弹窗在全屏模式下把浏览器踢出全屏状态。
  // Clear-confirm modal: replaces window.confirm() with the project's
  // ConfirmModal so native dialogs don't break fullscreen state.
  const [confirmOpen, setConfirmOpen] = useState(false)
  useBackToClose(confirmOpen, () => setConfirmOpen(false))

  useImperativeHandle(ref, () => ({
    tool,
    setTool,
    color,
    setColor,
    selectedId,
    drawCount,
    deleteSelected,
    clearAll,
    applyColor,
  }))

  // 交互期间用可变引用避免频繁 setState / mutable refs to avoid re-render during interaction
  const toolRef = useRef(tool)
  const colorRef = useRef(color)
  const selectedRef = useRef<string | null>(selectedId)
  const drawingsRef = useRef<Drawing[]>([])
  // 拖动/绘制过程中的像素级工作副本 / pixel-space working copy while dragging or drawing
  const workRef = useRef<{ type: DrawType; color: string; px: { x: number; y: number }[] } | null>(null)
  const dragRef = useRef<
    | { mode: 'create' }
    | { mode: 'move'; id: string; startX: number; startY: number; origPx: { x: number; y: number }[] }
    | { mode: 'handle'; id: string; handle: number }
    | null
  >(null)
  // 已应用到状态的画线快照，避免"保存后云端回传"把选中态重置 / snapshot to skip reload-after-save
  const appliedRef = useRef('')
  const symRef = useRef(symbol)

  toolRef.current = tool
  colorRef.current = color
  selectedRef.current = selectedId
  drawingsRef.current = drawings

  // ---------- 坐标换算 / coordinate conversion ----------
  // 时间 → x：精确命中本周期某根 bar 时直接换算；否则用相邻两根 bar 的坐标做
  // 线性插值（timeToCoordinate 对 in-data 的 bar 即使滚出可视区也返回有效坐标），
  // 从而让按品种保存的画线在任何周期都能显示。
  // time → x: exact bar hit converts directly; otherwise linearly interpolate
  // between the two neighbouring bars' coordinates (timeToCoordinate returns a
  // valid coordinate for any in-data bar, even off-screen), so per-symbol
  // drawings render on any interval.
  const xOf = useCallback(
    (tm: number): number | null => {
      const exact = chart.timeScale().timeToCoordinate(tm as UTCTimestamp)
      if (exact != null) return exact
      const times = barTimes()
      if (times.length < 2) return null
      const ts = chart.timeScale()
      const lerp = (i0: number, i1: number): number | null => {
        const x0 = ts.timeToCoordinate(times[i0] as UTCTimestamp)
        const x1 = ts.timeToCoordinate(times[i1] as UTCTimestamp)
        if (x0 == null || x1 == null || times[i1] === times[i0]) return null
        return x0 + ((tm - times[i0]) / (times[i1] - times[i0])) * (x1 - x0)
      }
      const last = times.length - 1
      if (tm <= times[0]) return lerp(0, 1)
      if (tm >= times[last]) return lerp(last - 1, last)
      let lo = 0
      let hi = last
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (times[mid] <= tm) lo = mid + 1
        else hi = mid
      }
      return lerp(lo - 1, lo)
    },
    [chart, barTimes]
  )
  const yOf = useCallback((p: number) => series.priceToCoordinate(p), [series])
  // x → 时间：图表数据区内直接换算；落在右侧空白/超出数据范围时，用 logical 索引
  // 在 barTimes 上插值/外推，避免返回 null——否则拖到空白处一放手画线就被丢弃。
  // x → time: convert directly inside the data area; when the point lands in the
  // right-side whitespace or beyond the data range, interpolate/extrapolate over
  // barTimes via the logical index instead of returning null — otherwise dropping
  // a shape in the whitespace would discard it on release.
  const tOf = useCallback(
    (x: number): number | null => {
      const ts = chart.timeScale()
      const exact = ts.coordinateToTime(x) as number | null
      if (exact != null) return exact
      const times = barTimes()
      if (times.length < 2) return exact
      const logical = ts.coordinateToLogical(x) as number | null
      if (logical == null) return exact
      const last = times.length - 1
      let i0: number
      if (logical <= 0) i0 = 0
      else if (logical >= last) i0 = last - 1
      else i0 = Math.floor(logical)
      const step = times[i0 + 1] - times[i0]
      return Math.round(times[i0] + (logical - i0) * step)
    },
    [chart, barTimes]
  )
  const pOf = useCallback((y: number) => series.coordinateToPrice(y) as number | null, [series])

  // ---------- 加载/保存（按品种，云端同步）/ load & save (per symbol, cloud sync) ----------
  useEffect(() => {
    const saved = getPref<Drawing[]>('chartDraw', symbol, [])
    const arr = Array.isArray(saved) ? saved : []
    const json = JSON.stringify(arr)
    if (symRef.current === symbol && json === appliedRef.current) return
    symRef.current = symbol
    appliedRef.current = json
    setDrawings(arr)
    setDrawCount(arr.length)
    setSelectedId(null)
  }, [symbol, getPref])

  const commit = useCallback(
    (next: Drawing[]) => {
      appliedRef.current = JSON.stringify(next)
      drawingsRef.current = next
      setDrawings(next)
      setDrawCount(next.length)
      setPref('chartDraw', symbol, next)
    },
    [setPref, symbol]
  )

  // ---------- 画线的像素端点 / a drawing's endpoints in pixel space ----------
  const toPx = useCallback(
    (d: Drawing): { x: number; y: number }[] | null => {
      if (d.type === 'hline') {
        const y = yOf(d.pts[0].p)
        return y == null ? null : [{ x: 0, y }]
      }
      const a = { x: xOf(d.pts[0].t), y: yOf(d.pts[0].p) }
      const b = { x: xOf(d.pts[1].t), y: yOf(d.pts[1].p) }
      if (a.x == null || a.y == null || b.x == null || b.y == null) return null
      return [
        { x: a.x, y: a.y },
        { x: b.x, y: b.y },
      ]
    },
    [xOf, yOf]
  )

  // ---------- 渲染 / render ----------
  const draw = useCallback(() => {
    const cv = canvasRef.current
    if (!cv) return
    const ctx = cv.getContext('2d')
    if (!ctx) return
    const dpr = window.devicePixelRatio || 1
    const w = host.clientWidth
    const h = host.clientHeight
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)

    const paintHandle = (x: number, y: number) => {
      ctx.fillStyle = '#0a0710'
      ctx.strokeStyle = '#ffffff'
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.rect(x - HANDLE / 2, y - HANDLE / 2, HANDLE, HANDLE)
      ctx.fill()
      ctx.stroke()
    }

    const paint = (type: DrawType, px: { x: number; y: number }[], col: string, selected: boolean) => {
      ctx.strokeStyle = col
      ctx.lineWidth = selected ? 2 : 1.5
      if (type === 'hline') {
        const y = px[0].y
        ctx.beginPath()
        ctx.moveTo(0, y)
        ctx.lineTo(w, y)
        ctx.stroke()
        if (selected) paintHandle(w / 2, y)
      } else if (type === 'trend') {
        ctx.beginPath()
        ctx.moveTo(px[0].x, px[0].y)
        ctx.lineTo(px[1].x, px[1].y)
        ctx.stroke()
        if (selected) {
          paintHandle(px[0].x, px[0].y)
          paintHandle(px[1].x, px[1].y)
        }
      } else if (type === 'fib') {
        const xL = Math.min(px[0].x, px[1].x)
        const xR = Math.max(px[0].x, px[1].x)
        const yA = px[0].y // ratio 1（第一个锚点）/ ratio 1 (first anchor)
        const yB = px[1].y // ratio 0（第二个锚点）/ ratio 0 (second anchor)
        // 连接两锚点的淡对角线 / faint diagonal joining the two anchors
        ctx.globalAlpha = 0.45
        ctx.beginPath()
        ctx.moveTo(px[0].x, px[0].y)
        ctx.lineTo(px[1].x, px[1].y)
        ctx.stroke()
        ctx.globalAlpha = 1
        ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace'
        ctx.textBaseline = 'middle'
        let prevY: number | null = null
        for (const lv of FIB_LEVELS) {
          const ly = yB + (yA - yB) * lv // lv=0 → yB, lv=1 → yA
          if (prevY != null) {
            ctx.fillStyle = col + '14'
            ctx.fillRect(xL, Math.min(prevY, ly), xR - xL, Math.abs(ly - prevY))
          }
          prevY = ly
          ctx.strokeStyle = col
          ctx.lineWidth = 1
          ctx.beginPath()
          ctx.moveTo(xL, ly)
          ctx.lineTo(xR, ly)
          ctx.stroke()
          const price = pOf(ly)
          ctx.fillStyle = col
          ctx.fillText(`${(lv * 100).toFixed(1)}%${price != null ? '  ' + price.toFixed(digits) : ''}`, xR + 4, ly)
        }
        if (selected) {
          paintHandle(px[0].x, px[0].y)
          paintHandle(px[1].x, px[1].y)
        }
      } else {
        const x = Math.min(px[0].x, px[1].x)
        const y = Math.min(px[0].y, px[1].y)
        const rw = Math.abs(px[1].x - px[0].x)
        const rh = Math.abs(px[1].y - px[0].y)
        ctx.fillStyle = col + '22'
        ctx.fillRect(x, y, rw, rh)
        ctx.strokeRect(x, y, rw, rh)
        if (selected) {
          paintHandle(px[0].x, px[0].y)
          paintHandle(px[1].x, px[1].y)
        }
      }
    }

    for (const d of drawingsRef.current) {
      if (workRef.current && dragRef.current && 'id' in dragRef.current && dragRef.current.id === d.id) continue
      const px = toPx(d)
      if (px) paint(d.type, px, d.color, d.id === selectedRef.current)
    }
    // 正在绘制/拖动的工作副本 / the in-progress working copy
    if (workRef.current) paint(workRef.current.type, workRef.current.px, workRef.current.color, true)
  }, [host, toPx, pOf, digits])

  // ---------- 画布尺寸自适配 / keep canvas sized to the host ----------
  useEffect(() => {
    const cv = canvasRef.current
    if (!cv) return
    const resize = () => {
      const dpr = window.devicePixelRatio || 1
      const w = host.clientWidth
      const h = host.clientHeight
      cv.width = Math.round(w * dpr)
      cv.height = Math.round(h * dpr)
      cv.style.width = w + 'px'
      cv.style.height = h + 'px'
      draw()
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(host)
    return () => ro.disconnect()
  }, [host, draw])

  // ---------- 随图表变化重绘（rAF 侦测坐标映射签名变化）/ repaint on chart changes ----------
  useEffect(() => {
    let raf = 0
    let lastSig = ''
    const loop = () => {
      const range = chart.timeScale().getVisibleLogicalRange()
      const yRef = lastPrice ? yOf(lastPrice) : null
      const sig = `${range?.from ?? ''}_${range?.to ?? ''}_${yRef ?? ''}`
      if (sig !== lastSig) {
        lastSig = sig
        draw()
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [chart, draw, yOf, lastPrice])

  // 画线/选中/工具/颜色变化后立即重绘 / redraw right after state changes
  useEffect(() => {
    draw()
  }, [drawings, selectedId, tool, color, draw])

  // ---------- 命中判定 / hit-testing (screen coords) ----------
  // 返回选中画线的某个把手序号（-1 表示未命中把手）/ handle index of the selected drawing (-1 = none)
  const hitHandle = useCallback(
    (x: number, y: number): number => {
      const sel = drawingsRef.current.find((d) => d.id === selectedRef.current)
      if (!sel) return -1
      const px = toPx(sel)
      if (!px) return -1
      if (sel.type === 'hline') {
        if (Math.hypot(x - host.clientWidth / 2, y - px[0].y) <= HANDLE + 2) return 0
        return -1
      }
      for (let i = 0; i < px.length; i++) {
        if (Math.abs(x - px[i].x) <= HANDLE + 2 && Math.abs(y - px[i].y) <= HANDLE + 2) return i
      }
      return -1
    },
    [toPx, host]
  )

  const hitDrawing = useCallback(
    (x: number, y: number): Drawing | null => {
      const list = drawingsRef.current
      for (let i = list.length - 1; i >= 0; i--) {
        const d = list[i]
        const px = toPx(d)
        if (!px) continue
        if (d.type === 'hline') {
          if (Math.abs(y - px[0].y) <= TOL) return d
        } else if (d.type === 'trend') {
          if (distToSeg(x, y, px[0].x, px[0].y, px[1].x, px[1].y) <= TOL) return d
        } else if (d.type === 'fib') {
          const xL = Math.min(px[0].x, px[1].x)
          const xR = Math.max(px[0].x, px[1].x)
          if (x >= xL - TOL && x <= xR + TOL) {
            const yA = px[0].y
            const yB = px[1].y
            for (const lv of FIB_LEVELS) {
              if (Math.abs(y - (yB + (yA - yB) * lv)) <= TOL) return d
            }
          }
          if (distToSeg(x, y, px[0].x, px[0].y, px[1].x, px[1].y) <= TOL) return d
        } else {
          const x1 = Math.min(px[0].x, px[1].x)
          const x2 = Math.max(px[0].x, px[1].x)
          const y1 = Math.min(px[0].y, px[1].y)
          const y2 = Math.max(px[0].y, px[1].y)
          const nearV = (x >= x1 - TOL && x <= x2 + TOL) && (Math.abs(y - y1) <= TOL || Math.abs(y - y2) <= TOL)
          const nearH = (y >= y1 - TOL && y <= y2 + TOL) && (Math.abs(x - x1) <= TOL || Math.abs(x - x2) <= TOL)
          if (nearV || nearH) return d
        }
      }
      return null
    },
    [toPx]
  )

  // ---------- 指针事件（画布）/ pointer events on the canvas ----------
  const localXY = (e: RPointerEvent<HTMLCanvasElement> | PointerEvent) => {
    const cv = canvasRef.current!
    const r = cv.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  const onDown = (e: RPointerEvent<HTMLCanvasElement>) => {
    const { x, y } = localXY(e)
    const cur = toolRef.current
    canvasRef.current?.setPointerCapture(e.pointerId)

    if (cur !== 'cursor') {
      // 绘制模式 / draw mode
      if (cur === 'hline') {
        const p = pOf(y)
        if (p == null) return
        const d: Drawing = { id: uid(), type: 'hline', pts: [{ t: 0, p }], color: colorRef.current }
        commit([...drawingsRef.current, d])
        setSelectedId(d.id)
        setTool('cursor')
        return
      }
      workRef.current = {
        type: cur,
        color: colorRef.current,
        px: [
          { x, y },
          { x, y },
        ],
      }
      dragRef.current = { mode: 'create' }
      draw()
      return
    }

    // 光标模式：先判把手，再判整体 / cursor mode: handles first, then bodies
    const h = hitHandle(x, y)
    if (h >= 0) {
      dragRef.current = { mode: 'handle', id: selectedRef.current!, handle: h }
      const sel = drawingsRef.current.find((d) => d.id === selectedRef.current)!
      workRef.current = { type: sel.type, color: sel.color, px: toPx(sel)! }
      draw()
      return
    }
    const hit = hitDrawing(x, y)
    if (hit) {
      setSelectedId(hit.id)
      dragRef.current = { mode: 'move', id: hit.id, startX: x, startY: y, origPx: toPx(hit)! }
      workRef.current = { type: hit.type, color: hit.color, px: toPx(hit)! }
      draw()
    } else {
      setSelectedId(null)
    }
  }

  const onMove = (e: RPointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current
    if (!drag || !workRef.current) return
    const { x, y } = localXY(e)
    if (drag.mode === 'create') {
      workRef.current.px[1] = { x, y }
    } else if (drag.mode === 'move') {
      const dx = x - drag.startX
      const dy = y - drag.startY
      workRef.current.px = drag.origPx.map((p) => ({ x: p.x + dx, y: p.y + dy }))
    } else {
      workRef.current.px[drag.handle] = { x, y }
    }
    draw()
  }

  const onUp = () => {
    const drag = dragRef.current
    const work = workRef.current
    dragRef.current = null
    workRef.current = null
    if (!drag || !work) {
      draw()
      return
    }

    // 像素工作副本转回数据坐标 / convert the pixel working copy back to data coords
    const toPoint = (px: { x: number; y: number }): Point | null => {
      const p = pOf(px.y)
      if (p == null) return null
      if (work.type === 'hline') return { t: 0, p }
      const tm = tOf(px.x)
      if (tm == null) return null
      return { t: tm, p }
    }

    if (drag.mode === 'create') {
      // 距离过小视为误触，丢弃 / too small => treat as a mis-tap, discard
      if (Math.hypot(work.px[1].x - work.px[0].x, work.px[1].y - work.px[0].y) < 4) {
        draw()
        return
      }
      const a = toPoint(work.px[0])
      const b = toPoint(work.px[1])
      if (!a || !b) {
        draw()
        return
      }
      const d: Drawing = { id: uid(), type: work.type, pts: [a, b], color: work.color }
      commit([...drawingsRef.current, d])
      setSelectedId(d.id)
      setTool('cursor')
      return
    }

    // move / handle：更新对应画线 / update the affected drawing
    const pts = work.px.map(toPoint)
    if (pts.some((p) => p == null)) {
      draw()
      return
    }
    const next = drawingsRef.current.map((d) =>
      d.id === drag.id ? { ...d, pts: work.type === 'hline' ? [pts[0]!] : (pts as Point[]) } : d
    )
    commit(next)
  }

  // ---------- 悬停时动态切换 canvas 是否拦截指针 / toggle pointer interception on hover ----------
  // 监听器挂在 window 的捕获阶段：lightweight-charts 在自己的 canvas 上绑定了
  // mousemove/mousedown/touchstart 且可能吞掉冒泡，挂 wrapper 冒泡会漏事件导致
  // “画完的东西点不中”。捕获阶段在图表处理之前必定触发，因此可靠。
  // The listener is attached to window in the capture phase: lightweight-charts
  // binds mousemove/mousedown/touchstart on its own canvas and may swallow
  // bubbling, so a wrapper bubble-phase listener misses events and makes existing
  // drawings hard to click. Capture always fires before the chart, so it's reliable.
  useEffect(() => {
    const cv = canvasRef.current
    if (!cv) return
    const onHover = (e: PointerEvent) => {
      if (dragRef.current) {
        cv.style.pointerEvents = 'auto'
        return
      }
      if (toolRef.current !== 'cursor') {
        cv.style.pointerEvents = 'auto'
        cv.style.cursor = 'crosshair'
        return
      }
      const r = cv.getBoundingClientRect()
      const x = e.clientX - r.left
      const y = e.clientY - r.top
      if (x < 0 || y < 0 || x > r.width || y > r.height) {
        cv.style.pointerEvents = 'none'
        return
      }
      const onHandle = hitHandle(x, y) >= 0
      const onBody = onHandle || hitDrawing(x, y) != null
      if (onBody) {
        cv.style.pointerEvents = 'auto'
        cv.style.cursor = onHandle ? 'crosshair' : 'move'
      } else {
        cv.style.pointerEvents = 'none'
        cv.style.cursor = 'default'
      }
    }
    window.addEventListener('pointermove', onHover, true)
    return () => window.removeEventListener('pointermove', onHover, true)
  }, [hitHandle, hitDrawing])

  // 工具切换：绘制工具下让画布常驻拦截，光标模式交回悬停逻辑
  // Tool switch: keep the canvas capturing under a draw tool; hand back to hover in cursor mode
  useEffect(() => {
    const cv = canvasRef.current
    if (!cv) return
    if (tool !== 'cursor') {
      cv.style.pointerEvents = 'auto'
      cv.style.cursor = 'crosshair'
    } else {
      cv.style.pointerEvents = 'none'
      cv.style.cursor = 'default'
    }
  }, [tool])

  // ---------- 键盘：Esc 取消 / Delete 删除所选 ----------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (dragRef.current) {
          dragRef.current = null
          workRef.current = null
          draw()
        }
        setTool('cursor')
        setSelectedId(null)
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedRef.current) {
        const target = e.target as HTMLElement | null
        if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return
        commit(drawingsRef.current.filter((d) => d.id !== selectedRef.current))
        setSelectedId(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [commit, draw])

  const deleteSelected = () => {
    if (!selectedId) return
    commit(drawings.filter((d) => d.id !== selectedId))
    setSelectedId(null)
  }
  const clearAll = () => {
    if (drawings.length === 0) return
    setConfirmOpen(true)
  }
  const doClearAll = () => {
    setConfirmOpen(false)
    commit([])
    setSelectedId(null)
  }
  const applyColor = (c: string) => {
    setColor(c)
    if (selectedId) commit(drawings.map((d) => (d.id === selectedId ? { ...d, color: c } : d)))
  }

  const toolBtn = (id: Tool, label: string, icon: JSX.Element) => (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={() => {
        setTool(id)
        if (id !== 'cursor') setSelectedId(null)
      }}
      className={`flex h-8 w-8 items-center justify-center rounded-md border transition ${
        tool === id
          ? 'border-prism-500/60 bg-prism-600/25 text-prism-200'
          : 'border-white/10 bg-ink-800/60 text-slate-400 hover:text-slate-100'
      }`}
    >
      {icon}
    </button>
  )

  return (
    <>
      {/* 左侧浮动工具栏 / floating left toolbar */}
      {!hideToolbar && (
      <div className="absolute left-3 top-3 z-20 flex flex-col gap-1.5 rounded-xl border border-white/10 bg-ink-900/80 p-1.5 backdrop-blur">
        {toolBtn(
          'cursor',
          t('charts.draw.cursor'),
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 3l7 17 2.5-6.5L20 11 4 3z" /></svg>
        )}
        {toolBtn(
          'trend',
          t('charts.draw.trend'),
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 20L20 4" /><circle cx="4" cy="20" r="2" /><circle cx="20" cy="4" r="2" /></svg>
        )}
        {toolBtn(
          'hline',
          t('charts.draw.hline'),
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12h18" /><circle cx="12" cy="12" r="2" /></svg>
        )}
        {toolBtn(
          'rect',
          t('charts.draw.rect'),
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="6" width="16" height="12" rx="1" /></svg>
        )}
        {toolBtn(
          'fib',
          t('charts.draw.fib'),
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 5h18M3 10h18M3 14h18M3 19h18" /><path d="M4 19L20 5" opacity="0.5" /></svg>
        )}

        <div className="my-0.5 h-px w-full bg-white/10" />

        {/* 颜色 / color swatches */}
        <div className="flex flex-col items-center gap-1">
          {COLORS.map((c) => (
            <button
              key={c}
              type="button"
              title={t('charts.draw.color')}
              aria-label={t('charts.draw.color')}
              onClick={() => {
                setColor(c)
                // 已选中某条画线时，改色即刻应用 / recolor the selected drawing on the fly
                if (selectedId) commit(drawings.map((d) => (d.id === selectedId ? { ...d, color: c } : d)))
              }}
              className={`h-4 w-4 rounded-full border transition ${color === c ? 'border-white scale-110' : 'border-white/20'}`}
              style={{ background: c }}
            />
          ))}
        </div>

        <div className="my-0.5 h-px w-full bg-white/10" />

        <button
          type="button"
          title={t('charts.draw.delete')}
          aria-label={t('charts.draw.delete')}
          onClick={deleteSelected}
          disabled={!selectedId}
          className="flex h-8 w-8 items-center justify-center rounded-md border border-white/10 bg-ink-800/60 text-slate-400 transition hover:text-down disabled:opacity-30 disabled:hover:text-slate-400"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" /></svg>
        </button>
        <button
          type="button"
          title={t('charts.draw.clear')}
          aria-label={t('charts.draw.clear')}
          onClick={clearAll}
          disabled={drawCount === 0}
          className="flex h-8 w-8 items-center justify-center rounded-md border border-white/10 bg-ink-800/60 text-slate-400 transition hover:text-down disabled:opacity-30 disabled:hover:text-slate-400"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 5L5 19M5 5l14 14" /></svg>
        </button>
      </div>
      )}

      {/* 叠加画布：与图表内容区等大（外层 .glass 有 p-1.5=6px 内边距）。
          pointer-events 默认 none（Tailwind 类），由各 effect 直接改写内联样式动态
          切换，避免 React 每次重渲染把内联样式重置掉。
          Overlay canvas matching the chart content box (outer .glass has
          p-1.5=6px). pointer-events default to none via a Tailwind class; the
          effects flip the inline value directly so React re-renders never reset it. */}
      <canvas
        ref={canvasRef}
        className="pointer-events-none absolute inset-1.5 z-10 touch-none"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      />

      {/* 清空确认弹窗 / clear-all confirm modal */}
      {confirmOpen && (
        <ConfirmModal
          title={t('charts.draw.clear')}
          message={t('charts.draw.clearConfirm', { symbol })}
          confirmLabel={t('charts.draw.clear')}
          danger
          onConfirm={doClearAll}
          onCancel={() => setConfirmOpen(false)}
        />
      )}
    </>
  )
}

export default forwardRef(DrawLayer)
