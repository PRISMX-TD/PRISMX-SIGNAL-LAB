// 第三批：锚定 VWAP、固定范围 / 锚定成交量分布。外汇和差价合约没有交易所成交量，这里用的是 tick 量
// （报价变动次数），设置里有说明；没有量的数据按每根 1 计。
// Batch 3: anchored VWAP and fixed-range / anchored volume profiles. FX and CFDs have no exchange
// volume, so these use tick volume (quote count), noted in settings; bars without volume count as 1.
import { type Drawing, type VpLine, type VpOpts, showLabelOf } from '../model'
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

// ── 成交量分布：把每根 K 线的量按它的高低区间摊到各价格行，分涨跌两色；POC = 量最大的行 ──
// 价值区照 TradingView：从 POC 起，每次比较上方两行与下方两行的量和，把大的那一对整对并入，直到占总量 vaPct%。
// 设置对标 TradingView 的 FRVP（2026-11-26）：行布局（行数 / 每行 tick 数）、成交量（上涨下跌 / 总量 / 差值）、
// 价值区百分比、向右延长；直方图宽度、位置、四种颜色、每行数值、VAH / VAL / POC / 发展 POC / 发展价值区、框底色。
// Volume profile: each bar's volume is spread over the price rows its range covers, split up / down;
// POC = the busiest row. Value area as TradingView does it: from the POC, compare the two rows above
// with the two below and take the bigger pair whole, until vaPct% of the total. Settings follow
// TradingView's FRVP (inputs and style).
export interface Profile { lo: number; hi: number; rowH: number; up: number[]; down: number[]; poc: number; vaLo: number; vaHi: number; max: number }

export function valueAreaTv(tot: number[], poc: number, vaPct: number): [number, number] {
  const n = tot.length
  const all = tot.reduce((a, b) => a + b, 0)
  const goal = (all * Math.max(1, Math.min(100, vaPct))) / 100
  let a = poc, b = poc, acc = tot[poc] ?? 0
  while (acc < goal && (a > 0 || b < n - 1)) {
    const up = (b + 1 < n ? tot[b + 1] : 0) + (b + 2 < n ? tot[b + 2] : 0)
    const dn = (a - 1 >= 0 ? tot[a - 1] : 0) + (a - 2 >= 0 ? tot[a - 2] : 0)
    const goUp = b < n - 1 && (a === 0 || up >= dn)
    // 一次并一对，但够数就停 / take the pair, but stop as soon as the goal is reached
    for (let k = 0; k < 2 && acc < goal; k++) {
      if (goUp) { if (b < n - 1) { b++; acc += tot[b] } } else if (a > 0) { a--; acc += tot[a] }
    }
  }
  return [a, b]
}

function spread(b: Bar, v: number, lo: number, rowH: number, n: number, into: number[]) {
  const span = b.h - b.l
  if (!(span > 0)) { into[Math.min(n - 1, Math.max(0, Math.floor((b.c - lo) / rowH)))] += v; return }
  const i0 = Math.max(0, Math.floor((b.l - lo) / rowH)), i1 = Math.min(n - 1, Math.floor((b.h - lo) / rowH))
  for (let i = i0; i <= i1; i++) {
    const overlap = Math.min(b.h, lo + (i + 1) * rowH) - Math.max(b.l, lo + i * rowH)
    if (overlap > 0) into[i] += v * overlap / span
  }
}

/** rows：行数；或传 { tick, ticks } 按每行几个最小跳动分行（上限 400 行）
 *  rows: a row count, or { tick, ticks } for a fixed number of ticks per row (capped at 400 rows) */
export function volumeProfile(bars: Bar[], rows: number | { tick: number; ticks: number }, vaPct = 70): Profile | null {
  if (!bars.length) return null
  let lo = Infinity, hi = -Infinity
  for (const b of bars) { if (b.l < lo) lo = b.l; if (b.h > hi) hi = b.h }
  if (!(hi > lo)) hi = lo + Math.max(Math.abs(lo) * 1e-6, 1e-9)
  const want = typeof rows === 'number' ? rows : Math.ceil((hi - lo) / Math.max(1e-12, rows.tick * Math.max(1, rows.ticks)))
  const n = Math.max(2, Math.min(400, Math.round(want)))
  const rowH = (hi - lo) / n
  const up = new Array<number>(n).fill(0), down = new Array<number>(n).fill(0)
  const any = bars.some((b) => b.v > 0)
  for (const b of bars) spread(b, volOf(b, any), lo, rowH, n, b.c >= b.o ? up : down)
  const tot = up.map((u, i) => u + down[i])
  let poc = 0
  for (let i = 1; i < n; i++) if (tot[i] > tot[poc]) poc = i
  const [vaLo, vaHi] = valueAreaTv(tot, poc, vaPct)
  return { lo, hi, rowH, up, down, poc, vaLo, vaHi, max: tot[poc] || 1 }
}

