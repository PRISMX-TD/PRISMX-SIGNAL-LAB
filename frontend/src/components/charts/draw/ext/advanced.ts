// 第三批：斐波那契螺旋、斐波那契楔形、江恩正方（可调档位 / 固定 1/8 档、画的时候锁成正方形）。
// Batch 3: Fibonacci spiral, Fibonacci wedge, Gann square (editable levels) and Gann square fixed
// (1/8 levels, kept square while drawing).
import { type Drawing, type FibLevel, fillOf, levelsOf, showLabelOf } from '../model'
import {
  type DrawEnv, type Px, FONT, FAN_COLORS, distToSeg, stroke, guide, withAlpha, setDash, distToPolyline, fmtRatio, spacer,
} from '../paint'
import { type ToolDefs, nearest, hitOrInside } from './types'

const onLevels = (d: Drawing): FibLevel[] => levelsOf(d).filter((l) => l.on).sort((a, b) => a.v - b.v)
const PHI = (1 + Math.sqrt(5)) / 2

// ── 斐波那契螺旋：圆心 p0，p1 定起始半径和方向；每转 90° 半径乘 φ（黄金螺旋）──
// Fib spiral: centre p0, p1 gives the starting radius and direction; the radius grows by φ every quarter turn
export function spiralPts(px: Px[], env: DrawEnv): Px[] {
  const [c, p] = px
  const r0 = Math.hypot(p.x - c.x, p.y - c.y)
  if (!(r0 > 0)) return [c]
  const a0 = Math.atan2(p.y - c.y, p.x - c.x)
  // 画到半径超过画布对角线为止，往里画到不足 1px / out until past the pane diagonal, in until under 1px
  const rMax = Math.hypot(env.w, env.h) * 1.2
  const thMax = Math.log(rMax / r0) / Math.log(PHI) * (Math.PI / 2)
  const thMin = r0 > 1 ? -Math.log(r0) / Math.log(PHI) * (Math.PI / 2) : 0
  const out: Px[] = []
  const steps = 360
  for (let i = 0; i <= steps; i++) {
    const th = thMin + (Math.max(thMax, 0) - thMin) * (i / steps)
    const r = r0 * Math.pow(PHI, th / (Math.PI / 2))
    // 屏幕 y 朝下：角度减小 = 逆时针 / screen y points down: a decreasing angle turns counter-clockwise
    out.push({ x: c.x + r * Math.cos(a0 - th), y: c.y + r * Math.sin(a0 - th) })
  }
  return out
}

// ── 斐波那契楔形：圆心 p0，p1 定第一条边和半径，p2 定第二条边方向；各档位画成楔形里的弧 ──
// Fib wedge: centre p0, p1 the first edge and radius, p2 the second edge's direction; levels are arcs inside
export function wedgeOf(px: Px[]) {
  const c = px[0]
  const R = Math.hypot(px[1].x - c.x, px[1].y - c.y)
  const a1 = Math.atan2(px[1].y - c.y, px[1].x - c.x)
  let sweep = Math.atan2(px[2].y - c.y, px[2].x - c.x) - a1
  while (sweep > Math.PI) sweep -= Math.PI * 2
  while (sweep < -Math.PI) sweep += Math.PI * 2
  return { c, R, a1, a2: a1 + sweep, ccw: sweep < 0, end2: { x: c.x + R * Math.cos(a1 + sweep), y: c.y + R * Math.sin(a1 + sweep) } }
}
const angIn = (a: number, a1: number, a2: number) => {
  const lo = Math.min(a1, a2), hi = Math.max(a1, a2)
  for (const k of [-2, 0, 2]) { const v = a + k * Math.PI; if (v >= lo && v <= hi) return true }
  return false
}

