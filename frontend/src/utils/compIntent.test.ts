// 比赛报名意图：只接受严格 UUID（防开放跳转 / 路径注入），14 天过期，本地意图优先于
// 服务端 pendingCompetition，没有意图时目的地必须仍是 /dashboard。jsdom 未安装，
// window.localStorage 用 Map 桩。
// Competition intent: strict UUIDs only (no open redirect / path injection), 14-day TTL,
// the local intent beats the server's pendingCompetition, and with no intent the destination
// is exactly /dashboard. No jsdom; window.localStorage is a Map-backed stub.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  COMP_INTENT_KEY,
  COMP_INTENT_TTL_MS,
  clearCompIntent,
  clearCompIntentFor,
  compIntentTarget,
  isCompId,
  postAuthDestination,
  readCompIntent,
  resumeCompIntent,
  storeCompIntent,
} from './compIntent'

const ID = '3f2b8c1e-9a4d-4e7f-8b21-0c5d6e7f8a9b'
const ID2 = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const T0 = new Date('2026-10-08T00:00:00Z').getTime()

let store: Map<string, string>

beforeEach(() => {
  store = new Map()
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
  })
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T0)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const HOSTILE: string[] = [
  '',
  'not-a-uuid',
  '//evil.com',
  '/\\evil.com',
  '\\\\evil.com',
  'https://evil.com',
  'javascript:alert(1)',
  '%2F%2Fevil.com',
  encodeURIComponent('//evil.com'),
  `${ID}/../../admin`,
  `${ID}?x=1`,
  `${ID}#x`,
  `${ID}&c=other`,
  `${ID}\n`,
  `\n${ID}`,
  `${ID}\t`,
  `\t${ID}`,
  ` ${ID}`,
  `${ID} `,
  `${ID}\u0000`,
  `${ID}‮`,
  ID.replace(/-/g, ''),
  ID.slice(0, -1),
  `${ID}0`,
  ID.replace('3', 'g'),
  '00000000-0000-0000-0000-00000000000', // 11 hex in last group
]

describe('isCompId', () => {
  it('accepts canonical UUIDs in either case', () => {
    expect(isCompId(ID)).toBe(true)
    expect(isCompId(ID.toUpperCase())).toBe(true)
  })
  it.each(HOSTILE)('rejects %j', (v) => {
    expect(isCompId(v)).toBe(false)
  })
  it('rejects non-strings', () => {
    for (const v of [null, undefined, 1, {}, [ID], { id: ID }]) expect(isCompId(v)).toBe(false)
  })
})

