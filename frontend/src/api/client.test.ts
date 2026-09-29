// request() 的网络层行为：GET/HEAD 8 秒门槛切换备用域名、带幂等号的写请求自动重发、
// AbortError / 非幂等写请求 / HTTP 错误绝不重发。jsdom 未安装，window / localStorage 用桩。
// Network behaviour of request(): the 8s header gate for GET/HEAD, automatic resend of
// idempotent writes, and never resending AbortError / non-idempotent writes / HTTP errors.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const MAIN = 'https://api.prismxsignallab.com'
const BACKUP = 'https://api.pmxsl.com'

interface Mods {
  api: typeof import('./client')
  base: typeof import('./apiBase')
}

async function load(): Promise<Mods> {
  vi.resetModules()
  vi.stubEnv('VITE_API_BASE', MAIN)
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
  const base = await import('./apiBase')
  const api = await import('./client')
  return { api, base }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

function abortError() {
  const e = new Error('The operation was aborted')
  e.name = 'AbortError'
  return e
}

// 探测根路径：只有 upBases 里的入口应答 / probe `/`: only bases in upBases answer
function probeAnswer(url: string, upBases: string[]): Response {
  if (upBases.some((b) => url === `${b}/`)) return json({ status: 'ok' })
  throw new TypeError('Failed to fetch')
}

describe('request(): network layer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('GET 响应头 8 秒没到：探测到备用入口后 abort 挂着的请求并用新入口重发', async () => {
    const { api, base } = await load()
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
      if (url.endsWith('/')) return Promise.resolve(probeAnswer(url, [BACKUP]))
      calls.push(url)
      if (url.startsWith(MAIN)) {
        // 黑洞：既不应答也不报错，直到被 abort / black hole until aborted
        return new Promise<Response>((_res, rej) => {
          init?.signal?.addEventListener('abort', () => rej(abortError()))
        })
      }
      return Promise.resolve(json({ signals: [] }))
    }))
    const p = api.signalApi.list()
    await vi.advanceTimersByTimeAsync(7_900)
    expect(calls).toEqual([`${MAIN}/api/signals`])
    await vi.advanceTimersByTimeAsync(200)
    await expect(p).resolves.toEqual({ signals: [] })
    expect(base.API_BASE).toBe(BACKUP)
    expect(calls).toEqual([`${MAIN}/api/signals`, `${BACKUP}/api/signals`])
  })

  it('写操作不走 8 秒门槛：POST 挂着时不会被中途重发', async () => {
    const { api } = await load()
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
      if (url.endsWith('/')) return Promise.resolve(probeAnswer(url, [BACKUP]))
      calls.push(url)
      return new Promise<Response>((_res, rej) => {
        init?.signal?.addEventListener('abort', () => rej(abortError()))
      })
    }))
    const p = api.orderApi.place({
      signalId: null, symbol: 'XAUUSD', side: 'BUY', volume: 0.1, clientOrderId: 'co_1',
    })
    const settled = p.then(() => 'ok', (e: Error) => e.name)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(110_000)
    expect(await settled).toBe('AbortError')
    expect(calls).toHaveLength(1)
  })

  it('幂等 POST 遇到 TypeError 且入口没切换：800ms 后重发一次', async () => {
    const { api } = await load()
    let n = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/')) throw new TypeError('down') // 两个入口都探不通 / no entry answers
      n += 1
      if (n === 1) throw new TypeError('Failed to fetch')
      return json({ id: 'o1', status: 'PENDING' })
    }))
    const p = api.orderApi.place({
      signalId: null, symbol: 'XAUUSD', side: 'BUY', volume: 0.1, clientOrderId: 'co_1',
    })
    await vi.advanceTimersByTimeAsync(10_000)
    await expect(p).resolves.toMatchObject({ id: 'o1' })
    expect(n).toBe(2)
  })

  it('幂等 POST 遇到 TypeError 且探测切换了入口：立即用新入口重发', async () => {
    const { api, base } = await load()
    const orderUrls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/')) return probeAnswer(url, [BACKUP])
      orderUrls.push(url)
      if (url.startsWith(MAIN)) throw new TypeError('Failed to fetch')
      return json({ id: 'o1', status: 'FILLED' })
    }))
    const p = api.orderApi.close({
      clientOrderId: 'co_2', ticket: 1, symbol: 'XAUUSD', side: 'BUY',
    })
    await vi.advanceTimersByTimeAsync(100)
    await expect(p).resolves.toMatchObject({ status: 'FILLED' })
    expect(base.API_BASE).toBe(BACKUP)
    expect(orderUrls).toEqual([`${MAIN}/api/orders/close`, `${BACKUP}/api/orders/close`])
  })

  it('AbortError 绝不重发（幂等 POST 也一样）', async () => {
    const { api } = await load()
    let n = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/')) return probeAnswer(url, [MAIN, BACKUP])
      n += 1
      throw abortError()
    }))
    const p = api.orderApi.place({
      signalId: null, symbol: 'XAUUSD', side: 'BUY', volume: 0.1, clientOrderId: 'co_1',
    })
    const settled = p.then(() => 'ok', (e: Error) => e.name)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await settled).toBe('AbortError')
    expect(n).toBe(1)
  })

  it('非幂等 POST 遇到 TypeError：不重发、不等探测直接抛', async () => {
    const { api } = await load()
    let n = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/')) return probeAnswer(url, [BACKUP])
      n += 1
      throw new TypeError('Failed to fetch')
    }))
    const p = api.orderApi.cancel('some-id')
    const settled = p.then(() => 'ok', (e: Error) => e.name)
    await vi.advanceTimersByTimeAsync(0)
    expect(await settled).toBe('TypeError')
    expect(n).toBe(1)
  })

  it('HTTP 错误是「拿到了响应」：不重发，且 hasHttpResponse 为真', async () => {
    const { api } = await load()
    let n = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      n += 1
      return json({ detail: 'rejected' }, 400)
    }))
    const err = await api.orderApi
      .close({ clientOrderId: 'co_3', ticket: 1, symbol: 'XAUUSD', side: 'BUY' })
      .catch((e: unknown) => e)
    expect(n).toBe(1)
    expect(api.hasHttpResponse(err)).toBe(true)
    expect(api.hasHttpResponse(new TypeError('x'))).toBe(false)
  })
})
