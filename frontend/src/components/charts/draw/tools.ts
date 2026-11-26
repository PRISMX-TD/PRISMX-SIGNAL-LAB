// 各画线工具的绘制、命中判定、手柄（阶段 2 第一批）。纯函数：输入画线 + 像素锚点 + 环境，
// 渲染器（primitive）和交互层共用同一套命中判定，不再各写一遍。
// Per-tool rendering, hit-testing and handles (phase 2 batch 1). Pure functions over a drawing, its
// pixel anchors and an environment; the renderer and the interaction layer share one hit test.
import {
  type Drawing, type Point, type DrawType, TOOL_META, fillOf, showLabelOf, fontSizeOf, levelsOf,
  DEFAULT_ACCOUNT, DEFAULT_RISK, pointsNeeded, isScreenAnchored,
} from './model'
import {
  type Px, type DrawEnv, upOf, downOf, textOn, FONT, tolOf, ok, distToSeg, extendSeg, setDash, withAlpha, stroke, labelBox,
  arrowHead, lineText, pct, signed, textWidth, pointInPoly,
} from './paint'
import { EXT } from './ext'

export type { Px, DrawLabels, DrawEnv } from './paint'

// 第一批在本文件里画的工具 / the batch 1 tools painted in this file
const BATCH1: Record<string, true> = Object.fromEntries(([
  'trend', 'ray', 'info', 'extended', 'angle', 'hline', 'hray', 'vline', 'crossline', 'channel', 'fib', 'fibExt',
  'long', 'short', 'priceRange', 'dateRange', 'datePriceRange', 'brush', 'arrow', 'rect', 'text', 'priceLabel',
] as DrawType[]).map((t) => [t, true]))
export { UP, DOWN, ACCENT, tolOf, handleROf, distToSeg, extendSeg, labelBox } from './paint'

export function anchorsOf(d: Drawing, env: DrawEnv): Px[] {
  if (isScreenAnchored(d.type)) return d.pts.map((pt) => ({ x: pt.t * env.w, y: pt.p * env.h }))
  return d.pts.map((pt) => ({ x: env.t2x(pt.t) ?? NaN, y: env.p2y(pt.p) ?? NaN }))
}

// 这个工具需要哪些坐标才能画 / which coordinates a tool needs
export function anchorsValid(d: Drawing, px: Px[]): boolean {
  if (d.type === 'hline') return px.length > 0 && ok(px[0].y)
  if (d.type === 'vline') return px.length > 0 && ok(px[0].x)
  if (px.length < pointsNeeded(d.type)) return false
  return px.every((p) => ok(p.x) && ok(p.y))
}

function lineExt(d: Drawing): [boolean, boolean] {
  if (d.type === 'ray') return [!!d.extendLeft, true]
  if (d.type === 'extended') return [true, true]
  return [!!d.extendLeft, !!d.extendRight]
}

export function textBox(d: Drawing, a: Px): { x: number; y: number; w: number; h: number } {
  const fs = fontSizeOf(d)
  const lines = (d.text || ' ').split('\n')
  const w = Math.max(...lines.map((l) => textWidth(l, fs))) + 8
  return { x: a.x - 4, y: a.y - 4, w, h: lines.length * fs * 1.3 + 8 }
}
function priceLabelBox(a: Px, text: string): { x: number; y: number; w: number; h: number } {
  const w = textWidth(text, 11) + 16
  return { x: a.x + 6, y: a.y - 34, w, h: 22 }
}

// 通道：第三点存成「平行线起点」，偏移 = 它的价格 − 起点价格 / channel offset from the third point
export const channelOffset = (d: Drawing) => (d.pts[2] ? d.pts[2].p - d.pts[0].p : 0)

function channelLines(d: Drawing, px: Px[], env: DrawEnv): { base: [Px, Px]; par: [Px, Px]; mid: [Px, Px] } | null {
  const dp = channelOffset(d)
  const ya2 = env.p2y(d.pts[0].p + dp), yb2 = env.p2y(d.pts[1].p + dp)
  const yam = env.p2y(d.pts[0].p + dp / 2), ybm = env.p2y(d.pts[1].p + dp / 2)
  if (ya2 == null || yb2 == null || yam == null || ybm == null) return null
  const [l, r] = lineExt(d)
  const ext = (a: Px, b: Px) => extendSeg(a, b, l, r, env)
  return {
    base: ext(px[0], px[1]),
    par: ext({ x: px[0].x, y: ya2 }, { x: px[1].x, y: yb2 }),
    mid: ext({ x: px[0].x, y: yam }, { x: px[1].x, y: ybm }),
  }
}

