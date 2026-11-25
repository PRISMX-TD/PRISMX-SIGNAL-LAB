// 第二批：锚定文本、注释、价格注释、图钉、标注、评论、路标、旗标、表情。
// 注释和图钉平时只显示图标，选中或悬停时才展开文字（同 TradingView）。
// Batch 2: anchored text, note, price note, pin, callout, comment, signpost, flag, emoji. Notes and
// pins show just an icon until selected or hovered, then expand their text (as TradingView does).
import { type Drawing, fontSizeOf, DEFAULT_EMOJI } from '../model'
import { type DrawEnv, type Px, SANS, FONT, textWidth, distToSeg, withAlpha } from '../paint'
import { type ToolDefs, nearest, inRect } from './types'

type Box = { x: number; y: number; w: number; h: number }

function contrast(color: string): string {
  const m = /^#([0-9a-f]{6})/i.exec(color)
  if (!m) return '#ffffff'
  const n = parseInt(m[1], 16)
  return 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255) > 150 ? '#0b0e14' : '#ffffff'
}
const linesOf = (d: Drawing) => (d.text || '').split('\n').slice(0, 20)
// 文字块尺寸（命中判定拿不到 ctx，按估算）/ text block size (estimated; hit tests have no ctx)
function textSize(d: Drawing, pad = 8): { w: number; h: number; fs: number } {
  const fs = fontSizeOf(d)
  const ls = linesOf(d)
  const w = Math.max(24, ...ls.map((l) => textWidth(l, fs))) + pad * 2
  return { w, h: ls.length * fs * 1.3 + pad * 1.4, fs }
}
function writeLines(ctx: CanvasRenderingContext2D, d: Drawing, b: Box, color: string, align: 'left' | 'center' = 'left') {
  const fs = fontSizeOf(d)
  ctx.save()
  ctx.font = SANS(fs)
  ctx.fillStyle = color
  ctx.textBaseline = 'top'
  ctx.textAlign = align
  ctx.setLineDash([])
  linesOf(d).forEach((l, i) => ctx.fillText(l, align === 'center' ? b.x + b.w / 2 : b.x + 8, b.y + fs * 0.35 + i * fs * 1.3))
  ctx.restore()
}
function roundBox(ctx: CanvasRenderingContext2D, b: Box, fill: string, strokeCol?: string) {
  ctx.save()
  ctx.setLineDash([])
  ctx.fillStyle = fill
  ctx.beginPath()
  ctx.roundRect?.(b.x, b.y, b.w, b.h, 5) ?? ctx.rect(b.x, b.y, b.w, b.h)
  ctx.fill()
  if (strokeCol) { ctx.strokeStyle = strokeCol; ctx.lineWidth = 1; ctx.stroke() }
  ctx.restore()
}

// 点上方的气泡（注释 / 图钉 / 评论共用）/ a bubble above a point (note / pin / comment)
function bubbleAbove(d: Drawing, tip: Px, lift: number): Box {
  const s = textSize(d)
  return { x: tip.x - 14, y: tip.y - lift - s.h, w: s.w, h: s.h }
}
function drawBubble(ctx: CanvasRenderingContext2D, d: Drawing, b: Box, tip: Px, env: DrawEnv) {
  const light = env.theme.bg === '#ffffff'
  const bg = light ? '#ffffff' : '#1e222d'
  ctx.save()
  ctx.setLineDash([])
  ctx.fillStyle = bg
  ctx.strokeStyle = d.color
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.roundRect?.(b.x, b.y, b.w, b.h, 5) ?? ctx.rect(b.x, b.y, b.w, b.h)
  ctx.fill(); ctx.stroke()
  // 小尖角指向锚点 / a small tail toward the anchor
  ctx.beginPath()
  ctx.moveTo(b.x + 8, b.y + b.h); ctx.lineTo(tip.x, tip.y); ctx.lineTo(b.x + 20, b.y + b.h)
  ctx.closePath(); ctx.fill(); ctx.stroke()
  ctx.fillRect(b.x + 9, b.y + b.h - 1.5, 10, 2)
  ctx.restore()
  writeLines(ctx, d, b, d.textColor || (light ? '#131722' : '#e2e8f0'))
}

// 图标尺寸 / icon geometry
const NOTE_BOX = (p: Px): Box => ({ x: p.x - 9, y: p.y - 9, w: 18, h: 18 })
const PIN_HEAD = (p: Px) => ({ x: p.x, y: p.y - 20, r: 7 })
const FLAG_BOX = (p: Px): Box => ({ x: p.x, y: p.y - 28, w: 20, h: 28 })
function signBox(d: Drawing, p: Px): Box {
  const s = textSize(d, 7)
  return { x: p.x - s.w / 2, y: p.y - 38 - s.h, w: s.w, h: s.h }
}
function calloutBox(d: Drawing, at: Px): Box {
  const s = textSize(d)
  return { x: at.x - s.w / 2, y: at.y - s.h / 2, w: s.w, h: s.h }
}
function priceNoteBox(d: Drawing, env: DrawEnv, at: Px): Box {
  const text = env.fmtPrice(d.pts[0].p) + (d.text ? `  ${d.text}` : '')
  const w = textWidth(text, 11) + 16
  return { x: at.x - w / 2, y: at.y - 11, w, h: 22 }
}
function emojiBox(d: Drawing, p: Px): Box {
  const s = fontSizeOf(d) * 1.8
  return { x: p.x - s / 2, y: p.y - s / 2, w: s, h: s }
}

