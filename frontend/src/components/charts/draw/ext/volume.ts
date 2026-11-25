// 第三批：锚定 VWAP、固定范围 / 锚定成交量分布。外汇和差价合约没有交易所成交量，这里用的是 tick 量
// （报价变动次数），设置里有说明；没有量的数据按每根 1 计。
// Batch 3: anchored VWAP and fixed-range / anchored volume profiles. FX and CFDs have no exchange
// volume, so these use tick volume (quote count), noted in settings; bars without volume count as 1.
import { type Drawing, showLabelOf } from '../model'
import {
  type Bar, type DrawEnv, type Px, FONT, DOWN, distToPolyline, stroke, setDash, withAlpha, labelBox, labelColors, guide,
} from '../paint'
import { type ToolDefs, nearest, hitOrInside } from './types'

const volOf = (b: Bar, any: boolean) => (any ? b.v : 1)

// ── 锚定 VWAP：从锚点那根起累计 Σ(典型价×量)/Σ量，可选 ±1σ / ±2σ 带 ──
// Anchored VWAP: Σ(typical × volume) / Σ volume from the anchor bar on, with optional ±1σ / ±2σ bands
export interface VwapPoint { x: number; v: number; sd: number }
export function vwapSeries(bars: Bar[]): VwapPoint[] {
  const any = bars.some((b) => b.v > 0)
  let sv = 0, spv = 0, sp2v = 0
  const out: VwapPoint[] = []
  for (const b of bars) {
    const tp = (b.h + b.l + b.c) / 3
    const v = volOf(b, any)
    sv += v; spv += tp * v; sp2v += tp * tp * v
    if (sv <= 0) continue
    const m = spv / sv
    out.push({ x: b.x, v: m, sd: Math.sqrt(Math.max(0, sp2v / sv - m * m)) })
  }
  return out
}
function vwapLine(env: DrawEnv, s: VwapPoint[], k: number): Px[] {
  const out: Px[] = []
  for (const q of s) {
    const y = env.p2y(q.v + k * q.sd)
    if (y != null && Number.isFinite(q.x)) out.push({ x: q.x, y })
  }
  return out
}
const vwapOf = (d: Drawing, env: DrawEnv) => vwapSeries(env.ohlc?.(d.pts[0].t, Infinity) ?? [])

// ── 成交量分布：把每根 K 线的量按它的高低区间摊到各价格行，分涨跌两色；POC = 量最大的行，价值区 = 围绕 POC 的 70% ──
// Volume profile: each bar's volume is spread over the price rows its range covers, split up / down;
// POC = the busiest row, value area = the 70% around the POC
export interface Profile { lo: number; hi: number; rowH: number; up: number[]; down: number[]; poc: number; vaLo: number; vaHi: number; max: number }
export function volumeProfile(bars: Bar[], rows: number): Profile | null {
  if (!bars.length) return null
  let lo = Infinity, hi = -Infinity
  for (const b of bars) { if (b.l < lo) lo = b.l; if (b.h > hi) hi = b.h }
  if (!(hi > lo)) hi = lo + Math.max(Math.abs(lo) * 1e-6, 1e-9)
  const n = Math.max(2, Math.min(400, Math.round(rows)))
  const rowH = (hi - lo) / n
  const up = new Array<number>(n).fill(0), down = new Array<number>(n).fill(0)
  const any = bars.some((b) => b.v > 0)
  for (const b of bars) {
    const v = volOf(b, any)
    const into = b.c >= b.o ? up : down
    const span = b.h - b.l
    if (!(span > 0)) { into[Math.min(n - 1, Math.max(0, Math.floor((b.c - lo) / rowH)))] += v; continue }
    const i0 = Math.max(0, Math.floor((b.l - lo) / rowH)), i1 = Math.min(n - 1, Math.floor((b.h - lo) / rowH))
    for (let i = i0; i <= i1; i++) {
      const overlap = Math.min(b.h, lo + (i + 1) * rowH) - Math.max(b.l, lo + i * rowH)
      if (overlap > 0) into[i] += v * overlap / span
    }
  }
  const tot = up.map((u, i) => u + down[i])
  let poc = 0
  for (let i = 1; i < n; i++) if (tot[i] > tot[poc]) poc = i
  const all = tot.reduce((a, b) => a + b, 0)
  let a = poc, b = poc, acc = tot[poc]
  while (acc < all * 0.7 && (a > 0 || b < n - 1)) {
    const below = a > 0 ? tot[a - 1] : -1, above = b < n - 1 ? tot[b + 1] : -1
    if (above >= below) { b++; acc += tot[b] } else { a--; acc += tot[a] }
  }
  return { lo, hi, rowH, up, down, poc, vaLo: a, vaHi: b, max: tot[poc] || 1 }
}

