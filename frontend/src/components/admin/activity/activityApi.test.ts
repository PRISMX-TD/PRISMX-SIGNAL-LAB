// adminApi.activity / activityItem 拼出来的地址：参数名是后端的 snake_case（user_id），sub 只在
// cat=trade 时发，abnormal 发 1，默认值不发，详情的 key 要编码。jsdom 未安装，window 等用桩。
// The URLs adminApi.activity / activityItem build: backend snake_case names (user_id), sub
// only under cat=trade, abnormal as 1, defaults omitted, the detail key encoded.
import { afterEach, describe, expect, it, vi } from 'vitest'

async function load() {
  vi.resetModules()
  vi.stubEnv('VITE_API_BASE', 'https://api.example.test')
  vi.stubGlobal('location', { hostname: 'localhost' })
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  })
  vi.stubGlobal('window', {
    setTimeout: (...a: Parameters<typeof setTimeout>) => setTimeout(...a),
    clearTimeout: (id: Parameters<typeof clearTimeout>[0]) => clearTimeout(id),
  })
  const urls: string[] = []
  vi.stubGlobal('fetch', async (url: string) => {
    urls.push(url)
    return new Response(JSON.stringify({ items: [], next: null }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  })
  const api = await import('../../../api/client')
  return { api, urls }
}

describe('adminApi.activity', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('默认值不发 / defaults are omitted', async () => {
    const { api, urls } = await load()
    await api.adminApi.activity({ cat: 'all', sub: 'all', abnormal: false })
    expect(urls[0]).toBe('https://api.example.test/api/admin/activity')
  })

  it('全部筛选 / every filter', async () => {
    const { api, urls } = await load()
    await api.adminApi.activity({
      cat: 'trade', sub: 'sltp', abnormal: true, q: 'lucas', userId: 'u-1', login: '51234567',
      since: '2026-10-08T16:00:00.000Z', until: '2026-10-09T16:00:00.000Z', cursor: 'eyJ1IjpudWxsfQ', limit: 50,
    })
    const u = new URL(urls[0])
    expect(u.pathname).toBe('/api/admin/activity')
    expect(Object.fromEntries(u.searchParams)).toEqual({
      cat: 'trade', sub: 'sltp', abnormal: '1', q: 'lucas', user_id: 'u-1', login: '51234567',
      since: '2026-10-08T16:00:00.000Z', until: '2026-10-09T16:00:00.000Z', cursor: 'eyJ1IjpudWxsfQ', limit: '50',
    })
  })

  it('sub 只跟着交易分类走 / sub is sent only with cat=trade', async () => {
    const { api, urls } = await load()
    await api.adminApi.activity({ cat: 'admin', sub: 'sltp' })
    expect(new URL(urls[0]).searchParams.has('sub')).toBe(false)
  })

  it('详情的 key 编码 / the detail key is encoded', async () => {
    const { api, urls } = await load()
    await api.adminApi.activityItem('g:abc/def')
    expect(urls[0]).toBe('https://api.example.test/api/admin/activity/item?key=g%3Aabc%2Fdef')
  })

  it('详情带上列表的筛选，默认值不发 / the detail carries the list filters, defaults omitted', async () => {
    const { api, urls } = await load()
    await api.adminApi.activityItem('t:o-1:o-3', { cat: 'trade', abnormal: true, q: '138 0013', userId: 'u-1' })
    await api.adminApi.activityItem('g:a-1', { cat: 'all', abnormal: false, q: undefined, userId: undefined })
    const u = new URL(urls[0])
    expect(u.pathname).toBe('/api/admin/activity/item')
    expect(Object.fromEntries(u.searchParams)).toEqual({ key: 't:o-1:o-3', cat: 'trade', abnormal: '1', q: '138 0013', user_id: 'u-1' })
    expect(urls[1]).toBe('https://api.example.test/api/admin/activity/item?key=g%3Aa-1')
  })
})
