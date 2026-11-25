// 交易日分隔线（设置 → 坐标与线 → 交易日分隔）：日内周期上，在每个券商交易日的第一根 K 线
// 左边画一条竖虚线。主序列上的 primitive，只遍历可见范围；日线及以上周期不画。
// Session breaks (Settings → Scales & lines): on intraday intervals, a dashed vertical line
// left of each broker trading day's first bar. A primitive on the main series that only walks
// the visible range; nothing on daily and longer intervals.
import type { CanvasRenderingTarget2D } from 'fancy-canvas'
import type {
  IChartApi, IPrimitivePaneRenderer, IPrimitivePaneView, ISeriesPrimitive, PrimitivePaneViewZOrder, Time,
} from 'lightweight-charts'
import { brokerOffsetSec } from './intervals'
import type { MainSeriesApi } from './useChartEngine'

const DAY = 86400
const brokerDay = (t: number) => Math.floor((t + brokerOffsetSec(t)) / DAY)

class Renderer implements IPrimitivePaneRenderer {
  constructor(private xs: number[], private color: string) {}
  draw(target: CanvasRenderingTarget2D) {
    target.useBitmapCoordinateSpace(({ context: ctx, horizontalPixelRatio: hr, bitmapSize }) => {
      ctx.save()
      ctx.strokeStyle = this.color
      ctx.lineWidth = Math.max(1, Math.floor(hr))
      ctx.setLineDash([4 * hr, 4 * hr])
      ctx.beginPath()
      for (const x of this.xs) {
        const px = Math.round(x * hr) + 0.5
        ctx.moveTo(px, 0)
        ctx.lineTo(px, bitmapSize.height)
      }
      ctx.stroke()
      ctx.restore()
    })
  }
}

class View implements IPrimitivePaneView {
  constructor(private src: SessionBreaks) {}
  zOrder(): PrimitivePaneViewZOrder { return 'bottom' }
  renderer() { return new Renderer(this.src.xs(), this.src.color) }
}

export class SessionBreaks implements ISeriesPrimitive<Time> {
  private chart: IChartApi | null = null
  private series: MainSeriesApi | null = null
  private views = [new View(this)]
  enabled = false
  color = 'rgba(148, 163, 184, 0.28)'

  attached(p: { chart: IChartApi; series: unknown; requestUpdate: () => void }) {
    this.chart = p.chart
    this.series = p.series as MainSeriesApi
  }
  detached() { this.chart = null; this.series = null }
  paneViews() { return this.enabled ? this.views : [] }

  xs(): number[] {
    const chart = this.chart
    const series = this.series
    if (!chart || !series) return []
    const r = chart.timeScale().getVisibleLogicalRange()
    const data = series.data()
    if (!r || data.length < 2) return []
    const from = Math.max(1, Math.floor(r.from))
    const to = Math.min(data.length - 1, Math.ceil(r.to))
    const out: number[] = []
    const ts = chart.timeScale()
    let prev = brokerDay(data[from - 1].time as number)
    for (let i = from; i <= to; i++) {
      const d = brokerDay(data[i].time as number)
      if (d !== prev) {
        // 两根之间的中点 / midway between the two bars
        const a = ts.logicalToCoordinate((i - 0.5) as never)
        if (a != null) out.push(a)
      }
      prev = d
    }
    return out
  }
}