describe('storeCompIntent / readCompIntent', () => {
  it('round-trips a valid id, normalised to lower case', () => {
    expect(storeCompIntent(ID.toUpperCase())).toBe(true)
    expect(readCompIntent()).toBe(ID)
    expect(JSON.parse(store.get(COMP_INTENT_KEY) ?? 'null')).toEqual({ id: ID, ts: T0 })
  })

  it.each(HOSTILE)('never stores %j', (v) => {
    expect(storeCompIntent(v)).toBe(false)
    expect(store.has(COMP_INTENT_KEY)).toBe(false)
    expect(readCompIntent()).toBeNull()
  })

  it('a later valid click replaces the earlier one', () => {
    storeCompIntent(ID)
    vi.setSystemTime(T0 + 1000)
    storeCompIntent(ID2)
    expect(readCompIntent()).toBe(ID2)
  })

  it('expires after 14 days and removes the entry', () => {
    storeCompIntent(ID)
    vi.setSystemTime(T0 + COMP_INTENT_TTL_MS)
    expect(readCompIntent()).toBe(ID)
    vi.setSystemTime(T0 + COMP_INTENT_TTL_MS + 1)
    expect(readCompIntent()).toBeNull()
    expect(store.has(COMP_INTENT_KEY)).toBe(false)
  })

  it.each(HOSTILE)('treats a tampered stored id %j as no intent and removes it', (v) => {
    store.set(COMP_INTENT_KEY, JSON.stringify({ id: v, ts: T0 }))
    expect(readCompIntent()).toBeNull()
    expect(store.has(COMP_INTENT_KEY)).toBe(false)
  })

  it('rejects future-dated, non-numeric or missing timestamps', () => {
    for (const ts of [T0 + 10 * 60 * 1000, '1', null, Number.NaN]) {
      store.set(COMP_INTENT_KEY, JSON.stringify({ id: ID, ts }))
      expect(readCompIntent()).toBeNull()
    }
    store.set(COMP_INTENT_KEY, JSON.stringify({ id: ID }))
    expect(readCompIntent()).toBeNull()
  })

  it('survives corrupt JSON and non-object values', () => {
    for (const raw of ['{oops', '"' + ID + '"', '[]', 'null', '42']) {
      store.set(COMP_INTENT_KEY, raw)
      expect(readCompIntent()).toBeNull()
    }
  })

  it('clearCompIntent removes it', () => {
    storeCompIntent(ID)
    clearCompIntent()
    expect(readCompIntent()).toBeNull()
  })

  it('clearCompIntentFor only clears an intent for that competition (any case)', () => {
    storeCompIntent(ID2)
    expect(clearCompIntentFor(ID)).toBe(false)
    expect(readCompIntent()).toBe(ID2)
    expect(clearCompIntentFor(ID2.toUpperCase())).toBe(true)
    expect(readCompIntent()).toBeNull()
    expect(clearCompIntentFor(ID2)).toBe(false)
  })

  it('never throws when storage is unavailable', () => {
    vi.stubGlobal('window', {
      get localStorage(): Storage {
        throw new Error('SecurityError')
      },
    })
    expect(storeCompIntent(ID)).toBe(false)
    expect(readCompIntent()).toBeNull()
    expect(() => clearCompIntent()).not.toThrow()
  })
})

describe('destination / resume', () => {
  it('no intent anywhere → exactly /dashboard and no navigation', () => {
    const nav = vi.fn()
    expect(postAuthDestination(null)).toBe('/dashboard')
    expect(postAuthDestination(undefined)).toBe('/dashboard')
    expect(postAuthDestination({ pendingCompetition: null })).toBe('/dashboard')
    expect(postAuthDestination({})).toBe('/dashboard')
    expect(resumeCompIntent(nav, { pendingCompetition: null })).toBe(false)
    expect(nav).not.toHaveBeenCalled()
  })

  it('local intent → /competitions?c=<id> with replace', () => {
    storeCompIntent(ID)
    const nav = vi.fn()
    expect(compIntentTarget(null)).toBe(`/competitions?c=${ID}`)
    expect(resumeCompIntent(nav, null)).toBe(true)
    expect(nav).toHaveBeenCalledWith(`/competitions?c=${ID}`, { replace: true })
  })

  it('falls back to the server pendingCompetition', () => {
    const nav = vi.fn()
    const user = { pendingCompetition: { id: ID2, name: 'Demo Cup' } }
    expect(postAuthDestination(user)).toBe(`/competitions?c=${ID2}`)
    expect(resumeCompIntent(nav, user)).toBe(true)
    expect(nav).toHaveBeenCalledWith(`/competitions?c=${ID2}`, { replace: true })
  })

  it('local intent beats pendingCompetition', () => {
    storeCompIntent(ID)
    expect(postAuthDestination({ pendingCompetition: { id: ID2, name: 'x' } })).toBe(`/competitions?c=${ID}`)
  })

  it.each(HOSTILE)('a hostile pendingCompetition.id %j is ignored', (v) => {
    const nav = vi.fn()
    const user = { pendingCompetition: { id: v, name: 'x' } }
    expect(postAuthDestination(user)).toBe('/dashboard')
    expect(resumeCompIntent(nav, user)).toBe(false)
    expect(nav).not.toHaveBeenCalled()
  })

  it('resume does not consume the intent (it must survive verify-email → bind)', () => {
    storeCompIntent(ID)
    resumeCompIntent(vi.fn(), null)
    expect(readCompIntent()).toBe(ID)
  })
})
