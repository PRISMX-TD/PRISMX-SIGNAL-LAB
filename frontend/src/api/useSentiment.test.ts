// 情绪数据的模块级缓存：5 分钟内重挂载直接用缓存；定时器只在有订阅者时跑。
// Module-level sentiment cache: a remount within 5 minutes reuses it; the timer runs only while
// someone is subscribed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const get = vi.fn()
vi.mock('./client', () => ({ sentimentApi: { get: () => get() } }))
// useSentiment 顶层 import 了 react 的 useSyncExternalStore；这里只测纯逻辑，用不到它。
// react's useSyncExternalStore is imported at top level; only the plain logic is tested here.
vi.mock('react', () => ({ useSyncExternalStore: () => undefined }))

const payload = { sentiment: { XAUUSD: { long: 60, short: 40 } } }

async function load() {
  vi.resetModules()
  return import('./useSentiment')
}

describe('sentiment cache', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-29T10:00:00Z'))
    get.mockReset()
    get.mockResolvedValue(payload)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('首个订阅者触发拉取；5 分钟内重新订阅不再请求', async () => {
    const m = await load()
    const off = m.subscribeSentiment(() => {})
    await vi.advanceTimersByTimeAsync(0)
    expect(get).toHaveBeenCalledTimes(1)
    expect(m.getSentimentState().loading).toBe(false)
    off()
    // 切页来回：2 分钟后重新挂载 / navigate away and back after 2 minutes
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000)
    const off2 = m.subscribeSentiment(() => {})
    await vi.advanceTimersByTimeAsync(0)
    expect(get).toHaveBeenCalledTimes(1)
    expect(m.getSentimentState().sentiment).toEqual(payload.sentiment)
    off2()
  })

  it('缓存过期后重新订阅会再拉一次', async () => {
    const m = await load()
    const off = m.subscribeSentiment(() => {})
    await vi.advanceTimersByTimeAsync(0)
    off()
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1)
    const off2 = m.subscribeSentiment(() => {})
    await vi.advanceTimersByTimeAsync(0)
    expect(get).toHaveBeenCalledTimes(2)
    off2()
  })

  it('有订阅者时每 5 分钟刷新；最后一个订阅者离开就停，无人看的页面不再轮询', async () => {
    const m = await load()
    const off = m.subscribeSentiment(() => {})
    await vi.advanceTimersByTimeAsync(0)
    expect(get).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
    expect(get).toHaveBeenCalledTimes(2)
    off()
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000)
    expect(get).toHaveBeenCalledTimes(2)
  })

  it('失败保留上一份数据并记录错误', async () => {
    const m = await load()
    const off = m.subscribeSentiment(() => {})
    await vi.advanceTimersByTimeAsync(0)
    get.mockRejectedValueOnce(new Error('boom'))
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
    const st = m.getSentimentState()
    expect(st.error).toBe('boom')
    expect(st.sentiment).toEqual(payload.sentiment)
    off()
  })
})