export const NOTES: ToolDefs = {
  anchoredText: {
    render(ctx, d, px) {
      const s = textSize(d)
      const b = { x: px[0].x - 8, y: px[0].y - 6, w: s.w, h: s.h }
      writeLines(ctx, d, b, d.textColor || d.color)
    },
    hit(d, px, _env, x, y) {
      const s = textSize(d)
      return inRect(x, y, { x: px[0].x - 8, y: px[0].y - 6, w: s.w, h: s.h }, 2) ? 0 : null
    },
    handles: () => [],
  },

  note: {
    render(ctx, d, px, env, hot) {
      const p = px[0]
      const b = NOTE_BOX(p)
      roundBox(ctx, b, d.color)
      ctx.save(); ctx.strokeStyle = contrast(d.color); ctx.lineWidth = 1.4; ctx.setLineDash([])
      ctx.beginPath()
      for (const yy of [b.y + 6, b.y + 9.5, b.y + 13]) { ctx.moveTo(b.x + 5, yy); ctx.lineTo(b.x + b.w - 5, yy) }
      ctx.stroke(); ctx.restore()
      if (hot && d.text) drawBubble(ctx, d, bubbleAbove(d, { x: p.x, y: b.y }, 8), { x: p.x, y: b.y }, env)
    },
    hit(_d, px, env, x, y) { return inRect(x, y, NOTE_BOX(px[0]), env.touch ? 6 : 2) ? 0 : null },
    handles: () => [],
  },

  pin: {
    render(ctx, d, px, env, hot) {
      const p = px[0]
      const h = PIN_HEAD(p)
      ctx.save(); ctx.setLineDash([])
      ctx.strokeStyle = d.color; ctx.lineWidth = 2
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(h.x, h.y); ctx.stroke()
      ctx.fillStyle = d.color; ctx.beginPath(); ctx.arc(h.x, h.y, h.r, 0, Math.PI * 2); ctx.fill()
      ctx.fillStyle = contrast(d.color); ctx.beginPath(); ctx.arc(h.x, h.y, 2.5, 0, Math.PI * 2); ctx.fill()
      ctx.restore()
      if (hot && d.text) drawBubble(ctx, d, bubbleAbove(d, { x: h.x, y: h.y - h.r }, 8), { x: h.x, y: h.y - h.r }, env)
    },
    hit(_d, px, env, x, y) {
      const h = PIN_HEAD(px[0])
      if (Math.hypot(x - h.x, y - h.y) <= h.r + (env.touch ? 6 : 2)) return 0
      return nearest(env, distToSeg(x, y, px[0].x, px[0].y, h.x, h.y))
    },
    handles: () => [],
  },

  comment: {
    render(ctx, d, px) {
      const p = px[0]
      const s = textSize(d)
      const b = { x: p.x - 10, y: p.y - 12 - s.h, w: s.w, h: s.h }
      ctx.save(); ctx.setLineDash([])
      ctx.fillStyle = withAlpha(d.color, 0.92)
      ctx.beginPath()
      ctx.roundRect?.(b.x, b.y, b.w, b.h, 8) ?? ctx.rect(b.x, b.y, b.w, b.h)
      ctx.moveTo(b.x + 6, b.y + b.h - 1); ctx.lineTo(p.x, p.y); ctx.lineTo(b.x + 22, b.y + b.h - 1)
      ctx.fill(); ctx.restore()
      writeLines(ctx, d, b, d.textColor || contrast(d.color))
    },
    hit(d, px, env, x, y) {
      const s = textSize(d)
      const b = { x: px[0].x - 10, y: px[0].y - 12 - s.h, w: s.w, h: s.h }
      if (inRect(x, y, b, 2)) return 0
      return nearest(env, Math.hypot(x - px[0].x, y - px[0].y))
    },
    handles: () => [],
  },

  callout: {
    render(ctx, d, px) {
      const b = calloutBox(d, px[1])
      ctx.save(); ctx.setLineDash([])
      ctx.fillStyle = withAlpha(d.color, 0.9)
      // 指向锚点的楔形 / a wedge pointing at the anchor
      const c = { x: b.x + b.w / 2, y: b.y + b.h / 2 }
      const ang = Math.atan2(px[0].y - c.y, px[0].x - c.x)
      const nx = -Math.sin(ang) * 7, ny = Math.cos(ang) * 7
      ctx.beginPath(); ctx.moveTo(c.x + nx, c.y + ny); ctx.lineTo(px[0].x, px[0].y); ctx.lineTo(c.x - nx, c.y - ny); ctx.closePath(); ctx.fill()
      ctx.beginPath(); ctx.roundRect?.(b.x, b.y, b.w, b.h, 5) ?? ctx.rect(b.x, b.y, b.w, b.h); ctx.fill()
      ctx.restore()
      writeLines(ctx, d, b, d.textColor || contrast(d.color))
    },
    hit(d, px, env, x, y) {
      const b = calloutBox(d, px[1])
      if (inRect(x, y, b, 2)) return 0
      const c = { x: b.x + b.w / 2, y: b.y + b.h / 2 }
      return nearest(env, distToSeg(x, y, c.x, c.y, px[0].x, px[0].y))
    },
    handles: (_d, px) => [px[0], px[1]],
  },

  priceNote: {
    render(ctx, d, px, env) {
      const b = priceNoteBox(d, env, px[1])
      ctx.save(); ctx.setLineDash([])
      ctx.strokeStyle = d.color; ctx.lineWidth = d.lineWidth ?? 1
      ctx.beginPath(); ctx.moveTo(px[0].x, px[0].y); ctx.lineTo(px[1].x, px[1].y); ctx.stroke()
      ctx.fillStyle = d.color; ctx.beginPath(); ctx.arc(px[0].x, px[0].y, 3.5, 0, Math.PI * 2); ctx.fill()
      ctx.restore()
      roundBox(ctx, b, d.color)
      ctx.save(); ctx.font = FONT; ctx.fillStyle = contrast(d.color); ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
      ctx.fillText(env.fmtPrice(d.pts[0].p) + (d.text ? `  ${d.text}` : ''), b.x + b.w / 2, b.y + b.h / 2 + 0.5); ctx.restore()
    },
    hit(d, px, env, x, y) {
      if (inRect(x, y, priceNoteBox(d, env, px[1]), 2)) return 0
      return nearest(env, distToSeg(x, y, px[0].x, px[0].y, px[1].x, px[1].y))
    },
  },

  signpost: {
    render(ctx, d, px) {
      const p = px[0]
      const b = signBox(d, p)
      ctx.save(); ctx.setLineDash([]); ctx.strokeStyle = d.color; ctx.lineWidth = 1.5
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x, b.y + b.h); ctx.stroke()
      ctx.fillStyle = d.color; ctx.beginPath(); ctx.arc(p.x, p.y, 3, 0, Math.PI * 2); ctx.fill()
      ctx.restore()
      roundBox(ctx, b, d.color)
      writeLines(ctx, d, b, d.textColor || contrast(d.color), 'center')
    },
    hit(d, px, env, x, y) {
      const b = signBox(d, px[0])
      if (inRect(x, y, b, 2)) return 0
      return nearest(env, distToSeg(x, y, px[0].x, px[0].y, px[0].x, b.y + b.h))
    },
    handles: () => [],
  },

  flag: {
    render(ctx, d, px) {
      const p = px[0]
      ctx.save(); ctx.setLineDash([])
      ctx.strokeStyle = d.color; ctx.lineWidth = 2
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x, p.y - 28); ctx.stroke()
      ctx.fillStyle = d.color
      ctx.beginPath()
      ctx.moveTo(p.x, p.y - 28)
      ctx.bezierCurveTo(p.x + 7, p.y - 32, p.x + 12, p.y - 24, p.x + 20, p.y - 27)
      ctx.lineTo(p.x + 20, p.y - 16)
      ctx.bezierCurveTo(p.x + 12, p.y - 13, p.x + 7, p.y - 21, p.x, p.y - 17)
      ctx.closePath(); ctx.fill()
      ctx.restore()
      if (d.text) { ctx.save(); ctx.font = SANS(fontSizeOf(d)); ctx.fillStyle = d.textColor || d.color; ctx.textBaseline = 'middle'; ctx.fillText(d.text, p.x + 24, p.y - 22); ctx.restore() }
    },
    hit(_d, px, env, x, y) { return inRect(x, y, FLAG_BOX(px[0]), env.touch ? 6 : 3) ? 0 : null },
    handles: () => [],
  },

  emoji: {
    render(ctx, d, px) {
      const b = emojiBox(d, px[0])
      ctx.save()
      ctx.font = `${b.h * 0.8}px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText((d.text || DEFAULT_EMOJI).slice(0, 8), px[0].x, px[0].y + 1)
      ctx.restore()
    },
    hit(d, px, env, x, y) { return inRect(x, y, emojiBox(d, px[0]), env.touch ? 6 : 0) ? 0 : null },
    handles: () => [],
  },
}