/** 发展 POC / 价值区：区间起点到每根 K 线为止的 POC 与价值区（行网格用整段的）
 *  Developing POC / value area as of each bar from the range start (on the full range's row grid) */
export interface DevPoint { x: number; poc: number; vah: number; val: number }
export function developing(bars: Bar[], pr: Profile, vaPct: number): DevPoint[] {
  const n = pr.up.length
  const tot = new Array<number>(n).fill(0)
  const any = bars.some((b) => b.v > 0)
  const out: DevPoint[] = []
  for (const b of bars) {
    spread(b, volOf(b, any), pr.lo, pr.rowH, n, tot)
    let poc = 0
    for (let i = 1; i < n; i++) if (tot[i] > tot[poc]) poc = i
    const [a, z] = valueAreaTv(tot, poc, vaPct)
    out.push({ x: b.x, poc: pr.lo + (poc + 0.5) * pr.rowH, vah: pr.lo + (z + 1) * pr.rowH, val: pr.lo + a * pr.rowH })
  }
  return out
}

/** 全部设置（缺省照 TradingView；直方图颜色的缺省从画线主色推出，老画线外观基本不变）
 *  Every setting resolved (TradingView-like defaults; histogram colours derive from the drawing colour) */
export const VP_DOWN = '#f5c451'
export const VP_LINE = '#3d7bff'
export function vpOf(d: Drawing): VpOpts {
  const o = d.vp ?? {}
  const line = (v: VpLine | undefined, on: boolean, color: string): VpLine => ({ on: v?.on ?? on, color: v?.color || color })
  return {
    layout: o.layout === 'ticks' ? 'ticks' : 'rows',
    ticks: Math.max(1, Math.round(o.ticks ?? 1)),
    volume: o.volume === 'total' || o.volume === 'delta' ? o.volume : 'updown',
    vaPct: Math.max(1, Math.min(100, o.vaPct ?? 70)),
    hist: o.hist ?? true,
    values: !!o.values,
    valuesColor: o.valuesColor || '',
    widthPct: Math.max(1, Math.min(100, o.widthPct ?? 30)),
    placement: o.placement === 'right' ? 'right' : 'left',
    up: o.up || withAlpha(d.color, 0.3),
    down: o.down || withAlpha(VP_DOWN, 0.3),
    vaUp: o.vaUp || withAlpha(d.color, 0.7),
    vaDown: o.vaDown || withAlpha(VP_DOWN, 0.7),
    vah: line(o.vah, true, VP_LINE),
    val: line(o.val, true, VP_LINE),
    poc: line(o.poc, true, DOWN),
    devPoc: line(o.devPoc, false, DOWN),
    devVa: line(o.devVa, false, VP_LINE),
    boxBg: o.boxBg || '',
  }
}

// 每个价格行的条：起点 x、总宽、上涨部分宽度（「上涨 / 下跌」模式）、颜色
// Each row's bar: start x, width, the up part's width (up / down mode), colours
interface RowRect { i: number; y: number; h: number; x: number; w: number; wu: number; col: string; colD: string }
function rowRects(env: DrawEnv, pr: Profile, o: VpOpts, xa: number, xb: number): RowRect[] {
  const maxW = Math.max(1, (xb - xa) * o.widthPct / 100)
  const tot = pr.up.map((u, i) => u + pr.down[i])
  const delta = pr.up.map((u, i) => Math.abs(u - pr.down[i]))
  const maxV = o.volume === 'delta' ? Math.max(1e-12, ...delta) : pr.max
  const out: RowRect[] = []
  for (let i = 0; i < pr.up.length; i++) {
    const yTop = env.p2y(pr.lo + (i + 1) * pr.rowH), yBot = env.p2y(pr.lo + i * pr.rowH)
    if (yTop == null || yBot == null) continue
    const inVa = i >= pr.vaLo && i <= pr.vaHi
    const cu = inVa ? o.vaUp : o.up, cd = inVa ? o.vaDown : o.down
    const v = o.volume === 'delta' ? delta[i] : tot[i]
    const w = (v / maxV) * maxW
    const wu = o.volume === 'updown' ? (tot[i] > 0 ? (pr.up[i] / tot[i]) * w : 0) : w
    const col = o.volume === 'delta' ? (pr.up[i] >= pr.down[i] ? cu : cd) : cu
    const x = o.placement === 'right' ? xb - w : xa
    out.push({ i, y: yTop, h: Math.max(1, yBot - yTop - 1), x, w, wu, col, colD: cd })
  }
  return out
}
const pocPrice = (pr: Profile) => pr.lo + (pr.poc + 0.5) * pr.rowH
const vahPrice = (pr: Profile) => pr.lo + (pr.vaHi + 1) * pr.rowH
const valPrice = (pr: Profile) => pr.lo + pr.vaLo * pr.rowH
const compact = (v: number) => (v >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : v >= 1e4 ? `${(v / 1e3).toFixed(1)}K` : v >= 100 ? v.toFixed(0) : v.toFixed(1))

