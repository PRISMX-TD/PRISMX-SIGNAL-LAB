// 主图 K 线序列：一个 lightweight-charts 自定义序列，按 style 选项画出全部图表类型
// （蜡烛、空心蜡烛、美国线、折线、带点折线、阶梯线、面积、高低收面积、基准线、柱状、
// 高低图、成交量蜡烛、砖形、新价线、卡吉、点数图）。
// 为什么不按类型换内置序列：画线、持仓线、倒计时、指标区域、信号标记都挂在主序列上，
// 换序列要把这些全部拆下重挂；一个常驻的自定义序列换类型只是 applyOptions。
// 数据字段沿用 open/high/low/close，库自带的信号标记插件据此找 K 线高低点。
// Main price series: one lightweight-charts custom series that draws every chart type
// through its `style` option. Swapping built-in series per type would mean detaching and
// re-attaching drawings, position lines, the countdown, indicator zones and markers; with
// one permanent custom series a type change is just applyOptions. Data keeps the
// open/high/low/close field names so the built-in markers plugin finds bar highs/lows.
import type {
  CustomData,
  CustomSeriesOptions,
  CustomSeriesPricePlotValues,
  CustomSeriesWhitespaceData,
  ICustomSeriesPaneRenderer,
  ICustomSeriesPaneView,
  PaneRendererCustomData,
  PriceToCoordinateConverter,
  Time,
  UTCTimestamp,
} from 'lightweight-charts'
import { customSeriesDefaultOptions } from 'lightweight-charts'
import type { CanvasRenderingTarget2D, BitmapCoordinatesRenderingScope } from 'fancy-canvas'

export type MainStyle =
  | 'candles' | 'hollow' | 'bars' | 'line' | 'lineMarkers' | 'step' | 'area' | 'hlcArea'
  | 'baseline' | 'columns' | 'highLow' | 'volumeCandles'
  | 'renko' | 'lineBreak' | 'kagi' | 'pnf'

export interface MainBar extends CustomData<Time> {
  time: UTCTimestamp
  open: number
  high: number
  low: number
  close: number
  volume?: number
  dir?: 1 | -1
  thick?: boolean
  box?: number
  boxes?: number
}

export interface MainSeriesOptions extends CustomSeriesOptions {
  style: MainStyle
  upColor: string
  downColor: string
  wickUpColor: string
  wickDownColor: string
  borderUpColor: string
  borderDownColor: string
  bodyVisible: boolean
  borderVisible: boolean
  wickVisible: boolean
  lineColor: string
  lineWidth: number
  // 面积图上下沿颜色 / area gradient top & bottom
  areaTopColor: string
  areaBottomColor: string
  // 基准线：基准价位于可见价格区间的百分比（0–100，默认 50）
  // Baseline: base level as a percentage of the visible price range (0–100, default 50)
  baseLevelPct: number
}

// 以「收盘价」定标的类型：自动缩放只看收盘价，和 TradingView 一致。
// Close-scaled styles: auto-scale uses closes only, matching TradingView.
const CLOSE_ONLY: ReadonlySet<MainStyle> = new Set(['line', 'lineMarkers', 'step', 'area', 'baseline', 'columns'])
export function isCloseOnlyStyle(s: MainStyle): boolean {
  return CLOSE_ONLY.has(s)
}

export const MAIN_SERIES_DEFAULTS: MainSeriesOptions = {
  ...customSeriesDefaultOptions,
  style: 'candles',
  upColor: '#089981',
  downColor: '#F23645',
  wickUpColor: '#089981',
  wickDownColor: '#F23645',
  borderUpColor: '#089981',
  borderDownColor: '#F23645',
  bodyVisible: true,
  borderVisible: false,
  wickVisible: true,
  lineColor: '#2962FF',
  lineWidth: 2,
  areaTopColor: 'rgba(41, 98, 255, 0.28)',
  areaBottomColor: 'rgba(41, 98, 255, 0.02)',
  baseLevelPct: 50,
} as MainSeriesOptions

