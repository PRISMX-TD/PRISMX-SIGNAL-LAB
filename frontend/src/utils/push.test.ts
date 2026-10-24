// ensurePushSubscription 的死订阅自愈：派发时推送服务回 410，后端删了那一行，浏览器手里的
// 订阅却还在（iOS / 多数 Chromium 不发 pushsubscriptionchange）。这台设备报过的那条被后端
// 回 stale 时，必须退订、换新 endpoint 再报；没报过的（新登录）照旧当新订阅报，不触发自愈。
// 订阅失败要把设备状态标成 failed，界面才会如实提示并给「重试」。
// jsdom 没装：window / navigator / Notification / localStorage 都是最小桩。
//
// Dead-subscription healing in ensurePushSubscription: when a previously reported endpoint
// comes back stale it is dropped and a fresh one reported; an unreported one (fresh login)
// is reported as new; a failed subscribe marks the device state failed. No jsdom, so the
// browser globals are minimal stubs.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type FakeSub = { endpoint: string; toJSON: () => unknown; unsubscribe: ReturnType<typeof vi.fn> }

function fakeSub(endpoint: string): FakeSub {
  return {
    endpoint,
    toJSON: () => ({ endpoint, keys: { p256dh: `p-${endpoint}`, auth: `a-${endpoint}` } }),
    unsubscribe: vi.fn(async () => true),
  }
}

function memoryStorage() {
  const m = new Map<string, string>()
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  }
}

async function load(opts: { existing?: FakeSub | null; fresh?: FakeSub[]; subscribeError?: Error } = {}) {
  vi.resetModules()
  let current: FakeSub | null = opts.existing ?? null
  const freshQueue = [...(opts.fresh ?? [])]
  const pushManager = {
    getSubscription: vi.fn(async () => current),
    subscribe: vi.fn(async () => {
      if (opts.subscribeError) throw opts.subscribeError
      current = freshQueue.shift() ?? null
      return current
    }),
  }
  const reg = { pushManager }
  const storage = memoryStorage()
  vi.stubGlobal('window', { PushManager: class {}, atob: globalThis.atob, localStorage: storage })
  vi.stubGlobal('navigator', { serviceWorker: { ready: Promise.resolve(reg) } })
  vi.stubGlobal('Notification', { permission: 'granted' })
  const push = await import('./push')
  const deviceState = await import('./pushDeviceState')
  return { push, deviceState, pushManager, storage }
}

describe('ensurePushSubscription', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('subscribes when there is no subscription and reports it as new', async () => {
    const { push, deviceState, pushManager, storage } = await load({ fresh: [fakeSub('e1')] })
    const report = vi.fn(async () => ({ ok: true }))
    await expect(push.ensurePushSubscription(async () => 'AAAA', report)).resolves.toBe(true)
    expect(pushManager.subscribe).toHaveBeenCalledTimes(1)
    expect(report).toHaveBeenCalledWith('e1', { p256dh: 'p-e1', auth: 'a-e1' }, false)
    expect(storage.getItem('prismx.pushReported')).toBe('e1')
    expect(deviceState.getDeviceSubState()).toBe('ok')
  })

  it('reports an existing subscription it has not reported before as new (no heal)', async () => {
    const existing = fakeSub('e1')
    const { push, pushManager } = await load({ existing })
    const report = vi.fn(async () => ({ ok: true }))
    await push.ensurePushSubscription(async () => 'AAAA', report)
    expect(report).toHaveBeenCalledWith('e1', expect.anything(), false)
    expect(pushManager.subscribe).not.toHaveBeenCalled()
    expect(existing.unsubscribe).not.toHaveBeenCalled()
  })

  it('replaces a previously reported subscription the backend says is stale', async () => {
    const existing = fakeSub('dead')
    const { push, deviceState, pushManager, storage } = await load({ existing, fresh: [fakeSub('e2')] })
    storage.setItem('prismx.pushReported', 'dead')
    const report = vi.fn(async (endpoint: string) => (endpoint === 'dead' ? { ok: true, stale: true } : { ok: true }))
    await expect(push.ensurePushSubscription(async () => 'AAAA', report)).resolves.toBe(true)
    expect(report).toHaveBeenNthCalledWith(1, 'dead', expect.anything(), true)
    expect(existing.unsubscribe).toHaveBeenCalledTimes(1)
    expect(pushManager.subscribe).toHaveBeenCalledTimes(1)
    expect(report).toHaveBeenNthCalledWith(2, 'e2', { p256dh: 'p-e2', auth: 'a-e2' }, false)
    expect(storage.getItem('prismx.pushReported')).toBe('e2')
    expect(deviceState.getDeviceSubState()).toBe('ok')
  })

  it('keeps a previously reported subscription the backend still has', async () => {
    const existing = fakeSub('e1')
    const { push, pushManager, storage } = await load({ existing })
    storage.setItem('prismx.pushReported', 'e1')
    const report = vi.fn(async () => ({ ok: true }))
    await push.ensurePushSubscription(async () => 'AAAA', report)
    expect(report).toHaveBeenCalledTimes(1)
    expect(report).toHaveBeenCalledWith('e1', expect.anything(), true)
    expect(pushManager.subscribe).not.toHaveBeenCalled()
  })

  it('marks the device failed when subscribing fails', async () => {
    const { push, deviceState } = await load({ subscribeError: new Error('AbortError: push service error') })
    const report = vi.fn(async () => ({ ok: true }))
    await expect(push.ensurePushSubscription(async () => 'AAAA', report)).rejects.toThrow('push service error')
    expect(report).not.toHaveBeenCalled()
    expect(deviceState.getDeviceSubState()).toBe('failed')
  })

  it('does not mark the app failed: the shell has its own socket fallback', async () => {
    const { push, deviceState } = await load({ subscribeError: new Error('连不上 Google 的推送服务器') })
    ;(globalThis.window as unknown as Record<string, unknown>).Capacitor = { isNativePlatform: () => true }
    await expect(push.ensurePushSubscription(async () => 'AAAA', vi.fn())).rejects.toThrow('Google')
    expect(deviceState.getDeviceSubState()).toBe('unknown')
  })

  it('does nothing without notification permission', async () => {
    const { push, pushManager } = await load({ fresh: [fakeSub('e1')] })
    vi.stubGlobal('Notification', { permission: 'default' })
    const report = vi.fn(async () => ({ ok: true }))
    await expect(push.ensurePushSubscription(async () => 'AAAA', report)).resolves.toBe(false)
    expect(pushManager.getSubscription).not.toHaveBeenCalled()
    expect(report).not.toHaveBeenCalled()
  })

  it('forgetReportedSubscription clears the remembered endpoint', async () => {
    const { push, storage } = await load()
    storage.setItem('prismx.pushReported', 'e1')
    push.forgetReportedSubscription()
    expect(storage.getItem('prismx.pushReported')).toBeNull()
  })
})
