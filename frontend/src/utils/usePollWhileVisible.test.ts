// startPolling：前台才轮询、回前台 2 秒去重、间隔可随 WS 状态变化而不重跑。
// startPolling: poll only in the foreground, 2s return de-dupe, interval that can change
// with WS state without re-running anything.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

class FakeDoc extends EventTarget {
  hidden = false
}

async function setup() {
  vi.resetModules()
  const win = new EventTarget()
  const doc = new FakeDoc()
  vi.stubGlobal('window', win)
  vi.stubGlobal('document', doc)
  const poll = await import('./usePollWhileVisible')
  return { poll, win, doc }
}

describe('startPolling', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-29T10:00:00Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('immediate 时挂载即执行，之后按间隔轮询，停止后不再执行', async () => {
    const { poll } = await setup()
    const load = vi.fn()
    const stop = poll.startPolling(load, 45_000, true)
    expect(load).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(45_000)
    expect(load).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(45_000)
    expect(load).toHaveBeenCalledTimes(3)
    stop()
    vi.advanceTimersByTime(200_000)
    expect(load).toHaveBeenCalledTimes(3)
  })

  it('immediate:false 时不立即执行 / no immediate run', async () => {
    const { poll } = await setup()
    const load = vi.fn()
    poll.startPolling(load, 20_000, false)
    expect(load).not.toHaveBeenCalled()
    vi.advanceTimersByTime(20_000)
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('后台（含 apppack:background）跳过轮询，回前台立即补一次', async () => {
    const { poll, win } = await setup()
    const load = vi.fn()
    poll.startPolling(load, 10_000, false)
    win.dispatchEvent(new Event('apppack:background'))
    vi.advanceTimersByTime(60_000)
    expect(load).not.toHaveBeenCalled()
    win.dispatchEvent(new Event('apppack:foreground'))
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('回前台 focus + visibilitychange 双触发只拉一次；刚拉过（<2 秒）也跳过', async () => {
    const { poll, win, doc } = await setup()
    const load = vi.fn()
    poll.startPolling(load, 45_000, true) // 挂载时拉了一次 / loaded once on mount
    vi.advanceTimersByTime(10_000)
    doc.dispatchEvent(new Event('visibilitychange'))
    win.dispatchEvent(new Event('focus'))
    expect(load).toHaveBeenCalledTimes(2)
    // 刚拉过 2 秒内的回前台被吞 / a return within 2s of a load is swallowed
    vi.advanceTimersByTime(1_000)
    win.dispatchEvent(new Event('apppack:foreground'))
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('间隔是函数时每次现读：WS 断开后从 3 分钟回到 45 秒，无需重启', async () => {
    const { poll } = await setup()
    const load = vi.fn()
    let ws = true
    poll.startPolling(load, () => (ws ? 180_000 : 45_000), false)
    vi.advanceTimersByTime(100_000)
    expect(load).not.toHaveBeenCalled()
    ws = false
    // 检查粒度最长 10 秒，切到短间隔后最多晚 10 秒生效 / check granularity ≤ 10s
    vi.advanceTimersByTime(10_000)
    expect(load).toHaveBeenCalledTimes(1)
  })
})
