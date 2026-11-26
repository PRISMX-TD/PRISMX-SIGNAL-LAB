// 画线共用的类型与画布小工具（2026-11-25 从 tools.ts 拆出，第二批的工具文件也用它）。
// Shared drawing types and canvas helpers (split out of tools.ts on 2026-11-25 so the batch 2 tool
// files can use them too).
import { type Drawing, fontSizeOf } from './model'

export interface Px { x: number; y: number }
export interface DrawLabels {
  bars: string; rr: string; target: string; stop: string; qty: string; risk: string; pips: string
  dur: (sec: number) => string
  // 头肩形态的「左肩 / 头 / 右肩」/ head & shoulders labels
  ls?: string; hd?: string; rs?: string
}
export interface DrawEnv {
  w: number
  h: number
  t2x: (t: number) => number | null
  p2y: (p: number) => number | null
  y2p: (y: number) => number | null
  fmtPrice: (p: number) => string
  bars: (t1: number, t2: number) => number
  pips: (dp: number) => number | null
  qty: (riskAmount: number, slDist: number, ref: number) => number | null
  // 按下单票当前的仓位设置（手数或风险 %）算这次止损对应的手数与亏损金额；没有下单票信息时缺省。
  // Lots and money at risk for this stop from the order ticket's current sizing (lots or risk %).
  size?: (slDist: number, ref: number) => { q: number | null; risk: number | null }
  L: DrawLabels
  theme: DrawTheme
  touch: boolean
  // 两个时间之间每根 K 线的 x 与收盘价（回归趋势用）/ x and close of each bar between two times (regression)
  closes?: (t0: number, t1: number) => { x: number; c: number }[]
  // 两个时间之间每根 K 线的完整数据（含 tick 量；成交量分布、VWAP 用）/ full bars between two times, tick volume included
  ohlc?: (t0: number, t1: number) => Bar[]
  // 从 t0 那根图表 K 线到 tLast 那根（含，Infinity = 到最新）之间比图表周期小的 K 线（成交量分布用，
  // 对标 TradingView）；还没到 / 用不了时 null。返回的 x 为 NaN，由调用方按所在的图表 K 线补上。
  // key 是画线 id（防抖用）。
  // Lower-timeframe bars from the chart bar at t0 through the one at tLast (inclusive; Infinity = up to
  // the newest) for volume profiles, TradingView-style; null while loading or unavailable. x comes back
  // NaN for the caller to fill from the chart bar it falls in; key = drawing id (debouncing).
  intrabar?: (t0: number, tLast: number, key: string) => Bar[] | null
  // 当前一根 K 线占多少像素 / pixels per bar right now
  spacing?: number
  // 异步资源（图片）到了之后请求重画 / ask for a repaint once an async resource (an image) arrives
  redraw?: () => void
}
export interface Bar { x: number; t: number; o: number; h: number; l: number; c: number; v: number }
// up / down = 用户的 K 线涨跌色（红涨绿跌也跟着走）/ the user's candle colours (red-up included)
export interface DrawTheme { bg: string; text: string; up?: string; down?: string }

export const UP = '#2ee07e'
export const DOWN = '#ff4d67'
export const upOf = (env: DrawEnv) => env.theme.up || UP
export const downOf = (env: DrawEnv) => env.theme.down || DOWN
// 选中画线时轴上价格 / 时间标签的底色：品牌紫 / axis chips of a selected drawing: brand violet
export const ACCENT = '#6e42ff'
// 色块上的字：亮底用深字，暗底用白字 / text on a colour chip: dark on bright, white on dark
export function textOn(hex: string): string {
  const m = /^#([0-9a-f]{6})/i.exec(hex)
  if (!m) return '#0b0e14'
  const n = parseInt(m[1], 16)
  return 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255) > 125 ? '#0b0e14' : '#ffffff'
}
export const FONT = '11px ui-monospace, SFMono-Regular, Menlo, monospace'
export const SANS = (px: number) => `${px}px system-ui, sans-serif`
// 江恩扇等多线工具的配色 / colours for multi-line tools such as the Gann fan
export const FAN_COLORS = ['#f5c451', '#fb923c', '#2ee07e', '#22d3ee', '#a78bfa', '#22d3ee', '#2ee07e', '#fb923c', '#f5c451']

