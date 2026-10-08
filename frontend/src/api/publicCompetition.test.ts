// 公开比赛接口：裸 fetch、绝不带 Authorization、404 可区分、事件打点永不抛错。
// Public competition client: bare fetch, never Authorization, 404 distinguishable, events never throw.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { API_BASE } from './apiBase'
import { PublicHttpError, publicCompetitionApi } from './publicCompetition'

type Call = [string, RequestInit]

function stubFetch(impl: () => Promise<Response>) {
  const f = vi.fn(impl)
  vi.stubGlobal('fetch', f)
  return f
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('publicCompetitionApi', () => {
  it('detail GETs the encoded public path without Authorization or cookies', async () => {
    // 即使本机存着登录 token 也不能带上 / even with a stored session token
    vi.stubGlobal('localStorage', { getItem: () => 'tok', setItem() {}, removeItem() {} })
    const f = stubFetch(async () => json({ id: 'c1', rows: [] }))
    await expect(publicCompetitionApi.detail('a/b')).resolves.toEqual({ id: 'c1', rows: [] })
    const [url, init] = f.mock.calls[0] as unknown as Call
    expect(url).toBe(`${API_BASE}/api/public/competitions/a%2Fb`)
    expect(new Headers(init.headers).has('Authorization')).toBe(false)
    expect(init.credentials).toBe('omit')
    expect(init.method).toBe('GET')
  })

  it('featured returns the id (or null)', async () => {
    stubFetch(async () => json({ id: null }))
    await expect(publicCompetitionApi.featured()).resolves.toEqual({ id: null })
  })

  it('non-2xx rejects with PublicHttpError carrying the status', async () => {
    stubFetch(async () => json({ detail: 'x' }, 404))
    const err = await publicCompetitionApi.detail('c1').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(PublicHttpError)
    expect((err as PublicHttpError).status).toBe(404)
    stubFetch(async () => new Response('', { status: 429 }))
    expect(((await publicCompetitionApi.detail('c1').catch((e: unknown) => e)) as PublicHttpError).status).toBe(429)
  })

  it('event POSTs JSON with keepalive and swallows failures', async () => {
    const f = stubFetch(async () => new Response(null, { status: 204 }))
    await expect(publicCompetitionApi.event({ compId: 'c1', step: 'view', ref: 'abc' })).resolves.toBeUndefined()
    const [url, init] = f.mock.calls[0] as unknown as Call
    expect(url).toBe(`${API_BASE}/api/public/competitions/event`)
    expect(init.method).toBe('POST')
    expect(init.keepalive).toBe(true)
    expect(JSON.parse(String(init.body))).toEqual({ compId: 'c1', step: 'view', ref: 'abc' })
    expect(new Headers(init.headers).has('Authorization')).toBe(false)
    stubFetch(async () => { throw new TypeError('offline') })
    await expect(publicCompetitionApi.event({ compId: 'c1', step: 'cta' })).resolves.toBeUndefined()
  })
})
