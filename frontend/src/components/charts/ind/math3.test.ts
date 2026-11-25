import { describe, it, expect } from 'vitest'
import type { Candle } from '../../../api/types'
import * as M from './math3'

function randomBars(n: number, seed = 7, step = 900): Candle[] {
  let x = seed
  const rnd = () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648)
  const out: Candle[] = []
  let c = 100
  for (let i = 0; i < n; i++) {
    const o = c
    c = o + (rnd() - 0.5) * 2
    out.push({ t: 1_700_000_000 + i * step, o, h: Math.max(o, c) + rnd(), l: Math.min(o, c) - rnd(), c, v: 1 + Math.floor(rnd() * 100) })
  }
  return out
}
const bar = (t: number, o: number, h: number, l: number, c: number, v = 10): Candle => ({ t, o, h, l, c, v })
const bars = randomBars(600)
const day = (t: number) => Math.floor(t / 86400)

describe('volume profile', () => {
  it('conserves volume and keeps POC inside the value area', () => {
    const p = M.volumeProfile(bars, 100, 299, 24, 70)!
    const vol = bars.slice(100, 300).reduce((s, b) => s + b.v, 0)
    const tot = p.up.reduce((a, b) => a + b, 0) + p.dn.reduce((a, b) => a + b, 0)
    expect(Math.abs(tot - vol)).toBeLessThan(1e-6)
    expect(p.val).toBeLessThanOrEqual(p.poc)
    expect(p.vah).toBeGreaterThanOrEqual(p.poc)
    const rows = p.up.map((u, r) => u + p.dn[r])
    const inVa = rows.slice(p.val, p.vah + 1).reduce((a, b) => a + b, 0)
    expect(inVa / tot).toBeGreaterThanOrEqual(0.7)
  })
  it('puts all volume of a flat bar in one row; up vs down by close/open', () => {
    const p = M.volumeProfile([bar(0, 1, 2, 0, 2, 5), bar(60, 2, 2, 0, 1, 3)], 0, 1, 4)!
    expect(p.up.reduce((a, b) => a + b, 0)).toBeCloseTo(5)
    expect(p.dn.reduce((a, b) => a + b, 0)).toBeCloseTo(3)
  })
  it('splits sessions', () => {
    const s = M.sessionProfiles(bars, day, 20)
    expect(s.length).toBeGreaterThan(3)
    for (let k = 1; k < s.length; k++) expect(s[k].i1).toBe(s[k - 1].i2 + 1)
  })
  it('value area grows toward the bigger neighbour', () => {
    expect(M.valueArea([1, 5, 10, 2, 1], 2, 70)).toEqual([1, 2])
  })
})

describe('tpo', () => {
  it('assigns periods and an initial balance', () => {
    const t = M.tpoProfiles(bars, day, 1800, 20)
    expect(t.length).toBeGreaterThan(2)
    const s = t[1]
    expect(s.periodBar[0]).toBe(s.i1)
    for (const row of s.rows) for (let k = 1; k < row.length; k++) expect(row[k]).toBeGreaterThan(row[k - 1])
    expect(s.ibHi).toBeGreaterThanOrEqual(s.ibLo)
    expect(s.rows[s.poc].length).toBe(Math.max(...s.rows.map((r) => r.length)))
  })
})

describe('candle patterns', () => {
  it('finds a bullish engulfing after a falling bar', () => {
    const b = [bar(0, 10, 10.2, 8.9, 9), bar(60, 8.8, 10.5, 8.7, 10.4)]
    expect(M.candlePatterns(b, 'none').some((p) => p.key === 'engulfBull' && p.i === 1)).toBe(true)
  })
  it('finds doji variants and a hammer', () => {
    const b = [bar(0, 10, 11, 9, 10), bar(60, 10, 10.02, 9, 10.01), bar(120, 10, 11, 9.98, 10.01)]
    const keys = M.candlePatterns(b, 'none').map((p) => `${p.i}:${p.key}`)
    expect(keys).toContain('0:doji')
    expect(keys).toContain('1:dragonfly')
    expect(keys).toContain('2:gravestone')
    const h = M.candlePatterns([...randomBars(20, 3), bar(9e9, 10, 10.05, 9, 10.04)].map((x, i) => ({ ...x, t: i })), 'none')
    expect(h.some((p) => p.key === 'hammer')).toBe(true)
  })
  it('three white soldiers', () => {
    const b = [bar(0, 10, 11.1, 9.9, 11), bar(60, 10.5, 12.1, 10.4, 12), bar(120, 11.5, 13.1, 11.4, 13)]
    expect(M.candlePatterns(b, 'none').some((p) => p.key === 'soldiers' && p.i === 2)).toBe(true)
  })
  it('respects the wanted directions', () => {
    const all = M.candlePatterns(bars, 'sma50')
    const bull = M.candlePatterns(bars, 'sma50', { bull: true, bear: false, neutral: false })
    expect(bull.every((p) => p.dir === 1)).toBe(true)
    expect(bull.length).toBe(all.filter((p) => p.dir === 1).length)
  })
})