export const tolOf = (env: DrawEnv) => (env.touch ? 22 : 8)
export const handleROf = (env: DrawEnv) => (env.touch ? 8 : 5)
export const ok = (n: number) => Number.isFinite(n)

export function distToSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

// 线段按「左延 / 右延」伸到画布外 / extend a segment off-canvas to the left / right
export function extendSeg(a: Px, b: Px, left: boolean, right: boolean, env: DrawEnv): [Px, Px] {
  const dx = b.x - a.x, dy = b.y - a.y
  const len = Math.hypot(dx, dy) || 1
  const ext = (env.w + env.h) * 2
  const ux = dx / len, uy = dy / len
  const p = left ? { x: a.x - ux * ext, y: a.y - uy * ext } : a
  const q = right ? { x: b.x + ux * ext, y: b.y + uy * ext } : b
  return [p, q]
}
// 从 a 朝 b 方向射出去的射线终点 / far end of a ray from a through b
export const rayEnd = (a: Px, b: Px, env: DrawEnv): Px => extendSeg(a, b, false, true, env)[1]

export function setDash(ctx: CanvasRenderingContext2D, s: Drawing['lineStyle']) {
  if (s === 'dashed') ctx.setLineDash([8, 4])
  else if (s === 'dotted') ctx.setLineDash([2, 3])
  else ctx.setLineDash([])
}

export function withAlpha(color: string, a: number): string {
  // 八位色自带透明度（设置里调过不透明度），再乘上这里的 a / an 8-digit colour already carries alpha; multiply
  if (/^#[0-9a-f]{8}$/i.test(color)) return color.slice(0, 7) + Math.round((parseInt(color.slice(7), 16) / 255) * a * 255).toString(16).padStart(2, '0')
  if (/^#[0-9a-f]{6}$/i.test(color)) return color + Math.round(a * 255).toString(16).padStart(2, '0')
  if (/^#[0-9a-f]{3}$/i.test(color)) return '#' + [...color.slice(1)].map((c) => c + c).join('') + Math.round(a * 255).toString(16).padStart(2, '0')
  return color
}

export function stroke(ctx: CanvasRenderingContext2D, d: Drawing, pts: Px[], width?: number, color?: string) {
  ctx.strokeStyle = color ?? d.color
  ctx.lineWidth = width ?? d.lineWidth ?? 1
  setDash(ctx, d.lineStyle)
  ctx.beginPath()
  pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)))
  ctx.stroke()
}
// 虚线辅助线（半透明、1px）/ a faint 1px dashed guide line
export function guide(ctx: CanvasRenderingContext2D, color: string, pts: Px[], alpha = 0.55) {
  ctx.save()
  ctx.globalAlpha = alpha
  ctx.strokeStyle = color
  ctx.lineWidth = 1
  ctx.setLineDash([4, 4])
  ctx.beginPath()
  pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)))
  ctx.stroke()
  ctx.restore()
}
export function fillPoly(ctx: CanvasRenderingContext2D, pts: Px[], color: string, alpha: number) {
  if (pts.length < 3) return
  ctx.save()
  ctx.fillStyle = withAlpha(color, alpha)
  ctx.beginPath()
  pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)))
  ctx.closePath()
  ctx.fill()
  ctx.restore()
}