// ───────────────────────── 绘制 / render ─────────────────────────
// hot = 选中或悬停（注释 / 图钉这类只在这时展开文字）/ hot = selected or hovered (notes / pins expand then)
export function renderDrawing(ctx: CanvasRenderingContext2D, d: Drawing, px: Px[], env: DrawEnv, hot = false) {
  const lw = d.lineWidth ?? 1
  const lbg = env.theme.bg === '#ffffff' ? 'rgba(19,23,34,0.85)' : 'rgba(30,34,45,0.92)'
  const lfg = '#e2e8f0'
  // 第二批工具走各自文件 / batch 2 tools live in their own files
  if (!(d.type in BATCH1)) { EXT[d.type]?.render(ctx, d, px, env, hot); ctx.setLineDash([]); return }
  switch (d.type) {
    case 'hline': {
      stroke(ctx, d, [{ x: 0, y: px[0].y }, { x: env.w, y: px[0].y }])
      if (d.text) { ctx.save(); ctx.font = `${fontSizeOf(d)}px system-ui, sans-serif`; ctx.fillStyle = d.textColor || d.color; ctx.textBaseline = 'bottom'; ctx.fillText(d.text, 8, px[0].y - 3); ctx.restore() }
      break
    }
    case 'hray': {
      stroke(ctx, d, [px[0], { x: env.w, y: px[0].y }])
      lineText(ctx, d, px[0], { x: Math.min(env.w, px[0].x + 240), y: px[0].y })
      break
    }
    case 'vline':
      stroke(ctx, d, [{ x: px[0].x, y: 0 }, { x: px[0].x, y: env.h }])
      break
    case 'crossline':
      stroke(ctx, d, [{ x: px[0].x, y: 0 }, { x: px[0].x, y: env.h }])
      stroke(ctx, d, [{ x: 0, y: px[0].y }, { x: env.w, y: px[0].y }])
      break
    case 'trend': case 'ray': case 'extended': case 'arrow': case 'info': case 'angle': {
      const [l, r] = lineExt(d)
      const [p, q] = extendSeg(px[0], px[1], l, r, env)
      stroke(ctx, d, [p, q])
      if (d.type === 'arrow') arrowHead(ctx, px[0], px[1], 8 + lw * 2, d.color)
      lineText(ctx, d, px[0], px[1])
      if (d.type === 'info' && showLabelOf(d)) {
        const [a, b] = d.pts
        const dp = b.p - a.p
        const deg = Math.atan2(-(px[1].y - px[0].y), px[1].x - px[0].x) * 180 / Math.PI
        const n = env.bars(a.t, b.t)
        labelBox(ctx, [
          `${signed(dp, env.fmtPrice(Math.abs(dp)))} (${signed(dp, Math.abs(pct(a.p, b.p)).toFixed(2))}%)`,
          `${n} ${env.L.bars}, ${env.L.dur(Math.abs(b.t - a.t))}`,
          `${deg.toFixed(1)}°`,
        ], px[1].x, px[1].y, lbg, lfg, px[1].y < px[0].y ? 'above' : 'below')
      }
      if (d.type === 'angle') {
        const deg = Math.atan2(-(px[1].y - px[0].y), px[1].x - px[0].x) * 180 / Math.PI
        const r0 = Math.min(40, Math.max(20, Math.hypot(px[1].x - px[0].x, px[1].y - px[0].y) * 0.4))
        ctx.save()
        ctx.strokeStyle = d.color; ctx.lineWidth = 1; ctx.setLineDash([4, 3])
        ctx.beginPath(); ctx.moveTo(px[0].x, px[0].y); ctx.lineTo(px[0].x + r0 * 1.6, px[0].y); ctx.stroke()
        ctx.setLineDash([])
        ctx.beginPath(); ctx.arc(px[0].x, px[0].y, r0, 0, -deg * Math.PI / 180, deg > 0); ctx.stroke()
        ctx.font = FONT; ctx.fillStyle = d.color; ctx.textBaseline = 'middle'
        ctx.fillText(`${deg.toFixed(1)}°`, px[0].x + r0 * 1.6 + 6, px[0].y)
        ctx.restore()
      }
      break
    }
    case 'channel': {
      const c = channelLines(d, px, env)
      if (!c) break
      if (fillOf(d)) {
        ctx.fillStyle = withAlpha(d.color, 0.1)
        ctx.beginPath(); ctx.moveTo(c.base[0].x, c.base[0].y); ctx.lineTo(c.base[1].x, c.base[1].y)
        ctx.lineTo(c.par[1].x, c.par[1].y); ctx.lineTo(c.par[0].x, c.par[0].y); ctx.closePath(); ctx.fill()
      }
      stroke(ctx, d, c.base)
      stroke(ctx, d, c.par)
      ctx.save(); ctx.globalAlpha = 0.6; stroke(ctx, { ...d, lineStyle: 'dashed' }, c.mid, 1); ctx.restore()
      lineText(ctx, d, px[0], px[1])
      break
    }
    case 'rect': {
      const x = Math.min(px[0].x, px[1].x), y = Math.min(px[0].y, px[1].y)
      const w = Math.abs(px[1].x - px[0].x), h = Math.abs(px[1].y - px[0].y)
      if (fillOf(d)) { ctx.fillStyle = withAlpha(d.color, 0.14); ctx.fillRect(x, y, w, h) }
      ctx.strokeStyle = d.color; ctx.lineWidth = lw; setDash(ctx, d.lineStyle)
      ctx.strokeRect(x, y, w, h)
      if (d.text) {
        ctx.save(); ctx.font = `${fontSizeOf(d)}px system-ui, sans-serif`; ctx.fillStyle = d.textColor || d.color
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.setLineDash([]); ctx.fillText(d.text, x + w / 2, y + h / 2); ctx.restore()
      }
      break
    }
    case 'fib': case 'fibExt': {
      const ext = d.type === 'fibExt'
      const base = ext ? d.pts[2].p : d.pts[1].p
      const span = ext ? d.pts[1].p - d.pts[0].p : d.pts[0].p - d.pts[1].p
      const xs = ext ? [px[2].x, px[2].x + Math.max(60, Math.abs(px[1].x - px[0].x))] : [Math.min(px[0].x, px[1].x), Math.max(px[0].x, px[1].x)]
      const xL = d.extendLeft ? 0 : xs[0]
      const xR = d.extendRight ? env.w : xs[1]
      ctx.save(); ctx.globalAlpha = 0.5
      stroke(ctx, { ...d, lineStyle: 'dashed' }, ext ? [px[0], px[1], px[2]] : [px[0], px[1]], 1)
      ctx.restore()
      const lv = levelsOf(d).filter((l) => l.on).sort((a, b) => a.v - b.v)
      let prevY: number | null = null
      ctx.font = FONT; ctx.textBaseline = 'middle'
      for (const l of lv) {
        const price = base + span * l.v
        const y = env.p2y(price)
        if (y == null) continue
        const col = l.color || d.color
        if (prevY != null && fillOf(d)) { ctx.fillStyle = withAlpha(col, 0.08); ctx.fillRect(xL, Math.min(prevY, y), xR - xL, Math.abs(y - prevY)) }
        prevY = y
        ctx.strokeStyle = col; ctx.lineWidth = lw; setDash(ctx, d.lineStyle)
        ctx.beginPath(); ctx.moveTo(xL, y); ctx.lineTo(xR, y); ctx.stroke()
        if (showLabelOf(d)) {
          ctx.fillStyle = col; ctx.textAlign = 'right'
          ctx.fillText(`${l.v} (${env.fmtPrice(price)})`, xL - 4, y)
        }
      }
      ctx.textAlign = 'left'
      break
    }
    case 'long': case 'short': {
      const xL = Math.min(px[0].x, px[1].x), xR = Math.max(px[0].x, px[1].x, xL + 1)
      const [e, tg, st] = [d.pts[0].p, d.pts[1].p, d.pts[2].p]
      const yE = px[0].y, yT = px[1].y, yS = px[2].y
      // 止盈区用用户的「涨」色、止损区用「跌」色：红涨绿跌的用户看到的盈利区也是红的。
      // Target zone in the user's "up" colour, stop zone in "down": red-up users see a red profit zone.
      const UPC = upOf(env), DNC = downOf(env)
      if (fillOf(d)) {
        ctx.fillStyle = withAlpha(UPC, 0.16); ctx.fillRect(xL, Math.min(yE, yT), xR - xL, Math.abs(yT - yE))
        ctx.fillStyle = withAlpha(DNC, 0.16); ctx.fillRect(xL, Math.min(yE, yS), xR - xL, Math.abs(yS - yE))
      }
      ctx.setLineDash([]); ctx.lineWidth = 1
      ctx.strokeStyle = UPC; ctx.beginPath(); ctx.moveTo(xL, yT); ctx.lineTo(xR, yT); ctx.stroke()
      ctx.strokeStyle = DNC; ctx.beginPath(); ctx.moveTo(xL, yS); ctx.lineTo(xR, yS); ctx.stroke()
      ctx.strokeStyle = env.theme.text; ctx.beginPath(); ctx.moveTo(xL, yE); ctx.lineTo(xR, yE); ctx.stroke()
      if (showLabelOf(d)) {
        const slDist = Math.abs(e - st), tpDist = Math.abs(tg - e)
        const rr = slDist > 0 ? tpDist / slDist : 0
        // 手数与金额：画线设置里填过账户规模 / 风险 % 就按它；否则跟下单票的仓位（手数或风险 %）走，
        // 金额按该品种的合约大小和入场价折算。
        // Lots and money: the drawing's own account size / risk % when the user set them, otherwise the
        // order ticket's sizing (lots or risk %), converted with the symbol's contract size at the entry.
        let riskAmt: number | null, q: number | null
        if (d.account != null || d.risk != null || !env.size) {
          riskAmt = (d.account ?? DEFAULT_ACCOUNT) * (d.risk ?? DEFAULT_RISK) / 100
          q = env.qty(riskAmt, slDist, e)
        } else {
          const s = env.size(slDist, e)
          riskAmt = s.risk; q = s.q
        }
        const money = (v: number | null, sign: string) => (v != null && Number.isFinite(v) ? `  ${sign}${v.toFixed(2)}` : '')
        const pipsT = env.pips(tpDist), pipsS = env.pips(slDist)
        const cx = (xL + xR) / 2
        labelBox(ctx, [`${env.L.target}: ${env.fmtPrice(tg)} (${Math.abs(pct(e, tg)).toFixed(2)}%)${pipsT != null ? ` ${pipsT.toFixed(1)} ${env.L.pips}` : ''}${money(riskAmt != null ? riskAmt * rr : null, '+')}`], cx, yT, withAlpha(UPC, 0.9), textOn(UPC), yT < yE ? 'above' : 'below')
        labelBox(ctx, [`${env.L.stop}: ${env.fmtPrice(st)} (${Math.abs(pct(e, st)).toFixed(2)}%)${pipsS != null ? ` ${pipsS.toFixed(1)} ${env.L.pips}` : ''}${money(riskAmt, '−')}`], cx, yS, withAlpha(DNC, 0.9), textOn(DNC), yS < yE ? 'above' : 'below')
        labelBox(ctx, [`${env.L.rr}: ${rr.toFixed(2)}${q != null ? `  ${env.L.qty}: ${q.toFixed(2)}` : ''}`], cx, yE, lbg, lfg)
      }
      break
    }
    case 'priceRange': case 'dateRange': case 'datePriceRange': {
      const x1 = Math.min(px[0].x, px[1].x), x2 = Math.max(px[0].x, px[1].x)
      const y1 = Math.min(px[0].y, px[1].y), y2 = Math.max(px[0].y, px[1].y)
      const [a, b] = d.pts
      const dp = b.p - a.p
      const col = d.type === 'dateRange' ? d.color : dp >= 0 ? upOf(env) : downOf(env)
      const c = d.type === 'priceRange' ? d.color : col
      if (fillOf(d)) { ctx.fillStyle = withAlpha(c, 0.12); ctx.fillRect(x1, y1, x2 - x1, y2 - y1) }
      ctx.lineWidth = lw; ctx.strokeStyle = c; ctx.setLineDash([])
      const midX = (x1 + x2) / 2, midY = (y1 + y2) / 2
      if (d.type !== 'dateRange') {
        ctx.beginPath(); ctx.moveTo(midX, px[0].y); ctx.lineTo(midX, px[1].y); ctx.stroke()
        if (Math.abs(px[1].y - px[0].y) > 10) arrowHead(ctx, { x: midX, y: px[0].y }, { x: midX, y: px[1].y }, 8, c)
        ctx.beginPath(); ctx.moveTo(x1, px[0].y); ctx.lineTo(x2, px[0].y); ctx.moveTo(x1, px[1].y); ctx.lineTo(x2, px[1].y); ctx.stroke()
      }
      if (d.type !== 'priceRange') {
        ctx.beginPath(); ctx.moveTo(px[0].x, midY); ctx.lineTo(px[1].x, midY); ctx.stroke()
        if (Math.abs(px[1].x - px[0].x) > 10) arrowHead(ctx, { x: px[0].x, y: midY }, { x: px[1].x, y: midY }, 8, c)
        ctx.beginPath(); ctx.moveTo(px[0].x, y1); ctx.lineTo(px[0].x, y2); ctx.moveTo(px[1].x, y1); ctx.lineTo(px[1].x, y2); ctx.stroke()
      }
      if (showLabelOf(d)) {
        const lines: string[] = []
        if (d.type !== 'dateRange') {
          const pp = env.pips(dp)
          lines.push(`${signed(dp, env.fmtPrice(Math.abs(dp)))} (${signed(dp, Math.abs(pct(a.p, b.p)).toFixed(2))}%)${pp != null ? ` ${signed(dp, pp.toFixed(1))} ${env.L.pips}` : ''}`)
        }
        if (d.type !== 'priceRange') lines.push(`${env.bars(a.t, b.t)} ${env.L.bars}, ${env.L.dur(Math.abs(b.t - a.t))}`)
        const below = d.type === 'dateRange' ? true : px[1].y > px[0].y
        labelBox(ctx, lines, midX, below ? y2 : y1, withAlpha(c, 0.92), '#0b0e14', below ? 'below' : 'above')
      }
      break
    }
    case 'brush': {
      if (px.length < 2) break
      ctx.strokeStyle = d.color; ctx.lineWidth = lw; ctx.lineJoin = 'round'; ctx.lineCap = 'round'; setDash(ctx, d.lineStyle)
      ctx.beginPath(); ctx.moveTo(px[0].x, px[0].y)
      for (let i = 1; i < px.length - 1; i++) {
        const mx = (px[i].x + px[i + 1].x) / 2, my = (px[i].y + px[i + 1].y) / 2
        ctx.quadraticCurveTo(px[i].x, px[i].y, mx, my)
      }
      ctx.lineTo(px[px.length - 1].x, px[px.length - 1].y)
      ctx.stroke()
      break
    }
    case 'text': {
      const fs = fontSizeOf(d)
      ctx.save()
      ctx.font = `${fs}px system-ui, sans-serif`
      ctx.fillStyle = d.textColor || d.color
      ctx.textBaseline = 'top'
      ctx.setLineDash([])
      const lines = (d.text || '').split('\n')
      lines.forEach((l, i) => ctx.fillText(l, px[0].x, px[0].y + i * fs * 1.3))
      ctx.restore()
      break
    }
    case 'priceLabel': {
      const text = env.fmtPrice(d.pts[0].p)
      const b = priceLabelBox(px[0], text)
      ctx.save()
      ctx.setLineDash([])
      ctx.fillStyle = d.color
      ctx.beginPath()
      ctx.roundRect?.(b.x, b.y, b.w, b.h, 4) ?? ctx.rect(b.x, b.y, b.w, b.h)
      ctx.moveTo(b.x + 6, b.y + b.h); ctx.lineTo(px[0].x, px[0].y); ctx.lineTo(b.x + 16, b.y + b.h)
      ctx.fill()
      ctx.fillStyle = '#0b0e14'; ctx.font = FONT; ctx.textBaseline = 'middle'; ctx.textAlign = 'center'
      ctx.fillText(text, b.x + b.w / 2, b.y + b.h / 2)
      ctx.restore()
      break
    }
  }
  ctx.setLineDash([])
}

