// 第二批：荧光笔、箭头标记（大箭头 / 向上 / 向下）、旋转矩形、路径、圆、椭圆、折线、三角形、弧、曲线、
// 双曲线、扇区，以及「预测」工具。
// Batch 2: highlighter, arrow markers (big arrow / up / down), rotated rectangle, path, circle, ellipse,
// polyline, triangle, arc, curve, double curve, sector, and the forecast tool.
import { type Drawing, fillOf, showLabelOf } from '../model'
import {
  type Px, UP, DOWN, stroke, fillPoly, setDash, withAlpha, arrowHead, lineText, centerText, labelBox,
  distToSeg, distToPolyline, pointInPoly, quadThrough, mid, pct, signed,
} from '../paint'
import { type ToolDefs, nearest, hitOrInside } from './types'

function outline(ctx: CanvasRenderingContext2D, d: Drawing, pts: Px[], closed: boolean, fill: boolean, alpha = 0.14) {
  if (fill && pts.length > 2) fillPoly(ctx, pts, d.color, alpha)
  ctx.strokeStyle = d.color
  ctx.lineWidth = d.lineWidth ?? 1
  ctx.lineJoin = 'round'
  setDash(ctx, d.lineStyle)
  ctx.beginPath()
  pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)))
  if (closed) ctx.closePath()
  ctx.stroke()
  ctx.setLineDash([])
}
const centroid = (pts: Px[]): Px => ({ x: pts.reduce((s, p) => s + p.x, 0) / pts.length, y: pts.reduce((s, p) => s + p.y, 0) / pts.length })

// 平滑笔画（荧光笔）/ smooth stroke (highlighter)
function smooth(ctx: CanvasRenderingContext2D, px: Px[]) {
  ctx.beginPath(); ctx.moveTo(px[0].x, px[0].y)
  for (let i = 1; i < px.length - 1; i++) ctx.quadraticCurveTo(px[i].x, px[i].y, (px[i].x + px[i + 1].x) / 2, (px[i].y + px[i + 1].y) / 2)
  ctx.lineTo(px[px.length - 1].x, px[px.length - 1].y)
}
const hlWidth = (d: Drawing) => Math.max(10, (d.lineWidth ?? 1) * 8)

// 大箭头：箭杆 + 箭头，宽度跟长度走 / big arrow: shaft and head, width follows length
function bigArrow(a: Px, b: Px): Px[] {
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1
  const ux = (b.x - a.x) / len, uy = (b.y - a.y) / len
  const nx = -uy, ny = ux
  const headL = Math.min(len * 0.5, Math.max(14, len * 0.32))
  const headW = Math.max(9, Math.min(28, len * 0.18))
  const shaftW = headW * 0.42
  const hb = { x: b.x - ux * headL, y: b.y - uy * headL }
  return [
    { x: a.x + nx * shaftW, y: a.y + ny * shaftW }, { x: hb.x + nx * shaftW, y: hb.y + ny * shaftW },
    { x: hb.x + nx * headW, y: hb.y + ny * headW }, b,
    { x: hb.x - nx * headW, y: hb.y - ny * headW }, { x: hb.x - nx * shaftW, y: hb.y - ny * shaftW },
    { x: a.x - nx * shaftW, y: a.y - ny * shaftW },
  ]
}
// 向上 / 向下的小箭头，尖端在点上 / small up / down arrow with its tip on the point
function markArrow(p: Px, up: boolean): Px[] {
  const s = up ? 1 : -1
  return [
    p, { x: p.x - 9, y: p.y + s * 11 }, { x: p.x - 4, y: p.y + s * 11 }, { x: p.x - 4, y: p.y + s * 26 },
    { x: p.x + 4, y: p.y + s * 26 }, { x: p.x + 4, y: p.y + s * 11 }, { x: p.x + 9, y: p.y + s * 11 },
  ]
}

// 旋转矩形：p0→p1 是中轴，p2 到中轴的垂直距离是半宽 / rotated rect: p0→p1 is the axis, p2's distance is half-width
function rotRect(px: Px[]): Px[] {
  const [a, b, c] = px
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1
  const nx = -(b.y - a.y) / len, ny = (b.x - a.x) / len
  const w = (c.x - a.x) * nx + (c.y - a.y) * ny
  return [
    { x: a.x + nx * w, y: a.y + ny * w }, { x: b.x + nx * w, y: b.y + ny * w },
    { x: b.x - nx * w, y: b.y - ny * w }, { x: a.x - nx * w, y: a.y - ny * w },
  ]
}

