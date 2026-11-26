// 第三批指标的图形层：矩形（多周期箱体）、线段（形态轮廓、斐波那契）、文字标签、成交量分布（按时段 /
// 可见范围）、TPO、角落表格（区间表现）与半圆仪表（技术评级）。每个实例一个，挂在它的宿主 series 上，
// 用那条 series 的价格坐标；横坐标用 K 线下标（= 逻辑下标），所以价格类图表（砖形等）上不画。
// 颜色与文字已由引擎解析好。背景层（箱体、分布、TPO）画在 K 线下面，其余画在上面。
// Batch 3 shape layer: rectangles (HTF boxes), segments (pattern outlines, Fibonacci), labels,
// volume profiles (per session / visible range), TPO, a corner table (performance) and a
// half-circle gauge (technical rating). One per instance on its host series, using that series'
// price coordinates; x comes from bar index (= logical index), so price-based chart types skip it.
// Colours and texts arrive resolved from the engine. The back layer (boxes, profiles, TPO) sits
// under the candles, the rest on top.
import type {
  IChartApi, ISeriesApi, IPrimitivePaneRenderer, IPrimitivePaneView, SeriesAttachedParameter, SeriesType, Time,
} from 'lightweight-charts'
import type { Candle } from '../../../api/types'
import { volumeProfile, type Profile } from './math3'
import { countdownText } from './math4'
import type { IndExtras, LineDash } from './types'

export interface ShapeTheme { bg: string; text: string; border: string }
export interface ShapeScene {
  rects: NonNullable<IndExtras['rects']>
  segs: NonNullable<IndExtras['segs']>
  labels: NonNullable<IndExtras['labels']>
  profiles: NonNullable<IndExtras['profiles']>
  vp: (NonNullable<IndExtras['vpVisible']> & { bars: Candle[] }) | null
  tpos: NonNullable<IndExtras['tpos']>
  table: IndExtras['table'] | null
  gauge: IndExtras['gauge'] | null
  theme: ShapeTheme
}

export const EMPTY_SCENE: ShapeScene = {
  rects: [], segs: [], labels: [], profiles: [], vp: null, tpos: [], table: null, gauge: null,
  theme: { bg: '#09090b', text: '#e4e4e7', border: '#27272a' },
}

type Target = Parameters<IPrimitivePaneRenderer['draw']>[0]
type Ctx = CanvasRenderingContext2D
const FONT = '11px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif'
const MONO = '10px ui-monospace, "JetBrains Mono", Menlo, monospace'
const DASHES: Record<LineDash, number[]> = { solid: [], dashed: [6, 4], dotted: [1.5, 3] }
// TPO 时段字母：A–Z 再 a–z / TPO period letters: A–Z then a–z
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

function roundRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

export class IndShapePrimitive {
  scene: ShapeScene = EMPTY_SCENE
  private chart: IChartApi | null = null
  private series: ISeriesApi<SeriesType> | null = null
  private ru: (() => void) | null = null
  private back: IPrimitivePaneView
  private front: IPrimitivePaneView
  // 可见范围分布的缓存 / cache for the visible-range profile
  private vpKey = ''
  private vpProf: Profile | null = null
  // 有倒计时标签时每秒重画一次 / repaint every second while a countdown label is shown
  private tick: ReturnType<typeof setInterval> | null = null

  constructor() {
    const rb: IPrimitivePaneRenderer = { draw: () => {}, drawBackground: (t: Target) => this.drawBack(t) }
    const rf: IPrimitivePaneRenderer = { draw: (t: Target) => this.drawFront(t) }
    this.back = { renderer: () => rb, zOrder: () => 'bottom' }
    this.front = { renderer: () => rf, zOrder: () => 'top' }
  }

  attached(p: SeriesAttachedParameter<Time>) { this.chart = p.chart; this.series = p.series; this.ru = p.requestUpdate }
  detached() { this.chart = null; this.series = null; this.ru = null; this.ticker(false) }
  paneViews(): readonly IPrimitivePaneView[] { return [this.back, this.front] }
  updateAllViews() { /* renderers read live state */ }