// ───────────────────────── 手柄 / handles ─────────────────────────
// 每个手柄的屏幕位置；拖手柄 i 由 dragHandle 换算回数据点。
// Screen position of each handle; dragging handle i maps back through dragHandle.
export function handlesOf(d: Drawing, px: Px[], env: DrawEnv): Px[] {
  const ext = EXT[d.type]
  if (ext) return ext.handles ? ext.handles(d, px, env) : px
  switch (d.type) {
    case 'hline': return [{ x: env.w / 2, y: px[0].y }]
    case 'vline': return [{ x: px[0].x, y: env.h / 2 }]
    case 'brush': return []
    case 'rect': case 'priceRange': case 'dateRange': case 'datePriceRange':
      return [px[0], px[1], { x: px[0].x, y: px[1].y }, { x: px[1].x, y: px[0].y }]
    case 'channel': {
      const dp = channelOffset(d)
      const ya = env.p2y(d.pts[0].p + dp), yb = env.p2y(d.pts[1].p + dp)
      return [px[0], px[1], { x: px[0].x, y: ya ?? NaN }, { x: px[1].x, y: yb ?? NaN }]
    }
    case 'long': case 'short':
      return [px[0], { x: px[0].x, y: px[1].y }, { x: px[0].x, y: px[2].y }, { x: px[1].x, y: px[0].y }]
    default: return px
  }
}

