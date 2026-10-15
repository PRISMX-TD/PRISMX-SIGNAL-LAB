import { describe, expect, it } from 'vitest'
import type { Candle } from '../api/types'
import { shenlong } from './indicators'

const mk = (closes: number[]): Candle[] =>
  closes.map((c, i) => ({ t: i * 60, o: c - 0.3, h: c + 1, l: c - 1, c, v: 0 }) as Candle)

describe('shenlong', () => {
  it('returns empty series for too few bars', () => {
    const r = shenlong(mk([1, 2, 3]))
    expect(r.lo.every((v) => v == null)).toBe(true)
  })

  it('computes rails around price, stop lines outside, and some signals on a wave', () => {
    const closes = [...Array(400)].map((_, i) => 100 + 15 * Math.sin(i / 9))
    const r = shenlong(mk(closes))
    const k = 300
    expect(r.hi[k]!).toBeGreaterThan(r.lo[k]!)
    expect(r.slSellLine[k]!).toBeGreaterThan(r.hi[k]!)
    expect(r.slBuyLine[k]!).toBeLessThan(r.lo[k]!)
    expect(r.beltTop[k]!).toBeGreaterThanOrEqual(r.beltBot[k]!)
    expect(r.sig.some((s) => s != null)).toBe(true)
    r.sig.forEach((s, i) => {
      if (s === 1) expect(r.slBuy[i]).not.toBeNull()
      if (s === -1) expect(r.slSell[i]).not.toBeNull()
    })
  })
})