const DOWN_COL = '#f5c451'
// 直方图最长占区间的 40%，且不超过 360px / the histogram takes at most 40% of the range and 360px
const maxWOf = (xa: number, xb: number) => Math.min(360, Math.max(40, (xb - xa) * 0.4))
// 每个价格行的条（宽度；从区间左端往右长，涨的部分在前）/ each row's bar widths (grown right from the range start, up part first)
function rowRects(env: DrawEnv, pr: Profile, maxW: number) {
  const out: { i: number; y: number; h: number; wu: number; wd: number }[] = []
  for (let i = 0; i < pr.up.length; i++) {
    const yTop = env.p2y(pr.lo + (i + 1) * pr.rowH), yBot = env.p2y(pr.lo + i * pr.rowH)
    if (yTop == null || yBot == null) continue
    out.push({ i, y: yTop, h: Math.max(1, yBot - yTop - 1), wu: (pr.up[i] / pr.max) * maxW, wd: (pr.down[i] / pr.max) * maxW })
  }
  return out
}
const pocPrice = (pr: Profile) => pr.lo + (pr.poc + 0.5) * pr.rowH
function paintProfile(ctx: CanvasRenderingContext2D, d: Drawing, env: DrawEnv, pr: Profile, xa: number, xb: number) {
  for (const r of rowRects(env, pr, maxWOf(xa, xb))) {
    const inVa = r.i >= pr.vaLo && r.i <= pr.vaHi
    ctx.fillStyle = withAlpha(d.color, inVa ? 0.6 : 0.25)
    ctx.fillRect(xa, r.y, r.wu, r.h)
    ctx.fillStyle = withAlpha(DOWN_COL, inVa ? 0.6 : 0.25)
    ctx.fillRect(xa + r.wu, r.y, r.wd, r.h)
  }
  const pocP = pocPrice(pr)
  const yp = env.p2y(pocP)
  if (yp != null) {
    ctx.save(); ctx.setLineDash([]); ctx.strokeStyle = DOWN; ctx.lineWidth = 1.5
    ctx.beginPath(); ctx.moveTo(xa, yp); ctx.lineTo(xb, yp); ctx.stroke(); ctx.restore()
    // 标签放在 POC 线右端的上方、区间以内（区间常常贴着价格轴）/ label above the POC line's right end, inside the range
    if (showLabelOf(d)) {
      const { bg, fg } = labelColors(env)
      labelBox(ctx, [`POC ${env.fmtPrice(pocP)}`], xb, yp - 12, bg, fg, 'left')
    }
  }
  // 价值区上下沿 / value-area high and low
  for (const p of [pr.lo + (pr.vaHi + 1) * pr.rowH, pr.lo + pr.vaLo * pr.rowH]) {
    const y = env.p2y(p)
    if (y == null) continue
    ctx.save(); ctx.strokeStyle = withAlpha(d.color, 0.7); ctx.lineWidth = 1; ctx.setLineDash([4, 3])
    ctx.beginPath(); ctx.moveTo(xa, y); ctx.lineTo(xb, y); ctx.stroke(); ctx.restore()
  }
}
function profileBox(env: DrawEnv, pr: Profile, xa: number, xb: number) {
  const yTop = env.p2y(pr.hi), yBot = env.p2y(pr.lo)
  return yTop == null || yBot == null ? null : { x1: Math.min(xa, xb), x2: Math.max(xa, xb), y1: yTop, y2: yBot }
}
const rowsOf = (d: Drawing) => d.rows ?? 24
function rangeOf(d: Drawing, env: DrawEnv, px: Px[], anchored: boolean) {
  const t0 = anchored ? d.pts[0].t : Math.min(d.pts[0].t, d.pts[1].t)
  const t1 = anchored ? Infinity : Math.max(d.pts[0].t, d.pts[1].t)
  const bars = env.ohlc?.(t0, t1) ?? []
  const pr = volumeProfile(bars, rowsOf(d))
  const xs = bars.map((b) => b.x).filter(Number.isFinite)
  const xa = anchored ? px[0].x : Math.min(px[0].x, px[1].x)
  const xb = anchored ? (xs.length ? Math.max(...xs) : px[0].x) : Math.max(px[0].x, px[1].x)
  return { pr, xa, xb }
}
function vpRender(anchored: boolean) {
  return (ctx: CanvasRenderingContext2D, d: Drawing, px: Px[], env: DrawEnv, hot: boolean) => {
    const { pr, xa, xb } = rangeOf(d, env, px, anchored)
    if (!pr) { guide(ctx, d.color, anchored ? [px[0], { x: env.w, y: px[0].y }] : [px[0], px[1]]); return }
    const box = profileBox(env, pr, xa, xb)
    if (box && hot) {
      ctx.save(); ctx.fillStyle = withAlpha(d.color, 0.05); ctx.fillRect(box.x1, box.y1, box.x2 - box.x1, box.y2 - box.y1); ctx.restore()
      guide(ctx, d.color, [{ x: box.x1, y: box.y1 }, { x: box.x2, y: box.y1 }, { x: box.x2, y: box.y2 }, { x: box.x1, y: box.y2 }, { x: box.x1, y: box.y1 }], 0.4)
    }
    paintProfile(ctx, d, env, pr, xa, xb)
  }
}
function vpHit(anchored: boolean) {
  return (d: Drawing, px: Px[], env: DrawEnv, x: number, y: number) => {
    const { pr, xa, xb } = rangeOf(d, env, px, anchored)
    if (!pr) return null
    // 点中直方图的条或 POC 线才算（整个区间都算的话，锚定分布会盖住大半张图、挡住别的画线）
    // Only the bars and the POC line count: the whole range would let an anchored profile swallow most of the chart
    const inBar = rowRects(env, pr, maxWOf(xa, xb)).some((r) => x >= xa && x <= xa + r.wu + r.wd && y >= r.y && y <= r.y + r.h + 1)
    const yp = env.p2y(pocPrice(pr))
    const dPoc = yp != null && x >= xa - 4 && x <= xb + 4 ? Math.abs(y - yp) : Infinity
    return hitOrInside(env, dPoc, inBar)
  }
}
// 手柄放在区间两端、价格区间中间高度 / handles at the range ends, halfway up the price range
function vpHandles(anchored: boolean) {
  return (d: Drawing, px: Px[], env: DrawEnv): Px[] => {
    const { pr, xa } = rangeOf(d, env, px, anchored)
    const y = pr ? env.p2y((pr.lo + pr.hi) / 2) ?? px[0].y : px[0].y
    if (anchored) return [{ x: xa, y }]
    return [{ x: px[0].x, y }, { x: px[1].x, y }]
  }
}
// 只改时间：价格由数据决定 / only the time moves: prices come from the data
const timeOnly = (_d: Drawing, i: number, pt: { t: number; p: number }, o: { t: number; p: number }[]) => o.map((q, k) => (k === i ? { t: pt.t, p: q.p } : q))

