// 左右滑动判定：距离、短促快甩、慢拖不算、竖向不算、dt 为 0 不算速度。
// Swipe decisions: distance, short fast flicks, slow drags and vertical moves rejected,
// dt = 0 counted as no speed. Pure function, no DOM.
import { describe, expect, it } from 'vitest'
import { swipeCommits } from './swipe'

const HERO = { distance: 45, flickMin: 16, flickVelocity: 0.3 }
const PEDESTAL = { distance: 36, flickMin: 10, flickVelocity: 0.3 }

describe('swipeCommits', () => {
  it('commits past the distance whatever the speed', () => {
    expect(swipeCommits(-46, 5, 900, HERO)).toBe(true)
    expect(swipeCommits(36, 0, 900, PEDESTAL)).toBe(true)
  })
  it('commits a short fast flick', () => {
    expect(swipeCommits(20, 2, 50, HERO)).toBe(true)
    expect(swipeCommits(-12, 0, 30, PEDESTAL)).toBe(true)
  })
  it('ignores a short slow drag', () => {
    expect(swipeCommits(30, 0, 200, HERO)).toBe(false)
  })
  it('ignores a flick below the minimum travel', () => {
    expect(swipeCommits(14, 0, 10, HERO)).toBe(false)
    expect(swipeCommits(8, 0, 5, PEDESTAL)).toBe(false)
  })
  it('never commits a mostly vertical move', () => {
    expect(swipeCommits(60, 80, 100, HERO)).toBe(false)
    expect(swipeCommits(40, 40, 100, PEDESTAL)).toBe(false)
  })
  it('treats dt = 0 as no speed', () => {
    expect(swipeCommits(20, 0, 0, HERO)).toBe(false)
  })
})