function hLine(ctx: CanvasRenderingContext2D, x1: number, x2: number, y: number, color: string, width: number) {
  ctx.save(); ctx.setLineDash([]); ctx.strokeStyle = color; ctx.lineWidth = width
  ctx.beginPath(); ctx.moveTo(x1, y); ctx.lineTo(x2, y); ctx.stroke(); ctx.restore()
}
function stepLine(ctx: CanvasRenderingContext2D, env: DrawEnv, pts: { x: number; p: number }[], color: string) {
  ctx.save(); ctx.setLineDash([]); ctx.strokeStyle = color; ctx.lineWidth = 1.5
  ctx.beginPath()
  let started = false, lastY = 0
  for (const q of pts) {
    const y = env.p2y(q.p)
    if (y == null || !Number.isFinite(q.x)) continue
    if (!started) { ctx.moveTo(q.x, y); started = true } else { ctx.lineTo(q.x, lastY); ctx.lineTo(q.x, y) }
    lastY = y
  }
  ctx.stroke(); ctx.restore()
}

function paintProfile(ctx: CanvasRenderingContext2D, d: Drawing, env: DrawEnv, pr: Profile, bars: Bar[], xa: number, xb: number) {
  const o = vpOf(d)
  if (o.boxBg) {
    const yTop = env.p2y(pr.hi), yBot = env.p2y(pr.lo)
    if (yTop != null && yBot != null) { ctx.save(); ctx.fillStyle = o.boxBg; ctx.fillRect(xa, yTop, xb - xa, yBot - yTop); ctx.restore() }
  }
  if (o.hist) {
    const rects = rowRects(env, pr, o, xa, xb)
    const right = o.placement === 'right'
    for (const r of rects) {
      if (o.volume === 'updown') {
        // 靠框边的那段是上涨量 / the part next to the box edge is up volume
        ctx.fillStyle = r.col
        ctx.fillRect(right ? r.x + r.w - r.wu : r.x, r.y, r.wu, r.h)
        ctx.fillStyle = r.colD
        ctx.fillRect(right ? r.x : r.x + r.wu, r.y, r.w - r.wu, r.h)
      } else {
        ctx.fillStyle = r.col
        ctx.fillRect(r.x, r.y, r.w, r.h)
      }
    }
    if (o.values) {
      ctx.save()
      ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace'
      ctx.fillStyle = o.valuesColor || env.theme.text
      ctx.textBaseline = 'middle'
      ctx.textAlign = right ? 'right' : 'left'
      for (const r of rects) {
        if (r.h < 8) continue
        const v = o.volume === 'delta' ? Math.abs(pr.up[r.i] - pr.down[r.i]) : pr.up[r.i] + pr.down[r.i]
        if (!(v > 0)) continue
        ctx.fillText(compact(v), right ? r.x - 3 : r.x + r.w + 3, r.y + r.h / 2)
      }
      ctx.restore()
    }
  }
  if ((o.devPoc.on || o.devVa.on) && bars.length > 1) {
    const dev = developing(bars, pr, o.vaPct)
    if (o.devVa.on) {
      stepLine(ctx, env, dev.map((q) => ({ x: q.x, p: q.vah })), o.devVa.color)
      stepLine(ctx, env, dev.map((q) => ({ x: q.x, p: q.val })), o.devVa.color)
    }
    if (o.devPoc.on) stepLine(ctx, env, dev.map((q) => ({ x: q.x, p: q.poc })), o.devPoc.color)
  }
  // VAH / VAL / POC 实线横贯整个框；向右延长时画到图表右缘
  // VAH / VAL / POC are solid lines across the whole box; extended, they run to the chart's right edge
  const x2 = d.extendRight ? env.w : xb
  const label = showLabelOf(d)
  const { bg, fg } = labelColors(env)
  const lines: [VpLine, number, string][] = [[o.vah, vahPrice(pr), 'VAH'], [o.val, valPrice(pr), 'VAL'], [o.poc, pocPrice(pr), 'POC']]
  for (const [ln, price, name] of lines) {
    if (!ln.on) continue
    const y = env.p2y(price)
    if (y == null) continue
    hLine(ctx, xa, x2, y, ln.color, name === 'POC' ? 1.5 : 1)
    // 标签放在线右端的上方、区间以内（区间常常贴着价格轴）/ label above the line's right end, inside the range
    if (label) labelBox(ctx, [`${name} ${env.fmtPrice(price)}`], xb, y - 12, bg, fg, 'left')
  }
}
function profileBox(env: DrawEnv, pr: Profile, xa: number, xb: number) {
  const yTop = env.p2y(pr.hi), yBot = env.p2y(pr.lo)
  return yTop == null || yBot == null ? null : { x1: Math.min(xa, xb), x2: Math.max(xa, xb), y1: yTop, y2: yBot }
}
const rowsOf = (d: Drawing) => d.rows ?? 24
// 最小跳动：按价格显示的小数位推（2 位 → 0.01）/ the minimum tick, from the price's displayed decimals
const tickOf = (env: DrawEnv) => {
  const s = env.fmtPrice(1)
  const i = s.indexOf('.')
  return i < 0 ? 1 : Math.pow(10, -(s.length - i - 1))
}
function rangeOf(d: Drawing, env: DrawEnv, px: Px[], anchored: boolean) {
  const t0 = anchored ? d.pts[0].t : Math.min(d.pts[0].t, d.pts[1].t)
  const t1 = anchored ? Infinity : Math.max(d.pts[0].t, d.pts[1].t)
  const bars = env.ohlc?.(t0, t1) ?? []
  const o = vpOf(d)
  const pr = volumeProfile(bars, o.layout === 'ticks' ? { tick: tickOf(env), ticks: o.ticks } : rowsOf(d), o.vaPct)
  const xs = bars.map((b) => b.x).filter(Number.isFinite)
  const xa = anchored ? px[0].x : Math.min(px[0].x, px[1].x)
  const xb = anchored ? (xs.length ? Math.max(...xs) : px[0].x) : Math.max(px[0].x, px[1].x)
  return { pr, bars, xa, xb, o }
}
function vpRender(anchored: boolean) {
  return (ctx: CanvasRenderingContext2D, d: Drawing, px: Px[], env: DrawEnv, hot: boolean) => {
    const { pr, bars, xa, xb } = rangeOf(d, env, px, anchored)
    if (!pr) { guide(ctx, d.color, anchored ? [px[0], { x: env.w, y: px[0].y }] : [px[0], px[1]]); return }
    const box = profileBox(env, pr, xa, xb)
    if (box && hot) {
      ctx.save(); ctx.fillStyle = withAlpha(d.color, 0.05); ctx.fillRect(box.x1, box.y1, box.x2 - box.x1, box.y2 - box.y1); ctx.restore()
      guide(ctx, d.color, [{ x: box.x1, y: box.y1 }, { x: box.x2, y: box.y1 }, { x: box.x2, y: box.y2 }, { x: box.x1, y: box.y2 }, { x: box.x1, y: box.y1 }], 0.4)
    }
    paintProfile(ctx, d, env, pr, bars, xa, xb)
  }
}
function vpHit(anchored: boolean) {
  return (d: Drawing, px: Px[], env: DrawEnv, x: number, y: number) => {
    const { pr, xa, xb, o } = rangeOf(d, env, px, anchored)
    if (!pr) return null
    // 点中直方图的条或三条线才算（整个区间都算的话，锚定分布会盖住大半张图、挡住别的画线）
    // Only the bars and the lines count: the whole range would let an anchored profile swallow most of the chart
    const inBar = o.hist && rowRects(env, pr, o, xa, xb).some((r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h + 1)
    const x2 = d.extendRight ? env.w : xb
    let best = Infinity
    const lines: [VpLine, number][] = [[o.poc, pocPrice(pr)], [o.vah, vahPrice(pr)], [o.val, valPrice(pr)]]
    for (const [ln, price] of lines) {
      if (!ln.on) continue
      const yl = env.p2y(price)
      if (yl != null && x >= xa - 4 && x <= x2 + 4) best = Math.min(best, Math.abs(y - yl))
    }
    return hitOrInside(env, best, inBar)
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
