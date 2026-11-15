import { describe, expect, it } from 'vitest'
import { createLegendStore, legendEqual } from './legendStore'

function manualFrames() {
  const queue = new Map<number, () => void>()
  let id = 0
  return {
    schedule: (cb: () => void) => { id += 1; queue.set(id, cb); return id },
    cancel: (n: number) => { queue.delete(n) },
    run: () => {
      const cbs = Array.from(queue.values())
      queue.clear()
      cbs.forEach((cb) => cb())
    },
    size: () => queue.size,
  }
}

describe('legendEqual', () => {
  it('逐项相同即相等 / equal when every value matches', () => {
    expect(legendEqual({ ma: { '0': 1, '1': null } }, { ma: { '0': 1, '1': null } })).toBe(true)
  })
  it('数值、键数、指标不同都不相等 / differs on value, key count or indicator', () => {
    expect(legendEqual({ ma: { '0': 1 } }, { ma: { '0': 2 } })).toBe(false)
    expect(legendEqual({ ma: { '0': 1 } }, { ma: { '0': 1, '1': 2 } })).toBe(false)
    expect(legendEqual({ ma: { '0': 1 } }, { ema: { '0': 1 } })).toBe(false)
  })
})

describe('createLegendStore', () => {
  it('一帧内多次写入只通知一次，取最后一份 / coalesces writes to one notify per frame', () => {
    const f = manualFrames()
    const store = createLegendStore(f.schedule, f.cancel)
    let calls = 0
    store.subscribe(() => { calls += 1 })
    store.set({ ma: { '0': 1 } })
    store.set({ ma: { '0': 2 } })
    expect(f.size()).toBe(1)
    expect(calls).toBe(0)
    f.run()
    expect(calls).toBe(1)
    expect(store.get()).toEqual({ ma: { '0': 2 } })
  })
  it('数值没变不通知 / an equal value notifies nobody', () => {
    const f = manualFrames()
    const store = createLegendStore(f.schedule, f.cancel)
    store.set({ ma: { '0': 1 } })
    f.run()
    const before = store.get()
    let calls = 0
    store.subscribe(() => { calls += 1 })
    store.set({ ma: { '0': 1 } })
    f.run()
    expect(calls).toBe(0)
    expect(store.get()).toBe(before)
  })
  it('dispose 取消还没执行的那一帧 / dispose cancels the pending frame', () => {
    const f = manualFrames()
    const store = createLegendStore(f.schedule, f.cancel)
    let calls = 0
    store.subscribe(() => { calls += 1 })
    store.set({ ma: { '0': 1 } })
    store.dispose()
    f.run()
    expect(calls).toBe(0)
  })
})