// lightweight-charts 自己的蜡烛宽度算法（来自库的 plugin-examples），宽度随间距收窄，
// 和内置蜡烛图完全同宽。/ The library's own candle-width rule (from its plugin
// examples), so custom candles are exactly as wide as the built-in ones.
function optimalCandleWidth(barSpacing: number, pixelRatio: number): number {
  const from = 2.5
  const to = 4
  if (barSpacing >= from && barSpacing <= to) return Math.floor(3 * pixelRatio)
  const coeff = 1 - (0.2 * Math.atan(Math.max(to, barSpacing) - to)) / (Math.PI * 0.5)
  const res = Math.floor(barSpacing * coeff * pixelRatio)
  const scaled = Math.floor(barSpacing * pixelRatio)
  return Math.max(Math.floor(pixelRatio), Math.min(res, scaled))
}

// 让实体宽度与影线宽度奇偶一致，影线才能落在正中。/ Match parity so the wick sits centred.
function alignWidth(body: number, wick: number): number {
  return (body - wick) % 2 === 0 ? body : body - 1
}

interface Px { x: number; o: number; h: number; l: number; c: number; bar: MainBar; prevClose: number | null }

class MainRenderer implements ICustomSeriesPaneRenderer {
  data: PaneRendererCustomData<Time, MainBar> | null = null
  opts: MainSeriesOptions = MAIN_SERIES_DEFAULTS

  draw(target: CanvasRenderingTarget2D, priceToCoordinate: PriceToCoordinateConverter): void {
    target.useBitmapCoordinateSpace((scope) => this.drawImpl(scope, priceToCoordinate))
  }

  private drawImpl(scope: BitmapCoordinatesRenderingScope, p2c: PriceToCoordinateConverter) {
    const d = this.data
    if (!d || d.bars.length === 0 || d.visibleRange === null) return
    const o = this.opts
    const hr = scope.horizontalPixelRatio
    const vr = scope.verticalPixelRatio
    // 可见区间两侧各多画一根，平移时边缘不闪。/ One extra bar each side so edges don't flicker.
    const from = Math.max(0, d.visibleRange.from - 1)
    const to = Math.min(d.bars.length, d.visibleRange.to + 1)
    const pts: Px[] = []
    for (let i = from; i < to; i++) {
      const b = d.bars[i]
      const bar = b.originalData
      if (!bar || bar.close === undefined) continue
      const oy = p2c(bar.open)
      const hy = p2c(bar.high)
      const ly = p2c(bar.low)
      const cy = p2c(bar.close)
      if (oy == null || hy == null || ly == null || cy == null) continue
      const prev = i > 0 ? d.bars[i - 1]?.originalData : undefined
      pts.push({ x: b.x * hr, o: oy * vr, h: hy * vr, l: ly * vr, c: cy * vr, bar, prevClose: prev && prev.close !== undefined ? prev.close : null })
    }
    if (pts.length === 0) return
    const ctx = scope.context
    const spacing = d.barSpacing * (d.conflationFactor || 1)
    switch (o.style) {
      case 'candles': return this.candles(ctx, pts, spacing, hr, vr, false)
      case 'hollow': return this.candles(ctx, pts, spacing, hr, vr, true)
      case 'volumeCandles': return this.volumeCandles(ctx, pts, spacing, hr, vr)
      case 'bars': return this.ohlcBars(ctx, pts, spacing, hr, vr)
      case 'line': return this.line(ctx, pts, hr, false, false)
      case 'lineMarkers': return this.line(ctx, pts, hr, true, false)
      case 'step': return this.line(ctx, pts, hr, false, true)
      case 'area': return this.area(ctx, pts, hr, scope.bitmapSize.height)
      case 'hlcArea': return this.hlcArea(ctx, pts, hr)
      case 'baseline': return this.baseline(ctx, pts, hr, scope.bitmapSize.height)
      case 'columns': return this.columns(ctx, pts, spacing, hr, scope.bitmapSize.height)
      case 'highLow': return this.highLow(ctx, pts, spacing, hr, vr)
      case 'renko':
      case 'lineBreak': return this.boxes(ctx, pts, spacing, hr, vr)
      case 'kagi': return this.kagi(ctx, pts, hr)
      case 'pnf': return this.pnf(ctx, pts, spacing, hr, vr, p2c)
    }
  }