  set(scene: ShapeScene) {
    this.scene = scene
    this.vpKey = ''
    this.ticker(scene.labels.some((l) => l.cd != null))
    this.ru?.()
  }

  private ticker(on: boolean) {
    if (on && !this.tick) this.tick = setInterval(() => this.ru?.(), 1000)
    else if (!on && this.tick) { clearInterval(this.tick); this.tick = null }
  }

  // K 线下标 → x；-1 = 右边缘 / bar index → x; -1 = right edge
  private x(i: number, width: number): number | null {
    if (i < 0) return width
    const v = this.chart?.timeScale().logicalToCoordinate(i as never)
    return v == null ? null : v
  }
  private y(p: number): number | null {
    const v = this.series?.priceToCoordinate(p)
    return v == null ? null : v
  }
  private half(): number {
    return Math.max(0.5, (this.chart?.timeScale().options().barSpacing ?? 6) / 2)
  }

  private drawBack(target: Target) {
    const s = this.scene
    if (!this.chart || !this.series) return
    if (!s.rects.some((r) => r.back) && s.profiles.length === 0 && !s.vp && s.tpos.length === 0) return
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      for (const r of s.rects) if (r.back) this.rect(ctx, r, mediaSize.width)
      for (const p of s.profiles) this.profile(ctx, p, p.p, mediaSize.width)
      if (s.vp) this.visibleProfile(ctx, s.vp, mediaSize.width)
      for (const t of s.tpos) this.tpo(ctx, t, mediaSize.width)
    })
  }

  private drawFront(target: Target) {
    const s = this.scene
    if (!this.chart || !this.series) return
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      for (const r of s.rects) if (!r.back) this.rect(ctx, r, mediaSize.width)
      for (const g of s.segs) this.seg(ctx, g, mediaSize.width)
      for (const l of s.labels) this.label(ctx, l, mediaSize.width)
      if (s.table) this.table(ctx, s.table, mediaSize.width, mediaSize.height)
      if (s.gauge) this.gauge(ctx, s.gauge, mediaSize.width)
    })
  }

  private rect(ctx: Ctx, r: ShapeScene['rects'][number], width: number) {
    const h = this.half()
    const x1 = this.x(r.i1, width)
    const x2 = this.x(r.i2, width)
    const y1 = this.y(r.top)
    const y2 = this.y(r.bottom)
    if (x1 == null || x2 == null || y1 == null || y2 == null) return
    const l = r.ctr ? x1 : x1 - h
    const w = (r.i2 < 0 || r.ctr ? x2 : x2 + h) - l
    if (w <= 0 || l > width || l + w < 0) return
    const t = Math.min(y1, y2)
    const hh = Math.max(1, Math.abs(y2 - y1))
    if (r.fill) { ctx.fillStyle = r.fill; ctx.fillRect(l, t, w, hh) }
    if (r.stroke) {
      ctx.strokeStyle = r.stroke
      ctx.lineWidth = 1
      ctx.setLineDash(DASHES[r.dash ?? 'solid'])
      ctx.strokeRect(Math.round(l) + 0.5, Math.round(t) + 0.5, Math.round(w) - 1, Math.round(hh) - 1)
      ctx.setLineDash([])
    }
  }

  private seg(ctx: Ctx, g: ShapeScene['segs'][number], width: number) {
    const x1 = this.x(g.i1, width)
    const x2 = this.x(g.i2, width)
    const y1 = this.y(g.p1)
    const y2 = this.y(g.p2)
    if (x1 == null || x2 == null || y1 == null || y2 == null) return
    ctx.strokeStyle = g.color
    ctx.lineWidth = g.width ?? 1
    ctx.setLineDash(DASHES[g.dash ?? 'solid'])
    ctx.beginPath()
    ctx.moveTo(x1, y1)
    ctx.lineTo(x2, y2)
    ctx.stroke()
    ctx.setLineDash([])
  }

  private label(ctx: Ctx, l: ShapeScene['labels'][number], width: number) {
    const x = this.x(l.i, width)
    const y = this.y(l.p)
    const lines = l.text ? l.text.split('\n') : []
    if (l.cd != null) lines.push(countdownText(l.cd - Date.now() / 1000))
    if (x == null || y == null || lines.length === 0) return
    const fs = l.size ?? 11
    ctx.font = l.size ? `${fs}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif` : FONT
    const tw = Math.max(...lines.map((s) => ctx.measureText(s).width))
    const padX = l.bg ? 5 : 0
    const bw = tw + padX * 2
    const lh = Math.round(fs * 1.35)
    const bh = Math.max(17, lines.length * lh + 2)
    const align = l.align ?? 'center'
    let bx = align === 'left' ? x + 4 : align === 'right' ? x - 4 - bw : x - bw / 2
    bx = Math.max(2, Math.min(width - bw - 2, bx))
    const pos = l.pos ?? 'middle'
    const by = pos === 'above' ? y - bh - 4 : pos === 'below' ? y + 4 : y - bh / 2
    if (l.bg) {
      ctx.fillStyle = l.bg
      roundRect(ctx, bx, by, bw, bh, 3)
      ctx.fill()
    }
    ctx.fillStyle = l.color
    ctx.textBaseline = 'middle'
    // 多行时居中对齐（周期标签 + 倒计时）/ multi-line text is centred (timeframe label + countdown)
    const multi = lines.length > 1
    ctx.textAlign = multi ? 'center' : 'left'
    const y0 = by + bh / 2 - ((lines.length - 1) * lh) / 2 + 0.5
    lines.forEach((s, k) => ctx.fillText(s, multi ? bx + bw / 2 : bx + padX, y0 + k * lh))
  }

  // 一个分布：区间 [i1, i2]，按 anchor 贴左或贴右；价值区内的行用更实的颜色，POC 画一条线。
  // mode：上涨/下跌（两段）、总量（一段）、差值（|涨−跌|，跌多用跌色）；vah / val 画虚线；ext 让线伸到右边缘；box 是区间底色。
  // One profile over [i1, i2], docked left or right; value-area rows use the stronger colours, POC gets a line.
  // mode: up/down (two segments), total (one), delta (|up − down|, down colour when down wins); vah / val are
  // dotted lines; ext runs a line to the right edge; box is the range background.
  private profile(ctx: Ctx, d: Omit<ShapeScene['profiles'][number], 'p'>, p: Profile, width: number, dock?: { x0: number; x1: number }) {
    const h = this.half()
    let left: number
    let right: number
    if (dock) { left = dock.x0; right = dock.x1 } else {
      const a = this.x(p.i1, width)
      const b = this.x(p.i2, width)
      if (a == null || b == null) return
      left = a - h
      right = b + h
    }
    const ext = d.ext ?? {}
    if ((right < 0 && !ext.poc && !ext.vah && !ext.val) || left > width) return
    const R = p.up.length
    if (d.box) {
      const ya = this.y(p.lo + R * p.step)
      const yb = this.y(p.lo)
      if (ya != null && yb != null) { ctx.fillStyle = d.box; ctx.fillRect(left, Math.min(ya, yb), right - left, Math.abs(yb - ya)) }
    }
    const mode = d.mode ?? 'updown'
    const span = (right - left) * d.width
    let max = 0
    for (let r = 0; r < R; r++) max = Math.max(max, mode === 'delta' ? Math.abs(p.up[r] - p.dn[r]) : p.up[r] + p.dn[r])
    if (d.hist !== false && span >= 2 && max > 0) {
      for (let r = 0; r < R; r++) {
        const yTop = this.y(p.lo + (r + 1) * p.step)
        const yBot = this.y(p.lo + r * p.step)
        if (yTop == null || yBot == null) continue
        const t = Math.min(yTop, yBot) + 0.5
        const hh = Math.max(1, Math.abs(yBot - yTop) - 1)
        const inVa = r >= p.val && r <= p.vah
        const u = p.up[r]
        const dn = p.dn[r]
        // 第一段 a、第二段 b（只有上涨/下跌模式才有）/ first segment a, second b (up/down mode only)
        const a = mode === 'updown' ? u : mode === 'total' ? u + dn : Math.abs(u - dn)
        const b = mode === 'updown' ? dn : 0
        const cA = mode === 'delta' && dn > u ? (inVa ? d.vaDn : d.dn) : (inVa ? d.vaUp : d.up)
        const wa = (a / max) * span
        const wb = (b / max) * span
        ctx.fillStyle = cA
        if (d.anchor === 'left') ctx.fillRect(left, t, wa, hh)
        else ctx.fillRect(right - wa, t, wa, hh)
        if (wb > 0) {
          ctx.fillStyle = inVa ? d.vaDn : d.dn
          if (d.anchor === 'left') ctx.fillRect(left + wa, t, wb, hh)
          else ctx.fillRect(right - wa - wb, t, wb, hh)
        }
      }
    }
    const hline = (key: 'poc' | 'vah' | 'val', price: number, color: string | undefined, def: LineDash, extend?: boolean) => {
      const y = this.y(price)
      if (y == null || !color) return
      const st = d.lines?.[key]
      const w = st?.width ?? 1
      ctx.strokeStyle = color
      ctx.lineWidth = w
      // 线宽大时虚线间隔跟着放大 / scale dash gaps with the width
      ctx.setLineDash(DASHES[st?.dash ?? def].map((x) => x * Math.max(1, w * 0.75)))
      ctx.beginPath()
      const yy = w % 2 === 1 ? Math.round(y) + 0.5 : Math.round(y)
      ctx.moveTo(left, yy)
      ctx.lineTo(extend ? width : right, yy)
      ctx.stroke()
      ctx.setLineDash([])
    }
    hline('vah', p.lo + (p.vah + 1) * p.step, d.vah, 'dotted', ext.vah)
    hline('val', p.lo + p.val * p.step, d.val, 'dotted', ext.val)
    hline('poc', p.lo + (p.poc + 0.5) * p.step, d.poc, 'solid', ext.poc)
  }

  private visibleProfile(ctx: Ctx, vp: NonNullable<ShapeScene['vp']>, width: number) {
    const lr = this.chart?.timeScale().getVisibleLogicalRange()
    if (!lr || vp.bars.length === 0) return
    const from = Math.max(0, Math.ceil(lr.from))
    const to = Math.min(vp.bars.length - 1, Math.floor(lr.to))
    if (to < from) return
    const key = `${from}|${to}|${vp.rows}|${vp.vaPct}|${vp.bars.length}|${vp.bars[to].c}|${vp.bars[to].v}`
    if (key !== this.vpKey) { this.vpKey = key; this.vpProf = volumeProfile(vp.bars, from, to, vp.rows, vp.vaPct) }
    if (!this.vpProf) return
    this.profile(ctx, { ...vp, anchor: 'right' }, this.vpProf, width, { x0: 0, x1: width })
  }

  private tpo(ctx: Ctx, d: ShapeScene['tpos'][number], width: number) {
    const t = d.t
    const h = this.half()
    const a = this.x(t.i1, width)
    const b = this.x(t.i2, width)
    if (a == null || b == null) return
    const x0 = a - h
    const x1 = b + h
    if (x1 < 0 || x0 > width) return
    const cw = Math.max(2, Math.min(14, h * 2))
    const y0 = this.y(t.lo)
    const y1 = this.y(t.lo + t.step)
    if (y0 == null || y1 == null) return
    const rh = Math.abs(y0 - y1)
    const letters = d.letters && rh >= 8 && cw >= 6
    if (letters) {
      ctx.font = `${Math.min(12, Math.floor(rh), Math.floor(cw * 1.3))}px ui-monospace, Menlo, monospace`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
    }
    for (let r = 0; r < t.rows.length; r++) {
      const yr = this.y(t.lo + (r + 0.5) * t.step)
      if (yr == null) continue
      const inVa = r >= t.val && r <= t.vah
      ctx.fillStyle = r === t.poc ? d.poc : inVa ? d.vaColor : d.color
      const row = t.rows[r]
      for (let k = 0; k < row.length; k++) {
        const x = x0 + k * cw
        if (x > x1) break
        if (letters) ctx.fillText(LETTERS[row[k] % LETTERS.length], x + cw / 2, yr + 0.5)
        else ctx.fillRect(x + 0.5, yr - rh / 2 + 0.5, cw - 1, Math.max(1, rh - 1))
      }
    }
    // 初始平衡区：左侧竖线 / initial balance: a bar on the left
    if (d.ib && Number.isFinite(t.ibHi) && Number.isFinite(t.ibLo)) {
      const ya = this.y(t.ibHi)
      const yb = this.y(t.ibLo)
      if (ya != null && yb != null) { ctx.fillStyle = d.ib; ctx.fillRect(x0 - 3, Math.min(ya, yb), 2, Math.abs(yb - ya)) }
    }
    const yp = this.y(t.lo + (t.poc + 0.5) * t.step)
    if (yp != null) {
      ctx.strokeStyle = d.poc
      ctx.lineWidth = 1
      ctx.setLineDash([4, 3])
      ctx.beginPath()
      ctx.moveTo(x0, Math.round(yp) + 0.5)
      ctx.lineTo(x1, Math.round(yp) + 0.5)
      ctx.stroke()
      ctx.setLineDash([])
    }
  }

  private table(ctx: Ctx, tb: NonNullable<ShapeScene['table']>, width: number, height: number) {
    if (tb.rows.length === 0) return
    const th = this.scene.theme
    ctx.font = FONT
    const kw = Math.max(...tb.rows.map((r) => ctx.measureText(r.k).width))
    ctx.font = MONO
    const vw = Math.max(...tb.rows.map((r) => ctx.measureText(r.v).width))
    const rowH = 19
    const w = kw + vw + 30
    const h = tb.rows.length * rowH + 8
    const m = 10
    const x = tb.pos.endsWith('l') ? m : width - w - m
    const y = tb.pos.startsWith('t') ? m + 22 : height - h - m
    ctx.fillStyle = th.bg
    roundRect(ctx, x, y, w, h, 6)
    ctx.fill()
    ctx.strokeStyle = th.border
    ctx.lineWidth = 1
    ctx.stroke()
    ctx.textBaseline = 'middle'
    tb.rows.forEach((r, k) => {
      const ry = y + 4 + k * rowH + rowH / 2
      ctx.font = FONT
      ctx.textAlign = 'left'
      ctx.fillStyle = th.text
      ctx.globalAlpha = 0.7
      ctx.fillText(r.k, x + 10, ry)
      ctx.globalAlpha = 1
      ctx.font = MONO
      ctx.textAlign = 'right'
      ctx.fillStyle = r.color ?? th.text
      ctx.fillText(r.v, x + w - 10, ry)
    })
  }

  // 半圆仪表：五档色弧 + 指针 + 结论文字，贴在窗格右上（按钮下面）
  // Half-circle gauge: five colour bands, a needle and the verdict, docked top-right under the pane buttons
  private gauge(ctx: Ctx, g: NonNullable<ShapeScene['gauge']>, width: number) {
    const R = 30
    const cx = width - R - 16
    const cy = 30 + R
    const th = this.scene.theme
    const bands = ['#f23645', '#f7525f', '#787b86', '#22ab94', '#089981']
    ctx.lineWidth = 6
    for (let k = 0; k < 5; k++) {
      ctx.strokeStyle = bands[k]
      ctx.globalAlpha = 0.85
      ctx.beginPath()
      ctx.arc(cx, cy, R, Math.PI + (k * Math.PI) / 5 + 0.03, Math.PI + ((k + 1) * Math.PI) / 5 - 0.03)
      ctx.stroke()
    }
    ctx.globalAlpha = 1
    if (g.value != null) {
      const a = Math.PI + ((Math.max(-1, Math.min(1, g.value)) + 1) / 2) * Math.PI
      ctx.strokeStyle = th.text
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(cx, cy)
      ctx.lineTo(cx + Math.cos(a) * (R - 6), cy + Math.sin(a) * (R - 6))
      ctx.stroke()
      ctx.fillStyle = th.text
      ctx.beginPath()
      ctx.arc(cx, cy, 3, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.font = `600 ${FONT}`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    ctx.fillStyle = g.color
    ctx.fillText(g.text, cx, cy + 5)
  }
}
