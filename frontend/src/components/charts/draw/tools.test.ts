import { describe, expect, it } from 'vitest'
import { finishPoints, sanitizeDrawings, visibleOn, visGroupOf, pointsNeeded, isScreenAnchored, TOOL_META, type Drawing } from './model'
import { dragHandle, hitDrawing, handlesOf, inMarquee, constrain45, anchorsOf, renderDrawing, type DrawEnv } from './tools'
import { volumeProfile, vwapSeries, valueAreaTv, developing, vpOf } from './ext/volume'
import { patternBars, tableGrid, ghostBars } from './ext/misc'
import { spiralPts } from './ext/advanced'

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

describe('draw tools, batch 2', () => {
  // 什么都接住的假 canvas：只为跑通每个工具的绘制路径 / a canvas stub that swallows every call
  const ctx = new Proxy({} as Record<string | symbol, unknown>, {
    get: (o, k) => {
      if (k in o) return o[k]
      if (k === 'measureText') return (s: string) => ({ width: String(s).length * 7 })
      if (k === 'getLineDash') return () => []
      if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => ({ addColorStop: () => {} })
      return () => {}
    },
    set: (o, k, v) => { o[k] = v; return true },
  }) as unknown as CanvasRenderingContext2D
  const envC: DrawEnv = {
    ...env,
    closes: (t0, t1) => Array.from({ length: 20 }, (_, i) => ({ x: (t0 + (t1 - t0) * i / 19) / 60, c: 100 + Math.sin(i) * 10 })),
    ohlc: () => Array.from({ length: 30 }, (_, i) => ({ x: 100 + i * 5, t: (100 + i * 5) * 60, o: 100 + i, h: 103 + i, l: 98 + i, c: 101 + i, v: 10 + i })),
    spacing: 5,
  }

  it('every tool renders, hit-tests, exposes handles and drags without throwing', () => {
    for (const type of Object.keys(TOOL_META) as Drawing['type'][]) {
      const cm = TOOL_META[type].create
      const n = cm === 'poly' || cm === 'free' ? 4 : type === 'long' || type === 'short' ? 3 : pointsNeeded(type)
      const d = isScreenAnchored(type)
        ? { id: 'x', type, color: '#22d3ee', text: 'hi', pts: [{ t: 0.5, p: 0.3 }] } as Drawing
        : mk(type, Array.from({ length: n }, (_, i) => [100 + i * 40, 100 + (i % 2 ? 60 : 0) + i * 5] as [number, number]), { text: 'hi' })
      const p = anchorsOf(d, envC)
      for (const hot of [false, true]) expect(() => renderDrawing(ctx, d, p, envC, hot), type).not.toThrow()
      const h = hitDrawing(d, p, envC, p[0].x, p[0].y)
      expect(h === null || Number.isFinite(h), type).toBe(true)
      const hs = handlesOf(d, p, envC)
      if (hs.length) expect(dragHandle(d, 0, { t: 5000, p: 120 }, d.pts).length, type).toBe(d.pts.length)
    }
  })
  it('points needed per creation mode', () => {
    expect(pointsNeeded('xabcd')).toBe(5)
    expect(pointsNeeded('headShoulders')).toBe(7)
    expect(pointsNeeded('elliottImpulse')).toBe(6)
    expect(pointsNeeded('pitchfork')).toBe(3)
    expect(pointsNeeded('emoji')).toBe(1)
    expect(pointsNeeded('callout')).toBe(2)
  })
  it('pitchfork median ray is hittable far to the right', () => {
    const d = mk('pitchfork', [[100, 100], [200, 150], [200, 50]])
    expect(hitDrawing(d, px(d), env, 600, 300)).not.toBeNull()
    expect(hitDrawing(d, px(d), env, 40, 40)).toBeNull()
  })
  it('xabcd legs are hittable', () => {
    const d = mk('xabcd', [[100, 100], [150, 200], [200, 150], [250, 250], [300, 120]])
    expect(hitDrawing(d, px(d), env, 125, 250)).not.toBeNull()
    expect(hitDrawing(d, px(d), env, 700, 20)).toBeNull()
  })
  it('fib time zones sit on fibonacci multiples of the first gap', () => {
    const d = mk('fibTimeZone', [[100, 100], [120, 100]])
    expect(hitDrawing(d, px(d), env, 160, 200)).not.toBeNull() // 3 × 20
    expect(hitDrawing(d, px(d), env, 200, 200)).not.toBeNull() // 5 × 20
    expect(hitDrawing(d, px(d), env, 230, 200)).toBeNull()
  })
  it('anchored text stays at a fixed spot of the pane', () => {
    const d = { id: 'a', type: 'anchoredText', color: '#fff', text: 'x', pts: [{ t: 0.5, p: 0.25 }] } as Drawing
    expect(anchorsOf(d, env)).toEqual([{ x: 400, y: 100 }])
    expect(sanitizeDrawings([d])).toHaveLength(1)
  })
})