describe('chart patterns', () => {
  // 用折线拼出 K 线：每段 10 根 / bars along a polyline, 10 per leg
  const legs = (pts: number[]): Candle[] => {
    const out: Candle[] = []
    for (let k = 0; k + 1 < pts.length; k++) {
      for (let j = 0; j < 10; j++) {
        const v = pts[k] + ((pts[k + 1] - pts[k]) * j) / 10
        out.push(bar(out.length * 60, v, v + 0.05, v - 0.05, v))
      }
    }
    const v = pts[pts.length - 1]
    for (let j = 0; j < 8; j++) out.push(bar(out.length * 60, v, v + 0.05, v - 0.05, v))
    return out
  }
  it('double top', () => {
    const r = M.chartPatterns(legs([100, 110, 103, 110.3, 101]), 2, 4)
    expect(r.map((p) => p.key)).toContain('doubleTop')
  })
  it('head and shoulders', () => {
    const r = M.chartPatterns(legs([100, 108, 103, 114, 103, 108.3, 99]), 2, 4)
    expect(r.map((p) => p.key)).toContain('hs')
  })
  it('ascending triangle', () => {
    const r = M.chartPatterns(legs([95, 110, 100, 110.2, 104, 110.1, 107]), 1, 4)
    expect(r.map((p) => p.key)).toContain('triAsc')
  })
})

describe('swing, boxes, 52w, performance', () => {
  it('last swing is the last two pivots', () => {
    const s = M.lastSwing(bars, 1, 10)!
    expect(s.i2).toBeGreaterThan(s.i1)
  })
  it('htf boxes cover every bar once', () => {
    const b = M.htfBoxes(bars, (t) => Math.floor(t / 14400))
    expect(b[0].i1).toBe(0)
    expect(b[b.length - 1].i2).toBe(bars.length - 1)
    for (const x of b) expect(x.h).toBeGreaterThanOrEqual(Math.max(x.o, x.c))
  })
  it('52w high/low from chart bars only equals a running max over the window', () => {
    const r = M.highLow52(bars, null, day, 1)
    const i = 300
    const from = bars.findIndex((b) => b.t > bars[i].t - 86400)
    expect(r.hi[i]).toBe(Math.max(...bars.slice(from, i + 1).map((b) => b.h)))
    expect(r.lo[i]).toBe(Math.min(...bars.slice(from, i + 1).map((b) => b.l)))
  })
  it('52w with daily bars uses prior days plus today so far', () => {
    const daily = [bar(0, 1, 50, 1, 1), bar(86400, 1, 20, 0.5, 1), bar(2 * 86400, 1, 2, 1, 1)]
    const intraday = [bar(2 * 86400, 1, 3, 1, 1), bar(2 * 86400 + 60, 1, 60, 1, 1)]
    const r = M.highLow52(intraday, daily, day, 365)
    expect(r.hi).toEqual([50, 60])
    expect(r.lo).toEqual([0.5, 0.5])
  })
  it('performance', () => {
    const d = Array.from({ length: 400 }, (_, i) => bar(i * 86400, 100 + i, 100 + i, 100 + i, 100 + i))
    const now = 399 * 86400
    const p = M.performance(d, 499, now, (t) => Math.floor(t / (365 * 86400)))
    expect(p.w1).toBeCloseTo(((499 - 492) / 492) * 100)
    expect(p.y1).toBeCloseTo(((499 - 134) / 134) * 100)
    expect(p.ytd).toBeCloseTo(((499 - 464) / 464) * 100)
  })
})

describe('tech rating, correlation', () => {
  it('ratings stay within [-1, 1]', () => {
    const r = M.techRating(bars)
    for (const v of [...r.all, ...r.ma, ...r.osc]) if (v != null) expect(Math.abs(v)).toBeLessThanOrEqual(1)
    expect(r.all.filter((v) => v != null).length).toBeGreaterThan(300)
  })
  it('a steady uptrend rates the MA group as buy', () => {
    const up = Array.from({ length: 300 }, (_, i) => bar(i * 60, 100 + i, 100.5 + i, 99.5 + i, 100.2 + i))
    expect(M.techRating(up).ma[299]).toBeGreaterThan(0.5)
  })
  it('rating bands', () => {
    expect([-0.8, -0.3, 0, 0.3, 0.8].map(M.ratingBand)).toEqual([0, 1, 2, 3, 4])
  })
  it('align + correlation', () => {
    const other = bars.filter((_, i) => i % 2 === 0).map((b) => ({ ...b, c: b.c * 2 + 1 }))
    const al = M.alignCloses(bars, other, 3600)
    expect(al[3]).toBe(other[1].c)
    const corr = M.correlation(bars.map((b) => b.c), bars.map((b) => b.c * 3 - 2), 20)
    expect(corr[50]).toBeCloseTo(1)
    const neg = M.correlation(bars.map((b) => b.c), bars.map((b) => -b.c), 20)
    expect(neg[50]).toBeCloseTo(-1)
  })
})
