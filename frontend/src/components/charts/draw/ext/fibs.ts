// 第二批：其余斐波那契（通道、时间周期、速度阻力扇、基于趋势的时间、圆、速度阻力弧）与江恩扇、江恩箱。
// 档位都可在设置里增删改（model.DEFAULT_LEVELS）。
// Batch 2: the remaining Fibonacci tools (channel, time zones, speed resistance fan, trend-based time,
// circles, speed resistance arcs) plus the Gann fan and Gann box. Levels are editable in settings.
import { type Drawing, type FibLevel, fillOf, levelsOf, showLabelOf } from '../model'
import {
  type DrawEnv, type Px, FONT, FAN_COLORS, distToSeg, extendSeg, rayEnd, stroke, guide, setDash, withAlpha, fillPoly,
  pointInPoly, fmtRatio,
} from '../paint'
import { type ToolDefs, nearest, hitOrInside } from './types'

const onLevels = (d: Drawing): FibLevel[] => levelsOf(d).filter((l) => l.on).sort((a, b) => a.v - b.v)
const colOf = (d: Drawing, l: FibLevel) => l.color || d.color

function vLine(ctx: CanvasRenderingContext2D, d: Drawing, x: number, env: DrawEnv, col: string, label: string | null) {
  ctx.strokeStyle = col
  ctx.lineWidth = d.lineWidth ?? 1
  setDash(ctx, d.lineStyle)
  ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, env.h); ctx.stroke()
  if (label) {
    ctx.save(); ctx.setLineDash([]); ctx.font = FONT; ctx.fillStyle = col; ctx.textAlign = 'left'; ctx.textBaseline = 'top'
    ctx.fillText(label, x + 4, 6); ctx.restore()
  }
}

// ── 斐波那契通道 / Fib channel ──
function fibChannelLines(d: Drawing, px: Px[], env: DrawEnv) {
  const dp = d.pts[2].p - d.pts[0].p
  const out: { l: FibLevel; s: [Px, Px] }[] = []
  for (const l of onLevels(d)) {
    const ya = env.p2y(d.pts[0].p + dp * l.v), yb = env.p2y(d.pts[1].p + dp * l.v)
    if (ya == null || yb == null) continue
    out.push({ l, s: extendSeg({ x: px[0].x, y: ya }, { x: px[1].x, y: yb }, !!d.extendLeft, !!d.extendRight, env) })
  }
  return out
}

// ── 速度阻力扇：价格扇（到右边竖边）+ 时间扇（到下 / 上边横边）/ speed fan: price rays and time rays ──
function fanRays(d: Drawing, px: Px[], env: DrawEnv) {
  const [o, p] = px
  const price: { l: FibLevel; end: Px; at: Px }[] = []
  const time: { l: FibLevel; end: Px; at: Px }[] = []
  for (const l of onLevels(d)) {
    const at = { x: p.x, y: p.y + (o.y - p.y) * l.v }
    if (Math.hypot(at.x - o.x, at.y - o.y) > 0.5) price.push({ l, at, end: rayEnd(o, at, env) })
    if (l.v > 0 && l.v < 1) {
      const at2 = { x: p.x + (o.x - p.x) * l.v, y: p.y }
      time.push({ l, at: at2, end: rayEnd(o, at2, env) })
    }
  }
  return { price, time }
}

const GANN = [{ r: 1 / 8, t: '1/8' }, { r: 1 / 4, t: '1/4' }, { r: 1 / 3, t: '1/3' }, { r: 1 / 2, t: '1/2' }, { r: 1, t: '1/1' }, { r: 2, t: '2/1' }, { r: 3, t: '3/1' }, { r: 4, t: '4/1' }, { r: 8, t: '8/1' }]
function gannRays(px: Px[], env: DrawEnv) {
  const [o, p] = px
  const dx = p.x - o.x, dy = p.y - o.y
  return GANN.map((g, i) => {
    const at = { x: o.x + dx, y: o.y + dy * g.r }
    return { ...g, at, end: rayEnd(o, at, env), col: FAN_COLORS[i] }
  })
}

