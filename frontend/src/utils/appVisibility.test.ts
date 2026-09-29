// 后台判定与回前台去重：focus / visibilitychange / apppack:foreground 几毫秒内接连触发，
// 同一次回前台只回调一次；App 壳的 apppack:background 即使 document.hidden 为 false 也算后台。
// Background detection and return-to-foreground de-dupe. jsdom isn't installed, so window and
// document are minimal EventTarget stubs.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

class FakeDoc extends EventTarget {
  hidden = false
}

async function load() {
  vi.resetModules()
  const win = new EventTarget()
  const doc = new FakeDoc()
  vi.stubGlobal('window', win)
  vi.stubGlobal('document', doc)
  const mod = await import('./appVisibility')
  return { mod, win, doc }
}

describe('appVisibility', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-29T10:00:00Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('apppack:background 即使 document.hidden 为 false 也算后台，apppack:foreground 恢复', async () => {
    const { mod, win } = await load()
    expect(mod.isAppHidden()).toBe(false)
    win.dispatchEvent(new Event('apppack:background'))
    expect(mod.isAppHidden()).toBe(true)
    win.dispatchEvent(new Event('apppack:foreground'))
    expect(mod.isAppHidden()).toBe(false)
  })

  it('页面自己报告可见会清掉遗漏 foreground 事件的旧后台标记', async () => {
    const { mod, win, doc } = await load()
    win.dispatchEvent(new Event('apppack:background'))
    expect(mod.isAppHidden()).toBe(true)
    doc.hidden = false
    doc.dispatchEvent(new Event('visibilitychange'))
    expect(mod.isAppHidden()).toBe(false)
  })

  it('三路回前台信号在 2 秒内只回调一次，之后再来会再回调', async () => {
    const { mod, win, doc } = await load()
    const cb = vi.fn()
    const off = mod.onForeground(cb)
    doc.dispatchEvent(new Event('visibilitychange'))
    win.dispatchEvent(new Event('focus'))
    win.dispatchEvent(new Event('apppack:foreground'))
    expect(cb).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(2_500)
    win.dispatchEvent(new Event('focus'))
    expect(cb).toHaveBeenCalledTimes(2)
    off()
    win.dispatchEvent(new Event('focus'))
    expect(cb).toHaveBeenCalledTimes(2)
  })

  it('仍处于后台时不回调；focus:false 时忽略 focus', async () => {
    const { mod, win, doc } = await load()
    const cb = vi.fn()
    mod.onForeground(cb)
    win.dispatchEvent(new Event('apppack:background'))
    win.dispatchEvent(new Event('focus'))
    expect(cb).not.toHaveBeenCalled()
    win.dispatchEvent(new Event('apppack:foreground'))
    expect(cb).toHaveBeenCalledTimes(1)

    const cb2 = vi.fn()
    vi.advanceTimersByTime(5_000)
    mod.onForeground(cb2, undefined, { focus: false })
    win.dispatchEvent(new Event('focus'))
    expect(cb2).not.toHaveBeenCalled()
    doc.dispatchEvent(new Event('visibilitychange'))
    expect(cb2).toHaveBeenCalledTimes(1)
  })
})
