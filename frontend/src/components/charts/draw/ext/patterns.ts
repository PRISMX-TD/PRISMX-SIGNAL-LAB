// 第二批：谐波与形态（XABCD、Cypher、ABCD、头肩、三角形、三推）、艾略特波浪 5 种、周期线 / 时间周期 / 正弦线。
// Batch 2: harmonic and chart patterns (XABCD, Cypher, ABCD, head & shoulders, triangle, three drives),
// five Elliott wave tools, and cyclic lines / time cycles / sine line.
import { type Drawing, fillOf } from '../model'
import {
  type DrawEnv, type Px, distToSeg, rayEnd, stroke, guide, fillPoly, pointTag, midTag, labelColors,
  distToPolyline, pointInPoly, withAlpha, setDash, fmtRatio,
} from '../paint'
import { type ToolDefs, nearest, hitOrInside } from './types'

const TAG_FG = '#0b0e14'
// 点是局部高点就把字母放上面 / labels go above local highs
function isHigh(px: Px[], i: number): boolean {
  const prev = px[i - 1], next = px[i + 1]
  if (prev && next) return px[i].y <= Math.min(prev.y, next.y) || (px[i].y < prev.y && px[i].y < next.y)
  const nb = prev ?? next
  return nb ? px[i].y <= nb.y : true
}
function tags(ctx: CanvasRenderingContext2D, d: Drawing, px: Px[], names: string[]) {
  names.forEach((n, i) => { if (n && px[i]) pointTag(ctx, n, px[i], isHigh(px, i), TAG_FG, d.color) })
}
const ratio = (a: number, b: number) => (b === 0 ? '—' : fmtRatio(Math.abs(a / b)))

// ── 谐波：XABCD / Cypher ──
function harmonic(cypher: boolean): NonNullable<ToolDefs['xabcd']> {
  return {
    render(ctx, d, px, env) {
      const [X, A, B, C, D] = px
      const [x, a, b, c, dd] = d.pts.map((p) => p.p)
      const { bg, fg } = labelColors(env)
      if (fillOf(d)) { fillPoly(ctx, [X, A, B], d.color, 0.12); fillPoly(ctx, [B, C, D], d.color, 0.12) }
      stroke(ctx, d, px)
      if (cypher) {
        guide(ctx, d.color, [X, B]); midTag(ctx, ratio(b - a, a - x), X, B, fg, bg)
        guide(ctx, d.color, [X, C]); midTag(ctx, ratio(c - a, a - x), X, C, fg, bg)
        guide(ctx, d.color, [B, D]); midTag(ctx, ratio(dd - c, c - b), B, D, fg, bg)
        guide(ctx, d.color, [X, D]); midTag(ctx, ratio(dd - c, c - x), X, D, fg, bg)
      } else {
        guide(ctx, d.color, [X, B]); midTag(ctx, ratio(b - a, a - x), X, B, fg, bg)
        guide(ctx, d.color, [A, C]); midTag(ctx, ratio(c - b, b - a), A, C, fg, bg)
        guide(ctx, d.color, [B, D]); midTag(ctx, ratio(dd - c, c - b), B, D, fg, bg)
        guide(ctx, d.color, [X, D]); midTag(ctx, ratio(dd - a, a - x), X, D, fg, bg)
      }
      tags(ctx, d, px, ['X', 'A', 'B', 'C', 'D'])
    },
    hit(d, px, env, x, y) {
      const [X, A, B, C, D] = px
      const inside = fillOf(d) && (pointInPoly(x, y, [X, A, B]) || pointInPoly(x, y, [B, C, D]))
      return hitOrInside(env, distToPolyline(x, y, px), inside)
    },
  }
}

// ── 折线 + 每个点一个标签（ABCD、三推、艾略特）/ a polyline with a tag on each point ──
function labelled(names: string[], extra?: (ctx: CanvasRenderingContext2D, d: Drawing, px: Px[], env: DrawEnv) => void): NonNullable<ToolDefs['abcd']> {
  return {
    render(ctx, d, px, env) {
      stroke(ctx, d, px)
      extra?.(ctx, d, px, env)
      tags(ctx, d, px, names)
    },
    hit(_d, px, env, x, y) { return nearest(env, distToPolyline(x, y, px)) },
  }
}

// 头肩：颈线过第 3、5 个点，延到首尾两点的横坐标 / neckline through points 3 and 5, out to the first and last x
function neckline(px: Px[]): [Px, Px] {
  const a = px[2], b = px[4]
  const k = b.x === a.x ? 0 : (b.y - a.y) / (b.x - a.x)
  const yAt = (x: number) => a.y + k * (x - a.x)
  return [{ x: px[0].x, y: yAt(px[0].x) }, { x: px[6].x, y: yAt(px[6].x) }]
}

