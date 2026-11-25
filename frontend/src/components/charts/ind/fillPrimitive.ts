// 指标的填充层：两条线之间填色（布林带、一目云图，a < b 换色）、两条水平线之间的带（RSI 30–70）、
// 整列背景色（交易时段）。每个实例一个，挂在它的第一条 series 上，用那条 series 的价格坐标；
// 只画可见范围内的点，同色的块合成一条 path 一次填充。
// Indicator fill layer: fills between two plots (Bollinger, Ichimoku cloud with a second colour
// where a < b), bands between two hlines (RSI 30–70) and full-height column backgrounds
// (sessions). One per instance, attached to its first series and using that series' price
// coordinates; only visible points are drawn and same-colour pieces are filled as one path.
import type {
  IChartApi, ISeriesApi, IPrimitivePaneRenderer, IPrimitivePaneView, SeriesAttachedParameter, SeriesType, Time,
} from 'lightweight-charts'

export interface FillBetween {
  t: number[]
  a: (number | null)[]
  b: (number | null)[]
  color: string
  colorB: string
}
export interface FillBand { a: number; b: number; color: string }
export interface BgColumns { t: number[]; color: (string | null)[] }

type Target = Parameters<IPrimitivePaneRenderer['draw']>[0]

function lowerBound(arr: number[], x: number): number {
  let lo = 0
  let hi = arr.length
  while (lo < hi) {
    const m = (lo + hi) >> 1
    if (arr[m] < x) lo = m + 1
    else hi = m
  }
  return lo
}

export class IndFillPrimitive {
  fills: FillBetween[] = []
  bands: FillBand[] = []
  bg: BgColumns | null = null
  hidden = false
  private chart: IChartApi | null = null
  private series: ISeriesApi<SeriesType> | null = null
  private ru: (() => void) | null = null
  private view: IPrimitivePaneView

  constructor() {
    const renderer: IPrimitivePaneRenderer = { draw: () => {}, drawBackground: (t: Target) => this.draw(t) }
    this.view = { renderer: () => renderer, zOrder: () => 'bottom' }
  }

  attached(p: SeriesAttachedParameter<Time>) { this.chart = p.chart; this.series = p.series; this.ru = p.requestUpdate }
  detached() { this.chart = null; this.series = null; this.ru = null }
  paneViews(): readonly IPrimitivePaneView[] { return [this.view] }
  updateAllViews() { /* renderer reads live state */ }

  set(fills: FillBetween[], bands: FillBand[], bg: BgColumns | null, hidden: boolean) {
    this.fills = fills
    this.bands = bands
    this.bg = bg
    this.hidden = hidden
    this.ru?.()
  }

  private draw(target: Target) {
    const chart = this.chart
    const series = this.series
    if (!chart || !series || this.hidden) return
    if (this.fills.length === 0 && this.bands.length === 0 && !this.bg) return
    const ts = chart.timeScale()
    const range = ts.getVisibleRange()
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      // 水平带 / hline bands
      for (const b of this.bands) {
        const y1 = series.priceToCoordinate(b.a)
        const y2 = series.priceToCoordinate(b.b)
        if (y1 == null || y2 == null) continue
        ctx.fillStyle = b.color
        ctx.fillRect(0, Math.min(y1, y2), mediaSize.width, Math.abs(y2 - y1))
      }
      if (!range) return
      const from = range.from as number
      const to = range.to as number
      const half = Math.max(0.5, ts.options().barSpacing / 2)
      // 背景列：相邻同色合并成一块 / background columns, adjacent same colours merged
      const bg = this.bg
      if (bg && bg.t.length) {
        const i0 = Math.max(0, lowerBound(bg.t, from) - 1)
        const i1 = Math.min(bg.t.length - 1, lowerBound(bg.t, to) + 1)
        let runColor: string | null = null
        let runX = 0
        let lastX = 0
        const flush = () => { if (runColor) { ctx.fillStyle = runColor; ctx.fillRect(runX, 0, lastX - runX, mediaSize.height) } }
        for (let i = i0; i <= i1; i++) {
          const x = ts.timeToCoordinate(bg.t[i] as Time)
          if (x == null) continue
          const c = bg.color[i]
          if (c !== runColor) { flush(); runColor = c; runX = x - half }
          lastX = x + half
        }
        flush()
      }
      // 线间填充 / fills between plots
      for (const f of this.fills) {
        const n = f.t.length
        if (n < 2) continue
        const i0 = Math.max(0, lowerBound(f.t, from) - 1)
        const i1 = Math.min(n - 1, lowerBound(f.t, to) + 1)
        const pA = new Path2D()
        const pB = new Path2D()
        let px: number | null = null
        let pa: number | null = null
        let pb: number | null = null
        for (let i = i0; i <= i1; i++) {
          const a = f.a[i]
          const b = f.b[i]
          const x = ts.timeToCoordinate(f.t[i] as Time)
          if (a == null || b == null || x == null) { px = null; continue }
          const ya = series.priceToCoordinate(a)
          const yb = series.priceToCoordinate(b)
          if (ya == null || yb == null) { px = null; continue }
          if (px != null && pa != null && pb != null) {
            const p = (f.a[i - 1] as number) >= (f.b[i - 1] as number) ? pA : pB
            p.moveTo(px, pa); p.lineTo(x, ya); p.lineTo(x, yb); p.lineTo(px, pb); p.closePath()
          }
          px = x; pa = ya; pb = yb
        }
        ctx.fillStyle = f.color
        ctx.fill(pA)
        ctx.fillStyle = f.colorB
        ctx.fill(pB)
      }
    })
  }
}
