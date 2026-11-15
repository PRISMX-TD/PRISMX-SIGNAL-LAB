// 防闪烁控制器：delay 内结束不显示；显示后至少停 minVisible；等撤期间又忙起来就继续显示。
// Flicker-guard controller: nothing shown when done within the delay; once shown it stays
// minVisible; busy again while waiting to hide keeps it up.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDelayedFlag } from './useDelayedFlag'

describe('createDelayedFlag', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-15T10:00:00Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('delay 之内就结束：从头到尾不显示', () => {
    const seen: boolean[] = []
    const f = createDelayedFlag((v) => seen.push(v), { delay: 200, minVisible: 400 })
    f.set(true)
    vi.advanceTimersByTime(150)
    f.set(false)
    vi.advanceTimersByTime(1000)
    expect(seen).toEqual([])
  })

  it('超过 delay 才显示，显示后即使马上结束也至少停 minVisible', () => {
    const seen: boolean[] = []
    const f = createDelayedFlag((v) => seen.push(v), { delay: 200, minVisible: 400 })
    f.set(true)
    vi.advanceTimersByTime(199)
    expect(seen).toEqual([])
    vi.advanceTimersByTime(1)
    expect(seen).toEqual([true])
    vi.advanceTimersByTime(50)
    f.set(false)
    vi.advanceTimersByTime(349)
    expect(seen).toEqual([true])
    vi.advanceTimersByTime(1)
    expect(seen).toEqual([true, false])
  })

  it('已经显示够久：结束时立刻撤（下一拍）', () => {
    const seen: boolean[] = []
    const f = createDelayedFlag((v) => seen.push(v), { delay: 200, minVisible: 400 })
    f.set(true)
    vi.advanceTimersByTime(200 + 1000)
    f.set(false)
    vi.advanceTimersByTime(0)
    expect(seen).toEqual([true, false])
  })

  it('等撤期间又忙起来：继续显示，不闪', () => {
    const seen: boolean[] = []
    const f = createDelayedFlag((v) => seen.push(v), { delay: 200, minVisible: 400 })
    f.set(true)
    vi.advanceTimersByTime(250)
    f.set(false)
    vi.advanceTimersByTime(100)
    f.set(true)
    vi.advanceTimersByTime(1000)
    expect(seen).toEqual([true])
  })

  it('dispose 之后不再回调', () => {
    const seen: boolean[] = []
    const f = createDelayedFlag((v) => seen.push(v))
    f.set(true)
    f.dispose()
    vi.advanceTimersByTime(1000)
    expect(seen).toEqual([])
  })
})
