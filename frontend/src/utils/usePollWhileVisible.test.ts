// startPolling：前台才轮询、回前台只补超过 10 秒的数据、间隔可随 WS 状态变化而不重跑。
// startPolling: poll only in the foreground, refetch on return only when older than 10s,
// interval that can change with WS state without re-running anything.
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

  it('回前台 focus + visibilitychange 双触发只拉一次；数据不到 10 秒不重拉', async () => {
    const { poll, win, doc } = await setup()
    const load = vi.fn()
    poll.startPolling(load, 45_000, true) // 挂载时拉了一次 / loaded once on mount
    vi.advanceTimersByTime(12_000)
    doc.dispatchEvent(new Event('visibilitychange'))
    win.dispatchEvent(new Event('focus'))
    expect(load).toHaveBeenCalledTimes(2)
    // 切出去 5 秒再回来：数据才 5 秒，不重拉（原来 2 秒以上就会再拉一遍）。
    // Away for 5s: the data is 5s old, no refetch (it used to refetch past 2s).
    vi.advanceTimersByTime(5_000)
    win.dispatchEvent(new Event('focus'))
    expect(load).toHaveBeenCalledTimes(2)
    // 再过 6 秒（共 11 秒）回来：超过 10 秒，补一次。/ 11s old on the next return: refetch.
    vi.advanceTimersByTime(6_000)
    doc.dispatchEvent(new Event('visibilitychange'))
    expect(load).toHaveBeenCalledTimes(3)
  })

  it('已经到期的轮询不靠回前台那条路：定时器自己补上', async () => {
    const { poll, win } = await setup()
    const load = vi.fn()
    poll.startPolling(load, 5_000, true)
    win.dispatchEvent(new Event('apppack:background'))
    vi.advanceTimersByTime(7_000) // 后台 7 秒，5 秒的轮询已到期但被跳过 / due but skipped while hidden
    expect(load).toHaveBeenCalledTimes(1)
    win.dispatchEvent(new Event('apppack:foreground')) // 7 秒 < 10 秒，回前台这条路不拉
    expect(load).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(150) // 定时器在 0.1 秒内补上 / the timer catches up within 0.1s
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
