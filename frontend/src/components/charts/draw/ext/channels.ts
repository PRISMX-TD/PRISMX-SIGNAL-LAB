// 第二批：其余通道（回归趋势、平顶 / 平底、不相交）与音叉（安德鲁斯、希夫、改良希夫、内部、音叉扇）。
// Batch 2: the remaining channels (regression trend, flat top / bottom, disjoint) and pitchforks
// (Andrews, Schiff, modified Schiff, inside, pitchfan).
import { type Drawing, fillOf, levelsOf, showLabelOf } from '../model'
import {
  type DrawEnv, type Px, FONT, FAN_COLORS, distToSeg, extendSeg, rayEnd, stroke, fillPoly, guide, lineText,
  pointInPoly, mid, lerp, fmtRatio,
} from '../paint'
import { type ToolDefs, nearest, hitOrInside } from './types'

const seg = (x: number, y: number, s: [Px, Px]) => distToSeg(x, y, s[0].x, s[0].y, s[1].x, s[1].y)
const ext = (d: Drawing, a: Px, b: Px, env: DrawEnv) => extendSeg(a, b, !!d.extendLeft, !!d.extendRight, env)

// ── 回归趋势：两点只取时间范围，价格由区间内收盘价做最小二乘，上下 ±2 个标准差 ──
// Regression trend: the two points only give the time range; least squares over the closes, ±2σ bands
const DEV = 2
function regLines(d: Drawing, px: Px[], env: DrawEnv): { c: [Px, Px]; u: [Px, Px]; l: [Px, Px]; xa: number; xb: number; at: (x: number, k: number) => number } | null {
  const t0 = Math.min(d.pts[0].t, d.pts[1].t), t1 = Math.max(d.pts[0].t, d.pts[1].t)
  const pts = env.closes?.(t0, t1) ?? []
  if (pts.length < 2) return null
  const n = pts.length
  let sx = 0, sy = 0, sxx = 0, sxy = 0
  for (const p of pts) { sx += p.x; sy += p.c; sxx += p.x * p.x; sxy += p.x * p.c }
  const den = n * sxx - sx * sx
  const m = den === 0 ? 0 : (n * sxy - sx * sy) / den
  const b = (sy - m * sx) / n
  let ss = 0
  for (const p of pts) { const r = p.c - (b + m * p.x); ss += r * r }
  const sd = Math.sqrt(ss / n)
  const xa = Math.min(px[0].x, px[1].x)
  const xb = d.extendRight ? env.w : Math.max(px[0].x, px[1].x)
  const at = (x: number, k: number) => env.p2y(b + m * x + k * DEV * sd) ?? NaN
  const line = (k: number): [Px, Px] => [{ x: xa, y: at(xa, k) }, { x: xb, y: at(xb, k) }]
  return { c: line(0), u: line(1), l: line(-1), xa, xb, at }
}

// ── 音叉：O 起点，A / B 两个叉尖；不同变体只是起点不同 / pitchforks differ only in the origin ──
function forkOrigin(d: Drawing, px: Px[]): Px {
  const [p0, a, b] = px
  switch (d.type) {
    case 'schiffPitchfork': return { x: p0.x, y: (p0.y + a.y) / 2 }
    case 'modSchiffPitchfork': return mid(p0, a)
    case 'insidePitchfork': return mid(p0, mid(a, b))
    default: return p0
  }
}
function forkLines(d: Drawing, px: Px[], env: DrawEnv) {
  const o = forkOrigin(d, px)
  const a = px[1], b = px[2]
  const m = mid(a, b)
  const ux = m.x - o.x, uy = m.y - o.y
  const median: [Px, Px] = [o, rayEnd(o, m, env)]
  const pa: [Px, Px] = [a, rayEnd(a, { x: a.x + ux, y: a.y + uy }, env)]
  const pb: [Px, Px] = [b, rayEnd(b, { x: b.x + ux, y: b.y + uy }, env)]
  return { o, m, median, pa, pb }
}

