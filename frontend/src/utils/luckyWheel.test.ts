import { describe, expect, it } from 'vitest'
import { indexAtRotation, slotCenter, slotSpan, targetRotation } from './luckyWheel'

describe('luckyWheel geometry', () => {
  it('splits the circle evenly', () => {
    expect(slotSpan(8)).toBe(45)
    expect(slotCenter(0, 8)).toBe(22.5)
  })
  it('lands the chosen slot under the top pointer, spinning forward', () => {
    for (const n of [2, 5, 8, 12]) {
      for (let i = 0; i < n; i++) {
        for (const jitter of [-1, 0, 0.99]) {
          const cur = 1234.5
          const rot = targetRotation(cur, i, n, jitter)
          expect(rot).toBeGreaterThan(cur + 360 * 4)
          expect(indexAtRotation(rot, n)).toBe(i)
        }
      }
    }
  })
})
