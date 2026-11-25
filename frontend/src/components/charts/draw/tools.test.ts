import { describe, expect, it } from 'vitest'
import { finishPoints, sanitizeDrawings, visibleOn, visGroupOf, type Drawing } from './model'
import { dragHandle, hitDrawing, handlesOf, inMarquee, constrain45, type DrawEnv } from './tools'

// 线性坐标：t 每 60 秒 1px，价格每 1 元 1px（y 向下）/ linear coords: 1px per 60 s, 1px per unit price
const env: DrawEnv = {
  w: 800, h: 400,
  t2x: (t) => t / 60, p2y: (p) => 400 - p, y2p: (y) => 400 - y,
  fmtPrice: (p) => p.toFixed(2), bars: (a, b) => Math.abs(b - a) / 60,
  pips: () => null, qty: () => null,
  L: { bars: 'bars', rr: 'rr', target: 't', stop: 's', qty: 'q', risk: 'r', pips: 'p', dur: () => '' },
  theme: { bg: '#000', text: '#fff' }, touch: false,
}
const px = (d: Drawing) => d.pts.map((p) => ({ x: env.t2x(p.t)!, y: env.p2y(p.p)! }))
const mk = (type: Drawing['type'], pts: [number, number][], extra: Partial<Drawing> = {}): Drawing =>
  ({ id: 'x', type, color: '#22d3ee', pts: pts.map(([x, p]) => ({ t: x * 60, p })), ...extra })

describe('draw model', () => {
  it('long position: stop mirrors the target around the entry', () => {
    const pts = finishPoints('long', [{ t: 600, p: 100 }, { t: 1200, p: 110 }])
    expect(pts).toEqual([{ t: 600, p: 100 }, { t: 1200, p: 110 }, { t: 1200, p: 90 }])
    const sp = finishPoints('short', [{ t: 1200, p: 100 }, { t: 600, p: 104 }])
    expect(sp[0]).toEqual({ t: 600, p: 100 })
    expect(sp[1].p).toBe(96)
    expect(sp[2].p).toBe(104)
  })
  it('sanitize drops unknown types and broken points', () => {
    const out = sanitizeDrawings([
      { id: 'a', type: 'trend', pts: [{ t: 1, p: 1 }, { t: 2, p: 2 }], color: '#fff' },
      { id: 'b', type: 'spiral', pts: [{ t: 1, p: 1 }] },
      { id: 'c', type: 'hline', pts: [{ t: 0, p: NaN }] },
      null,
    ])
    expect(out.map((d) => d.id)).toEqual(['a'])
  })
  it('visibility per interval group', () => {
    expect(visGroupOf('15')).toBe('m')
    expect(visGroupOf('240')).toBe('h')
    expect(visGroupOf('D')).toBe('d')
    expect(visGroupOf('1W')).toBe('w')
    expect(visGroupOf('1M')).toBe('M')
    const d = mk('trend', [[1, 1], [2, 2]], { vis: { m: false } })
    expect(visibleOn(d, '5')).toBe(false)
    expect(visibleOn(d, 'D')).toBe(true)
    expect(visibleOn({ ...d, hidden: true }, 'D')).toBe(false)
  })
})

describe('draw tools', () => {
  it('trend hits on the segment only; ray beyond its end too', () => {
    const d = mk('trend', [[100, 100], [200, 200]])
    expect(hitDrawing(d, px(d), env, 150, 250)).not.toBeNull()
    expect(hitDrawing(d, px(d), env, 300, 100)).toBeNull()
    const r = { ...d, type: 'ray' as const }
    expect(hitDrawing(r, px(r), env, 300, 100)).not.toBeNull()
  })
  it('rect corner handles map back onto the two points', () => {
    const d = mk('rect', [[100, 100], [200, 200]])
    expect(handlesOf(d, px(d), env)).toHaveLength(4)
    const moved = dragHandle(d, 2, { t: 50 * 60, p: 50 }, d.pts)
    expect(moved).toEqual([{ t: 3000, p: 100 }, { t: 12000, p: 50 }])
  })
  it('channel third handle sets the offset, base unchanged', () => {
    const d = mk('channel', [[100, 100], [200, 150], [100, 120]])
    const moved = dragHandle(d, 3, { t: 200 * 60, p: 180 }, d.pts)
    expect(moved[0]).toEqual(d.pts[0])
    expect(moved[1]).toEqual(d.pts[1])
    expect(moved[2].p - moved[0].p).toBe(30)
  })
  it('position handles move entry / target / stop independently', () => {
    const d = mk('long', [[100, 100], [200, 110], [200, 90]])
    expect(dragHandle(d, 1, { t: 0, p: 130 }, d.pts)[1]).toEqual({ t: 12000, p: 130 })
    expect(dragHandle(d, 2, { t: 0, p: 80 }, d.pts)[2]).toEqual({ t: 12000, p: 80 })
    const w = dragHandle(d, 3, { t: 300 * 60, p: 0 }, d.pts)
    expect(w[1].t).toBe(18000)
    expect(w[2].t).toBe(18000)
  })
  it('fib levels are hittable', () => {
    const d = mk('fib', [[100, 200], [300, 100]])
    // 0.5 level at price 150 → y 250
    expect(hitDrawing(d, px(d), env, 200, 250)).not.toBeNull()
    expect(hitDrawing(d, px(d), env, 200, 230)).toBeNull()
  })
  it('marquee selects by any anchor; hline by its row', () => {
    const d = mk('trend', [[100, 100], [500, 200]])
    expect(inMarquee(d, px(d), { x1: 90, y1: 290, x2: 110, y2: 310 })).toBe(true)
    const h = mk('hline', [[0, 100]])
    expect(inMarquee(h, px(h), { x1: 0, y1: 290, x2: 20, y2: 310 })).toBe(true)
  })
  it('shift snaps to 45°', () => {
    const b = constrain45({ x: 0, y: 0 }, { x: 100, y: 10 })
    expect(Math.round(b.y)).toBe(0)
    const c = constrain45({ x: 0, y: 0 }, { x: 100, y: 90 })
    expect(Math.round(c.x)).toBe(Math.round(c.y))
  })
})
