// 全部画线共用一个 series primitive：按数组顺序画（= 叠放次序），选中 / 悬停的画手柄，
// 正在画的那条（temp）和框选框画在最上面；价格轴 / 时间轴上给水平线、垂直线和选中的画线出标签。
// 以前每条画线一个 primitive，叠放次序、框选、临时线都得另想办法。
// One series primitive for every drawing: painted in array order (= z-order), handles on the
// selected / hovered ones, the drawing in progress (temp) and the marquee on top; axis labels for
// horizontal / vertical lines and the selection. It used to be one primitive per drawing, which
// left z-order, marquee and the temp line without a home.
import type { CanvasRenderingTarget2D } from 'fancy-canvas'
import type {
  IChartApi, IPrimitivePaneView, IPrimitivePaneRenderer, PrimitiveHoveredItem, AutoscaleInfo,
  ISeriesPrimitiveAxisView, PrimitivePaneViewZOrder,
} from 'lightweight-charts'
import type { MainSeriesApi } from '../useChartEngine'
import { type Drawing, visibleOn, isScreenAnchored } from './model'
import { timeToX, barsBetween } from './coords'
import {
  type DrawEnv, type DrawLabels, type Px, anchorsOf, anchorsValid, renderDrawing, handlesOf, hitDrawing,
  handleROf, tolOf,
} from './tools'

export interface DrawScene {
  fmtPrice: (p: number) => string
  fmtTime: (t: number) => string
  L: DrawLabels
  theme: { bg: string; text: string }
  qty: (riskAmount: number, slDist: number, ref: number) => number | null
  pips: (dp: number) => number | null
  interval: string
  touch: boolean
}

export interface DrawHit { d: Drawing; handle: number; dist: number }

function contrastText(color: string): string {
  const m = /^#([0-9a-f]{6})/i.exec(color)
  if (!m) return '#ffffff'
  const n = parseInt(m[1], 16)
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? '#0b0e14' : '#ffffff'
}

class AxisLabel implements ISeriesPrimitiveAxisView {
  constructor(private c: number, private txt: string, private bg: string) {}
  coordinate() { return this.c }
  text() { return this.txt }
  textColor() { return contrastText(this.bg) }
  backColor() { return this.bg }
}

export class DrawingsPrimitive {
  list: Drawing[] = []
  temp: Drawing | null = null
  selected = new Set<string>()
  hover: string | null = null
  // 鼠标正压在悬停画线的第几个手柄上（-1 = 没有），那个手柄画实心 / handle under the mouse, painted solid
  hoverHandle = -1
  marquee: { x1: number; y1: number; x2: number; y2: number } | null = null
  scene: DrawScene

  private _chart: IChartApi | null = null
  private _series: MainSeriesApi | null = null
  private _ru: (() => void) | null = null
  private _pv: IPrimitivePaneView[]
  private _pAxis: ISeriesPrimitiveAxisView[] = []
  private _tAxis: ISeriesPrimitiveAxisView[] = []

  constructor(scene: DrawScene) {
    this.scene = scene
    const renderer: IPrimitivePaneRenderer = {
      draw: (target: CanvasRenderingTarget2D) => {
        target.useMediaCoordinateSpace((s) => this._render(s.context, s.mediaSize.width, s.mediaSize.height))
      },
    }
    this._pv = [{ renderer: () => renderer, zOrder: () => 'normal' as PrimitivePaneViewZOrder }]
  }

  attached(p: { chart: IChartApi; series: MainSeriesApi; requestUpdate: () => void }) {
    this._chart = p.chart
    this._series = p.series
    this._ru = p.requestUpdate
  }
  detached() { this._chart = null; this._series = null; this._ru = null }
  requestUpdate() { this._ru?.() }

