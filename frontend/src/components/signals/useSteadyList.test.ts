import { describe, expect, it } from 'vitest'
import { ARRIVAL_HOLD_MS, __setTouch, msUntilIdle, steadyStep } from './useSteadyList'

type Row = { id: string; v: number }
const r = (id: string, v = 0): Row => ({ id, v })

describe('steadyStep', () => {
  it('takes the new list when not holding', () => {
    const next = [r('new'), r('a'), r('b')]
    expect(steadyStep(['a', 'b'], next, false, new Map()).items).toBe(next)
  })

  it('holds an arrival while the user is interacting, but keeps updating existing rows', () => {
    const cache = new Map<string, Row>()
    steadyStep(null, [r('a'), r('b')], false, cache)
    const held = steadyStep(['a', 'b'], [r('new'), r('a', 1), r('b')], true, cache)
    expect(held.ids).toEqual(['a', 'b'])
    expect(held.items.map((x) => x.v)).toEqual([1, 0])
  })

  it('keeps a removed row in place (last known version) while holding', () => {
    const cache = new Map<string, Row>()
    steadyStep(null, [r('a'), r('b', 7), r('c')], false, cache)
    const held = steadyStep(['a', 'b', 'c'], [r('a'), r('c')], true, cache)
    expect(held.items.map((x) => `${x.id}${x.v}`)).toEqual(['a0', 'b7', 'c0'])
    // 手停了：一次性放进来 / idle again: the change lands
    expect(steadyStep(held.ids, [r('a'), r('c')], false, cache).ids).toEqual(['a', 'c'])
  })

  it('passes a same-order update straight through even while holding', () => {
    const next = [r('a', 2), r('b')]
    expect(steadyStep(['a', 'b'], next, true, new Map()).items).toBe(next)
  })
})

describe('msUntilIdle', () => {
  it('counts down from the last touch and holds while the pointer is down', () => {
    __setTouch(1000, false)
    expect(msUntilIdle(1000 + 200)).toBe(ARRIVAL_HOLD_MS - 200)
    expect(msUntilIdle(1000 + ARRIVAL_HOLD_MS + 1)).toBe(0)
    __setTouch(1000, true)
    expect(msUntilIdle(99999)).toBe(ARRIVAL_HOLD_MS)
    __setTouch(0, false)
  })
})