// ── 江恩正方：p0 一角、p1 对角；网格 + 从 p0 出发的角度线 + 以 p0 为圆心的弧（按方框比例压成椭圆弧）──
// Gann square: p0 one corner, p1 the opposite; grid, angle lines from p0, and arcs around p0 (scaled to the box)
function gannSquare(ctx: CanvasRenderingContext2D, d: Drawing, px: Px[]) {
  const [a, b] = px
  const w = b.x - a.x, h = b.y - a.y
  const x1 = Math.min(a.x, b.x), y1 = Math.min(a.y, b.y)
  const lv = onLevels(d)
  if (fillOf(d)) { ctx.fillStyle = withAlpha(d.color, 0.05); ctx.fillRect(x1, y1, Math.abs(w), Math.abs(h)) }
  ctx.font = FONT
  const fit = spacer()
  for (const l of lv) {
    const col = l.color || d.color
    const x = a.x + w * l.v, y = a.y + h * l.v
    stroke(ctx, d, [{ x, y: a.y }, { x, y: b.y }], 1, withAlpha(col, 0.55))
    stroke(ctx, d, [{ x: a.x, y }, { x: b.x, y }], 1, withAlpha(col, 0.55))
    const txt = fmtRatio(l.v), tw = ctx.measureText(txt).width
    if (showLabelOf(d) && l.v > 0 && fit(x - tw / 2 - 2, x + tw / 2 + 2)) {
      ctx.save(); ctx.setLineDash([]); ctx.fillStyle = col
      ctx.textAlign = 'center'; ctx.textBaseline = h > 0 ? 'top' : 'bottom'; ctx.fillText(txt, x, b.y + (h > 0 ? 3 : -3))
      ctx.restore()
    }
  }
  // 角度线：p0 到对边上的各档位点 / angle lines from p0 to each level on the far edges
  lv.forEach((l, i) => {
    if (l.v <= 0) return
    const col = FAN_COLORS[i % FAN_COLORS.length]
    stroke(ctx, d, [a, { x: b.x, y: a.y + h * l.v }], undefined, col)
    if (l.v < 1) stroke(ctx, d, [a, { x: a.x + w * l.v, y: b.y }], undefined, col)
  })
  // 弧：以 p0 为圆心、半径 = 档位 × 边长，只画方框内那四分之一 / arcs: radius = level × side, the quarter inside
  ctx.save()
  ctx.strokeStyle = withAlpha(d.color, 0.8); ctx.lineWidth = d.lineWidth ?? 1; setDash(ctx, d.lineStyle)
  for (const l of lv) {
    if (l.v <= 0) continue
    ctx.beginPath()
    for (let k = 0; k <= 32; k++) {
      const th = (Math.PI / 2) * (k / 32)
      const x = a.x + w * l.v * Math.cos(th), y = a.y + h * l.v * Math.sin(th)
      if (x < x1 - 0.5 || x > x1 + Math.abs(w) + 0.5) continue
      if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y)
    }
    ctx.stroke()
  }
  ctx.restore()
  ctx.save(); ctx.setLineDash([]); ctx.strokeStyle = d.color; ctx.lineWidth = d.lineWidth ?? 1
  ctx.strokeRect(x1, y1, Math.abs(w), Math.abs(h)); ctx.restore()
}
function gannSquareHit(d: Drawing, px: Px[], env: DrawEnv, x: number, y: number): number | null {
  const [a, b] = px
  const w = b.x - a.x, h = b.y - a.y
  const x1 = Math.min(a.x, b.x), x2 = Math.max(a.x, b.x), y1 = Math.min(a.y, b.y), y2 = Math.max(a.y, b.y)
  if (x < x1 - 8 || x > x2 + 8 || y < y1 - 8 || y > y2 + 8) return null
  const ds = [Math.abs(x - x1), Math.abs(x - x2), Math.abs(y - y1), Math.abs(y - y2)]
  for (const l of onLevels(d)) if (l.v > 0) ds.push(distToSeg(x, y, a.x, a.y, b.x, a.y + h * l.v), distToSeg(x, y, a.x, a.y, a.x + w * l.v, b.y))
  return hitOrInside(env, Math.min(...ds), fillOf(d) && x >= x1 && x <= x2 && y >= y1 && y <= y2)
}

export const ADVANCED: ToolDefs = {
  fibSpiral: {
    render(ctx, d, px, env) {
      const pts = spiralPts(px, env)
      guide(ctx, d.color, [px[0], px[1]])
      stroke(ctx, d, pts)
    },
    hit(_d, px, env, x, y) { return nearest(env, distToPolyline(x, y, spiralPts(px, env)), distToSeg(x, y, px[0].x, px[0].y, px[1].x, px[1].y)) },
  },

  fibWedge: {
    render(ctx, d, px) {
      const g = wedgeOf(px)
      const lv = onLevels(d)
      // 相邻档位之间交替填色 / alternate fills between neighbouring levels
      if (fillOf(d)) {
        let prev = 0
        lv.forEach((l, i) => {
          ctx.beginPath()
          ctx.arc(g.c.x, g.c.y, g.R * l.v, g.a1, g.a2, g.ccw)
          ctx.arc(g.c.x, g.c.y, g.R * prev, g.a2, g.a1, !g.ccw)
          ctx.closePath()
          ctx.fillStyle = withAlpha(l.color || d.color, i % 2 ? 0.05 : 0.11)
          ctx.fill()
          prev = l.v
        })
      }
      ctx.font = FONT
      for (const l of lv) {
        const col = l.color || d.color
        ctx.save()
        ctx.strokeStyle = col; ctx.lineWidth = d.lineWidth ?? 1; setDash(ctx, d.lineStyle)
        ctx.beginPath(); ctx.arc(g.c.x, g.c.y, g.R * l.v, g.a1, g.a2, g.ccw); ctx.stroke()
        if (showLabelOf(d)) {
          ctx.setLineDash([]); ctx.fillStyle = col; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'
          ctx.fillText(fmtRatio(l.v), g.c.x + g.R * l.v * Math.cos(g.a1) + 4, g.c.y + g.R * l.v * Math.sin(g.a1))
        }
        ctx.restore()
      }
      stroke(ctx, d, [g.c, px[1]])
      stroke(ctx, d, [g.c, g.end2])
    },
    hit(d, px, env, x, y) {
      const g = wedgeOf(px)
      const dc = Math.hypot(x - g.c.x, y - g.c.y)
      const inAng = angIn(Math.atan2(y - g.c.y, x - g.c.x), g.a1, g.a2)
      const ds = [distToSeg(x, y, g.c.x, g.c.y, px[1].x, px[1].y), distToSeg(x, y, g.c.x, g.c.y, g.end2.x, g.end2.y)]
      if (inAng) for (const l of onLevels(d)) ds.push(Math.abs(dc - g.R * l.v))
      const maxR = g.R * Math.max(1, ...onLevels(d).map((l) => l.v))
      return hitOrInside(env, Math.min(...ds), fillOf(d) && inAng && dc <= maxR)
    },
    // 第三个手柄放在第二条边的末端（半径与第一条边相同）/ the third handle sits at the end of the second edge
    handles: (_d, px) => [px[0], px[1], wedgeOf(px).end2],
  },

  gannSquare: {
    render: (ctx, d, px) => gannSquare(ctx, d, px),
    hit: gannSquareHit,
  },
  // 固定版：DrawLayer 在画和拉手柄时把它锁成屏幕上的正方形 / DrawLayer keeps it square on screen while drawing / dragging
  gannSquareFixed: {
    render: (ctx, d, px) => gannSquare(ctx, d, px),
    hit: gannSquareHit,
  },
}