  paneViews(): readonly IPrimitivePaneView[] { return this._pv }
  priceAxisViews(): readonly ISeriesPrimitiveAxisView[] { return this._pAxis }
  timeAxisViews(): readonly ISeriesPrimitiveAxisView[] { return this._tAxis }
  // 画线不参与价格轴自动缩放，否则远处的一条线会把 K 线压扁。
  // Drawings opt out of autoscale, or one far-away line would squash the candles.
  autoscaleInfo(): AutoscaleInfo | null { return null }

  // 视口变了 / 我们请求重画时由图表调用：重算轴标签 / called on viewport change or our requestUpdate
  updateAllViews() {
    const pa: ISeriesPrimitiveAxisView[] = []
    const ta: ISeriesPrimitiveAxisView[] = []
    const s = this._series, c = this._chart
    if (s && c) {
      const addP = (p: number, col: string) => { const y = s.priceToCoordinate(p); if (y != null) pa.push(new AxisLabel(y, this.scene.fmtPrice(p), col)) }
      const addT = (t: number, col: string) => { const x = timeToX(c, t); if (x != null) ta.push(new AxisLabel(x, this.scene.fmtTime(t), col)) }
      const sel = (d: Drawing) => d === this.temp || this.selected.has(d.id)
      for (const d of this.visible()) {
        if (d.type === 'hline' || d.type === 'hray') addP(d.pts[0].p, d.color)
        else if (d.type === 'vline') addT(d.pts[0].t, d.color)
        else if (d.type === 'crossline') { addP(d.pts[0].p, d.color); addT(d.pts[0].t, d.color) }
        else if (sel(d) && d.type !== 'brush' && d.type !== 'highlighter' && !isScreenAnchored(d.type)) {
          const seenT = new Set<number>()
          for (const pt of d.pts) {
            addP(pt.p, d.color)
            if (!seenT.has(pt.t)) { seenT.add(pt.t); addT(pt.t, d.color) }
          }
        }
      }
    }
    this._pAxis = pa
    this._tAxis = ta
  }

  visible(): Drawing[] {
    const out = this.list.filter((d) => visibleOn(d, this.scene.interval))
    if (this.temp) out.push(this.temp)
    return out
  }

  env(w?: number, h?: number): DrawEnv | null {
    const c = this._chart, s = this._series
    if (!c || !s) return null
    const chart = c
    if (w == null || h == null) {
      const ps = c.paneSize(0)
      w = ps.width; h = ps.height
    }
    const sc = this.scene
    return {
      w, h,
      t2x: (t) => timeToX(c, t),
      p2y: (p) => s.priceToCoordinate(p) as number | null,
      y2p: (y) => s.coordinateToPrice(y) as number | null,
      fmtPrice: sc.fmtPrice,
      bars: (t1, t2) => Math.abs(barsBetween(c, t1, t2)),
      pips: sc.pips,
      qty: sc.qty,
      L: sc.L,
      theme: sc.theme,
      touch: sc.touch,
      closes: (t0, t1) => {
        const out: { x: number; c: number }[] = []
        const data = s.data() as readonly { time: unknown; close?: number; value?: number }[]
        for (const b of data) {
          const tt = typeof b.time === 'number' ? b.time : null
          if (tt == null || tt < t0) continue
          if (tt > t1) break
          const c = b.close ?? b.value
          const x = timeToX(chart, tt)
          if (c != null && x != null) out.push({ x, c })
        }
        return out
      },
    }
  }

