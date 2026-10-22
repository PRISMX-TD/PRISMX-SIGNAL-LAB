import { describe, expect, it } from 'vitest'
import { TOTAL_MS, WINDUP_DEG, WINDUP_MS, spinAngle } from './spinMotion'

describe('spinAngle', () => {
  it('starts where the wheel is and ends exactly on the target', () => {
    expect(spinAngle(0, 10, 1810)).toBe(10)
    expect(spinAngle(TOTAL_MS, 10, 1810)).toBeCloseTo(1810, 6)
    expect(spinAngle(TOTAL_MS + 500, 10, 1810)).toBeCloseTo(1810, 6)
  })

  it('winds back a little before the fling', () => {
    expect(spinAngle(WINDUP_MS / 2, 10, 1810)).toBeLessThan(10)
    expect(spinAngle(WINDUP_MS, 10, 1810)).toBeCloseTo(10 - WINDUP_DEG, 6)
  })

  it('only moves forward after the wind-up', () => {
    let prev = spinAngle(WINDUP_MS, 10, 1810)
    for (let ms = WINDUP_MS + 16; ms <= TOTAL_MS; ms += 16) {
      const a = spinAngle(ms, 10, 1810)
      expect(a).toBeGreaterThanOrEqual(prev)
      prev = a
    }
  })
})