function ellipseOf(px: Px[]) {
  return { cx: (px[0].x + px[1].x) / 2, cy: (px[0].y + px[1].y) / 2, rx: Math.abs(px[1].x - px[0].x) / 2, ry: Math.abs(px[1].y - px[0].y) / 2 }
}

// 双曲线（S 形）：前半段经过 p2，后半段经过 p2 关于中点的对称点 / S curve: first half through p2, second through its mirror
function doubleCurve(px: Px[]): Px[] {
  const m = mid(px[0], px[1])
  const mirror = { x: 2 * m.x - px[2].x, y: 2 * m.y - px[2].y }
  return [...quadThrough(px[0], m, px[2], 24), ...quadThrough(m, px[1], mirror, 24).slice(1)]
}

// 扇区：圆心 p0，半径到 p1，从 p1 的方向扫到 p2 的方向（取较小的那边）
// Sector: centre p0, radius to p1, swept from p1's direction to p2's (the smaller way round)
function sectorOf(px: Px[]) {
  const c = px[0]
  const r = Math.hypot(px[1].x - c.x, px[1].y - c.y)
  const a1 = Math.atan2(px[1].y - c.y, px[1].x - c.x)
  let a2 = Math.atan2(px[2].y - c.y, px[2].x - c.x)
  let sweep = a2 - a1
  while (sweep > Math.PI) sweep -= Math.PI * 2
  while (sweep < -Math.PI) sweep += Math.PI * 2
  a2 = a1 + sweep
  return { c, r, a1, a2, ccw: sweep < 0 }
}
const angIn = (a: number, a1: number, a2: number) => {
  const lo = Math.min(a1, a2), hi = Math.max(a1, a2)
  for (const k of [-2, 0, 2]) { const v = a + k * Math.PI; if (v >= lo && v <= hi) return true }
  return false
}