// 圆角读数框 / rounded readout box
export function labelBox(ctx: CanvasRenderingContext2D, lines: string[], cx: number, cy: number, bg: string, fg: string, anchor: 'center' | 'above' | 'below' | 'left' | 'right' = 'center') {
  if (lines.length === 0) return
  ctx.save()
  ctx.font = FONT
  ctx.setLineDash([])
  const lh = 15
  const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 14
  const h = lines.length * lh + 8
  let x = cx - w / 2, y = cy - h / 2
  if (anchor === 'above') y = cy - h - 6
  if (anchor === 'below') y = cy + 6
  if (anchor === 'left') x = cx - w - 8
  if (anchor === 'right') x = cx + 8
  // 别伸到价格轴底下被裁掉（多空仓位画在最新 K 线旁时，金额就在右半截）
  // Keep the box inside the pane so the price axis doesn't clip it (the money sits on the right half).
  const sc = ctx.getTransform?.()?.a || 1
  const cw = ctx.canvas?.width ? ctx.canvas.width / sc : Infinity
  if (Number.isFinite(cw) && cw > w + 4) x = Math.max(2, Math.min(x, cw - w - 2))
  ctx.fillStyle = bg
  ctx.beginPath()
  ctx.roundRect?.(x, y, w, h, 4) ?? ctx.rect(x, y, w, h)
  ctx.fill()
  ctx.fillStyle = fg
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  lines.forEach((l, i) => ctx.fillText(l, x + w / 2, y + 4 + lh * i + lh / 2))
  ctx.restore()
}
// 读数框底色（随主题）/ readout box colours for the theme
export const labelColors = (env: DrawEnv) => ({ bg: env.theme.bg === '#ffffff' ? 'rgba(19,23,34,0.85)' : 'rgba(30,34,45,0.92)', fg: '#e2e8f0' })

export function arrowHead(ctx: CanvasRenderingContext2D, from: Px, to: Px, size: number, color: string) {
  const ang = Math.atan2(to.y - from.y, to.x - from.x)
  ctx.save()
  ctx.setLineDash([])
  ctx.fillStyle = color
  ctx.beginPath()
  ctx.moveTo(to.x, to.y)
  ctx.lineTo(to.x - size * Math.cos(ang - Math.PI / 7), to.y - size * Math.sin(ang - Math.PI / 7))
  ctx.lineTo(to.x - size * Math.cos(ang + Math.PI / 7), to.y - size * Math.sin(ang + Math.PI / 7))
  ctx.closePath()
  ctx.fill()
  ctx.restore()
}

// 线上附注：沿线方向写在中点上方 / a note on a line: written along it, above the midpoint
export function lineText(ctx: CanvasRenderingContext2D, d: Drawing, a: Px, b: Px) {
  if (!d.text) return
  let ang = Math.atan2(b.y - a.y, b.x - a.x)
  if (ang > Math.PI / 2) ang -= Math.PI
  if (ang < -Math.PI / 2) ang += Math.PI
  ctx.save()
  ctx.translate((a.x + b.x) / 2, (a.y + b.y) / 2)
  ctx.rotate(ang)
  ctx.font = SANS(fontSizeOf(d))
  ctx.fillStyle = d.textColor || d.color
  ctx.textAlign = 'center'
  ctx.textBaseline = 'bottom'
  ctx.setLineDash([])
  ctx.fillText(d.text, 0, -4)
  ctx.restore()
}
// 形状中心写字 / text centred in a shape
export function centerText(ctx: CanvasRenderingContext2D, d: Drawing, c: Px) {
  if (!d.text) return
  ctx.save()
  ctx.font = SANS(fontSizeOf(d))
  ctx.fillStyle = d.textColor || d.color
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.setLineDash([])
  const lines = d.text.split('\n')
  const lh = fontSizeOf(d) * 1.3
  lines.forEach((l, i) => ctx.fillText(l, c.x, c.y + (i - (lines.length - 1) / 2) * lh))
  ctx.restore()
}
// 点旁边的小标签（形态 / 波浪的字母）/ a small label next to a point (pattern / wave letters)
export function pointTag(ctx: CanvasRenderingContext2D, text: string, p: Px, above: boolean, color: string, bg: string) {
  ctx.save()
  ctx.font = 'bold 11px system-ui, sans-serif'
  ctx.setLineDash([])
  const w = ctx.measureText(text).width + 10
  const h = 17
  const x = p.x - w / 2
  const y = above ? p.y - h - 7 : p.y + 7
  ctx.fillStyle = bg
  ctx.beginPath()
  ctx.roundRect?.(x, y, w, h, 4) ?? ctx.rect(x, y, w, h)
  ctx.fill()
  ctx.fillStyle = color
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, p.x, y + h / 2 + 0.5)
  ctx.restore()
}
// 线段中点写一个比例数（谐波形态）/ a ratio written at a segment's midpoint (harmonic patterns)
export function midTag(ctx: CanvasRenderingContext2D, text: string, a: Px, b: Px, color: string, bg: string) {
  ctx.save()
  ctx.font = FONT
  ctx.setLineDash([])
  const w = ctx.measureText(text).width + 8
  const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2
  ctx.fillStyle = bg
  ctx.beginPath()
  ctx.roundRect?.(cx - w / 2, cy - 8, w, 16, 3) ?? ctx.rect(cx - w / 2, cy - 8, w, 16)
  ctx.fill()
  ctx.fillStyle = color
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, cx, cy + 0.5)
  ctx.restore()
}

