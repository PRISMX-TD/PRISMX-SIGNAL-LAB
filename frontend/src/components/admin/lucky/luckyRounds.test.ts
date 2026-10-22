import { describe, expect, it } from 'vitest'
import type { LuckyPhase, LuckyRoundAdmin } from '../../../api/luckyTypes'
import {
  deleteNameMatches, endsInPast, fromLocalInput, keepSelection, replaceRound, roundFormProblem, roundPatch,
  shown, splitRounds, toLocalInput,
} from './luckyRounds'

const round = (id: string, phase: LuckyPhase, extra: Partial<LuckyRoundAdmin> = {}): LuckyRoundAdmin => ({
  id, name: `期${id}`, startsAt: '2026-11-01T00:00:00', endsAt: '2026-11-10T00:00:00', phase,
  mode: 'prob', visible: false, endedAt: null, stats: { issued: 0, used: 0, unused: 0, pendingClaims: 0, draws: 0 },
  ...extra,
})

describe('luckyRounds list', () => {
  it('splits open from ended, keeping order', () => {
    const { open, ended } = splitRounds([round('a', 'active'), round('b', 'ended'), round('c', 'upcoming')])
    expect(open.map((r) => r.id)).toEqual(['a', 'c'])
    expect(ended.map((r) => r.id)).toEqual(['b'])
  })
  it('keeps the selection while it exists, else falls back to the first open round', () => {
    const rs = [round('x', 'ended'), round('a', 'active'), round('b', 'upcoming')]
    expect(keepSelection(rs, 'b')).toBe('b')
    expect(keepSelection(rs, 'gone')).toBe('a')
    expect(keepSelection([round('x', 'ended')], null)).toBe('x')
    expect(keepSelection([], 'a')).toBeNull()
  })
  it('swaps in a returned round without the voided count, or prepends a new one', () => {
    const rs = [round('a', 'active'), round('b', 'upcoming')]
    const next = replaceRound(rs, { ...round('b', 'ended'), voided: 3 })
    expect(next.map((r) => [r.id, r.phase])).toEqual([['a', 'active'], ['b', 'ended']])
    expect(next[1]).not.toHaveProperty('voided')
    expect(replaceRound(rs, round('c', 'upcoming')).map((r) => r.id)).toEqual(['c', 'a', 'b'])
  })
})

describe('luckyRounds time inputs', () => {
  it('reads naive UTC as UTC and round-trips through the local input', () => {
    const v = toLocalInput('2026-11-01T04:30:00')
    expect(v).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
    expect(fromLocalInput(v)).toBe('2026-11-01T04:30:00.000Z')
    expect(shown(v)).toBe('01/11, 12:30:00 UTC+8')
  })
  it('handles empty / invalid values', () => {
    expect(toLocalInput(null)).toBe('')
    expect(toLocalInput('garbage')).toBe('')
    expect(shown('')).toBe('')
    expect(endsInPast('', 0)).toBe(false)
  })
})

describe('luckyRounds form', () => {
  const now = new Date('2026-10-22T00:00:00Z').getTime()
  const start = toLocalInput('2026-10-25T00:00:00')
  const end = toLocalInput('2026-10-30T00:00:00')
  const f = (p: Partial<{ name: string; start: string; end: string }> = {}) => ({ name: '双十一', start, end, mode: 'qty' as const, ...p })
  it('accepts a sane window', () => {
    expect(roundFormProblem(f(), now)).toBeNull()
  })
  it('names the first problem', () => {
    expect(roundFormProblem(f({ name: '  ' }), now)).toBe('name')
    expect(roundFormProblem(f({ name: 'x'.repeat(41) }), now)).toBe('nameLong')
    expect(roundFormProblem(f({ start: '' }), now)).toBe('start')
    expect(roundFormProblem(f({ end: 'nope' }), now)).toBe('end')
    expect(roundFormProblem(f({ end: start }), now)).toBe('order')
  })
  it('refuses an end in the past when creating but lets an edit end the round now', () => {
    const past = { start: toLocalInput('2026-10-01T00:00:00'), end: toLocalInput('2026-10-02T00:00:00') }
    expect(roundFormProblem(f(past), now)).toBe('past')
    expect(roundFormProblem(f(past), now, true)).toBeNull()
    expect(endsInPast(past.end, now)).toBe(true)
    expect(endsInPast(end, now)).toBe(false)
  })
})

describe('luckyRounds.roundPatch', () => {
  const orig = round('a', 'upcoming')
  const form = { name: orig.name, start: toLocalInput(orig.startsAt), end: toLocalInput(orig.endsAt), mode: 'prob' as const }
  it('returns null when nothing changed', () => {
    expect(roundPatch(orig, form)).toBeNull()
    expect(roundPatch(orig, { ...form, name: ` ${orig.name} ` })).toBeNull()
  })
  it('sends only the changed fields', () => {
    expect(roundPatch(orig, { ...form, name: '新名字' })).toEqual({ name: '新名字' })
    const end = toLocalInput('2026-11-12T00:00:00')
    expect(roundPatch(orig, { ...form, end })).toEqual({ endsAt: '2026-11-12T00:00:00.000Z' })
  })
  it('only moves the start while the round is upcoming', () => {
    const start = toLocalInput('2026-11-02T00:00:00')
    expect(roundPatch(orig, { ...form, start })).toEqual({ startsAt: '2026-11-02T00:00:00.000Z' })
    expect(roundPatch({ ...orig, phase: 'active' }, { ...form, start })).toBeNull()
  })
})

describe('luckyRounds.deleteNameMatches', () => {
  it('needs the exact name', () => {
    expect(deleteNameMatches('期a', '期a')).toBe(true)
    expect(deleteNameMatches(' 期a ', '期a')).toBe(true)
    expect(deleteNameMatches('期', '期a')).toBe(false)
    expect(deleteNameMatches('', '')).toBe(false)
  })
})