  private isUp(p: Px): boolean {
    if (p.bar.dir != null) return p.bar.dir > 0
    return p.bar.close >= p.bar.open
  }

  private candles(ctx: CanvasRenderingContext2D, pts: Px[], spacing: number, hr: number, vr: number, hollow: boolean) {
    const o = this.opts
    const wickW = Math.max(1, Math.floor(hr))
    const bodyW = alignWidth(optimalCandleWidth(spacing, hr), wickW)
    const minH = Math.max(1, Math.floor(vr))
    for (const p of pts) {
      // 空心蜡烛：颜色看收盘对前收，空心 / 实心看收盘对开盘（TradingView 规则）。
      // Hollow candles: colour = close vs previous close, hollow/filled = close vs open.
      const up = hollow ? (p.prevClose == null ? p.bar.close >= p.bar.open : p.bar.close >= p.prevClose) : this.isUp(p)
      const color = up ? o.upColor : o.downColor
      const x = Math.round(p.x)
      if (o.wickVisible) {
        ctx.fillStyle = up ? o.wickUpColor : o.wickDownColor
        if (hollow) ctx.fillStyle = color
        const top = Math.round(Math.min(p.h, p.l))
        const bottom = Math.round(Math.max(p.h, p.l))
        ctx.fillRect(x - Math.floor(wickW / 2), top, wickW, Math.max(minH, bottom - top))
      }
      const top = Math.round(Math.min(p.o, p.c))
      const h = Math.max(minH, Math.round(Math.max(p.o, p.c)) - top)
      const left = x - Math.floor(bodyW / 2)
      const filled = hollow ? p.bar.close < p.bar.open : true
      if (filled && o.bodyVisible) {
        ctx.fillStyle = color
        ctx.fillRect(left, top, bodyW, h)
      }
      if ((o.borderVisible && !hollow) || (hollow && !filled)) {
        const bw = Math.max(1, Math.floor(hr))
        ctx.fillStyle = hollow ? color : up ? o.borderUpColor : o.borderDownColor
        if (bodyW <= 2 * bw) { ctx.fillRect(left, top, bodyW, h); continue }
        ctx.fillRect(left, top, bodyW, bw)
        ctx.fillRect(left, top + h - bw, bodyW, bw)
        ctx.fillRect(left, top, bw, h)
        ctx.fillRect(left + bodyW - bw, top, bw, h)
      }
    }
  }

  private volumeCandles(ctx: CanvasRenderingContext2D, pts: Px[], spacing: number, hr: number, vr: number) {
    const o = this.opts
    let maxV = 0
    for (const p of pts) maxV = Math.max(maxV, p.bar.volume ?? 0)
    const full = optimalCandleWidth(spacing, hr)
    const wickW = Math.max(1, Math.floor(hr))
    const minH = Math.max(1, Math.floor(vr))
    for (const p of pts) {
      const up = this.isUp(p)
      const ratio = maxV > 0 ? Math.max(0.15, (p.bar.volume ?? 0) / maxV) : 1
      const bodyW = alignWidth(Math.max(wickW, Math.round(full * ratio)), wickW)
      const x = Math.round(p.x)
      ctx.fillStyle = up ? o.upColor : o.downColor
      const wt = Math.round(Math.min(p.h, p.l))
      ctx.fillRect(x - Math.floor(wickW / 2), wt, wickW, Math.max(minH, Math.round(Math.max(p.h, p.l)) - wt))
      const top = Math.round(Math.min(p.o, p.c))
      ctx.fillRect(x - Math.floor(bodyW / 2), top, bodyW, Math.max(minH, Math.round(Math.max(p.o, p.c)) - top))
    }
  }

