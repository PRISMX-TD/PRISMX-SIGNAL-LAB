// 财经事件标记：主图窗格底边（时间轴正上方）一排圆形徽章，每个徽章是落在同一处的一簇事件。
// 颜色按簇内最高重要度：3 = 红、2 = 橙（与财经日历的影响色一致）；还没公布的画成空心；
// 一簇多于一个事件时圆里写个数；悬停（或手机点中）的那簇画一条竖虚线到顶。
// 时间 → x 走 draw/coords 的 timeToX：两根 K 线之间按比例插值，最新 K 线右侧的未来时间外推，
// 所以下周的数据也能标在右边空白区。只在可见宽度内的事件参与聚簇和绘制。
// Econ event markers: a row of round badges along the bottom of the main pane (just above the
// time axis), one per cluster of events that land on the same spot. Colour = the highest
// importance in the cluster: 3 = red, 2 = amber (the calendar's impact colours); not yet released
// = hollow; more than one event = a count inside; the hovered (or tapped) cluster gets a dashed
// guide up to the top. Time → x goes through draw/coords' timeToX: interpolated between bars and
// extrapolated past the last bar, so next week's releases sit in the right-hand whitespace. Only
// events within the visible width are clustered and drawn.
import type { CanvasRenderingTarget2D } from 'fancy-canvas'
import type {
  IChartApi, IPrimitivePaneRenderer, IPrimitivePaneView, ISeriesPrimitive, PrimitiveHoveredItem, PrimitivePaneViewZOrder, Time,
} from 'lightweight-charts'
import { timeToX } from '../draw/coords'
import { clusterByX, clusterId, hitCluster, type Cluster, type EconEvent } from './econEvents'

// 影响色：与财经日历（styles/econ.css 的 --ec-imp-h / --ec-imp-m，Forex Factory 三色）一致
// Impact colours: the calendar's (--ec-imp-h / --ec-imp-m in styles/econ.css, Forex Factory's)
export const ECON_IMP_COLORS: Record<number, string> = { 3: '#e8322b', 2: '#f7941d', 1: '#f5d90a' }
export const impColor = (n: number) => ECON_IMP_COLORS[Math.max(1, Math.min(3, n))]

export const BADGE_R = 7
export const BADGE_GAP = BADGE_R * 2 + 3
// 徽章下边离窗格底边的距离 / gap between the badge and the pane's bottom edge
export const BADGE_BOTTOM = 5

export interface DrawnCluster {
  id: string
  x: number
  cluster: Cluster<EconEvent>
  importance: number
  upcoming: boolean
}