// 三角形形态：A→C 和 B→D 两条边往右延长 / triangle pattern: the A→C and B→D sides extended right
function triSides(px: Px[], env: DrawEnv): { ac: [Px, Px]; bd: [Px, Px] } {
  const [A, B, C, D] = px
  // 两边交点在右边就停在交点，否则画到边上 / stop at the apex when it lies to the right
  const den = (A.x - C.x) * (B.y - D.y) - (A.y - C.y) * (B.x - D.x)
  if (Math.abs(den) > 1e-6) {
    const t = ((A.x - B.x) * (B.y - D.y) - (A.y - B.y) * (B.x - D.x)) / den
    const apex = { x: A.x + t * (C.x - A.x), y: A.y + t * (C.y - A.y) }
    if (apex.x > Math.max(C.x, D.x) && apex.x < env.w * 3) return { ac: [A, apex], bd: [B, apex] }
  }
  return { ac: [A, rayEnd(A, C, env)], bd: [B, rayEnd(B, D, env)] }
}

const ELLIOTT: Record<string, string[]> = {
  elliottImpulse: ['(0)', '(1)', '(2)', '(3)', '(4)', '(5)'],
  elliottCorrection: ['(0)', '(A)', '(B)', '(C)'],
  elliottTriangle: ['(0)', '(A)', '(B)', '(C)', '(D)', '(E)'],
  elliottDouble: ['(0)', '(W)', '(X)', '(Y)'],
  elliottTriple: ['(0)', '(W)', '(X)', '(Y)', '(X)', '(Z)'],
}

// ── 周期 / cycles ──
const MIN_STEP = 3
function cycleXs(px: Px[], env: DrawEnv): number[] {
  const step = Math.abs(px[1].x - px[0].x)
  if (step < MIN_STEP) return [px[0].x]
  const x0 = Math.min(px[0].x, px[1].x)
  const out: number[] = []
  for (let x = x0; x <= env.w + step && out.length < 400; x += step) out.push(x)
  return out
}
function sineY(px: Px[]): (x: number) => number {
  const half = Math.max(2, Math.abs(px[1].x - px[0].x))
  const amp = (px[0].y - px[1].y) / 2
  const midY = (px[0].y + px[1].y) / 2
  return (x) => midY + amp * Math.cos(Math.PI * (x - px[0].x) / half)
}

