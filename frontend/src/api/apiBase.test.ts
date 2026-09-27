import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const MAIN = 'https://api.prismxsignallab.com'
const BACKUP = 'https://api.pmxsl.com'

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
    expect(m.API_CANDIDATES).toEqual([MAIN, BACKUP])
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
