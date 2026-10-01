import { describe, expect, it } from 'vitest'
import type { Candle } from '../api/types'
import { xma, xmaBand } from './indicators'

describe('xma', () => {
  it('centred window, shrinks at both edges', () => {
    // n=4 → half=2: i=0 → mean(v0..v2), i=2 → mean(v0..v4), last → mean(v3..v5)
    expect(xma([1, 2, 3, 4, 5, 6], 4)).toEqual([2, 2.5, 3, 4, 4.5, 5])
  })
})

describe('xmaBand', () => {
  const bar = (i: number, h: number, l: number): Candle => ({ t: i * 60, o: l, h, l, c: h, v: 1 }) as Candle
  it('matches the TDX formula on a flat market', () => {
    const r = xmaBand(Array.from({ length: 10 }, (_, i) => bar(i, 12, 10)), 4, 1.08, 1.08)
    // GD=2: upper=12+2.16, lower=10-2.16, OB=12+2*2.28, OS=10-2*2.28
    expect(r.upper[5]).toBeCloseTo(14.16)
    expect(r.lower[5]).toBeCloseTo(7.84)
    expect(r.mid[5]).toBeCloseTo(11)
    expect(r.ob[5]).toBeCloseTo(16.56)
    expect(r.os[5]).toBeCloseTo(5.44)
    // 平盘：上下轨都"<= 上一根"，按原公式算下跌态 / flat counts as down per the formula's <=
    expect(r.upperDn[5]).toBeCloseTo(14.16)
  })
  it('no green overlay while rising', () => {
    const r = xmaBand(Array.from({ length: 20 }, (_, i) => bar(i, 12 + i, 10 + i)), 4)
    expect(r.upperDn.every((v) => v == null)).toBe(true)
  })
})
