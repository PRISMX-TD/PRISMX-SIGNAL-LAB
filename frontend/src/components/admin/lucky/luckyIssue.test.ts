import { describe, expect, it } from 'vitest'
import { clampCount, limitProblem, merge, periodValid, tierProblem, totals } from './luckyIssue'
import type { LuckyIssueRow } from '../../../api/luckyTypes'

const row = (userId: string, count: number, source: LuckyIssueRow['source'] = 'manual'): LuckyIssueRow =>
  ({ userId, email: `${userId}@t.co`, nickname: null, rank: null, count, source, sourceRef: null, label: '' })

describe('luckyIssue.merge', () => {
  it('appends new people', () => {
    expect(merge([], [row('a', 1), row('b', 2)], 'sum').map((x) => x.userId)).toEqual(['a', 'b'])
  })
  it('sums or keeps the max for duplicates and flags them', () => {
    const base = merge([], [row('a', 3, 'comp_rank')], 'sum')
    expect(merge(base, [row('a', 2)], 'sum')[0]).toMatchObject({ count: 5, dup: true })
    expect(merge(base, [row('a', 2)], 'once')[0]).toMatchObject({ count: 3, dup: true })
    expect(merge(base, [row('a', 7)], 'once')[0]).toMatchObject({ count: 7, dup: true })
  })
  it('caps a person at 100 and totals the list', () => {
    const l = merge(merge([], [row('a', 90)], 'sum'), [row('a', 30), row('b', 1)], 'sum')
    expect(l[0].count).toBe(100)
    expect(totals(l)).toEqual({ users: 2, tickets: 101 })
  })
  it('keeps the original source when the existing line wins or sums', () => {
    const base = merge([], [row('a', 3, 'comp_rank')], 'sum')
    expect(merge(base, [row('a', 2)], 'sum')[0].source).toBe('comp_rank')
    expect(merge(base, [row('a', 2)], 'once')[0].source).toBe('comp_rank')
    expect(merge(base, [row('a', 7)], 'once')[0].source).toBe('manual')
  })
  it('does not mutate the input list and merges repeats inside one batch', () => {
    const base = merge([], [row('a', 1)], 'sum')
    const out = merge(base, [row('a', 1), row('a', 1)], 'sum')
    expect(base[0]).toMatchObject({ count: 1, dup: false })
    expect(out[0]).toMatchObject({ count: 3, dup: true })
  })
  it('caps a fresh row that arrives above 100', () => {
    expect(merge([], [row('a', 500)], 'sum')[0].count).toBe(100)
  })
})

describe('luckyIssue.limitProblem', () => {
  const line = (id: string, count: number) => merge([], [row(id, count)], 'sum')[0]
  it('passes at the exact limits and flags the first one crossed', () => {
    expect(limitProblem([line('a', 100)])).toBeNull()
    const many = Array.from({ length: 2001 }, (_, i) => line(`u${i}`, 1))
    expect(limitProblem(many)).toBe('users')
    expect(limitProblem(many.slice(0, 2000))).toBeNull()
    const heavy = Array.from({ length: 201 }, (_, i) => line(`u${i}`, 100))
    expect(limitProblem(heavy)).toBe('tickets')
    expect(limitProblem(heavy.slice(0, 200))).toBeNull()
  })
})

describe('luckyIssue.tierProblem', () => {
  it('accepts ordered, non-overlapping tiers in any entry order', () => {
    expect(tierProblem([{ fromRank: 4, toRank: 10, count: 1 }, { fromRank: 1, toRank: 3, count: 5 }])).toBeNull()
  })
  it('flags a reversed range and an overlap (backend 400 rules)', () => {
    expect(tierProblem([{ fromRank: 5, toRank: 2, count: 1 }])).toBe('reversed')
    expect(tierProblem([{ fromRank: 1, toRank: 5, count: 1 }, { fromRank: 5, toRank: 9, count: 1 }])).toBe('overlap')
  })
})

describe('luckyIssue helpers', () => {
  it('clamps typed counts into the allowed range', () => {
    expect(clampCount(0)).toBe(1)
    expect(clampCount(250)).toBe(100)
    expect(clampCount(7.9)).toBe(7)
    expect(clampCount(Number.NaN)).toBe(1)
    expect(clampCount(5000, 1000)).toBe(1000)
  })
  it('accepts only real period keys', () => {
    expect(['week', 'month', '2026-10', '2026-W42'].every(periodValid)).toBe(true)
    expect(['', '2026', '2026-1', '2026-W4', 'abc'].some(periodValid)).toBe(false)
  })
})
