import { describe, expect, it } from 'vitest'
import { calcDayChange, fmtPct, mergeDayRefs } from './useDayChange'

describe('calcDayChange', () => {
  it('compares the live bid with the previous close', () => {
    const r = calcDayChange(101, { open: 99, prevClose: 100, t: 1 })!
    expect(r.chg).toBeCloseTo(1)
    expect(r.pct).toBeCloseTo(1)
  })
  it('falls back to the day open without a previous close', () => {
    const r = calcDayChange(98, { open: 100, prevClose: null, t: 1 })!
    expect(r.pct).toBeCloseTo(-2)
  })
  it('returns null without a bid, a ref or a usable base', () => {
    expect(calcDayChange(null, { open: 1, prevClose: 1, t: 1 })).toBeNull()
    expect(calcDayChange(1, undefined)).toBeNull()
    expect(calcDayChange(1, { open: 0, prevClose: 0, t: 1 })).toBeNull()
  })
})

describe('fmtPct', () => {
  it('signs and rounds', () => {
    expect(fmtPct(0.4234)).toBe('+0.42%')
    expect(fmtPct(-1.3)).toBe('−1.30%')
    expect(fmtPct(0.001)).toBe('0.00%')
    expect(fmtPct(-0.004)).toBe('0.00%')
    expect(fmtPct(150.4)).toBe('+150%')
  })
})

describe('mergeDayRefs', () => {
  it('keeps unchanged objects and the same map when nothing changed', () => {
    const a = { open: 1, prevClose: 2, t: 3 }
    const prev = { EURUSD: a }
    const same = mergeDayRefs(prev, { EURUSD: { open: 1, prevClose: 2, t: 3 } })
    expect(same).toBe(prev)
    const next = mergeDayRefs(prev, { EURUSD: { open: 1, prevClose: 2, t: 3 }, XAUUSD: { open: 5, prevClose: null, t: 3 } })
    expect(next).not.toBe(prev)
    expect(next.EURUSD).toBe(a)
    expect(next.XAUUSD.open).toBe(5)
  })
  it('drops malformed entries and notices removals', () => {
    const prev = { A: { open: 1, prevClose: 1, t: 1 }, B: { open: 2, prevClose: 2, t: 1 } }
    const next = mergeDayRefs(prev, { A: { open: 1, prevClose: 1, t: 1 }, C: { open: 'x' } as never })
    expect(Object.keys(next)).toEqual(['A'])
    expect(next.A).toBe(prev.A)
  })
})