export function dragHandle(d: Drawing, i: number, pt: Point, orig: Point[]): Point[] {
  const o = orig.map((p) => ({ ...p }))
  const ext = EXT[d.type]
  if (ext?.drag) return ext.drag(d, i, pt, o)
  switch (d.type) {
    case 'hline': return [{ t: o[0].t, p: pt.p }]
    case 'vline': return [{ t: pt.t, p: o[0].p }]
    case 'rect': case 'priceRange': case 'dateRange': case 'datePriceRange':
      if (i === 0) return [pt, o[1]]
      if (i === 1) return [o[0], pt]
      if (i === 2) return [{ t: pt.t, p: o[0].p }, { t: o[1].t, p: pt.p }]
      return [{ t: o[0].t, p: pt.p }, { t: pt.t, p: o[1].p }]
    case 'channel': {
      const dp = o[2].p - o[0].p
      if (i === 0) return [pt, o[1], { t: pt.t, p: pt.p + dp }]
      if (i === 1) return [o[0], pt, o[2]]
      const ndp = i === 2 ? pt.p - o[0].p : pt.p - o[1].p
      return [o[0], o[1], { t: o[0].t, p: o[0].p + ndp }]
    }
    case 'long': case 'short':
      if (i === 0) return [pt, o[1], o[2]]
      if (i === 1) return [o[0], { t: o[1].t, p: pt.p }, o[2]]
      if (i === 2) return [o[0], o[1], { t: o[2].t, p: pt.p }]
      return [o[0], { t: pt.t, p: o[1].p }, { t: pt.t, p: o[2].p }]
    default:
      return o.map((p, k) => (k === i ? pt : p))
  }
}

