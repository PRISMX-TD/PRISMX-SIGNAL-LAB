import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const MAIN = 'https://api.prismxsignallab.com'
const BACKUP = 'https://api.pmxsl.com'
const THIRD = 'https://api.ljlhxhsys.com'
const IP = 'https://43.134.110.47/_b'
const HK_IP = 'https://124.156.167.169/_b'
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
    expect(m.API_CANDIDATES).toEqual([MAIN, BACKUP, THIRD, DIRECT_MAIN, DIRECT, HK_IP, IP])
  })

  it('prefers the direct entries when the page is served from www2', async () => {
    stubStorage()
    vi.stubGlobal('location', { hostname: 'www2.prismxsignallab.com' })
    const m = await load()
    expect(m.API_BASE).toBe(DIRECT_MAIN)
    expect(m.API_CANDIDATES).toEqual([DIRECT_MAIN, DIRECT, MAIN, BACKUP, THIRD, HK_IP, IP])
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
    expect(m.API_CANDIDATES).toEqual([THIRD, MAIN, BACKUP, DIRECT_MAIN, DIRECT, HK_IP, IP])
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
    expect(m.API_CANDIDATES).toEqual([IP, HK_IP, MAIN, BACKUP, THIRD, DIRECT_MAIN, DIRECT])
  })

  it('prefers the HK IP entry over the SG IP when every domain is blocked', async () => {
    const storage = stubStorage()
    stubFetch([IP, HK_IP])
    const m = await load()
    await m.reportApiFailure()
    expect(m.API_BASE).toBe(HK_IP)
    expect(storage.get('prismx.apiBase')).toBe(HK_IP)
  })

  it('prefers the HK IP entry when the page is opened by the HK IP', async () => {
    stubStorage()
    vi.stubGlobal('location', { hostname: '124.156.167.169' })
    const m = await load()
    expect(m.API_BASE).toBe(HK_IP)
    expect(m.API_CANDIDATES).toEqual([HK_IP, IP, MAIN, BACKUP, THIRD, DIRECT_MAIN, DIRECT])
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

describe('admin entry list', () => {
  const NEW = 'https://5.6.7.8/_b'
  const NEW2 = 'https://api.fresh.com'

  beforeEach(() => {
    vi.stubEnv('VITE_API_BASE', MAIN)
    vi.stubGlobal('location', { hostname: 'localhost' })
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  // 入口列表接口回 body；其余同 stubFetch。
  // The entries endpoint answers `body`; everything else as stubFetch.
  function stubWithEntries(up: string[], body: unknown) {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/api/site/entries')) return new Response(JSON.stringify(body), { status: 200 })
      if (up.some((b) => url === `${b}/`)) return new Response('{"status":"ok"}', { status: 200 })
      throw new TypeError('Failed to fetch')
    })
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  it('puts stored admin entries first and keeps every built-in entry after them', async () => {
    stubStorage({ 'prismx.apiEntries': JSON.stringify([NEW]) })
    const m = await load()
    expect(m.API_CANDIDATES).toEqual([NEW, MAIN, BACKUP, THIRD, DIRECT_MAIN, DIRECT, HK_IP, IP])
  })

  it('ignores a corrupted or unsafe stored list', async () => {
    stubStorage({ 'prismx.apiEntries': JSON.stringify(['http://plain.com', 'javascript:x', 7]) })
    const m = await load()
    expect(m.API_CANDIDATES[0]).toBe(MAIN)
    stubStorage({ 'prismx.apiEntries': '{not json' })
    const m2 = await load()
    expect(m2.API_CANDIDATES[0]).toBe(MAIN)
  })

  it('keeps the page own entry first when opened from an IP', async () => {
    stubStorage({ 'prismx.apiEntries': JSON.stringify([NEW]) })
    vi.stubGlobal('location', { hostname: '124.156.167.169' })
    const m = await load()
    expect(m.API_CANDIDATES.slice(0, 4)).toEqual([HK_IP, NEW, IP, MAIN])
  })

  it('fetches the list, drops invalid entries, stores it and re-ranks', async () => {
    const storage = stubStorage()
    stubWithEntries([MAIN], { entries: [NEW, 'http://bad.com', NEW2] })
    const m = await load()
    await m.refreshEntries()
    expect(m.API_CANDIDATES.slice(0, 3)).toEqual([NEW, NEW2, MAIN])
    expect(JSON.parse(storage.get('prismx.apiEntries') ?? '[]')).toEqual([NEW, NEW2])
  })

  it('an empty list from the server clears the stored one', async () => {
    const storage = stubStorage({ 'prismx.apiEntries': JSON.stringify([NEW]) })
    stubWithEntries([MAIN], { entries: [] })
    const m = await load()
    await m.refreshEntries()
    expect(m.API_CANDIDATES[0]).toBe(MAIN)
    expect(storage.has('prismx.apiEntries')).toBe(false)
  })

  it('a malformed response changes nothing', async () => {
    const storage = stubStorage({ 'prismx.apiEntries': JSON.stringify([NEW]) })
    stubWithEntries([MAIN], { nope: true })
    const m = await load()
    await m.refreshEntries()
    expect(m.API_CANDIDATES[0]).toBe(NEW)
    expect(storage.has('prismx.apiEntries')).toBe(true)
  })

  it('fails over to an admin entry when every built-in entry is blocked', async () => {
    stubStorage({ 'prismx.apiEntries': JSON.stringify([NEW]), 'prismx.apiBase': IP })
    stubFetch([NEW])
    const m = await load()
    expect(m.API_BASE).toBe(IP)
    await m.reportApiFailure()
    expect(m.API_BASE).toBe(NEW)
  })

  it('never schedules the fetch outside a browser (build-time prerender must exit)', async () => {
    vi.useFakeTimers()
    try {
      stubStorage()
      const fetchMock = stubWithEntries([MAIN], { entries: [NEW] })
      await load()
      await vi.advanceTimersByTimeAsync(7 * 3600_000)
      expect(fetchMock).not.toHaveBeenCalledWith(`${MAIN}/api/site/entries`, expect.anything())
    } finally {
      vi.useRealTimers()
    }
  })

  it('fetches the list on its own about 20 seconds after start', async () => {
    vi.useFakeTimers()
    try {
      stubStorage()
      const fetchMock = stubWithEntries([MAIN], { entries: [NEW] })
      vi.stubGlobal('window', {})
      const m = await load()
      await vi.advanceTimersByTimeAsync(20_000)
      expect(fetchMock).toHaveBeenCalledWith(`${MAIN}/api/site/entries`, expect.anything())
      expect(m.API_CANDIDATES[0]).toBe(NEW)
    } finally {
      vi.useRealTimers()
    }
  })

  it('sanitizeEntries keeps https bases only, deduped and capped at 20', async () => {
    const m = await load()
    const many = Array.from({ length: 30 }, (_, i) => `https://h${i}.com`)
    expect(m.sanitizeEntries(many)).toHaveLength(20)
    expect(m.sanitizeEntries([NEW, NEW, 'https://a.com/', 'https://u@a.com', 'https://a.com?x=1'])).toEqual([NEW])
    expect(m.sanitizeEntries('nope')).toEqual([])
  })
})
