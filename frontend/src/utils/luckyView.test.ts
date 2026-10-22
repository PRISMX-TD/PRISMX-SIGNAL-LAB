import { describe, expect, it } from 'vitest'
import type { LuckyDraw, LuckyPhase, LuckyRoundState } from '../api/luckyTypes'
import { LAST_ROUND_KEY, isWheelClosed, openRounds, cheerKey, pickRound, readLastRound, revealCopy, wonDraws, withTicketsLeft, writeLastRound } from './luckyView'

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

describe('wonDraws / revealCopy', () => {
  it('hides thanks-for-playing, spin-again refunds and sold-out misses from My prizes', () => {
    const list = [draw('none'), draw('retry'), draw('pro_days', true), draw('pro_days'), draw('custom')]
    expect(wonDraws(list).map((d) => [d.prize.kind, d.soldOut])).toEqual([['pro_days', false], ['custom', false]])
  })
  it('a sold-out miss reads as a miss whatever the slot was', () => {
    expect(revealCopy(draw('custom', true))).toEqual({ tone: 'miss', titleKey: 'lucky.reveal.missTitle', subKey: 'lucky.reveal.soldOut' })
    expect(revealCopy(draw('pro_days', true, { proDays: 7 })).tone).toBe('miss')
  })
  it('picks the tone and copy by prize kind otherwise', () => {
    expect(revealCopy(draw('none'))).toMatchObject({ tone: 'miss', subKey: 'lucky.reveal.none', params: { name: '耳机' } })
    expect(revealCopy(draw('retry'))).toMatchObject({ tone: 'retry', titleKey: 'lucky.reveal.retryTitle' })
    expect(revealCopy(draw('pro_days', false, { proDays: 7 }))).toMatchObject({ tone: 'win', titleKey: 'lucky.reveal.proTitle', params: { n: 7 } })
    // 实物奖品：大标题就是奖品名，不走文案键 / custom: the headline is the prize name itself
    expect(revealCopy(draw('custom'))).toEqual({ tone: 'win', eyebrowKey: 'lucky.reveal.won', titleText: '耳机' })
  })
})

describe('cheerKey', () => {
  const base = { phase: 'active' as const, spinning: false, unused: 3, hadTickets: true, last: null, missStreak: 0 }
  it('says when the round has not started or a spin is running', () => {
    expect(cheerKey({ ...base, phase: 'upcoming' })).toBe('lucky.cheer.upcoming')
    expect(cheerKey({ ...base, spinning: true })).toBe('lucky.cheer.spinning')
  })
  it('separates never-had-tickets from used-them-all', () => {
    expect(cheerKey({ ...base, unused: 0, hadTickets: false })).toBe('lucky.cheer.none')
    expect(cheerKey({ ...base, unused: 0 })).toBe('lucky.cheer.out')
    expect(cheerKey({ ...base, unused: 0, last: 'win' })).toBe('lucky.cheer.winOut')
  })
  it('reacts to the last outcome and rotates miss lines without repeating', () => {
    expect(cheerKey(base)).toBe('lucky.cheer.ready')
    expect(cheerKey({ ...base, last: 'win' })).toBe('lucky.cheer.win')
    expect(cheerKey({ ...base, last: 'retry' })).toBe('lucky.cheer.retry')
    const misses = [1, 2, 3, 4].map((k) => cheerKey({ ...base, last: 'miss', missStreak: k }))
    expect(misses).toEqual(['lucky.cheer.miss1', 'lucky.cheer.miss2', 'lucky.cheer.miss3', 'lucky.cheer.miss1'])
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