export const SHAPES: ToolDefs = {
  highlighter: {
    render(ctx, d, px) {
      if (px.length < 2) return
      ctx.save()
      ctx.strokeStyle = withAlpha(d.color, 0.35)
      ctx.lineWidth = hlWidth(d)
      ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.setLineDash([])
      smooth(ctx, px)
      ctx.stroke()
      ctx.restore()
    },
    hit(d, px, env, x, y) {
      const dist = distToPolyline(x, y, px) - hlWidth(d) / 2
      return nearest(env, Math.max(0, dist))
    },
    handles: () => [],
  },

  arrowMarker: {
    render(ctx, d, px) {
      const poly = bigArrow(px[0], px[1])
      fillPoly(ctx, poly, d.color, 0.9)
      if (d.text) {
        ctx.save(); ctx.font = `${d.fontSize ?? 14}px system-ui, sans-serif`; ctx.fillStyle = d.textColor || d.color
        ctx.textAlign = 'center'; ctx.textBaseline = px[0].y >= px[1].y ? 'top' : 'bottom'
        ctx.fillText(d.text, px[0].x, px[0].y + (px[0].y >= px[1].y ? 6 : -6)); ctx.restore()
      }
    },
    hit(_d, px, env, x, y) {
      const poly = bigArrow(px[0], px[1])
      return pointInPoly(x, y, poly) ? 0 : nearest(env, distToPolyline(x, y, poly, true))
    },
  },
  arrowUp: markDef(true),
  arrowDown: markDef(false),

  rotatedRect: {
    render(ctx, d, px) {
      const r = rotRect(px)
      outline(ctx, d, r, true, fillOf(d))
      centerText(ctx, d, mid(px[0], px[1]))
    },
    hit(d, px, env, x, y) {
      const r = rotRect(px)
      return hitOrInside(env, distToPolyline(x, y, r, true), fillOf(d) && pointInPoly(x, y, r))
    },
    handles(_d, px) {
      const r = rotRect(px)
      return [px[0], px[1], mid(r[0], r[1])]
    },
  },

  path: {
    render(ctx, d, px) {
      if (px.length < 2) return
      outline(ctx, d, px, false, false)
      arrowHead(ctx, px[px.length - 2], px[px.length - 1], 8 + (d.lineWidth ?? 1) * 2, d.color)
      lineText(ctx, d, px[0], px[1])
    },
    hit(_d, px, env, x, y) { return nearest(env, distToPolyline(x, y, px)) },
  },
  polyline: {
    render(ctx, d, px) {
      if (px.length < 2) return
      outline(ctx, d, px, !!d.closed, !!d.closed && fillOf(d))
      if (d.closed) centerText(ctx, d, centroid(px))
      else lineText(ctx, d, px[0], px[1])
    },
    hit(d, px, env, x, y) {
      return hitOrInside(env, distToPolyline(x, y, px, !!d.closed), !!d.closed && fillOf(d) && pointInPoly(x, y, px))
    },
  },
  triangle: {
    render(ctx, d, px) { outline(ctx, d, px, true, fillOf(d)); centerText(ctx, d, centroid(px)) },
    hit(d, px, env, x, y) { return hitOrInside(env, distToPolyline(x, y, px, true), fillOf(d) && pointInPoly(x, y, px)) },
  },

  circle: {
    render(ctx, d, px) {
      const r = Math.hypot(px[1].x - px[0].x, px[1].y - px[0].y)
      ctx.beginPath(); ctx.arc(px[0].x, px[0].y, r, 0, Math.PI * 2)
      if (fillOf(d)) { ctx.fillStyle = withAlpha(d.color, 0.14); ctx.fill() }
      ctx.strokeStyle = d.color; ctx.lineWidth = d.lineWidth ?? 1; setDash(ctx, d.lineStyle); ctx.stroke(); ctx.setLineDash([])
      centerText(ctx, d, px[0])
    },
    hit(d, px, env, x, y) {
      const r = Math.hypot(px[1].x - px[0].x, px[1].y - px[0].y)
      const dc = Math.hypot(x - px[0].x, y - px[0].y)
      return hitOrInside(env, Math.abs(dc - r), fillOf(d) && dc <= r)
    },
  },
  ellipse: {
    render(ctx, d, px) {
      const e = ellipseOf(px)
      ctx.beginPath(); ctx.ellipse(e.cx, e.cy, Math.max(0.5, e.rx), Math.max(0.5, e.ry), 0, 0, Math.PI * 2)
      if (fillOf(d)) { ctx.fillStyle = withAlpha(d.color, 0.14); ctx.fill() }
      ctx.strokeStyle = d.color; ctx.lineWidth = d.lineWidth ?? 1; setDash(ctx, d.lineStyle); ctx.stroke(); ctx.setLineDash([])
      centerText(ctx, d, { x: e.cx, y: e.cy })
    },
    hit(d, px, env, x, y) {
      const e = ellipseOf(px)
      if (e.rx < 1 || e.ry < 1) return nearest(env, distToSeg(x, y, px[0].x, px[0].y, px[1].x, px[1].y))
      const k = Math.hypot((x - e.cx) / e.rx, (y - e.cy) / e.ry)
      return hitOrInside(env, Math.abs(k - 1) * Math.min(e.rx, e.ry), fillOf(d) && k <= 1)
    },
    handles: (_d, px) => [px[0], px[1], { x: px[0].x, y: px[1].y }, { x: px[1].x, y: px[0].y }],
    drag(_d, i, pt, o) {
      if (i === 0) return [pt, o[1]]
      if (i === 1) return [o[0], pt]
      if (i === 2) return [{ t: pt.t, p: o[0].p }, { t: o[1].t, p: pt.p }]
      return [{ t: o[0].t, p: pt.p }, { t: pt.t, p: o[1].p }]
    },
  },

  arc: {
    render(ctx, d, px) {
      const pts = quadThrough(px[0], px[1], px[2])
      outline(ctx, d, pts, false, fillOf(d))
    },
    hit(d, px, env, x, y) {
      const pts = quadThrough(px[0], px[1], px[2])
      return hitOrInside(env, distToPolyline(x, y, pts), fillOf(d) && pointInPoly(x, y, pts))
    },
  },
  curve: {
    render(ctx, d, px) { outline(ctx, d, quadThrough(px[0], px[1], px[2]), false, false) },
    hit(_d, px, env, x, y) { return nearest(env, distToPolyline(x, y, quadThrough(px[0], px[1], px[2]))) },
  },
  doubleCurve: {
    render(ctx, d, px) { outline(ctx, d, doubleCurve(px), false, false) },
    hit(_d, px, env, x, y) { return nearest(env, distToPolyline(x, y, doubleCurve(px))) },
  },
  sector: {
    render(ctx, d, px) {
      const s = sectorOf(px)
      ctx.beginPath(); ctx.moveTo(s.c.x, s.c.y); ctx.arc(s.c.x, s.c.y, s.r, s.a1, s.a2, s.ccw); ctx.closePath()
      if (fillOf(d)) { ctx.fillStyle = withAlpha(d.color, 0.14); ctx.fill() }
      ctx.strokeStyle = d.color; ctx.lineWidth = d.lineWidth ?? 1; setDash(ctx, d.lineStyle); ctx.stroke(); ctx.setLineDash([])
    },
    hit(d, px, env, x, y) {
      const s = sectorOf(px)
      const dc = Math.hypot(x - s.c.x, y - s.c.y)
      const a = Math.atan2(y - s.c.y, x - s.c.x)
      const inAng = angIn(a, s.a1, s.a2)
      const e1 = { x: s.c.x + Math.cos(s.a1) * s.r, y: s.c.y + Math.sin(s.a1) * s.r }
      const e2 = { x: s.c.x + Math.cos(s.a2) * s.r, y: s.c.y + Math.sin(s.a2) * s.r }
      const dist = Math.min(inAng ? Math.abs(dc - s.r) : Infinity, distToSeg(x, y, s.c.x, s.c.y, e1.x, e1.y), distToSeg(x, y, s.c.x, s.c.y, e2.x, e2.y))
      return hitOrInside(env, dist, fillOf(d) && inAng && dc <= s.r)
    },
    handles(_d, px) {
      const s = sectorOf(px)
      return [px[0], px[1], { x: s.c.x + Math.cos(s.a2) * s.r, y: s.c.y + Math.sin(s.a2) * s.r }]
    },
  },

  forecast: {
    render(ctx, d, px, env) {
      const [a, b] = d.pts
      const dp = b.p - a.p
      const col = dp >= 0 ? UP : DOWN
      stroke(ctx, d, [px[0], px[1]])
      for (const [p, c] of [[px[0], d.color], [px[1], col]] as const) {
        ctx.save(); ctx.setLineDash([]); ctx.fillStyle = c; ctx.beginPath(); ctx.arc(p.x, p.y, 4, 0, Math.PI * 2); ctx.fill(); ctx.restore()
      }
      lineText(ctx, d, px[0], px[1])
      if (showLabelOf(d)) {
        const pp = env.pips(dp)
        labelBox(ctx, [
          `${signed(dp, env.fmtPrice(Math.abs(dp)))} (${signed(dp, Math.abs(pct(a.p, b.p)).toFixed(2))}%)${pp != null ? ` ${signed(dp, Math.abs(pp).toFixed(1))} ${env.L.pips}` : ''}`,
          `${env.bars(a.t, b.t)} ${env.L.bars}, ${env.L.dur(Math.abs(b.t - a.t))}`,
        ], px[1].x, px[1].y, withAlpha(col, 0.92), '#0b0e14', px[1].y < px[0].y ? 'above' : 'below')
      }
    },
    hit(_d, px, env, x, y) { return nearest(env, distToSeg(x, y, px[0].x, px[0].y, px[1].x, px[1].y)) },
  },
}

function markDef(up: boolean): NonNullable<ToolDefs['arrowUp']> {
  return {
    render(ctx, d, px) {
      fillPoly(ctx, markArrow(px[0], up), d.color, 1)
      if (d.text) {
        ctx.save(); ctx.font = `${d.fontSize ?? 14}px system-ui, sans-serif`; ctx.fillStyle = d.textColor || d.color
        ctx.textAlign = 'center'; ctx.textBaseline = up ? 'top' : 'bottom'
        ctx.fillText(d.text, px[0].x, px[0].y + (up ? 30 : -30)); ctx.restore()
      }
    },
    hit(_d, px, env, x, y) {
      const poly = markArrow(px[0], up)
      return pointInPoly(x, y, poly) ? 0 : nearest(env, distToPolyline(x, y, poly, true))
    },
  }
}
