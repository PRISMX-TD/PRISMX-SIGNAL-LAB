import { describe, expect, it } from 'vitest'
import { EMAIL_MAX_EDGE, fitSize } from './shrinkImage'

describe('fitSize', () => {
  it('leaves images within the cap alone', () => {
    expect(fitSize(800, 600)).toEqual({ width: 800, height: 600 })
    expect(fitSize(1600, 1600)).toEqual({ width: 1600, height: 1600 })
  })
  it('shrinks the longest side to 1600 keeping the ratio', () => {
    expect(fitSize(3200, 1800)).toEqual({ width: 1600, height: 900 })
    expect(fitSize(1000, 4000)).toEqual({ width: 400, height: 1600 })
  })
  it('never returns a zero side', () => {
    expect(fitSize(100000, 1).height).toBe(1)
  })
})

describe('fitSize for email images', () => {
  it('caps the longest side at the email limit', () => {
    expect(EMAIL_MAX_EDGE).toBe(1200)
    expect(fitSize(2508, 2508, EMAIL_MAX_EDGE)).toEqual({ width: 1200, height: 1200 })
    expect(fitSize(1000, 400, EMAIL_MAX_EDGE)).toEqual({ width: 1000, height: 400 })
  })
})
