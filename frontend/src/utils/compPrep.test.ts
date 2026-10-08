import { describe, expect, it } from 'vitest'
import { ApiHttpError } from '../api/client'
import type { CompetitionDetail, MT5Account } from '../api/types'
import {
  bindHint, classifyDetailError, eligibleAccounts, fundsOk, fundsRule, gatesOfDetail, prepState,
  registerErrorKey, shouldClearIntent, type CompGates,
} from './compPrep'

const acct = (over: Partial<MT5Account>): MT5Account => ({ login: '1', online: true, source: 'gateway', tradeMode: 0, balance: 500, equity: 500, ...over })
const EXACT: CompGates = { minBaselineUsd: 500, maxBaselineUsd: 500, minTrades: 5 }
const RANGE: CompGates = { minBaselineUsd: 100, maxBaselineUsd: 1000, minTrades: 5 }
const MIN: CompGates = { minBaselineUsd: 100, maxBaselineUsd: null, minTrades: 5 }

describe('fundsRule / fundsOk', () => {
  it('classifies the gate shape', () => {
    expect(fundsRule(EXACT)).toEqual({ kind: 'exact', usd: 500 })
    expect(fundsRule(RANGE)).toEqual({ kind: 'range', min: 100, max: 1000 })
    expect(fundsRule(MIN)).toEqual({ kind: 'min', min: 100 })
  })
  it('exact amount: within 0.005 and flat (equity == balance)', () => {
    expect(fundsOk({ balance: 500.004, equity: 500.004 }, EXACT)).toBe(true)
    expect(fundsOk({ balance: 500.01, equity: 500.01 }, EXACT)).toBe(false)
    expect(fundsOk({ balance: 500, equity: 498.2 }, EXACT)).toBe(false)
    expect(fundsOk({ balance: 500, equity: null }, EXACT)).toBeNull()
  })
  it('range / floor use the balance; unknown balance is null', () => {
    expect(fundsOk({ balance: 100, equity: 90 }, RANGE)).toBe(true)
    expect(fundsOk({ balance: 1000.5, equity: 1000.5 }, RANGE)).toBe(false)
    expect(fundsOk({ balance: 99.99, equity: 99.99 }, MIN)).toBe(false)
    expect(fundsOk({ balance: 1e6, equity: 1e6 }, MIN)).toBe(true)
    expect(fundsOk({ balance: null, equity: null }, MIN)).toBeNull()
  })
})

describe('eligibleAccounts / bindHint', () => {
  const all = [
    acct({ login: 'g-demo' }),
    acct({ login: 'g-real', tradeMode: 2 }),
    acct({ login: 'b-demo', source: 'bridge' }),
    acct({ login: 'g-revoked', needsReverify: true }),
    acct({ login: 'g-entered' }),
    acct({ login: 'g-unknown', tradeMode: null }),
  ]
  it('keeps only direct, on-track, live, not-yet-entered accounts', () => {
    expect(eligibleAccounts(all, 'demo', new Set(['g-entered'])).map((a) => a.login)).toEqual(['g-demo'])
    expect(eligibleAccounts(all, 'real', new Set()).map((a) => a.login)).toEqual(['g-real'])
  })
  it('explains why nothing is eligible', () => {
    expect(bindHint([], 'demo')).toBe('noAccounts')
    expect(bindHint([acct({ source: 'bridge' })], 'demo')).toBe('gatewayOnly')
    expect(bindHint([acct({ tradeMode: null })], 'demo')).toBe('pendingType')
    expect(bindHint([acct({ tradeMode: 2 })], 'demo')).toBe('wrongTrack')
    expect(bindHint([acct({})], 'demo')).toBeNull()
  })
})

describe('prepState', () => {
  it('orders steps and marks progress', () => {
    const s = prepState({ emailVerified: true, accounts: [acct({ balance: 480, equity: 480 })], track: 'demo', gates: EXACT, enteredLogins: new Set(), hasOpenAccountUrl: true })
    expect(s.steps).toEqual([
      { key: 'email', done: true },
      { key: 'openAccount', done: true },
      { key: 'bind', done: true },
      { key: 'funds', done: false },
      { key: 'register', done: false },
    ])
    expect(s.eligible).toHaveLength(1)
    expect(s.fundsReady).toHaveLength(0)
  })
  it('omits the open-account step without a link', () => {
    const s = prepState({ emailVerified: false, accounts: [], track: 'demo', gates: EXACT, enteredLogins: new Set(), hasOpenAccountUrl: false })
    expect(s.steps.map((x) => x.key)).toEqual(['email', 'bind', 'funds', 'register'])
    expect(s.steps.every((x) => !x.done)).toBe(true)
  })
})

describe('gatesOfDetail', () => {
  const board = { gates: { minBaselineUsd: 500, maxBaselineUsd: 500, minTradesReturn: 5, minTradesWinrate: 20, winrateRequireProfit: false } } as CompetitionDetail['board']
  it('picks the trade gate by metric', () => {
    expect(gatesOfDetail({ metric: 'return_pct', board })).toEqual({ minBaselineUsd: 500, maxBaselineUsd: 500, minTrades: 5 })
    expect(gatesOfDetail({ metric: 'win_rate', board }).minTrades).toBe(20)
  })
})

describe('error mapping', () => {
  it('detail: 403 beta, 404 gone, anything else retry', () => {
    expect(classifyDetailError(new ApiHttpError('beta', 403))).toBe('forbidden')
    expect(classifyDetailError(new ApiHttpError('gone', 404))).toBe('notFound')
    expect(classifyDetailError(new ApiHttpError('x', 500))).toBe('retry')
    expect(classifyDetailError(new TypeError('Failed to fetch'))).toBe('retry')
  })
  it('register: 409 / 503 get their own copy, others use the server message', () => {
    expect(registerErrorKey(new ApiHttpError('x', 409))).toBe('competition.regErr.taken')
    expect(registerErrorKey(new ApiHttpError('x', 503))).toBe('competition.regErr.fundsUnavailable')
    expect(registerErrorKey(new ApiHttpError('非直连 / not direct', 400))).toBeNull()
    expect(registerErrorKey(new Error('x'))).toBeNull()
  })
})

describe('shouldClearIntent', () => {
  const NOW = Date.parse('2026-10-10T00:00:00Z')
  const d = (over: Partial<Parameters<typeof shouldClearIntent>[0]>) => ({
    status: 'upcoming' as const, enrollment: 'signup' as const,
    regOpensAt: '2026-10-01T00:00:00Z', regClosesAt: '2026-10-20T00:00:00Z', myEntries: [], ...over,
  })
  it('keeps the intent while the user can still enter', () => {
    expect(shouldClearIntent(d({}), NOW)).toBe(false)
    expect(shouldClearIntent(d({ regOpensAt: '2026-10-15T00:00:00Z' }), NOW)).toBe(false)
  })
  it('clears it once entered, closed or over', () => {
    expect(shouldClearIntent(d({ myEntries: [{ login: '1', scoringFrom: null, finalRank: null, finalScore: null, disqualified: false }] }), NOW)).toBe(true)
    expect(shouldClearIntent(d({ regClosesAt: '2026-10-05T00:00:00Z' }), NOW)).toBe(true)
    expect(shouldClearIntent(d({ status: 'ended' }), NOW)).toBe(true)
    expect(shouldClearIntent(d({ enrollment: 'auto' }), NOW)).toBe(true)
  })
})