// ───────────────────────── 命中判定 / hit test ─────────────────────────
// 返回距离（越小越近），没命中返回 null / distance (smaller = closer), null when missed
export function hitDrawing(d: Drawing, px: Px[], env: DrawEnv, x: number, y: number): number | null {
  const ext = EXT[d.type]
  if (ext) return ext.hit(d, px, env, x, y)
  const tol = tolOf(env)
  const inBox = (bx: number, by: number, bw: number, bh: number) => x >= bx - tol / 2 && x <= bx + bw + tol / 2 && y >= by - tol / 2 && y <= by + bh + tol / 2
  const seg = (a: Px, b: Px) => distToSeg(x, y, a.x, a.y, b.x, b.y)
  const best = (...ds: number[]) => { const m = Math.min(...ds); return m <= tol ? m : null }
  switch (d.type) {
    case 'hline': return best(Math.abs(y - px[0].y))
    case 'vline': return best(Math.abs(x - px[0].x))
    case 'crossline': return best(Math.abs(y - px[0].y), Math.abs(x - px[0].x))
    case 'hray': return x >= px[0].x - tol ? best(Math.abs(y - px[0].y)) : null
    case 'trend': case 'ray': case 'extended': case 'arrow': case 'info': case 'angle': {
      const [l, r] = lineExt(d)
      const [p, q] = extendSeg(px[0], px[1], l, r, env)
      return best(seg(p, q))
    }
    case 'channel': {
      const c = channelLines(d, px, env)
      if (!c) return null
      const ds = [seg(...c.base), seg(...c.par), seg(...c.mid)]
      const m = best(...ds)
      if (m != null) return m
      if (fillOf(d) && pointInPoly(x, y, [c.base[0], c.base[1], c.par[1], c.par[0]])) return tol
      return null
    }
    case 'rect': case 'priceRange': case 'dateRange': case 'datePriceRange': case 'long': case 'short': {
      const xs = d.type === 'long' || d.type === 'short' ? [px[0].x, px[1].x] : [px[0].x, px[1].x]
      const ys = d.type === 'long' || d.type === 'short' ? [px[1].y, px[2].y, px[0].y] : [px[0].y, px[1].y]
      const x1 = Math.min(...xs), x2 = Math.max(...xs), y1 = Math.min(...ys), y2 = Math.max(...ys)
      const onEdge = best(
        x >= x1 - tol && x <= x2 + tol ? Math.min(Math.abs(y - y1), Math.abs(y - y2)) : Infinity,
        y >= y1 - tol && y <= y2 + tol ? Math.min(Math.abs(x - x1), Math.abs(x - x2)) : Infinity,
      )
      if (onEdge != null) return onEdge
      if ((fillOf(d) || d.type !== 'rect') && x >= x1 && x <= x2 && y >= y1 && y <= y2) return tol
      return null
    }
    case 'fib': case 'fibExt': {
      const ext = d.type === 'fibExt'
      const base = ext ? d.pts[2].p : d.pts[1].p
      const span = ext ? d.pts[1].p - d.pts[0].p : d.pts[0].p - d.pts[1].p
      const xs = ext ? [px[2].x, px[2].x + Math.max(60, Math.abs(px[1].x - px[0].x))] : [Math.min(px[0].x, px[1].x), Math.max(px[0].x, px[1].x)]
      const xL = d.extendLeft ? 0 : xs[0], xR = d.extendRight ? env.w : xs[1]
      const ds: number[] = [seg(px[0], px[1])]
      if (ext) ds.push(seg(px[1], px[2]))
      if (x >= xL - tol && x <= xR + tol) {
        for (const l of levelsOf(d)) {
          if (!l.on) continue
          const ly = env.p2y(base + span * l.v)
          if (ly != null) ds.push(Math.abs(y - ly))
        }
      }
      return best(...ds)
    }
    case 'brush': {
      let m = Infinity
      for (let i = 1; i < px.length; i++) m = Math.min(m, seg(px[i - 1], px[i]))
      return best(m)
    }
    case 'text': {
      const b = textBox(d, px[0])
      return inBox(b.x, b.y, b.w, b.h) ? 0 : null
    }
    case 'priceLabel': {
      const b = priceLabelBox(px[0], d.pts[0].p.toFixed(5))
      if (inBox(b.x, b.y, b.w, b.h)) return 0
      return best(Math.hypot(x - px[0].x, y - px[0].y))
    }
  }
  return null
}

// 框选：画线任一锚点落在框里就算选中 / marquee: any anchor inside the box selects the drawing
export function inMarquee(d: Drawing, px: Px[], box: { x1: number; y1: number; x2: number; y2: number }): boolean {
  const pts = d.type === 'hline' ? [{ x: (box.x1 + box.x2) / 2, y: px[0].y }] : d.type === 'vline' ? [{ x: px[0].x, y: (box.y1 + box.y2) / 2 }] : px
  return pts.some((p) => p.x >= box.x1 && p.x <= box.x2 && p.y >= box.y1 && p.y <= box.y2)
}

// Shift：把第二点相对第一点的角度吸到 45° 的倍数 / Shift snaps the angle to multiples of 45°
export function constrain45(a: Px, b: Px): Px {
  const dx = b.x - a.x, dy = b.y - a.y
  const len = Math.hypot(dx, dy)
  const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4)
  return { x: a.x + Math.cos(ang) * len, y: a.y + Math.sin(ang) * len }
}

export const isLineLike = (t: DrawType) => !!TOOL_META[t]?.lineLike
