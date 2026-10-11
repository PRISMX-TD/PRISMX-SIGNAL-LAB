// 首屏预取（prefetch.ts）的规矩：只认白名单路径、用一次就删、绑定 token、会过期、
// /bootstrap 在路上时先等它、它失败就当没有预取。
// First-screen prefetch rules: allow-listed paths only, consumed once, bound to the token,
// expiring, waits for an in-flight bootstrap, and a failed bootstrap means no prefetch.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { beginPrefetch, clearPrefetch, takePrefetched } from './prefetch'

afterEach(() => {
  clearPrefetch()
  vi.useRealTimers()
})

describe('prefetch', () => {
  it('serves a prefetched path once, then falls through to the network', async () => {
    beginPrefetch(Promise.resolve({ '/orders': { orders: [1] } }), 'tok')
    expect(await takePrefetched('/orders', 'tok')).toEqual({ data: { orders: [1] } })
    expect(await takePrefetched('/orders', 'tok')).toBeNull()
  })

  it('waits for an in-flight bootstrap before answering', async () => {
    let resolve!: (v: unknown) => void
    beginPrefetch(new Promise((r) => { resolve = r }), 'tok')
    const take = takePrefetched('/sentiment', 'tok')
    resolve({ '/sentiment': { XAUUSD: 60 } })
    expect(await take).toEqual({ data: { XAUUSD: 60 } })
  })

  it('never hands data to a different session', async () => {
    beginPrefetch(Promise.resolve({ '/auth/me': { email: 'a@x' } }), 'tok-a')
    expect(await takePrefetched('/auth/me', 'tok-b')).toBeNull()
  })

  it('ignores paths outside the allow-list, including other query strings', async () => {
    beginPrefetch(Promise.resolve({ '/admin/users': {}, '/notifications/feed?limit=4': { items: [] } }), 'tok')
    expect(await takePrefetched('/admin/users', 'tok')).toBeNull()
    expect(await takePrefetched('/notifications/feed?limit=20', 'tok')).toBeNull()
    expect(await takePrefetched('/notifications/feed?limit=4', 'tok')).toEqual({ data: { items: [] } })
  })

  it('expires after 15 seconds', async () => {
    vi.useFakeTimers()
    beginPrefetch(Promise.resolve({ '/orders/winrate': { rate: 0.5 } }), 'tok')
    await vi.advanceTimersByTimeAsync(0)
    vi.setSystemTime(Date.now() + 16_000)
    expect(await takePrefetched('/orders/winrate', 'tok')).toBeNull()
  })

  it('treats a failed bootstrap as no prefetch', async () => {
    beginPrefetch(Promise.reject(new Error('503')), 'tok')
    expect(await takePrefetched('/orders', 'tok')).toBeNull()
  })

  it('does not wait forever on a stuck bootstrap', async () => {
    vi.useFakeTimers()
    beginPrefetch(new Promise(() => {}), 'tok')
    const take = takePrefetched('/orders', 'tok')
    await vi.advanceTimersByTimeAsync(6_000)
    expect(await take).toBeNull()
  })
})