  private ohlcBars(ctx: CanvasRenderingContext2D, pts: Px[], spacing: number, hr: number, vr: number) {
    const o = this.opts
    const lineW = Math.max(1, Math.floor(hr * (spacing > 12 ? 2 : 1)))
    const tick = Math.max(lineW, Math.floor(optimalCandleWidth(spacing, hr) / 2))
    const minH = Math.max(1, Math.floor(vr))
    for (const p of pts) {
      ctx.fillStyle = this.isUp(p) ? o.upColor : o.downColor
      const x = Math.round(p.x) - Math.floor(lineW / 2)
      const top = Math.round(Math.min(p.h, p.l))
      ctx.fillRect(x, top, lineW, Math.max(minH, Math.round(Math.max(p.h, p.l)) - top))
      ctx.fillRect(x - tick, Math.round(p.o) - Math.floor(lineW / 2), tick, lineW)
      ctx.fillRect(x + lineW, Math.round(p.c) - Math.floor(lineW / 2), tick, lineW)
    }
  }

  private path(ctx: CanvasRenderingContext2D, pts: Px[], step: boolean, key: 'c' | 'h' | 'l' = 'c') {
    ctx.beginPath()
    pts.forEach((p, i) => {
      if (i === 0) ctx.moveTo(p.x, p[key])
      else if (step) { ctx.lineTo(p.x, pts[i - 1][key]); ctx.lineTo(p.x, p[key]) } else ctx.lineTo(p.x, p[key])
    })
  }

  private line(ctx: CanvasRenderingContext2D, pts: Px[], hr: number, markers: boolean, step: boolean) {
    const o = this.opts
    ctx.lineWidth = o.lineWidth * hr
    ctx.lineJoin = 'round'
    ctx.lineCap = 'round'
    ctx.strokeStyle = o.lineColor
    this.path(ctx, pts, step)
    ctx.stroke()
    if (markers) {
      ctx.fillStyle = o.lineColor
      const r = Math.max(1.5, o.lineWidth * 1.3) * hr
      for (const p of pts) { ctx.beginPath(); ctx.arc(p.x, p.c, r, 0, Math.PI * 2); ctx.fill() }
    }
  }

  private area(ctx: CanvasRenderingContext2D, pts: Px[], hr: number, height: number) {
    const o = this.opts
    const top = Math.min(...pts.map((p) => p.c))
    const grad = ctx.createLinearGradient(0, top, 0, height)
    grad.addColorStop(0, o.areaTopColor)
    grad.addColorStop(1, o.areaBottomColor)
    this.path(ctx, pts, false)
    ctx.lineTo(pts[pts.length - 1].x, height)
    ctx.lineTo(pts[0].x, height)
    ctx.closePath()
    ctx.fillStyle = grad
    ctx.fill()
    this.line(ctx, pts, hr, false, false)
  }