  // 命中：自上而下（后画的在上面），先看手柄再看线身；锁定的也命中（可选中，不可拖）。
  // Hit test top-down (later = on top), handles before bodies; locked ones hit too (select, no drag).
  hitAt(x: number, y: number): DrawHit | null {
    const env = this.env()
    if (!env) return null
    const list = this.list.filter((d) => visibleOn(d, this.scene.interval))
    // 抓取范围比画出来的圆圈大一圈，手柄好抓 / the grab area is wider than the drawn circle
    const r = handleROf(env) + (env.touch ? 10 : 5)
    let best: DrawHit | null = null
    for (let i = list.length - 1; i >= 0; i--) {
      const d = list[i]
      const px = anchorsOf(d, env)
      if (!anchorsValid(d, px)) continue
      // 手柄只在选中 / 悬停（触屏：选中）时画出来，也只有那时能抓 / handles are grabbable only when shown
      if (!d.locked && (this.selected.has(d.id) || (this.hover === d.id && !env.touch))) {
        const hs = handlesOf(d, px, env)
        for (let k = 0; k < hs.length; k++) {
          const dd = Math.hypot(x - hs[k].x, y - hs[k].y)
          if (Number.isFinite(dd) && dd <= r) return { d, handle: k, dist: dd }
        }
      }
      // 叠在最上面的那条线身胜出 / the topmost body wins
      if (!best) {
        const dist = hitDrawing(d, px, env, x, y)
        if (dist != null) best = { d, handle: -1, dist }
      }
    }
    // 选中的画线优先于叠在它上面的别的线 / a selected drawing beats one stacked above it
    if (best && !this.selected.has(best.d.id)) {
      for (const d of list) {
        if (!this.selected.has(d.id)) continue
        const px = anchorsOf(d, env)
        if (!anchorsValid(d, px)) continue
        const dist = hitDrawing(d, px, env, x, y)
        if (dist != null) return { d, handle: -1, dist }
      }
    }
    return best
  }

  hitTest(x: number, y: number): PrimitiveHoveredItem | null {
    const h = this.hitAt(x, y)
    if (!h) return null
    return {
      externalId: h.d.id,
      cursorStyle: h.d.locked ? 'default' : 'move',
      hitTestPriority: 1,
      distance: h.dist,
      zOrder: 'normal' as PrimitivePaneViewZOrder,
    }
  }

  private _render(ctx: CanvasRenderingContext2D, w: number, h: number) {
    const env = this.env(w, h)
    if (!env) return
    const r = handleROf(env)
    const drawOne = (d: Drawing, showHandles: boolean) => {
      const px = anchorsOf(d, env)
      if (!anchorsValid(d, px)) return
      ctx.save()
      renderDrawing(ctx, d, px, env, d === this.temp || this.selected.has(d.id) || this.hover === d.id)
      ctx.restore()
      if (showHandles) paintHandles(ctx, handlesOf(d, px, env), d, r, env.theme.bg, d.id === this.hover ? this.hoverHandle : -1)
    }
    for (const d of this.list) {
      if (!visibleOn(d, this.scene.interval)) continue
      drawOne(d, this.selected.has(d.id) || (this.hover === d.id && !env.touch))
    }
    if (this.temp) drawOne(this.temp, true)
    if (this.marquee) {
      const m = this.marquee
      ctx.save()
      ctx.fillStyle = 'rgba(41, 98, 255, 0.08)'
      ctx.strokeStyle = 'rgba(41, 98, 255, 0.7)'
      ctx.setLineDash([4, 3])
      ctx.lineWidth = 1
      ctx.fillRect(Math.min(m.x1, m.x2), Math.min(m.y1, m.y2), Math.abs(m.x2 - m.x1), Math.abs(m.y2 - m.y1))
      ctx.strokeRect(Math.min(m.x1, m.x2), Math.min(m.y1, m.y2), Math.abs(m.x2 - m.x1), Math.abs(m.y2 - m.y1))
      ctx.restore()
    }
  }
}

function paintHandles(ctx: CanvasRenderingContext2D, hs: Px[], d: Drawing, r: number, bg: string, hot: number) {
  ctx.save()
  ctx.setLineDash([])
  ctx.lineWidth = 1.5
  for (let i = 0; i < hs.length; i++) {
    const p = hs[i]
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue
    ctx.beginPath()
    ctx.arc(p.x, p.y, i === hot ? r + 1.5 : r, 0, Math.PI * 2)
    ctx.fillStyle = d.locked ? '#64748b' : i === hot ? d.color : bg
    ctx.strokeStyle = d.locked ? '#94a3b8' : d.color
    ctx.fill()
    ctx.stroke()
  }
  ctx.restore()
}

export const hitTolerance = tolOf