class Renderer implements IPrimitivePaneRenderer {
  constructor(private src: EconEventsPrimitive) {}
  draw(target: CanvasRenderingTarget2D) {
    const src = this.src
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      src.paneHeight = mediaSize.height
      const list = src.drawn
      if (list.length === 0) return
      const cy = src.centerY()
      ctx.save()
      ctx.font = `600 9px system-ui, -apple-system, "Segoe UI", sans-serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      for (const d of list) {
        const col = impColor(d.importance)
        const hov = d.id === src.hovered
        if (hov) {
          ctx.save()
          ctx.strokeStyle = col
          ctx.globalAlpha = 0.75
          ctx.lineWidth = 1
          ctx.setLineDash([4, 3])
          ctx.beginPath()
          const x = Math.round(d.x) + 0.5
          ctx.moveTo(x, 0)
          ctx.lineTo(x, cy - BADGE_R - 2)
          ctx.stroke()
          ctx.restore()
        }
        const r = hov ? BADGE_R + 1 : BADGE_R
        ctx.beginPath()
        ctx.arc(d.x, cy, r, 0, Math.PI * 2)
        if (d.upcoming) {
          // 未公布：空心（底色填充挡住后面的 K 线）/ upcoming: hollow, bg-filled so candles don't show through
          ctx.fillStyle = src.bg
          ctx.fill()
          ctx.lineWidth = 1.5
          ctx.strokeStyle = col
          ctx.stroke()
        } else {
          ctx.fillStyle = col
          ctx.fill()
          ctx.lineWidth = 1
          ctx.strokeStyle = src.bg
          ctx.stroke()
        }
        const n = d.cluster.items.length
        if (n > 1) {
          ctx.fillStyle = d.upcoming ? col : '#fff'
          ctx.fillText(n > 9 ? '9+' : String(n), d.x, cy + 0.5)
        } else {
          // 单个事件：圆心一个小点 / a single event: a small centre dot
          ctx.beginPath()
          ctx.arc(d.x, cy, 1.6, 0, Math.PI * 2)
          ctx.fillStyle = d.upcoming ? col : '#fff'
          ctx.fill()
        }
      }
      ctx.restore()
    })
  }
}

class View implements IPrimitivePaneView {
  private r: Renderer
  constructor(src: EconEventsPrimitive) { this.r = new Renderer(src) }
  zOrder(): PrimitivePaneViewZOrder { return 'top' }
  renderer() { return this.r }
}

export class EconEventsPrimitive implements ISeriesPrimitive<Time> {
  private chart: IChartApi | null = null
  private requestUpdate: (() => void) | null = null
  private views: View[] = [new View(this)]
  private events: EconEvent[] = []
  private nowSec = Date.now() / 1000
  drawn: DrawnCluster[] = []
  hovered: string | null = null
  paneHeight = 0
  bg = '#09090b'

  attached(p: { chart: IChartApi; series: unknown; requestUpdate: () => void }) {
    this.chart = p.chart
    this.requestUpdate = p.requestUpdate
  }
  detached() { this.chart = null; this.requestUpdate = null; this.drawn = [] }
  paneViews() { return this.events.length ? this.views : [] }

  setEvents(events: EconEvent[], nowMs: number) {
    this.events = events
    this.nowSec = nowMs / 1000
    this.recompute()
    this.requestUpdate?.()
  }
  setHovered(id: string | null) {
    if (id === this.hovered) return
    this.hovered = id
    this.requestUpdate?.()
  }
  setBg(bg: string) {
    if (bg === this.bg) return
    this.bg = bg
    this.requestUpdate?.()
  }

  centerY(): number { return this.paneHeight - BADGE_BOTTOM - BADGE_R }

  // 每次重绘前图表库都会调；坐标跟着缩放 / 平移重算 / called before every redraw; follows zoom / pan
  updateAllViews() { this.recompute() }

  private recompute() {
    const chart = this.chart
    if (!chart || this.events.length === 0) { this.drawn = []; return }
    const w = chart.timeScale().width()
    const pts: { x: number; item: EconEvent }[] = []
    for (const e of this.events) {
      const x = timeToX(chart, e.t)
      if (x == null || x < -BADGE_R || x > w + BADGE_R) continue
      pts.push({ x, item: e })
    }
    this.drawn = clusterByX(pts, BADGE_GAP).map((c) => ({
      id: clusterId(c),
      x: c.x,
      cluster: c,
      importance: c.items.reduce((m, e) => Math.max(m, e.importance), 0),
      // 簇里全部都还没到点才算「即将公布」/ upcoming only when every member is still ahead
      upcoming: c.items.every((e) => e.t > this.nowSec && !hasActual(e)),
    }))
  }

  /** (x, y) 处的簇（窗格坐标；r = 命中半径，触屏给大一点）/ cluster at (x, y) in pane coords; r = hit radius */
  hitAt(x: number, y: number, r = BADGE_R + 3): DrawnCluster | null {
    if (this.paneHeight <= 0) return null
    const i = hitCluster(this.drawn.map((d) => d.x), this.centerY(), x, y, r)
    return i >= 0 ? this.drawn[i] : null
  }

  hitTest(x: number, y: number): PrimitiveHoveredItem | null {
    const d = this.hitAt(x, y)
    if (!d) return null
    return { externalId: `econ:${d.id}`, zOrder: 'top', cursorStyle: 'pointer', hitTestPriority: 2, distance: Math.abs(d.x - x) }
  }
}

function hasActual(e: EconEvent): boolean {
  return e.group.status === 'published' || e.group.values.some((v) => v.actual !== null && v.actual !== undefined && v.actual !== '')
}