export const VOLUME: ToolDefs = {
  anchoredVwap: {
    render(ctx, d, _px, env) {
      const s = vwapOf(d, env)
      if (!s.length) return
      if (d.bands) {
        const u1 = vwapLine(env, s, 1), l1 = vwapLine(env, s, -1)
        if (u1.length > 1 && l1.length > 1) {
          ctx.beginPath()
          u1.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)))
          for (let i = l1.length - 1; i >= 0; i--) ctx.lineTo(l1[i].x, l1[i].y)
          ctx.closePath(); ctx.fillStyle = withAlpha(d.color, 0.07); ctx.fill()
        }
        for (const k of [1, -1, 2, -2]) stroke(ctx, { ...d, lineStyle: 'dashed' }, vwapLine(env, s, k), 1, withAlpha(d.color, Math.abs(k) === 1 ? 0.8 : 0.5))
      }
      const line = vwapLine(env, s, 0)
      stroke(ctx, d, line)
      if (line.length && showLabelOf(d)) {
        const last = line[line.length - 1]
        const { bg, fg } = labelColors(env)
        ctx.font = FONT
        labelBox(ctx, [`VWAP ${env.fmtPrice(s[s.length - 1].v)}`], last.x, last.y - 12, bg, fg, 'left')
      }
      // 锚点竖线标记 / a short tick marking the anchor
      if (line.length) {
        ctx.save(); ctx.strokeStyle = d.color; ctx.lineWidth = 1; setDash(ctx, 'dotted')
        ctx.beginPath(); ctx.moveTo(line[0].x, line[0].y - 14); ctx.lineTo(line[0].x, line[0].y + 14); ctx.stroke(); ctx.restore()
      }
    },
    hit(d, _px, env, x, y) {
      const s = vwapOf(d, env)
      const ds = [distToPolyline(x, y, vwapLine(env, s, 0))]
      if (d.bands) for (const k of [1, -1, 2, -2]) ds.push(distToPolyline(x, y, vwapLine(env, s, k)))
      return nearest(env, ...ds)
    },
    handles(d, px, env) {
      const s = vwapOf(d, env)
      const y = s.length ? env.p2y(s[0].v) : null
      return [{ x: s.length ? s[0].x : px[0].x, y: y ?? px[0].y }]
    },
    drag: timeOnly,
  },
  fixedRangeVP: { render: vpRender(false), hit: vpHit(false), handles: vpHandles(false), drag: timeOnly },
  anchoredVP: { render: vpRender(true), hit: vpHit(true), handles: vpHandles(true), drag: timeOnly },
}
