import { describe, expect, it } from 'vitest'
import { RAMP_MS, TOTAL_MS, WINDUP_DEG, WINDUP_MS, spinAngle } from './spinMotion'

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

  it('lasts 4.57s in total', () => {
    expect(TOTAL_MS).toBe(4570)
  })

  // 以前甩出第一帧（16ms）就跳 23.5°；现在约 1.65°。/ The first 16ms after the wind-up used to jump 23.5°; now about 1.65°.
  it('ramps up after the wind-up instead of jumping to full speed', () => {
    const first = spinAngle(WINDUP_MS + 16, 10, 1810) - spinAngle(WINDUP_MS, 10, 1810)
    expect(first).toBeGreaterThan(0)
    expect(first).toBeLessThan(2)
  })

  it('has no speed step where the ramp ends', () => {
    const at = WINDUP_MS + RAMP_MS
    const before = spinAngle(at, 10, 1810) - spinAngle(at - 8, 10, 1810)
    const after = spinAngle(at + 8, 10, 1810) - spinAngle(at, 10, 1810)
    expect(after / before).toBeGreaterThan(0.9)
    expect(after / before).toBeLessThan(1.1)
  })

  // 以前最后一秒只走 3.14°；现在约 24.42°。/ The last second used to cover 3.14°; now about 24.42°.
  it('is still visibly turning in the last second', () => {
    expect(spinAngle(TOTAL_MS, 10, 1810) - spinAngle(TOTAL_MS - 1000, 10, 1810)).toBeGreaterThan(15)
  })
})
