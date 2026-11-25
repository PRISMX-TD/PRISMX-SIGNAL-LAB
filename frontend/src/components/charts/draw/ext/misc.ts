// 第三批：K 线形态复制、幽灵 K 线、表格、图片。
// Batch 3: bars pattern, ghost feed, table and image.
import { type Drawing, fontSizeOf } from '../model'
import { type DrawEnv, type Px, SANS, UP, DOWN, withAlpha, distToPolyline, guide, textWidth } from '../paint'
import { type ToolDefs, nearest, hitOrInside, inRect } from './types'

const spacingOf = (env: DrawEnv) => Math.max(1, env.spacing ?? 6)

// ── K 线形态复制：bars 是复制下来的 [开, 高, 低, 收]（相对第一根开盘价），从 p0 起按当前 K 线宽度排开 ──
// Bars pattern: bars are the copied [o, h, l, c] relative to the first open, laid out from p0 at the current bar width
interface GhostBar { x: number; o: number; h: number; l: number; c: number }
export function patternBars(d: Drawing, px: Px[], env: DrawEnv): GhostBar[] {
  const src = d.bars ?? []
  const sp = spacingOf(env)
  const n = src.length
  const base = d.pts[0].p
  const out: GhostBar[] = []
  for (let i = 0; i < n; i++) {
    const b = src[d.mirror ? n - 1 - i : i]
    // 镜像（时间倒放）时开收互换 / mirrored in time: open and close swap
    let [o, h, l, c] = d.mirror ? [b[3], b[1], b[2], b[0]] : b
    // 翻转：围绕第一根开盘价上下颠倒 / flipped upside down around the first open
    if (d.flip) [o, h, l, c] = [-o, -l, -h, -c]
    const y = (v: number) => env.p2y(base + v) ?? NaN
    out.push({ x: px[0].x + i * sp, o: y(o), h: y(h), l: y(l), c: y(c) })
  }
  return out
}
function paintCandles(ctx: CanvasRenderingContext2D, bars: GhostBar[], sp: number, up: string, down: string, alpha: number) {
  const bw = Math.max(1, Math.round(sp * 0.6))
  for (const b of bars) {
    if (![b.o, b.h, b.l, b.c].every(Number.isFinite)) continue
    const rising = b.c <= b.o // y 朝下 / y points down
    const col = rising ? up : down
    ctx.strokeStyle = withAlpha(col, Math.min(1, alpha + 0.25))
    ctx.lineWidth = 1
    ctx.beginPath(); ctx.moveTo(Math.round(b.x) + 0.5, b.h); ctx.lineTo(Math.round(b.x) + 0.5, b.l); ctx.stroke()
    ctx.fillStyle = withAlpha(col, alpha)
    const top = Math.min(b.o, b.c), hgt = Math.max(1, Math.abs(b.c - b.o))
    ctx.fillRect(Math.round(b.x - bw / 2), top, bw, hgt)
  }
}
function barsBox(bars: GhostBar[], sp: number) {
  let x1 = Infinity, x2 = -Infinity, y1 = Infinity, y2 = -Infinity
  for (const b of bars) {
    if (!Number.isFinite(b.h) || !Number.isFinite(b.l)) continue
    x1 = Math.min(x1, b.x - sp / 2); x2 = Math.max(x2, b.x + sp / 2)
    y1 = Math.min(y1, b.h, b.l); y2 = Math.max(y2, b.h, b.l)
  }
  return Number.isFinite(x1) ? { x: x1, y: y1, w: x2 - x1, h: y2 - y1 } : null
}

// ── 幽灵 K 线：按点出的折线生成一串预想的 K 线（每段按 K 线宽度切成几根，影线长短做个确定性的抖动）──
// Ghost feed: a run of imagined candles along the clicked path (each leg cut at the bar width, wicks
// jittered deterministically)
const jitter = (i: number) => { const v = Math.sin(i * 12.9898 + 78.233) * 43758.5453; return v - Math.floor(v) }
export function ghostBars(px: Px[], env: DrawEnv): GhostBar[] {
  const sp = spacingOf(env)
  const out: GhostBar[] = []
  let k = 0
  for (let s = 0; s + 1 < px.length; s++) {
    const a = px[s], b = px[s + 1]
    const n = Math.max(1, Math.round(Math.abs(b.x - a.x) / sp))
    let prev = a.y
    for (let j = 1; j <= n; j++) {
      const t = j / n
      const c = a.y + (b.y - a.y) * t
      const amp = Math.abs(c - prev) * 0.5 + sp * 0.6
      out.push({ x: a.x + (b.x - a.x) * t, o: prev, c, h: Math.min(prev, c) - amp * jitter(k * 2 + 1), l: Math.max(prev, c) + amp * jitter(k * 2 + 2) })
      prev = c
      k++
    }
  }
  return out
}

