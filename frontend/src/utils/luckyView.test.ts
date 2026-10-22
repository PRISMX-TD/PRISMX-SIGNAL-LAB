import { describe, expect, it } from 'vitest'
import type { LuckyDraw, LuckyPhase, LuckyRoundState } from '../api/luckyTypes'
import { LAST_ROUND_KEY, isWheelClosed, openRounds, pickRound, readLastRound, resultKey, wonDraws, withTicketsLeft, writeLastRound } from './luckyView'

const rs = (id: string, phase: LuckyPhase, unused = 0): LuckyRoundState => ({
  round: { id, name: `期${id}`, startsAt: '', endsAt: '', phase },
  prizes: [],
  tickets: { unused, batches: [] },
})

const draw = (kind: LuckyDraw['prize']['kind'], soldOut = false, extra: Partial<LuckyDraw['prize']> = {}): LuckyDraw => ({
  id: `d-${kind}`, createdAt: '', slotIndex: 0,
  prize: { id: 'p', name: '耳机', description: null, imageUrl: null, color: null, kind, proDays: null, claimMode: null, claimHint: null, ...extra },
  fulfillmentStatus: 'auto_done', claimInfo: null, supportTicketId: null, adminNote: null, soldOut, roundId: 'r', roundName: '期r',
})

describe('isWheelClosed / openRounds', () => {
  it('is closed with no rounds or only ended ones', () => {
    expect(isWheelClosed({ rounds: [] })).toBe(true)
    expect(isWheelClosed({ rounds: [rs('a', 'ended')] })).toBe(true)
  })
  it('is open for upcoming and active rounds, dropping ended ones from the list', () => {
    const state = { rounds: [rs('a', 'ended'), rs('b', 'upcoming'), rs('c', 'active')] }
    expect(isWheelClosed(state)).toBe(false)
    expect(openRounds(state).map((r) => r.round.id)).toEqual(['b', 'c'])
  })
})

describe('pickRound', () => {
  const rounds = [rs('a', 'upcoming'), rs('b', 'active', 0), rs('c', 'active', 2)]
  it('keeps the remembered round when it is still listed', () => {
    expect(pickRound(rounds, 'a')?.round.id).toBe('a')
  })
  it('otherwise prefers an active round with tickets, then any active one, then the first', () => {
    expect(pickRound(rounds, 'gone')?.round.id).toBe('c')
    expect(pickRound(rounds.slice(0, 2), null)?.round.id).toBe('b')
    expect(pickRound([rs('x', 'upcoming'), rs('y', 'upcoming')], undefined)?.round.id).toBe('x')
  })
  it('returns null with no rounds', () => {
    expect(pickRound([], 'a')).toBeNull()
  })
})

describe('withTicketsLeft', () => {
  it('only touches the round that was spun', () => {
    const state = { rounds: [rs('a', 'active', 3), rs('b', 'active', 5)] }
    const next = withTicketsLeft(state, 'b', 4)
    expect(next.rounds.map((r) => r.tickets.unused)).toEqual([3, 4])
    expect(state.rounds[1].tickets.unused).toBe(5)
  })
})

describe('wonDraws / resultKey', () => {
  it('hides thanks-for-playing and sold-out misses from My prizes', () => {
    const list = [draw('none'), draw('pro_days', true), draw('pro_days'), draw('custom')]
    expect(wonDraws(list).map((d) => [d.prize.kind, d.soldOut])).toEqual([['pro_days', false], ['custom', false]])
  })
  it('a sold-out miss reads as a miss whatever the slot was', () => {
    expect(resultKey(draw('custom', true))).toEqual({ key: 'lucky.result.soldOut' })
    expect(resultKey(draw('pro_days', true, { proDays: 7 }))).toEqual({ key: 'lucky.result.soldOut' })
  })
  it('picks the sentence by prize kind otherwise', () => {
    expect(resultKey(draw('none')).key).toBe('lucky.result.none')
    expect(resultKey(draw('retry')).key).toBe('lucky.result.retry')
    expect(resultKey(draw('pro_days', false, { proDays: 7 }))).toEqual({ key: 'lucky.result.proDays', params: { n: 7 } })
    expect(resultKey(draw('custom'))).toEqual({ key: 'lucky.result.custom', params: { name: '耳机' } })
  })
})

describe('last-round memory', () => {
  it('round-trips through the store', () => {
    const m = new Map<string, string>()
    const store = () => ({ getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v) } })
    expect(readLastRound(store)).toBeNull()
    writeLastRound('r2', store)
    expect(m.get(LAST_ROUND_KEY)).toBe('r2')
    expect(readLastRound(store)).toBe('r2')
  })
  it('swallows storage errors', () => {
    const boom = () => ({ getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('denied') } })
    expect(readLastRound(boom)).toBeNull()
    expect(() => writeLastRound('x', boom)).not.toThrow()
    expect(readLastRound(() => { throw new Error('no storage') })).toBeNull()
    expect(readLastRound(() => null)).toBeNull()
  })
})
