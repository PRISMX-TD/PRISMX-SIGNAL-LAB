import { describe, expect, it } from 'vitest'
import type { Candle } from '../api/types'
import { inferPoint, wallZones } from './indicators'

const mk = (closes: number[]): Candle[] =>
  closes.map((c, i) => ({ t: i * 60, o: c - 0.2, h: c + 0.5, l: c - 0.5, c, v: 0 }) as Candle)

describe('wallZones', () => {
  it('infers point from price decimals', () => {
    expect(inferPoint(mk([1.23456]))).toBeCloseTo(0.00001)
    expect(inferPoint([{ t: 0, o: 2000, h: 2001, l: 1999, c: 2000, v: 0 } as Candle])).toBe(1)
  })

  it('finds a support zone at a V bottom and a resistance zone at a peak', () => {
    const wave = [...Array(40)].map((_, i) => 100 + 20 * Math.sin(i / 6))
    const z = wallZones(mk([...wave, ...wave, ...wave]), 13, 8, 5)
    expect(z.length).toBeGreaterThan(0)
    for (const w of z) expect(w.top).toBeGreaterThanOrEqual(w.bottom)
    expect(z.some((w) => w.kind === 'res')).toBe(true)
    expect(z.some((w) => w.kind === 'sup')).toBe(true)
  })

  it('returns nothing for too few bars', () => {
    expect(wallZones(mk([1, 2, 3]))).toEqual([])
  })
})