  private hlcArea(ctx: CanvasRenderingContext2D, pts: Px[], hr: number) {
    const o = this.opts
    const band = (key: 'h' | 'l', color: string) => {
      ctx.beginPath()
      pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p[key]) : ctx.lineTo(p.x, p[key])))
      for (let i = pts.length - 1; i >= 0; i--) ctx.lineTo(pts[i].x, pts[i].c)
      ctx.closePath()
      ctx.fillStyle = color
      ctx.fill()
    }
    band('h', withAlpha(o.upColor, 0.18))
    band('l', withAlpha(o.downColor, 0.18))
    ctx.lineWidth = Math.max(1, hr)
    ctx.strokeStyle = o.upColor
    this.path(ctx, pts, false, 'h'); ctx.stroke()
    ctx.strokeStyle = o.downColor
    this.path(ctx, pts, false, 'l'); ctx.stroke()
    ctx.lineWidth = o.lineWidth * hr
    ctx.strokeStyle = o.lineColor
    this.path(ctx, pts, false, 'c'); ctx.stroke()
  }

  private baseline(ctx: CanvasRenderingContext2D, pts: Px[], hr: number, height: number) {
    const o = this.opts
    let min = Infinity
    let max = -Infinity
    for (const p of pts) { min = Math.min(min, p.c); max = Math.max(max, p.c) }
    // 坐标轴 y 向下增大：pct=50 落在可见收盘区间正中。/ y grows downward; 50 = middle of the visible closes.
    const baseY = max - ((max - min) * o.baseLevelPct) / 100
    const fillSide = (clipTop: number, clipBottom: number, color: string, line: string) => {
      ctx.save()
      ctx.beginPath()
      ctx.rect(0, clipTop, ctx.canvas.width, clipBottom - clipTop)
      ctx.clip()
      this.path(ctx, pts, false)
      ctx.lineTo(pts[pts.length - 1].x, baseY)
      ctx.lineTo(pts[0].x, baseY)
      ctx.closePath()
      ctx.fillStyle = color
      ctx.fill()
      ctx.lineWidth = o.lineWidth * hr
      ctx.strokeStyle = line
      this.path(ctx, pts, false)
      ctx.stroke()
      ctx.restore()
    }
    fillSide(0, baseY, withAlpha(o.upColor, 0.22), o.upColor)
    fillSide(baseY, height, withAlpha(o.downColor, 0.22), o.downColor)
    ctx.setLineDash([4 * hr, 4 * hr])
    ctx.lineWidth = Math.max(1, hr)
    ctx.strokeStyle = 'rgba(148,163,184,0.6)'
    ctx.beginPath(); ctx.moveTo(pts[0].x, baseY); ctx.lineTo(pts[pts.length - 1].x, baseY); ctx.stroke()
    ctx.setLineDash([])
  }

  private columns(ctx: CanvasRenderingContext2D, pts: Px[], spacing: number, hr: number, height: number) {
    const o = this.opts
    const w = Math.max(1, optimalCandleWidth(spacing, hr))
    for (const p of pts) {
      const up = p.prevClose == null ? p.bar.close >= p.bar.open : p.bar.close >= p.prevClose
      ctx.fillStyle = withAlpha(up ? o.upColor : o.downColor, 0.65)
      const top = Math.round(p.c)
      ctx.fillRect(Math.round(p.x) - Math.floor(w / 2), top, w, height - top)
    }
  }

  private highLow(ctx: CanvasRenderingContext2D, pts: Px[], spacing: number, hr: number, vr: number) {
    const o = this.opts
    const w = Math.max(1, optimalCandleWidth(spacing, hr))
    ctx.fillStyle = o.lineColor
    for (const p of pts) {
      const top = Math.round(Math.min(p.h, p.l))
      ctx.fillRect(Math.round(p.x) - Math.floor(w / 2), top, w, Math.max(Math.floor(vr), Math.round(Math.max(p.h, p.l)) - top))
    }
  }

  private boxes(ctx: CanvasRenderingContext2D, pts: Px[], spacing: number, hr: number, vr: number) {
    const o = this.opts
    const w = Math.max(1, Math.floor(spacing * hr * 0.9))
    const wickW = Math.max(1, Math.floor(hr))
    for (const p of pts) {
      const up = this.isUp(p)
      const color = up ? o.upColor : o.downColor
      const x = Math.round(p.x)
      if (o.wickVisible && (p.h < Math.min(p.o, p.c) - 1 || p.l > Math.max(p.o, p.c) + 1)) {
        ctx.fillStyle = color
        const t = Math.round(Math.min(p.h, p.l))
        ctx.fillRect(x - Math.floor(wickW / 2), t, wickW, Math.round(Math.max(p.h, p.l)) - t)
      }
      const top = Math.round(Math.min(p.o, p.c))
      const h = Math.max(Math.floor(vr), Math.round(Math.max(p.o, p.c)) - top)
      ctx.fillStyle = color
      ctx.fillRect(x - Math.floor(w / 2), top, w, h)
    }
  }

  private kagi(ctx: CanvasRenderingContext2D, pts: Px[], hr: number) {
    const o = this.opts
    ctx.lineCap = 'square'
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i]
      const prev = i > 0 ? pts[i - 1] : null
      const thick = p.bar.thick !== false
      ctx.lineWidth = (thick ? 2.5 : 1) * hr
      ctx.strokeStyle = thick ? o.upColor : o.downColor
      ctx.beginPath()
      // 水平肩 / 腰：从上一条竖线走到这一条。/ Horizontal shoulder/waist from the previous line.
      if (prev) { ctx.moveTo(prev.x, p.o); ctx.lineTo(p.x, p.o) } else ctx.moveTo(p.x, p.o)
      ctx.lineTo(p.x, p.c)
      ctx.stroke()
    }
  }

  private pnf(ctx: CanvasRenderingContext2D, pts: Px[], spacing: number, hr: number, vr: number, p2c: PriceToCoordinateConverter) {
    const o = this.opts
    const w = Math.max(2, spacing * hr * 0.8)
    ctx.lineWidth = Math.max(1, hr * 1.4)
    for (const p of pts) {
      const box = p.bar.box ?? 0
      const n = p.bar.boxes ?? 0
      if (!(box > 0) || n <= 0) continue
      const up = (p.bar.dir ?? 1) > 0
      ctx.strokeStyle = up ? o.upColor : o.downColor
      // 每个 X / O 落在一个格位上，上下各占半格（barTransforms 的约定）。
      // Each X / O sits on a grid level and spans half a box either side (barTransforms' convention).
      const lo = Math.min(p.bar.open, p.bar.close)
      for (let k = 0; k < n; k++) {
        const y1 = p2c(lo + k * box - box / 2)
        const y2 = p2c(lo + k * box + box / 2)
        if (y1 == null || y2 == null) continue
        const top = Math.min(y1, y2) * vr
        const h = Math.abs(y2 - y1) * vr
        const pad = Math.min(h, w) * 0.12
        ctx.beginPath()
        if (up) {
          ctx.moveTo(p.x - w / 2 + pad, top + pad); ctx.lineTo(p.x + w / 2 - pad, top + h - pad)
          ctx.moveTo(p.x + w / 2 - pad, top + pad); ctx.lineTo(p.x - w / 2 + pad, top + h - pad)
        } else {
          ctx.ellipse(p.x, top + h / 2, Math.max(1, w / 2 - pad), Math.max(1, h / 2 - pad), 0, 0, Math.PI * 2)
        }
        ctx.stroke()
      }
    }
  }
}

