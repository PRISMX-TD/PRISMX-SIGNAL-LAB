import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const MAIN = 'https://api.prismxsignallab.com'
const BACKUP = 'https://api.pmxsl.com'
const THIRD = 'https://api.ljlhxhsys.com'
const IP = 'https://43.134.110.47/_b'
const DIRECT_MAIN = 'https://api2.prismxsignallab.com'
const DIRECT = 'https://api2.pmxsl.com'

// apiBase 在模块加载时读 env / localStorage，每个用例重新加载一份。
// apiBase reads env / localStorage at load time, so each case loads a fresh copy.
async function load() {
  vi.resetModules()
  return import('./apiBase')
}

function stubStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  })
  return data
}

// 只有 up 里的入口应答，其余一律网络失败。
// Only the bases in `up` answer; everything else fails at the network level.
function stubFetch(up: string[]) {
  const fetchMock = vi.fn(async (url: string) => {
    if (up.some((b) => url === `${b}/`)) return new Response('{"status":"ok"}', { status: 200 })
    throw new TypeError('Failed to fetch')
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('apiBase failover', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_API_BASE', MAIN)
    vi.stubGlobal('location', { hostname: 'localhost' })
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('starts on the main domain with the backup as second candidate', async () => {
    stubStorage()
    const m = await load()
    expect(m.API_BASE).toBe(MAIN)
    expect(m.API_CANDIDATES).toEqual([MAIN, BACKUP, THIRD, DIRECT_MAIN, DIRECT, IP])
  })

  it('prefers the direct entries when the page is served from www2', async () => {
    stubStorage()
    vi.stubGlobal('location', { hostname: 'www2.prismxsignallab.com' })
    const m = await load()
    expect(m.API_BASE).toBe(DIRECT_MAIN)
    expect(m.API_CANDIDATES).toEqual([DIRECT_MAIN, DIRECT, MAIN, BACKUP, THIRD, IP])
  })

  it('falls back to the direct entry when both HK entries are blocked', async () => {
    const storage = stubStorage()
    stubFetch([DIRECT_MAIN, DIRECT])
    const m = await load()
    await m.reportApiFailure()
    expect(m.API_BASE).toBe(DIRECT_MAIN)
    expect(storage.get('prismx.apiBase')).toBe(DIRECT_MAIN)
  })

  it('uses the pmxsl direct entry when the main-domain name is blocked too', async () => {
    stubStorage()
    stubFetch([DIRECT])
    const m = await load()
    await m.reportApiFailure()
    expect(m.API_BASE).toBe(DIRECT)
  })

  it('falls back to the third domain when both old names are blacklisted', async () => {
    const storage = stubStorage()
    stubFetch([THIRD, DIRECT_MAIN, DIRECT])
    const m = await load()
    await m.reportApiFailure()
    expect(m.API_BASE).toBe(THIRD)
    expect(storage.get('prismx.apiBase')).toBe(THIRD)
  })

  it('prefers the third domain when the page is served from it', async () => {
    stubStorage()
    vi.stubGlobal('location', { hostname: 'www.ljlhxhsys.com' })
    const m = await load()
    expect(m.API_BASE).toBe(THIRD)
    expect(m.API_CANDIDATES).toEqual([THIRD, MAIN, BACKUP, DIRECT_MAIN, DIRECT, IP])
  })

  it('falls back to the IP entry when every domain is blocked', async () => {
    const storage = stubStorage()
    stubFetch([IP])
    const m = await load()
    await m.reportApiFailure()
    expect(m.API_BASE).toBe(IP)
    expect(storage.get('prismx.apiBase')).toBe(IP)
  })

  it('prefers the IP entry when the page is opened by IP', async () => {
    stubStorage()
    vi.stubGlobal('location', { hostname: '43.134.110.47' })
    const m = await load()
    expect(m.API_BASE).toBe(IP)
    expect(m.API_CANDIDATES).toEqual([IP, MAIN, BACKUP, THIRD, DIRECT_MAIN, DIRECT])
  })

  it('picks by priority, not by who answers first', async () => {
    stubStorage()
    // 新加坡先回、香港后回：仍应选香港 / SG answers first, HK later: HK must still win
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === `${MAIN}/`) await new Promise((r) => setTimeout(r, 30))
        return new Response('{"status":"ok"}', { status: 200 })
      }),
    )
    const m = await load()
    await m.reportApiFailure()
    expect(m.API_BASE).toBe(MAIN)
  })

  it('switches back to HK once it is reachable again', async () => {
    vi.useFakeTimers()
    try {
      const storage = stubStorage({ 'prismx.apiBase': DIRECT })
      stubFetch([DIRECT])
      const m = await load()
      expect(m.API_BASE).toBe(DIRECT)

      // 首次回头探：香港仍不通，留在直连 / first recheck: HK still down, stay direct
      await vi.advanceTimersByTimeAsync(15_000)
      expect(m.API_BASE).toBe(DIRECT)

      // 香港恢复：下一轮换回主域名 / HK back: the next round switches to main
      stubFetch([MAIN, BACKUP, DIRECT])
      await vi.advanceTimersByTimeAsync(5 * 60_000)
      expect(m.API_BASE).toBe(MAIN)
      expect(storage.get('prismx.apiBase')).toBe(MAIN)
    } finally {
      vi.useRealTimers()
    }
  })

  it('prefers the backup when the page is served from pmxsl.com', async () => {
    stubStorage()
    vi.stubGlobal('location', { hostname: 'www.pmxsl.com' })
    const m = await load()
    expect(m.API_BASE).toBe(BACKUP)
  })

  it('switches to the backup when the main domain is unreachable, and remembers it', async () => {
    const storage = stubStorage()
    stubFetch([BACKUP])
    const m = await load()
    await m.reportApiFailure()
    expect(m.API_BASE).toBe(BACKUP)
    expect(storage.get('prismx.apiBase')).toBe(BACKUP)

    // 下次启动直接用记下的入口 / the next start uses the remembered base
    const again = await load()
    expect(again.API_BASE).toBe(BACKUP)
  })

  it('keeps the current base when nothing is reachable', async () => {
    stubStorage()
    stubFetch([])
    const m = await load()
    await m.reportApiFailure()
    expect(m.API_BASE).toBe(MAIN)
  })

  it('ignores a stored base that is not a known candidate', async () => {
    stubStorage({ 'prismx.apiBase': 'https://evil.example' })
    const m = await load()
    expect(m.API_BASE).toBe(MAIN)
  })

  it('does not probe again within the cooldown', async () => {
    stubStorage()
    const fetchMock = stubFetch([MAIN])
    const m = await load()
    await m.reportApiFailure()
    const calls = fetchMock.mock.calls.length
    await m.reportApiFailure()
    expect(fetchMock.mock.calls.length).toBe(calls)
  })

  it('does nothing in dev (no VITE_API_BASE)', async () => {
    vi.stubEnv('VITE_API_BASE', '')
    stubStorage()
    const fetchMock = stubFetch([])
    const m = await load()
    await m.reportApiFailure()
    expect(m.API_BASE).toBe('')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