// ── 表格：文字里每行一行、用 | 分列；第一行当表头 / table: one row per line, cells split by |, first row is the header ──
export function tableGrid(d: Drawing) {
  const rows = (d.text ?? '').split('\n').map((r) => r.split('|').map((c) => c.trim()))
  const cols = Math.max(1, ...rows.map((r) => r.length))
  const fs = fontSizeOf(d)
  const colW = Array.from({ length: cols }, (_, ci) => Math.max(36, ...rows.map((r) => textWidth(r[ci] ?? '', fs))) + 14)
  const rowH = Math.round(fs * 1.6 + 4)
  return { rows, cols, colW, rowH, fs, w: colW.reduce((a, b) => a + b, 0), h: rowH * rows.length }
}
const lightTheme = (env: DrawEnv) => env.theme.bg === '#ffffff'

// ── 图片：data URL 解码一次缓存起来，解码完请求重画 / image: decoded once and cached, repaint requested when ready ──
const imgCache = new Map<string, HTMLImageElement>()
function imageOf(src: string, env: DrawEnv): HTMLImageElement | null {
  let im = imgCache.get(src)
  if (!im) {
    if (typeof Image === 'undefined') return null
    im = new Image()
    im.onload = () => env.redraw?.()
    im.src = src
    imgCache.set(src, im)
    if (imgCache.size > 40) imgCache.delete(imgCache.keys().next().value as string)
  }
  return im.complete && im.naturalWidth > 0 ? im : null
}
const rectOf = (px: Px[]) => ({ x: Math.min(px[0].x, px[1].x), y: Math.min(px[0].y, px[1].y), w: Math.abs(px[1].x - px[0].x), h: Math.abs(px[1].y - px[0].y) })
// 四角手柄（与矩形一致）/ four corner handles, same as the rectangle
const corners = (px: Px[]): Px[] => [px[0], px[1], { x: px[0].x, y: px[1].y }, { x: px[1].x, y: px[0].y }]
const cornerDrag = (_d: Drawing, i: number, pt: { t: number; p: number }, o: { t: number; p: number }[]) => {
  if (i === 0) return [pt, o[1]]
  if (i === 1) return [o[0], pt]
  if (i === 2) return [{ t: pt.t, p: o[0].p }, { t: o[1].t, p: pt.p }]
  return [{ t: o[0].t, p: pt.p }, { t: pt.t, p: o[1].p }]
}