export const PATTERNS: ToolDefs = {
  xabcd: harmonic(false),
  cypher: harmonic(true),
  abcd: labelled(['A', 'B', 'C', 'D'], (ctx, d, px, env) => {
    const [A, B, C, D] = px
    const [a, b, c, dd] = d.pts.map((p) => p.p)
    const { bg, fg } = labelColors(env)
    guide(ctx, d.color, [A, C]); midTag(ctx, ratio(c - b, b - a), A, C, fg, bg)
    guide(ctx, d.color, [B, D]); midTag(ctx, ratio(dd - c, c - b), B, D, fg, bg)
  }),
  headShoulders: {
    render(ctx, d, px, env) {
      const nk = neckline(px)
      if (fillOf(d)) fillPoly(ctx, [nk[0], ...px.slice(1, 6), nk[1]], d.color, 0.1)
      stroke(ctx, d, px)
      stroke(ctx, { ...d, lineStyle: 'dashed' }, nk, 1)
      const up = px[3].y < nk[0].y + (nk[1].y - nk[0].y) * ((px[3].x - nk[0].x) / ((nk[1].x - nk[0].x) || 1))
      const L = env.L
      ;[[1, L.ls ?? 'LS'], [3, L.hd ?? 'H'], [5, L.rs ?? 'RS']].forEach(([i, n]) => pointTag(ctx, String(n), px[i as number], up, TAG_FG, d.color))
    },
    hit(d, px, env, x, y) {
      const nk = neckline(px)
      const dist = Math.min(distToPolyline(x, y, px), distToSeg(x, y, nk[0].x, nk[0].y, nk[1].x, nk[1].y))
      return hitOrInside(env, dist, fillOf(d) && pointInPoly(x, y, [nk[0], ...px.slice(1, 6), nk[1]]))
    },
  },
  trianglePattern: {
    render(ctx, d, px, env) {
      const s = triSides(px, env)
      if (fillOf(d)) fillPoly(ctx, [s.ac[0], s.ac[1], s.bd[0]], d.color, 0.1)
      stroke(ctx, d, px)
      stroke(ctx, { ...d, lineStyle: 'dashed' }, s.ac, 1)
      stroke(ctx, { ...d, lineStyle: 'dashed' }, s.bd, 1)
      tags(ctx, d, px, ['A', 'B', 'C', 'D'])
    },
    hit(d, px, env, x, y) {
      const s = triSides(px, env)
      const dist = Math.min(distToPolyline(x, y, px), distToSeg(x, y, s.ac[0].x, s.ac[0].y, s.ac[1].x, s.ac[1].y), distToSeg(x, y, s.bd[0].x, s.bd[0].y, s.bd[1].x, s.bd[1].y))
      return hitOrInside(env, dist, fillOf(d) && pointInPoly(x, y, [s.ac[0], s.ac[1], s.bd[0]]))
    },
  },
  threeDrives: labelled(['', '1', '', '2', '', '3', ''], (ctx, d, px, env) => {
    const { bg, fg } = labelColors(env)
    const p = d.pts.map((q) => q.p)
    // 回撤 / 延伸比例写在虚线上 / retracement / extension ratios on the guides
    guide(ctx, d.color, [px[1], px[3]]); midTag(ctx, ratio(p[3] - p[2], p[2] - p[1]), px[1], px[3], fg, bg)
    guide(ctx, d.color, [px[3], px[5]]); midTag(ctx, ratio(p[5] - p[4], p[4] - p[3]), px[3], px[5], fg, bg)
  }),
  elliottImpulse: labelled(ELLIOTT.elliottImpulse),
  elliottCorrection: labelled(ELLIOTT.elliottCorrection),
  elliottTriangle: labelled(ELLIOTT.elliottTriangle),
  elliottDouble: labelled(ELLIOTT.elliottDouble),
  elliottTriple: labelled(ELLIOTT.elliottTriple),

  cyclicLines: {
    render(ctx, d, px, env) {
      guide(ctx, d.color, [px[0], px[1]])
      ctx.strokeStyle = d.color; ctx.lineWidth = d.lineWidth ?? 1; setDash(ctx, d.lineStyle)
      ctx.beginPath()
      for (const x of cycleXs(px, env)) { ctx.moveTo(x, 0); ctx.lineTo(x, env.h) }
      ctx.stroke()
      ctx.setLineDash([])
    },
    hit(_d, px, env, x, y) {
      return nearest(env, ...cycleXs(px, env).map((cx) => Math.abs(x - cx)), distToSeg(x, y, px[0].x, px[0].y, px[1].x, px[1].y))
    },
  },
  timeCycles: {
    render(ctx, d, px, env) {
      const xs = cycleXs(px, env)
      const r = Math.abs(px[1].x - px[0].x) / 2
      const y = px[0].y
      if (r < 1.5) return
      ctx.strokeStyle = d.color; ctx.lineWidth = d.lineWidth ?? 1; setDash(ctx, d.lineStyle)
      for (const x of xs) {
        ctx.beginPath(); ctx.arc(x + r, y, r, Math.PI, Math.PI * 2)
        if (fillOf(d)) { ctx.save(); ctx.fillStyle = withAlpha(d.color, 0.07); ctx.fill(); ctx.restore() }
        ctx.stroke()
      }
      ctx.setLineDash([])
      stroke(ctx, { ...d, lineStyle: 'dotted' }, [{ x: xs[0], y }, { x: env.w, y }], 1)
    },
    hit(d, px, env, x, y) {
      const r = Math.abs(px[1].x - px[0].x) / 2
      const by = px[0].y
      if (r < 1.5) return null
      const ds: number[] = []
      for (const cx of cycleXs(px, env)) if (y <= by + 2) ds.push(Math.abs(Math.hypot(x - (cx + r), y - by) - r))
      return hitOrInside(env, Math.min(...ds, Infinity), fillOf(d) && y <= by && cycleXs(px, env).some((cx) => Math.hypot(x - (cx + r), y - by) <= r))
    },
  },
  sineLine: {
    render(ctx, d, px, env) {
      const f = sineY(px)
      ctx.strokeStyle = d.color; ctx.lineWidth = d.lineWidth ?? 1; setDash(ctx, d.lineStyle)
      ctx.beginPath()
      for (let x = 0; x <= env.w; x += 2) { const y = f(x); if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y) }
      ctx.stroke()
      ctx.setLineDash([])
    },
    hit(_d, px, env, x, y) { return nearest(env, Math.abs(y - sineY(px)(x))) },
  },
}