// #rrggbb / rgba(...) → 指定透明度 / apply an alpha to a hex or rgb(a) colour
export function withAlpha(color: string, alpha: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(color)
  if (m) {
    const n = parseInt(m[1], 16)
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`
  }
  const r = /^rgba?\(([^)]+)\)$/i.exec(color)
  if (r) {
    const parts = r[1].split(',').map((s) => s.trim())
    return `rgba(${parts[0]}, ${parts[1]}, ${parts[2]}, ${alpha})`
  }
  return color
}

export class MainSeriesView implements ICustomSeriesPaneView<Time, MainBar, MainSeriesOptions> {
  private readonly r = new MainRenderer()
  // 自动缩放口径：折线类只看收盘，其余看高低。由引擎在 setData 之前设置。
  // Auto-scale basis: close-only for line-like styles, high/low otherwise. Set by the engine before setData.
  closeOnly = false

  renderer(): ICustomSeriesPaneRenderer {
    return this.r
  }

  update(data: PaneRendererCustomData<Time, MainBar>, options: MainSeriesOptions): void {
    this.r.data = data
    this.r.opts = options
  }

  priceValueBuilder(row: MainBar): CustomSeriesPricePlotValues {
    if (this.closeOnly) return [row.close]
    return [row.low, row.high, row.close]
  }

  isWhitespace(data: MainBar | CustomSeriesWhitespaceData<Time>): data is CustomSeriesWhitespaceData<Time> {
    return (data as Partial<MainBar>).close === undefined
  }

  defaultOptions(): MainSeriesOptions {
    return MAIN_SERIES_DEFAULTS
  }
}
