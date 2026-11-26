// 多图同步换算的单测（阶段 6）/ unit tests for the multi-chart sync maths (phase 6)
import { describe, expect, it } from 'vitest'
import { barAtOrBefore, crosshairBar, estimateStep, logicalToTime, mapLogicalRange, timeToLogical } from './syncMath'

const H = 3600
const range = (n: number, step: number, t0 = 1_700_000_000) => Array.from({ length: n }, (_, i) => t0 + i * step)

describe('estimateStep', () => {
  it('uses the median gap, ignoring a weekend gap', () => {
    const t = range(10, H)
    t.push(t[t.length - 1] + 48 * H, t[t.length - 1] + 49 * H)
    expect(estimateStep(t)).toBe(H)
  })
  it('falls back to 60 with too few bars', () => {
    expect(estimateStep([])).toBe(60)
    expect(estimateStep([5])).toBe(60)
  })
})

describe('index ↔ time', () => {
  const t = range(5, 60)
  it('finds the bar at or before a time', () => {
    expect(barAtOrBefore(t, t[0] - 1)).toBe(-1)
    expect(barAtOrBefore(t, t[2])).toBe(2)
    expect(barAtOrBefore(t, t[2] + 30)).toBe(2)
    expect(barAtOrBefore(t, t[4] + 999)).toBe(4)
  })
  it('round-trips inside and outside the data', () => {
    for (const l of [-3, 0, 1.5, 4, 7.25]) {
      const time = logicalToTime(t, l)!
      expect(timeToLogical(t, time)).toBeCloseTo(l, 6)
    }
  })
  it('returns null without data', () => {
    expect(logicalToTime([], 1)).toBeNull()
    expect(timeToLogical([], 1)).toBeNull()
  })
})

describe('mapLogicalRange', () => {
  it('maps M15 onto H1 by time', () => {
    const t0 = 1_700_000_000
    const m15 = range(400, 900, t0)
    const h1 = range(100, H, t0)
    // M15 的第 40–80 根 = 10–20 小时 / M15 bars 40–80 = hours 10–20
    const r = mapLogicalRange(m15, h1, { from: 40, to: 80 })!
    expect(r.from).toBeCloseTo(10, 6)
    expect(r.to).toBeCloseTo(20, 6)
  })
  it('extrapolates into right-side whitespace', () => {
    const a = range(10, 60)
    const b = range(10, 60)
    expect(mapLogicalRange(a, b, { from: 5, to: 15 })).toEqual({ from: 5, to: 15 })
  })
  it('is null with no data on either side', () => {
    expect(mapLogicalRange([], range(3, 60), { from: 0, to: 2 })).toBeNull()
    expect(mapLogicalRange(range(3, 60), [], { from: 0, to: 2 })).toBeNull()
  })
})

describe('crosshairBar', () => {
  const t = range(10, H)
  it('snaps to the bar at or before the time', () => {
    expect(crosshairBar(t, t[3] + 1800)).toBe(3)
  })
  it('clears before the first bar or well past the last', () => {
    expect(crosshairBar(t, t[0] - 1)).toBe(-1)
    expect(crosshairBar(t, t[9] + 2 * H)).toBe(-1)
    expect(crosshairBar(t, t[9] + H)).toBe(9)
  })
})
