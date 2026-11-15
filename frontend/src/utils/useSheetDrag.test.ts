// 下拉关闭的判定：距离、甩动速度、速度符号优先；橡皮筋；松手速度的 100ms 窗口。
// Drag-to-dismiss decisions: distance, flick velocity, the velocity sign winning; the
// rubber-band; the 100ms release-velocity window. Pure functions, no DOM needed.
import { describe, expect, it } from 'vitest'
import { releaseVelocity, rubberBand, shouldDismissSheet } from './useSheetDrag'

describe('shouldDismissSheet', () => {
  it('never dismisses without downward travel', () => {
    expect(shouldDismissSheet(0, 1, 500)).toBe(false)
    expect(shouldDismissSheet(-20, 0.5, 500)).toBe(false)
  })
  it('dismisses past 30% of the height', () => {
    expect(shouldDismissSheet(151, 0, 500)).toBe(true)
    expect(shouldDismissSheet(150, 0, 500)).toBe(false)
  })
  it('dismisses a short fast flick', () => {
    expect(shouldDismissSheet(40, 0.12, 500)).toBe(true)
    expect(shouldDismissSheet(100, 0.11, 500)).toBe(false)
  })
  it('ignores a flick that barely moved', () => {
    expect(shouldDismissSheet(8, 0.5, 500)).toBe(false)
  })
  it('lets an upward flick win over distance', () => {
    expect(shouldDismissSheet(300, -0.2, 500)).toBe(false)
    expect(shouldDismissSheet(300, -0.05, 500)).toBe(true)
  })
  it('does not dismiss by distance with an unknown height', () => {
    expect(shouldDismissSheet(50, 0, 0)).toBe(false)
  })
})

describe('rubberBand', () => {
  it('tracks 1:1 downward', () => {
    expect(rubberBand(0)).toBe(0)
    expect(rubberBand(30)).toBe(30)
  })
  it('resists upward and never passes 24px', () => {
    expect(rubberBand(-10)).toBeCloseTo(-4.4746, 3)
    expect(rubberBand(-20)).toBeLessThan(rubberBand(-10))
    expect(rubberBand(-1000)).toBeGreaterThan(-24)
    expect(rubberBand(-1000)).toBeLessThan(-22)
  })
})

describe('releaseVelocity', () => {
  it('is 0 with fewer than two samples', () => {
    expect(releaseVelocity([])).toBe(0)
    expect(releaseVelocity([{ y: 10, t: 5 }])).toBe(0)
  })
  it('averages the samples inside the window', () => {
    expect(releaseVelocity([{ y: 0, t: 0 }, { y: 10, t: 16 }, { y: 22, t: 32 }, { y: 36, t: 48 }])).toBeCloseTo(0.75, 5)
  })
  it('only looks at the last 100ms', () => {
    expect(releaseVelocity([{ y: 0, t: 0 }, { y: 100, t: 200 }, { y: 110, t: 250 }])).toBeCloseTo(0.2, 5)
  })
  it('is 0 when the finger stopped before lifting', () => {
    expect(releaseVelocity([{ y: 0, t: 0 }, { y: 50, t: 50 }, { y: 50, t: 400 }])).toBe(0)
  })
})
