// 指标区域矩形（看盘神器的压力 / 支撑墙）：挂在 K 线 series 上的 ISeriesPrimitive，
// 每块从起点 K 线一直画到最新一根，半透明填充 + 实色边框 + 右侧价格标。
// Indicator zone rectangles (看盘神器 resistance/support walls): an
// ISeriesPrimitive on the candle series; each zone spans from its start bar to
// the latest bar, translucent fill + solid edge + a price tag on the right.
import type {
  IChartApi, ISeriesApi, IPrimitivePaneRenderer, IPrimitivePaneView, SeriesAttachedParameter, SeriesType, Time, UTCTimestamp,
} from 'lightweight-charts'

export interface ZoneRect {
  from: UTCTimestamp
  to: UTCTimestamp
  top: number
  bottom: number
  color: string
}

type Target = Parameters<IPrimitivePaneRenderer['draw']>[0]

function withAlpha(hex: string, a: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex)
  if (!m) return hex
  const n = parseInt(m[1], 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`
}

export class ZonePrimitive {
  zones: ZoneRect[] = []
  private chart: IChartApi | null = null
  private series: ISeriesApi<SeriesType> | null = null
  private ru: (() => void) | null = null
  private view: IPrimitivePaneView

  constructor() {
    const renderer: IPrimitivePaneRenderer = { draw: (t: Target) => this.draw(t) }
    this.view = { renderer: () => renderer, zOrder: () => 'bottom' }
  }

  attached(p: SeriesAttachedParameter<Time>) {
    this.chart = p.chart
    this.series = p.series
    this.ru = p.requestUpdate
  }
  detached() { this.chart = null; this.series = null; this.ru = null }
  paneViews(): readonly IPrimitivePaneView[] { return [this.view] }
  updateAllViews() { /* renderer reads live state */ }

  setZones(z: ZoneRect[]) {
    this.zones = z
    this.ru?.()
  }

  private draw(target: Target) {
    const chart = this.chart
    const series = this.series
    if (!chart || !series || this.zones.length === 0) return
    const ts = chart.timeScale()
    target.useBitmapCoordinateSpace(({ context: ctx, horizontalPixelRatio: hr, verticalPixelRatio: vr, bitmapSize }) => {
      for (const z of this.zones) {
        const x1 = ts.timeToCoordinate(z.from as Time)
        const x2 = ts.timeToCoordinate(z.to as Time)
        const y1 = series.priceToCoordinate(z.top)
        const y2 = series.priceToCoordinate(z.bottom)
        if (y1 == null || y2 == null) continue
        // 起点在可视范围左侧之外时 timeToCoordinate 可能为空，按左边缘画 / clamp to the left edge
        const left = Math.round((x1 ?? 0) * hr)
        const right = x2 == null ? bitmapSize.width : Math.round(x2 * hr)
        if (right <= left) continue
        const top = Math.round(Math.min(y1, y2) * vr)
        const h = Math.max(1, Math.round(Math.abs(y2 - y1) * vr))
        ctx.fillStyle = withAlpha(z.color, 0.22)
        ctx.fillRect(left, top, right - left, h)
        ctx.strokeStyle = z.color
        ctx.lineWidth = Math.max(1, Math.round(hr))
        ctx.strokeRect(left + 0.5, top + 0.5, right - left - 1, h - 1)
      }
    })
  }
}
