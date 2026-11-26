// 触屏拖动时的放大镜：手指拖画线的点、手柄、止盈止损线时，点正好被手指挡住，看不清落在哪。
// 拖动期间在图表左上角（手指在左上角时换到右上角）放一块放大两倍的局部画面，正中一个十字
// 标出手指正在放的那个点。画面直接从图表自己的画布上拷（lightweight-charts 的窗格画布里
// 已经有 K 线、画线、持仓线），不重新画一遍。
// 用一个模块级的小仓库：画线层、持仓线层各自在拖动里 showLoupe / hideLoupe，页面上只挂一个
// <ChartLoupe />。拖动期间用 requestAnimationFrame 逐帧拷，停手就停。
// Touch-drag loupe: when a finger drags a drawing point, a handle or an SL/TP line, the point
// sits right under the finger. While dragging, a 2× close-up sits in the chart's top-left
// corner (top-right when the finger is there), with a cross marking the point being placed.
// The image is copied straight from the chart's own canvases (lightweight-charts' pane
// canvases already hold the candles, drawings and position lines) rather than redrawn.
// A tiny module-level store: the drawing and position layers call showLoupe / hideLoupe
// during their drags, and the page mounts a single <ChartLoupe />. Frames are copied with
// requestAnimationFrame only while a drag is on.
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { IChartApi } from 'lightweight-charts'
import { isChartAlive } from './chartLifecycle'

const SIZE = 116 // 放大镜边长（CSS px）/ loupe side in CSS px
const ZOOM = 2
const GAP = 8

interface LoupeReq { chart: IChartApi; x: number; y: number } // 视口坐标 / viewport (client) coords
let req: LoupeReq | null = null
const subs = new Set<() => void>()

// 显示 / 移动放大镜，(x, y) 是要放大的那个点的视口坐标 / show or move the loupe; (x, y) in client coords
export function showLoupe(chart: IChartApi, x: number, y: number): void {
  const was = req
  req = { chart, x, y }
  if (!was) subs.forEach((f) => f())
}

export function hideLoupe(): void {
  if (!req) return
  req = null
  subs.forEach((f) => f())
}

export default function ChartLoupe() {
  const boxRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  // 图表全屏（Fullscreen API）时只显示全屏元素里的东西：放大镜要挂到那里面去
  // In Fullscreen API mode only the fullscreen element's subtree shows: mount the loupe inside it
  const [target, setTarget] = useState<Element>(() => document.fullscreenElement ?? document.body)
  useEffect(() => {
    const onFs = () => setTarget(document.fullscreenElement ?? document.body)
    document.addEventListener('fullscreenchange', onFs)
    return () => document.removeEventListener('fullscreenchange', onFs)
  }, [])

  useEffect(() => {
    let raf = 0
    let lastLeft = NaN, lastTop = NaN
    const box = boxRef.current
    const cv = canvasRef.current
    if (!box || !cv) return
    const ctx = cv.getContext('2d')
    if (!ctx) return

    const frame = () => {
      raf = 0
      const r = req
      if (!r || !isChartAlive(r.chart)) { box.style.display = 'none'; return }
      const host = r.chart.chartElement()
      const hr = host.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1
      const px = Math.round(SIZE * dpr)
      if (cv.width !== px) { cv.width = px; cv.height = px }

      // 位置：默认左上角；手指（被放大的点）落在那一块附近时换到右上角（价格轴左边）
      // Placement: top-left by default; when the point is near there, top-right (left of the price axis)
      const scaleW = r.chart.priceScale('right').width()
      const nearLeft = r.x < hr.left + GAP + SIZE + 32 && r.y < hr.top + GAP + SIZE + 32
      const left = Math.round(nearLeft ? hr.right - scaleW - SIZE - GAP : hr.left + GAP)
      const top = Math.round(hr.top + GAP)
      if (left !== lastLeft || top !== lastTop) { box.style.transform = `translate(${left}px, ${top}px)`; lastLeft = left; lastTop = top }

      // 底色：图表背景 / background: the chart's own
      const bg = r.chart.options().layout.background
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.fillStyle = bg.type === 'solid' ? bg.color : '#0b0b0f'
      ctx.fillRect(0, 0, px, px)

      // 把以 (x, y) 为中心、SIZE / ZOOM 见方的一块，从每张画布上按 DOM 顺序拷过来放大
      // Copy the SIZE / ZOOM square centred on (x, y) from every canvas, in DOM order, scaled up
      const half = SIZE / ZOOM / 2
      const sx0 = r.x - half, sy0 = r.y - half, sx1 = r.x + half, sy1 = r.y + half
      const k = ZOOM * dpr
      ctx.imageSmoothingEnabled = true
      for (const c of host.querySelectorAll('canvas')) {
        if (c === cv) continue
        const cr = c.getBoundingClientRect()
        if (cr.width <= 0 || cr.height <= 0 || c.width === 0 || c.height === 0) continue
        const ix0 = Math.max(sx0, cr.left), iy0 = Math.max(sy0, cr.top)
        const ix1 = Math.min(sx1, cr.right), iy1 = Math.min(sy1, cr.bottom)
        if (ix1 <= ix0 || iy1 <= iy0) continue
        const kx = c.width / cr.width, ky = c.height / cr.height
        try {
          ctx.drawImage(c, (ix0 - cr.left) * kx, (iy0 - cr.top) * ky, (ix1 - ix0) * kx, (iy1 - iy0) * ky,
            (ix0 - sx0) * k, (iy0 - sy0) * k, (ix1 - ix0) * k, (iy1 - iy0) * k)
        } catch { /* 画布刚被释放 / canvas just released */ }
      }

      // 正中十字：中间留空，不盖住点本身 / centre cross with a gap so the point itself stays visible
      const c0 = px / 2, gap = 5 * dpr, arm = 14 * dpr
      ctx.lineCap = 'round'
      const cross = (color: string, w: number) => {
        ctx.strokeStyle = color
        ctx.lineWidth = w
        ctx.beginPath()
        ctx.moveTo(c0 - gap - arm, c0); ctx.lineTo(c0 - gap, c0)
        ctx.moveTo(c0 + gap, c0); ctx.lineTo(c0 + gap + arm, c0)
        ctx.moveTo(c0, c0 - gap - arm); ctx.lineTo(c0, c0 - gap)
        ctx.moveTo(c0, c0 + gap); ctx.lineTo(c0, c0 + gap + arm)
        ctx.stroke()
      }
      cross('rgba(0,0,0,0.55)', 3 * dpr)
      cross('#ffffff', 1.25 * dpr)

      box.style.display = 'block'
      raf = requestAnimationFrame(frame)
    }

    const onChange = () => {
      if (req && !raf) raf = requestAnimationFrame(frame)
      if (!req) { if (raf) cancelAnimationFrame(raf); raf = 0; box.style.display = 'none' }
    }
    subs.add(onChange)
    onChange()
    return () => {
      subs.delete(onChange)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [target])

  return createPortal(
    <div ref={boxRef} className="chart-loupe" aria-hidden="true" style={{ display: 'none' }}>
      <canvas ref={canvasRef} />
    </div>,
    target,
  )
}
