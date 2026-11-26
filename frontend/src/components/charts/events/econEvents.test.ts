import { describe, expect, it } from 'vitest'
import type { EconGroup } from '../../../api/econTypes'
import { normalizeChartPrefs } from '../chartPrefs'
import { BLOCK_DAYS, MAX_BACK_DAYS, MAX_AHEAD_DAYS, REQ_DAYS, clusterByX, hitCluster, toEvents, windowsFor } from './econEvents'

const DAY = 86400
const g = (o: Partial<EconGroup>): EconGroup => ({
  key: 'k', country: 'US', currency: 'USD', at: '2026-11-27T13:30:00Z', date: '2026-11-27', allDay: false, indicative: false,
  importance: 3, status: 'scheduled', releases: [{ name: 'CPI', period: null }], values: [], primaryMeasure: null, outcome: null, preview: null, ...o,
})

describe('clusterByX', () => {
  it('merges points closer than the gap to the first point of the cluster', () => {
    const c = clusterByX([{ x: 100, item: 'a' }, { x: 10, item: 'b' }, { x: 112, item: 'c' }, { x: 118, item: 'd' }, { x: 140, item: 'e' }], 17)
    expect(c.map((k) => k.items)).toEqual([['b'], ['a', 'c'], ['d'], ['e']])
  })
  it('stacks events at the same x and averages the centre', () => {
    const c = clusterByX([{ x: 50, item: 1 }, { x: 50, item: 2 }, { x: 56, item: 3 }], 17)
    expect(c).toHaveLength(1)
    expect(c[0].items).toEqual([1, 2, 3])
    expect(c[0].x).toBeCloseTo(52)
  })
  it('returns nothing for no points', () => {
    expect(clusterByX([], 17)).toEqual([])
  })
})

describe('hitCluster', () => {
  it('finds the nearest cluster within the radius on the badge row only', () => {
    expect(hitCluster([10, 40, 70], 100, 43, 102, 10)).toBe(1)
    expect(hitCluster([10, 40, 70], 100, 55, 100, 10)).toBe(-1)
    expect(hitCluster([10, 40, 70], 100, 40, 80, 10)).toBe(-1)
  })
})

describe('windowsFor', () => {
  const now = Date.UTC(2026, 10, 27) / 1000
  it('covers the range with fixed blocks and a spare day each side', () => {
    const w = windowsFor(now - 3 * DAY, now + 2 * DAY, now)
    expect(w.length).toBeGreaterThanOrEqual(1)
    for (const x of w) {
      expect(x.days).toBe(REQ_DAYS)
      expect(x.to - x.from).toBe(BLOCK_DAYS * DAY)
      expect(Date.parse(`${x.start}T00:00:00Z`) / 1000).toBe(x.from - DAY)
      // 请求覆盖整块再各多一天 / the request spans the block plus a day each side
      expect(x.from - DAY + REQ_DAYS * DAY).toBeGreaterThanOrEqual(x.to + DAY)
    }
    expect(w[0].from).toBeLessThanOrEqual(now - 3 * DAY)
    expect(w[w.length - 1].to).toBeGreaterThan(now + 2 * DAY)
  })
  it('gives the same keys while panning inside a block', () => {
    const a = windowsFor(now - DAY, now, now).map((x) => x.start)
    const b = windowsFor(now - DAY + 3600, now + 3600, now).map((x) => x.start)
    expect(b[0]).toBe(a[0])
  })
  it('clamps to 120 days back and 14 ahead', () => {
    const w = windowsFor(now - 400 * DAY, now + 60 * DAY, now)
    expect(w[0].to).toBeGreaterThan(now - MAX_BACK_DAYS * DAY)
    expect(w[0].from).toBeLessThanOrEqual(now - MAX_BACK_DAYS * DAY)
    expect(w[w.length - 1].from).toBeLessThanOrEqual(now + MAX_AHEAD_DAYS * DAY)
    expect(w.length).toBeLessThanOrEqual(16)
    expect(windowsFor(now - 400 * DAY, now - 300 * DAY, now)).toEqual([])
  })
})

describe('toEvents', () => {
  it('filters by currency and importance, drops cancelled, sorts and dedupes', () => {
    const ev = toEvents([
      g({ key: 'b', at: '2026-11-27T15:00:00Z' }),
      g({ key: 'a', at: '2026-11-27T13:30:00Z', importance: 2 }),
      g({ key: 'a', at: '2026-11-27T13:30:00Z', importance: 2 }),
      g({ key: 'eur', currency: 'EUR', country: 'EU' }),
      g({ key: 'low', importance: 1 }),
      g({ key: 'x', status: 'cancelled' }),
      g({ key: 'cn', currency: null, country: 'CN', at: '2026-11-27T01:30:00Z' }),
    ], ['USD', 'CNY'], 2)
    expect(ev.map((e) => e.key)).toEqual(['cn', 'a', 'b'])
    expect(ev[1].t).toBe(Date.parse('2026-11-27T13:30:00Z') / 1000)
    expect(ev[0].currency).toBe('CNY')
    expect(toEvents([g({ key: 'a', importance: 2 })], ['USD'], 3)).toEqual([])
  })
  it('places all-day events at 00:00 UTC of their date', () => {
    const [e] = toEvents([g({ key: 'd', at: null, date: '2026-11-28', allDay: true })], ['USD'], 2)
    expect(e.t).toBe(Date.parse('2026-11-28T00:00:00Z') / 1000)
    expect(e.allDay).toBe(true)
  })
})

describe('chart prefs: events', () => {
  it('defaults to econ on, importance 2, and normalises bad values', () => {
    expect(normalizeChartPrefs({}).events).toEqual({ econ: true, minImp: 2 })
    expect(normalizeChartPrefs({ events: { econ: false, minImp: 3 } }).events).toEqual({ econ: false, minImp: 3 })
    expect(normalizeChartPrefs({ events: { econ: 'x', minImp: 7 } }).events).toEqual({ econ: true, minImp: 2 })
  })
})