const box = (px: Px[]) => {
  const x1 = Math.min(px[0].x, px[1].x), x2 = Math.max(px[0].x, px[1].x)
  const y1 = Math.min(px[0].y, px[1].y), y2 = Math.max(px[0].y, px[1].y)
  return { x1, x2, y1, y2 }
}

export const FIBS: ToolDefs = {
  fibChannel: {
    render(ctx, d, px, env) {
      const ls = fibChannelLines(d, px, env)
      if (fillOf(d)) {
        for (let i = 1; i < ls.length; i++) fillPoly(ctx, [ls[i - 1].s[0], ls[i - 1].s[1], ls[i].s[1], ls[i].s[0]], colOf(d, ls[i].l), 0.07)
      }
      ctx.font = FONT
      ctx.textBaseline = 'middle'
      for (const { l, s } of ls) {
        stroke(ctx, d, s, undefined, colOf(d, l))
        if (showLabelOf(d)) {
          const a = d.extendLeft ? s[0] : (s[0].x < s[1].x ? s[0] : s[1])
          ctx.fillStyle = colOf(d, l); ctx.textAlign = 'right'
          ctx.fillText(fmtRatio(l.v), Math.max(30, a.x - 4), a.y)
        }
      }
    },
    hit(d, px, env, x, y) {
      const ls = fibChannelLines(d, px, env)
      const ds = ls.map(({ s }) => distToSeg(x, y, s[0].x, s[0].y, s[1].x, s[1].y))
      const inside = fillOf(d) && ls.length >= 2 && pointInPoly(x, y, [ls[0].s[0], ls[0].s[1], ls[ls.length - 1].s[1], ls[ls.length - 1].s[0]])
      return hitOrInside(env, Math.min(...ds, Infinity), inside)
    },
    handles(d, px, env) {
      const y2 = env.p2y(d.pts[2].p)
      return [px[0], px[1], { x: px[0].x, y: y2 ?? NaN }]
    },
    drag(_d, i, pt, o) {
      if (i === 2) return [o[0], o[1], { t: o[0].t, p: pt.p }]
      if (i === 0) { const dp = o[2].p - o[0].p; return [pt, o[1], { t: pt.t, p: pt.p + dp }] }
      return [o[0], pt, o[2]]
    },
  },

  fibTimeZone: {
    render(ctx, d, px, env) {
      const dx = px[1].x - px[0].x
      guide(ctx, d.color, [px[0], px[1]])
      for (const l of onLevels(d)) {
        const x = px[0].x + dx * l.v
        if (x < -2 || x > env.w + 2) continue
        vLine(ctx, d, x, env, colOf(d, l), showLabelOf(d) ? fmtRatio(l.v) : null)
      }
    },
    hit(d, px, env, x, y) {
      const dx = px[1].x - px[0].x
      const ds = onLevels(d).map((l) => Math.abs(x - (px[0].x + dx * l.v)))
      return nearest(env, ...ds, distToSeg(x, y, px[0].x, px[0].y, px[1].x, px[1].y))
    },
  },

  fibFan: {
    render(ctx, d, px, env) {
      const { price, time } = fanRays(d, px, env)
      const b = box(px)
      guide(ctx, d.color, [{ x: b.x1, y: b.y1 }, { x: b.x2, y: b.y1 }, { x: b.x2, y: b.y2 }, { x: b.x1, y: b.y2 }, { x: b.x1, y: b.y1 }], 0.35)
      if (fillOf(d)) for (let i = 1; i < price.length; i++) fillPoly(ctx, [px[0], price[i - 1].end, price[i].end], colOf(d, price[i].l), 0.06)
      ctx.font = FONT
      ctx.textBaseline = 'middle'
      for (const r of [...price, ...time]) {
        const col = colOf(d, r.l)
        stroke(ctx, d, [px[0], r.end], undefined, col)
        if (showLabelOf(d)) { ctx.fillStyle = col; ctx.textAlign = 'left'; ctx.fillText(fmtRatio(r.l.v), r.at.x + 4, r.at.y) }
      }
    },
    hit(d, px, env, x, y) {
      const { price, time } = fanRays(d, px, env)
      const ds = [...price, ...time].map((r) => distToSeg(x, y, px[0].x, px[0].y, r.end.x, r.end.y))
      return nearest(env, ...ds)
    },
  },

  fibTime: {
    render(ctx, d, px, env) {
      const dx = px[1].x - px[0].x
      guide(ctx, d.color, [px[0], px[1], px[2]])
      for (const l of onLevels(d)) {
        const x = px[2].x + dx * l.v
        if (x < -2 || x > env.w + 2) continue
        vLine(ctx, d, x, env, colOf(d, l), showLabelOf(d) ? fmtRatio(l.v) : null)
      }
    },
    hit(d, px, env, x, y) {
      const dx = px[1].x - px[0].x
      const ds = onLevels(d).map((l) => Math.abs(x - (px[2].x + dx * l.v)))
      return nearest(env, ...ds, distToSeg(x, y, px[0].x, px[0].y, px[1].x, px[1].y), distToSeg(x, y, px[1].x, px[1].y, px[2].x, px[2].y))
    },
  },

  fibCircles: {
    render(ctx, d, px) {
      const c = px[0]
      const R = Math.hypot(px[1].x - c.x, px[1].y - c.y)
      guide(ctx, d.color, [px[0], px[1]])
      const ls = onLevels(d)
      if (fillOf(d)) {
        ls.forEach((l, i) => {
          if (i % 2) return
          ctx.save(); ctx.fillStyle = withAlpha(colOf(d, l), 0.06)
          ctx.beginPath(); ctx.arc(c.x, c.y, R * l.v, 0, Math.PI * 2)
          if (i > 0) ctx.arc(c.x, c.y, R * ls[i - 1].v, 0, Math.PI * 2, true)
          ctx.fill(); ctx.restore()
        })
      }
      ctx.font = FONT
      for (const l of ls) {
        const col = colOf(d, l)
        ctx.strokeStyle = col; ctx.lineWidth = d.lineWidth ?? 1; setDash(ctx, d.lineStyle)
        ctx.beginPath(); ctx.arc(c.x, c.y, R * l.v, 0, Math.PI * 2); ctx.stroke()
        if (showLabelOf(d)) { ctx.save(); ctx.setLineDash([]); ctx.fillStyle = col; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'; ctx.fillText(fmtRatio(l.v), c.x, c.y - R * l.v - 2); ctx.restore() }
      }
      ctx.setLineDash([])
    },
    hit(d, px, env, x, y) {
      const c = px[0]
      const R = Math.hypot(px[1].x - c.x, px[1].y - c.y)
      const r = Math.hypot(x - c.x, y - c.y)
      return nearest(env, ...onLevels(d).map((l) => Math.abs(r - R * l.v)), distToSeg(x, y, px[0].x, px[0].y, px[1].x, px[1].y))
    },
  },

  fibArcs: {
    render(ctx, d, px) {
      const c = px[1]
      const R = Math.hypot(px[0].x - c.x, px[0].y - c.y)
      // 弧朝起点那一侧（起点在下就画下半圆）/ arcs open toward the start point's side
      const below = px[0].y > c.y
      const [a0, a1] = below ? [0, Math.PI] : [Math.PI, Math.PI * 2]
      guide(ctx, d.color, [px[0], px[1]])
      ctx.font = FONT
      for (const l of onLevels(d)) {
        const col = colOf(d, l)
        ctx.strokeStyle = col; ctx.lineWidth = d.lineWidth ?? 1; setDash(ctx, d.lineStyle)
        ctx.beginPath(); ctx.arc(c.x, c.y, R * l.v, a0, a1); ctx.stroke()
        if (showLabelOf(d)) {
          ctx.save(); ctx.setLineDash([]); ctx.fillStyle = col; ctx.textAlign = 'center'; ctx.textBaseline = below ? 'top' : 'bottom'
          ctx.fillText(fmtRatio(l.v), c.x, c.y + (below ? 1 : -1) * (R * l.v + 2)); ctx.restore()
        }
      }
      ctx.setLineDash([])
    },
    hit(d, px, env, x, y) {
      const c = px[1]
      const R = Math.hypot(px[0].x - c.x, px[0].y - c.y)
      const below = px[0].y > c.y
      const r = Math.hypot(x - c.x, y - c.y)
      const side = below ? y >= c.y - 2 : y <= c.y + 2
      const ds = side ? onLevels(d).map((l) => Math.abs(r - R * l.v)) : []
      return nearest(env, ...ds, distToSeg(x, y, px[0].x, px[0].y, px[1].x, px[1].y))
    },
  },

  gannFan: {
    render(ctx, d, px, env) {
      ctx.font = FONT
      ctx.textBaseline = 'middle'
      for (const g of gannRays(px, env)) {
        stroke(ctx, d, [px[0], g.end], undefined, g.col)
        if (showLabelOf(d) && g.at.x >= 0 && g.at.x <= env.w && g.at.y >= 0 && g.at.y <= env.h) {
          ctx.fillStyle = g.col; ctx.textAlign = 'left'; ctx.fillText(g.t, g.at.x + 4, g.at.y)
        }
      }
    },
    hit(_d, px, env, x, y) {
      return nearest(env, ...gannRays(px, env).map((g) => distToSeg(x, y, px[0].x, px[0].y, g.end.x, g.end.y)))
    },
  },

  gannBox: {
    render(ctx, d, px) {
      const b = box(px)
      const w = b.x2 - b.x1, h = b.y2 - b.y1
      if (fillOf(d)) { ctx.fillStyle = withAlpha(d.color, 0.06); ctx.fillRect(b.x1, b.y1, w, h) }
      ctx.font = FONT
      for (const l of onLevels(d)) {
        const col = colOf(d, l)
        const x = px[0].x + (px[1].x - px[0].x) * l.v
        const y = px[0].y + (px[1].y - px[0].y) * l.v
        stroke(ctx, d, [{ x, y: b.y1 }, { x, y: b.y2 }], undefined, col)
        stroke(ctx, d, [{ x: b.x1, y }, { x: b.x2, y }], undefined, col)
        if (showLabelOf(d)) {
          ctx.save(); ctx.setLineDash([]); ctx.fillStyle = col
          ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'; ctx.fillText(fmtRatio(l.v), x, b.y1 - 2)
          ctx.textAlign = 'right'; ctx.textBaseline = 'middle'; ctx.fillText(fmtRatio(l.v), b.x1 - 4, y)
          ctx.restore()
        }
      }
      guide(ctx, d.color, [{ x: b.x1, y: b.y1 }, { x: b.x2, y: b.y2 }])
      guide(ctx, d.color, [{ x: b.x1, y: b.y2 }, { x: b.x2, y: b.y1 }])
    },
    hit(d, px, env, x, y) {
      const b = box(px)
      const ds: number[] = []
      if (x >= b.x1 - 4 && x <= b.x2 + 4 && y >= b.y1 - 4 && y <= b.y2 + 4) {
        for (const l of onLevels(d)) {
          ds.push(Math.abs(x - (px[0].x + (px[1].x - px[0].x) * l.v)), Math.abs(y - (px[0].y + (px[1].y - px[0].y) * l.v)))
        }
      }
      const inside = fillOf(d) && x >= b.x1 && x <= b.x2 && y >= b.y1 && y <= b.y2
      return hitOrInside(env, Math.min(...ds, Infinity), inside)
    },
    handles: (_d, px) => [px[0], px[1], { x: px[0].x, y: px[1].y }, { x: px[1].x, y: px[0].y }],
    drag(_d, i, pt, o) {
      if (i === 0) return [pt, o[1]]
      if (i === 1) return [o[0], pt]
      if (i === 2) return [{ t: pt.t, p: o[0].p }, { t: o[1].t, p: pt.p }]
      return [{ t: o[0].t, p: pt.p }, { t: pt.t, p: o[1].p }]
    },
  },
}