describe('draw tools, batch 3', () => {
  const bar = (i: number, o: number, h: number, l: number, c: number, v: number) => ({ x: i * 10, t: i * 600, o, h, l, c, v })
  it('volume profile: POC on the busiest price, value area covers 70%', () => {
    const bars = [bar(0, 10, 11, 10, 11, 1), bar(1, 11, 12, 11, 12, 1), bar(2, 12, 13, 12, 12.5, 50), bar(3, 12.5, 13, 12, 12.2, 50), bar(4, 13, 14, 13, 14, 1)]
    const pr = volumeProfile(bars, 4)!
    expect(pr.lo).toBe(10)
    expect(pr.hi).toBe(14)
    expect(pr.poc).toBe(2) // 12..13
    const tot = pr.up.map((u, i) => u + pr.down[i])
    const all = tot.reduce((a, b) => a + b, 0)
    const va = tot.slice(pr.vaLo, pr.vaHi + 1).reduce((a, b) => a + b, 0)
    expect(va / all).toBeGreaterThanOrEqual(0.7)
    expect(all).toBeCloseTo(103, 6)
  })
  it('value area adds the bigger pair of rows each step, TradingView style', () => {
    // POC = 4；上方两行 1+1 = 2，下方两行 3+3 = 6 → 先整对并入下方，再比 2 对 0 → 上方
    // the pair below wins first (6 vs 2), then the pair above (2 vs 0)
    const tot = [0, 0, 3, 3, 10, 1, 1, 0]
    expect(valueAreaTv(tot, 4, 90)).toEqual([2, 5])
    expect(valueAreaTv(tot, 4, 70)).toEqual([3, 4]) // 13 / 18 already ≥ 70%
    // 够数就停，不硬凑满一对 / stops as soon as the goal is met
    expect(valueAreaTv([1, 1, 10, 5, 0], 2, 70)).toEqual([2, 3])
    expect(valueAreaTv([5], 0, 70)).toEqual([0, 0])
  })
  it('volume profile: ticks-per-row layout, custom value area %, developing POC', () => {
    const bars = [bar(0, 10, 11, 10, 11, 1), bar(1, 11, 12, 11, 12, 1), bar(2, 12, 13, 12, 12.5, 50), bar(3, 12.5, 13, 12, 12.2, 50), bar(4, 13, 14, 13, 14, 1)]
    const byTicks = volumeProfile(bars, { tick: 0.01, ticks: 50 })!
    expect(byTicks.up.length).toBe(8) // 4 / 0.5
    expect(byTicks.rowH).toBeCloseTo(0.5)
    expect(volumeProfile(bars, { tick: 0.00001, ticks: 1 })!.up.length).toBe(400) // capped
    const narrow = volumeProfile(bars, 4, 30)!
    expect([narrow.vaLo, narrow.vaHi]).toEqual([2, 2])
    const dev = developing(bars, volumeProfile(bars, 4)!, 70)
    expect(dev).toHaveLength(5)
    expect(dev[0].poc).toBeCloseTo(10.5) // only the first bar so far
    expect(dev[4].poc).toBeCloseTo(12.5)
  })
  it('vpOf fills TradingView-like defaults and keeps saved values', () => {
    const d = { id: 'v', type: 'fixedRangeVP', color: '#7c5cff', pts: [{ t: 0, p: 1 }, { t: 1, p: 1 }] } as Drawing
    const o = vpOf(d)
    expect(o).toMatchObject({ layout: 'rows', volume: 'updown', vaPct: 70, widthPct: 30, placement: 'left', hist: true })
    expect(o.vah).toEqual({ on: true, color: '#3d7bff' })
    expect(o.devPoc.on).toBe(false)
    const s = vpOf({ ...d, vp: { placement: 'right', vaPct: 150, poc: { on: false, color: '#ff0000' } } })
    expect(s.placement).toBe('right')
    expect(s.vaPct).toBe(100)
    expect(s.poc).toEqual({ on: false, color: '#ff0000' })
  })
  it('anchored VWAP is the volume-weighted typical price; zero volume counts each bar once', () => {
    const s = vwapSeries([bar(0, 10, 12, 8, 10, 1), bar(1, 10, 22, 18, 20, 3)])
    expect(s[0].v).toBeCloseTo(10)
    expect(s[1].v).toBeCloseTo((10 * 1 + 20 * 3) / 4)
    const z = vwapSeries([bar(0, 10, 12, 8, 10, 0), bar(1, 10, 22, 18, 20, 0)])
    expect(z[1].v).toBeCloseTo(15)
  })
  it('bars pattern copy flips around the first open and mirrors in time', () => {
    const d = mk('barsPattern', [[100, 100], [100, 100]], { bars: [[0, 2, -1, 1], [1, 5, 0, 4]] })
    const plain = patternBars(d, px(d), { ...env, spacing: 10 })
    expect(plain.map((b) => b.x)).toEqual([100, 110])
    expect(plain[1].c).toBe(env.p2y(104))
    const flipped = patternBars({ ...d, flip: true }, px(d), { ...env, spacing: 10 })
    expect(flipped[1].c).toBe(env.p2y(96))
    expect(flipped[1].h).toBe(env.p2y(100)) // low 0 → high after the flip
    const mirrored = patternBars({ ...d, mirror: true }, px(d), { ...env, spacing: 10 })
    expect(mirrored[0].o).toBe(env.p2y(104)) // the last bar comes first, open and close swapped
  })
  it('table splits rows on newlines and cells on |', () => {
    const g = tableGrid(mk('table', [[1, 1]], { text: 'A | B | C' + String.fromCharCode(10) + '1 | 2' }))
    expect(g.rows).toEqual([['A', 'B', 'C'], ['1', '2']])
    expect(g.cols).toBe(3)
    expect(g.h).toBe(g.rowH * 2)
  })
  it('fib spiral grows by φ every quarter turn', () => {
    const pts = spiralPts([{ x: 400, y: 200 }, { x: 410, y: 200 }], env)
    const r = pts.map((p) => Math.hypot(p.x - 400, p.y - 200))
    expect(Math.max(...r)).toBeGreaterThan(800)
    expect(Math.min(...r)).toBeLessThan(1.1)
  })
  it('ghost feed lays one candle per bar width along each leg', () => {
    const g = ghostBars([{ x: 0, y: 100 }, { x: 50, y: 50 }, { x: 80, y: 90 }], { ...env, spacing: 10 })
    expect(g).toHaveLength(8)
    expect(g[4].c).toBeCloseTo(50)
    expect(g[0].o).toBe(100)
  })
  it('sanitize drops malformed copied bars and non-image data URLs', () => {
    const out = sanitizeDrawings([
      { id: 'a', type: 'barsPattern', color: '#fff', pts: [{ t: 1, p: 1 }, { t: 1, p: 1 }], bars: [[1, 2, 3]] },
      { id: 'b', type: 'image', color: '#fff', pts: [{ t: 1, p: 1 }, { t: 2, p: 2 }], img: 'javascript:alert(1)' },
      { id: 'c', type: 'image', color: '#fff', pts: [{ t: 1, p: 1 }, { t: 2, p: 2 }], img: 'data:image/png;base64,AAAA' },
    ])
    expect(out[0].bars).toBeUndefined()
    expect(out[1].img).toBeUndefined()
    expect(out[2].img).toBe('data:image/png;base64,AAAA')
  })
})