export const CHANNELS: ToolDefs = {
  regression: {
    render(ctx, d, px, env) {
      const r = regLines(d, px, env)
      if (!r) { guide(ctx, d.color, [px[0], px[1]]); return }
      if (fillOf(d)) fillPoly(ctx, [r.u[0], r.u[1], r.l[1], r.l[0]], d.color, 0.08)
      stroke(ctx, d, r.c)
      stroke(ctx, { ...d, lineStyle: 'dashed' }, r.u, 1)
      stroke(ctx, { ...d, lineStyle: 'dashed' }, r.l, 1)
      lineText(ctx, d, r.c[0], r.c[1])
    },
    hit(d, px, env, x, y) {
      const r = regLines(d, px, env)
      if (!r) return nearest(env, distToSeg(x, y, px[0].x, px[0].y, px[1].x, px[1].y))
      const inside = fillOf(d) && pointInPoly(x, y, [r.u[0], r.u[1], r.l[1], r.l[0]])
      return hitOrInside(env, Math.min(seg(x, y, r.c), seg(x, y, r.u), seg(x, y, r.l)), inside)
    },
    handles(d, px, env) {
      const r = regLines(d, px, env)
      if (!r) return px
      return px.map((p) => ({ x: p.x, y: r.at(p.x, 0) }))
    },
    // 只改时间（价格由收盘价算出来）/ only the time changes (the price comes from the closes)
    drag(_d, i, pt, o) { return o.map((p, k) => (k === i ? { t: pt.t, p: p.p } : p)) },
  },

  flatChannel: {
    render(ctx, d, px, env) {
      const [a, b] = ext(d, px[0], px[1], env)
      const fa = { x: a.x, y: px[2].y }, fb = { x: b.x, y: px[2].y }
      if (fillOf(d)) fillPoly(ctx, [a, b, fb, fa], d.color, 0.1)
      stroke(ctx, d, [a, b])
      stroke(ctx, d, [fa, fb])
      lineText(ctx, d, px[0], px[1])
    },
    hit(d, px, env, x, y) {
      const [a, b] = ext(d, px[0], px[1], env)
      const fa = { x: a.x, y: px[2].y }, fb = { x: b.x, y: px[2].y }
      return hitOrInside(env, Math.min(seg(x, y, [a, b]), seg(x, y, [fa, fb])), fillOf(d) && pointInPoly(x, y, [a, b, fb, fa]))
    },
    handles: (_d, px) => [px[0], px[1], { x: (px[0].x + px[1].x) / 2, y: px[2].y }],
    drag(_d, i, pt, o) { return i === 2 ? [o[0], o[1], { t: o[2].t, p: pt.p }] : o.map((p, k) => (k === i ? pt : p)) },
  },

  disjointChannel: {
    render(ctx, d, px, env) {
      const q = disjoint(d, px, env)
      if (!q) return
      if (fillOf(d)) fillPoly(ctx, [q.a[0], q.a[1], q.b[1], q.b[0]], d.color, 0.1)
      stroke(ctx, d, q.a)
      stroke(ctx, d, q.b)
      lineText(ctx, d, px[0], px[1])
    },
    hit(d, px, env, x, y) {
      const q = disjoint(d, px, env)
      if (!q) return null
      return hitOrInside(env, Math.min(seg(x, y, q.a), seg(x, y, q.b)), fillOf(d) && pointInPoly(x, y, [q.a[0], q.a[1], q.b[1], q.b[0]]))
    },
    handles(d, px, env) { const q = disjoint(d, px, env); return [px[0], px[1], q ? q.b[0] : px[2]] },
    drag(_d, i, pt, o) { return i === 2 ? [o[0], o[1], { t: o[0].t, p: pt.p }] : o.map((p, k) => (k === i ? pt : p)) },
  },

  pitchfork: forkDef(),
  schiffPitchfork: forkDef(),
  modSchiffPitchfork: forkDef(),
  insidePitchfork: forkDef(),

  pitchfan: {
    render(ctx, d, px, env) {
      const [o, a, b] = px
      const lv = levelsOf(d).filter((l) => l.on).sort((x, y) => x.v - y.v)
      const ends = lv.map((l) => rayEnd(o, lerp(a, b, l.v), env))
      if (fillOf(d) && ends.length >= 2) fillPoly(ctx, [o, ends[0], ends[ends.length - 1]], d.color, 0.06)
      stroke(ctx, d, [a, b])
      ctx.font = FONT
      ctx.textBaseline = 'middle'
      lv.forEach((l, i) => {
        const col = l.color || FAN_COLORS[i % FAN_COLORS.length]
        stroke(ctx, d, [o, ends[i]], undefined, col)
        if (showLabelOf(d)) {
          const p = lerp(a, b, l.v)
          ctx.fillStyle = col
          ctx.textAlign = 'left'
          ctx.fillText(fmtRatio(l.v), p.x + 6, p.y)
        }
      })
    },
    hit(d, px, env, x, y) {
      const [o, a, b] = px
      const ds = [distToSeg(x, y, a.x, a.y, b.x, b.y)]
      for (const l of levelsOf(d)) if (l.on) { const e = rayEnd(o, lerp(a, b, l.v), env); ds.push(distToSeg(x, y, o.x, o.y, e.x, e.y)) }
      return nearest(env, ...ds)
    },
  },
}

function disjoint(d: Drawing, px: Px[], env: DrawEnv): { a: [Px, Px]; b: [Px, Px] } | null {
  const yb0 = env.p2y(d.pts[2].p)
  const yb1 = env.p2y(d.pts[2].p - (d.pts[1].p - d.pts[0].p))
  if (yb0 == null || yb1 == null) return null
  return {
    a: ext(d, px[0], px[1], env),
    b: ext(d, { x: px[0].x, y: yb0 }, { x: px[1].x, y: yb1 }, env),
  }
}

function forkDef(): NonNullable<ToolDefs['pitchfork']> {
  return {
    render(ctx, d, px, env) {
      const f = forkLines(d, px, env)
      if (fillOf(d)) fillPoly(ctx, [f.pa[0], f.pa[1], f.pb[1], f.pb[0]], d.color, 0.07)
      guide(ctx, d.color, [px[0], f.o, f.m])
      stroke(ctx, d, [px[1], px[2]])
      stroke(ctx, d, f.median)
      stroke(ctx, d, f.pa)
      stroke(ctx, d, f.pb)
      lineText(ctx, d, f.o, f.m)
    },
    hit(d, px, env, x, y) {
      const f = forkLines(d, px, env)
      const dist = Math.min(seg(x, y, f.median), seg(x, y, f.pa), seg(x, y, f.pb), distToSeg(x, y, px[1].x, px[1].y, px[2].x, px[2].y))
      return hitOrInside(env, dist, fillOf(d) && pointInPoly(x, y, [f.pa[0], f.pa[1], f.pb[1], f.pb[0]]))
    },
  }
}
