// 首页模式判定与首页漏斗：第一次来要等配置（超时 / 失败按落地页），来过的立即用缓存、
// 后台刷新留给下一次；访问每会话记一次，注册按 7 天内最近一次首页访问的模式只记一次。
// Home-mode decision and home funnel: a first visit waits for the config (timeout / failure →
// landing), a returning one uses the cache at once and refreshes it for next time; a view is
// counted once per session, a sign-up once toward the latest home visit within 7 days.
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

const getJson = vi.fn()
vi.mock('../api/publicCompetition', () => ({ publicGetJson: (...a: unknown[]) => getJson(...a) }))
vi.mock('../api/apiBase', () => ({ API_BASE: '' }))

function memStorage(): Storage {
  const m = new Map<string, string>()
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => { m.set(k, String(v)) },
    removeItem: (k: string) => { m.delete(k) },
    clear: () => m.clear(),
    key: () => null,
    get length() { return m.size },
  }
}

beforeEach(() => {
  vi.resetModules()
  getJson.mockReset()
  vi.stubGlobal('window', {
    localStorage: memStorage(),
    sessionStorage: memStorage(),
    // 调用时再取全局的 setTimeout，假时钟才接得住 / resolve the global at call time so fake timers apply
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  })
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true })))
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const load = () => import('./homeMode')
const flush = () => new Promise((r) => setTimeout(r, 0))
const pings = () => ((fetch as unknown as Mock).mock.calls as [string, RequestInit][]).map((c) => JSON.parse(String(c[1].body)))

describe('resolveHomeMode', () => {
  it('a first visit waits for the config and caches the answer', async () => {
    getJson.mockResolvedValue({ guestPreview: true })
    const m = await load()
    await expect(m.resolveHomeMode()).resolves.toBe('preview')
    expect(m.decidedHomeMode()).toBe('preview')
    expect(window.localStorage.getItem('prismx_home_mode')).toBe('preview')
  })

  it('a cached answer is used at once while the config refreshes it for next time', async () => {
    window.localStorage.setItem('prismx_home_mode', 'landing')
    getJson.mockResolvedValue({ guestPreview: true })
    const m = await load()
    await expect(m.resolveHomeMode()).resolves.toBe('landing')
    await flush()
    expect(window.localStorage.getItem('prismx_home_mode')).toBe('preview')
  })

  it('a slow config falls back to the landing page', async () => {
    vi.useFakeTimers()
    getJson.mockReturnValue(new Promise(() => {}))
    const m = await load()
    const p = m.resolveHomeMode()
    await vi.advanceTimersByTimeAsync(2500)
    await expect(p).resolves.toBe('landing')
  })

  it('a failing config falls back to the landing page', async () => {
    getJson.mockRejectedValue(new Error('offline'))
    const m = await load()
    await expect(m.resolveHomeMode()).resolves.toBe('landing')
  })

  it('demoteToLanding overrides a stale cached preview', async () => {
    window.localStorage.setItem('prismx_home_mode', 'preview')
    getJson.mockResolvedValue({ guestPreview: true })
    const m = await load()
    await m.resolveHomeMode()
    m.demoteToLanding()
    expect(m.decidedHomeMode()).toBe('landing')
    expect(window.localStorage.getItem('prismx_home_mode')).toBe('landing')
  })
})

describe('home funnel', () => {
  it('counts a view once per session and a sign-up once toward the latest mode', async () => {
    const m = await load()
    m.markHomeView('preview')
    m.markHomeView('preview')
    m.trackSignupFromHome()
    m.trackSignupFromHome()
    expect(pings()).toEqual([{ mode: 'preview', step: 'view' }, { mode: 'preview', step: 'signup' }])
  })

  it('does not credit a sign-up to a home visit older than 7 days', async () => {
    window.localStorage.setItem('prismx_home_entry', JSON.stringify({ mode: 'landing', at: Date.now() - 8 * 86400_000 }))
    const m = await load()
    m.trackSignupFromHome()
    expect(pings()).toEqual([])
  })

  it('ignores a sign-up that never came through the home page', async () => {
    const m = await load()
    m.trackSignupFromHome()
    expect(pings()).toEqual([])
  })
})
