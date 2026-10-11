import { describe, expect, it } from 'vitest'
import { bestWorstHours, fmtHourRange } from './shared'

// 固定时区偏移，测试不依赖跑测试机器的本地时区。/ Pin the zone offset so tests don't depend on the host TZ.
const at = (offsetMin: number) => ({ getTimezoneOffset: () => offsetMin }) as Date

function hours(cells: Record<number, [number, number]>) {
  return Array.from({ length: 24 }, (_, h) => {
    const [tp, sl] = cells[h] ?? [0, 0]
    return { tp, sl }
  })
}

describe('bestWorstHours', () => {
  it('returns empty lists without data', () => {
    expect(bestWorstHours(null, at(0))).toEqual({ best: [], worst: [] })
    expect(bestWorstHours(hours({}), at(0))).toEqual({ best: [], worst: [] })
  })

  it('ranks by win rate with no sample floor, ties broken by trade count', () => {
    const { best, worst } = bestWorstHours(
      hours({ 1: [1, 0], 2: [5, 0], 3: [3, 1], 4: [1, 1], 5: [1, 3], 6: [0, 4], 7: [0, 1] }),
      at(0),
    )
    expect(best.map((h) => h.localMinutes / 60)).toEqual([2, 1, 3])
    expect(best[1]).toMatchObject({ rate: 1, n: 1 })
    expect(worst.map((h) => h.localMinutes / 60)).toEqual([6, 7, 5])
  })

  it('never lists the same hour as both best and worst', () => {
    const { best, worst } = bestWorstHours(hours({ 9: [2, 1], 10: [1, 1], 11: [0, 2], 12: [1, 0] }), at(0))
    expect(best).toHaveLength(3)
    expect(worst.map((h) => h.localMinutes / 60)).toEqual([11])
  })

  it('converts UTC slots to the viewer clock', () => {
    // UTC+8 → getTimezoneOffset() === -480; UTC 20:00 is 04:00 local.
    const { best } = bestWorstHours(hours({ 20: [1, 0] }), at(-480))
    expect(best[0].localMinutes).toBe(4 * 60)
    expect(fmtHourRange(best[0].localMinutes)).toBe('04:00–05:00')
    expect(fmtHourRange(23 * 60)).toBe('23:00–00:00')
  })
})