export const pct = (from: number, to: number) => (from ? ((to - from) / Math.abs(from)) * 100 : 0)
export const signed = (n: number, s: string) => (n > 0 ? '+' : n < 0 ? '−' : '') + s

// 估算文字宽（命中判定拿不到 ctx）：CJK 按 1 个字号，其它按 0.6 / estimated text width
export function textWidth(s: string, fs: number): number {
  let w = 0
  for (const ch of s) w += ch.charCodeAt(0) > 255 ? fs : fs * 0.6
  return w
}

export function pointInPoly(x: number, y: number, poly: Px[]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j]
    if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}
// 点到折线的最近距离（closed = 首尾相接）/ nearest distance to a polyline (closed joins the ends)
export function distToPolyline(x: number, y: number, pts: Px[], closed = false): number {
  let m = Infinity
  for (let i = 1; i < pts.length; i++) m = Math.min(m, distToSeg(x, y, pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y))
  if (closed && pts.length > 2) m = Math.min(m, distToSeg(x, y, pts[pts.length - 1].x, pts[pts.length - 1].y, pts[0].x, pts[0].y))
  return m
}

// 二次贝塞尔：过 a、b，且经过 through 点（控制点 = 2·through − (a+b)/2），取样成折线
// Quadratic Bézier from a to b passing through `through` (control = 2·through − (a+b)/2), sampled to a polyline
export function quadThrough(a: Px, b: Px, through: Px, steps = 32): Px[] {
  const c = { x: 2 * through.x - (a.x + b.x) / 2, y: 2 * through.y - (a.y + b.y) / 2 }
  return quadCtrl(a, b, c, steps)
}
export function quadCtrl(a: Px, b: Px, c: Px, steps = 32): Px[] {
  const out: Px[] = []
  for (let i = 0; i <= steps; i++) {
    const t = i / steps, u = 1 - t
    out.push({ x: u * u * a.x + 2 * u * t * c.x + t * t * b.x, y: u * u * a.y + 2 * u * t * c.y + t * t * b.y })
  }
  return out
}
export const mid = (a: Px, b: Px): Px => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })
export const lerp = (a: Px, b: Px, t: number): Px => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })
// 把数字写得短一点（比例、档位）/ a short number (ratios, levels)
// 一排标签防重叠：占位登记，挨得太近的就不画 / keeps a row of labels apart: claims spans, refuses overlapping ones
export function spacer(): (a: number, b: number) => boolean {
  const taken: [number, number][] = []
  return (a, b) => {
    if (taken.some(([s, e]) => a < e && b > s)) return false
    taken.push([a, b])
    return true
  }
}
export const fmtRatio = (v: number) => (Math.round(v * 1000) / 1000).toString()