export const MISC: ToolDefs = {
  barsPattern: {
    render(ctx, d, px, env, hot) {
      // 还在框选源区间（没复制）时画一个范围框 / while picking the source range, show the span
      if (!d.bars) {
        ctx.save(); ctx.fillStyle = withAlpha(d.color, 0.08)
        ctx.fillRect(Math.min(px[0].x, px[1].x), 0, Math.abs(px[1].x - px[0].x), env.h); ctx.restore()
        guide(ctx, d.color, [{ x: px[0].x, y: 0 }, { x: px[0].x, y: env.h }])
        guide(ctx, d.color, [{ x: px[1].x, y: 0 }, { x: px[1].x, y: env.h }])
        return
      }
      const sp = spacingOf(env)
      const bars = patternBars(d, px, env)
      paintCandles(ctx, bars, sp, d.color, d.color, 0.35)
      const box = barsBox(bars, sp)
      if (box && hot) { ctx.save(); ctx.strokeStyle = withAlpha(d.color, 0.5); ctx.setLineDash([4, 3]); ctx.strokeRect(box.x, box.y, box.w, box.h); ctx.restore() }
    },
    hit(d, px, env, x, y) {
      if (!d.bars) return null
      const box = barsBox(patternBars(d, px, env), spacingOf(env))
      return box && inRect(x, y, box, 4) ? 0 : null
    },
    handles: (_d, px) => [px[0]],
    // 唯一的手柄 = 整体挪 / the one handle moves the whole copy
    drag: (_d, _i, pt, o) => o.map((q) => ({ t: q.t + (pt.t - o[0].t), p: q.p + (pt.p - o[0].p) })),
  },

  ghostFeed: {
    render(ctx, d, px, env, hot) {
      if (hot) guide(ctx, d.color, px, 0.45)
      paintCandles(ctx, ghostBars(px, env), spacingOf(env), UP, DOWN, 0.4)
    },
    hit(_d, px, env, x, y) { return nearest(env, Math.max(0, distToPolyline(x, y, px) - spacingOf(env))) },
  },

  table: {
    render(ctx, d, px, env, hot) {
      const g = tableGrid(d)
      const { x, y } = px[0]
      const light = lightTheme(env)
      ctx.save()
      ctx.setLineDash([])
      ctx.fillStyle = light ? 'rgba(255,255,255,0.94)' : 'rgba(22,26,36,0.94)'
      ctx.fillRect(x, y, g.w, g.h)
      ctx.fillStyle = withAlpha(d.color, 0.32)
      ctx.fillRect(x, y, g.w, g.rowH)
      ctx.strokeStyle = withAlpha(d.color, hot ? 0.95 : 0.6)
      ctx.lineWidth = 1
      ctx.strokeRect(x + 0.5, y + 0.5, g.w - 1, g.h - 1)
      for (let r = 1; r < g.rows.length; r++) { ctx.beginPath(); ctx.moveTo(x, y + r * g.rowH + 0.5); ctx.lineTo(x + g.w, y + r * g.rowH + 0.5); ctx.stroke() }
      let cx = x
      for (let c = 0; c < g.cols - 1; c++) { cx += g.colW[c]; ctx.beginPath(); ctx.moveTo(cx + 0.5, y); ctx.lineTo(cx + 0.5, y + g.h); ctx.stroke() }
      ctx.fillStyle = d.textColor || (light ? '#0f172a' : '#e2e8f0')
      ctx.textBaseline = 'middle'
      ctx.textAlign = 'left'
      g.rows.forEach((row, r) => {
        ctx.font = (r === 0 ? '600 ' : '') + SANS(g.fs)
        let tx = x
        for (let c = 0; c < g.cols; c++) {
          ctx.fillText(row[c] ?? '', tx + 7, y + r * g.rowH + g.rowH / 2)
          tx += g.colW[c]
        }
      })
      ctx.restore()
    },
    hit(d, px, env, x, y) {
      const g = tableGrid(d)
      return hitOrInside(env, Infinity, inRect(x, y, { x: px[0].x, y: px[0].y, w: g.w, h: g.h }))
    },
  },

  image: {
    render(ctx, d, px, env, hot) {
      const r = rectOf(px)
      const im = d.img ? imageOf(d.img, env) : null
      ctx.save()
      if (im) {
        ctx.globalAlpha = d.alpha ?? 1
        ctx.drawImage(im, r.x, r.y, r.w, r.h)
        ctx.globalAlpha = 1
      } else {
        // 还没选图：虚线框 + 图片图标 / no image yet: a dashed box with a picture glyph
        ctx.fillStyle = withAlpha(d.color, 0.06); ctx.fillRect(r.x, r.y, r.w, r.h)
        ctx.strokeStyle = withAlpha(d.color, 0.8); ctx.setLineDash([5, 4]); ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w, r.h)
        ctx.setLineDash([])
        const s = Math.min(28, r.w * 0.5, r.h * 0.5)
        if (s > 8) {
          const cx = r.x + r.w / 2, cy = r.y + r.h / 2
          ctx.strokeRect(cx - s / 2, cy - s * 0.38, s, s * 0.76)
          ctx.beginPath(); ctx.moveTo(cx - s / 2, cy + s * 0.3); ctx.lineTo(cx - s / 8, cy - s / 12); ctx.lineTo(cx + s / 6, cy + s / 5); ctx.lineTo(cx + s / 2, cy - s / 8); ctx.stroke()
        }
      }
      if (hot && im) { ctx.strokeStyle = withAlpha(d.color, 0.8); ctx.lineWidth = 1; ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w, r.h) }
      ctx.restore()
    },
    hit(_d, px, env, x, y) { return hitOrInside(env, Infinity, inRect(x, y, rectOf(px))) },
    handles: (_d, px) => corners(px),
    drag: cornerDrag,
  },
}
