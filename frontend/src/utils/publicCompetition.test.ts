import { describe, expect, it } from 'vitest'
import { PublicHttpError } from '../api/publicCompetition'
import type { PublicCompetition, PublicCompetitionRow } from '../api/types'
import { classifyPublicError, publicCta, publicLadderRows, shouldSendView } from './publicCompetition'

const NOW = Date.parse('2026-10-10T00:00:00Z')
const iso = (ms: number) => new Date(ms).toISOString()
const DAY = 86_400_000

type CtaInput = Parameters<typeof publicCta>[0]
const base = (over: Partial<CtaInput> = {}): CtaInput => ({
  id: 'self',
  status: 'upcoming',
  enrollment: 'signup',
  regOpensAt: iso(NOW - DAY),
  regClosesAt: iso(NOW + DAY),
  nextCompetitionId: null,
  ...over,
})

describe('publicCta', () => {
  it('open window → join (upcoming or running)', () => {
    expect(publicCta(base(), NOW)).toEqual({ kind: 'join' })
    expect(publicCta(base({ status: 'running' }), NOW)).toEqual({ kind: 'join' })
  })
  it('window not open yet → notOpen with the opening time', () => {
    const opens = iso(NOW + DAY)
    expect(publicCta(base({ regOpensAt: opens, regClosesAt: iso(NOW + 2 * DAY) }), NOW)).toEqual({ kind: 'notOpen', opensAt: opens })
  })
  it('window closed while running → closed, no next', () => {
    expect(publicCta(base({ status: 'running', regClosesAt: iso(NOW - 1) }), NOW)).toEqual({ kind: 'closed', reason: 'closed', next: null })
  })
  it('ended / settled → ended with the next competition (never itself)', () => {
    expect(publicCta(base({ status: 'ended', nextCompetitionId: 'n1' }), NOW)).toEqual({ kind: 'closed', reason: 'ended', next: 'n1' })
    expect(publicCta(base({ status: 'settled', nextCompetitionId: 'self' }), NOW)).toEqual({ kind: 'closed', reason: 'ended', next: null })
  })
  it('non-signup enrollment never offers joining', () => {
    expect(publicCta(base({ enrollment: 'auto' }), NOW)).toEqual({ kind: 'closed', reason: 'closed', next: null })
  })
})

describe('classifyPublicError', () => {
  it('only a 404 means not found; everything else keeps data and retries', () => {
    expect(classifyPublicError(new PublicHttpError(404))).toBe('notFound')
    expect(classifyPublicError(new PublicHttpError(429))).toBe('retry')
    expect(classifyPublicError(new PublicHttpError(503))).toBe('retry')
    expect(classifyPublicError(new TypeError('Failed to fetch'))).toBe('retry')
    expect(classifyPublicError(undefined)).toBe('retry')
  })
})

describe('publicLadderRows', () => {
  const row = (over: Partial<PublicCompetitionRow>): PublicCompetitionRow => ({
    rank: 1, displayName: 'Alice', score: 0.12, sample: 7, equippedBadge: 'arena', equippedBadgeTier: 2, ...over,
  })
  const label = (n: number) => `${n} closed`
  it('anonymous rows show the anon label and never a badge', () => {
    const [a, b] = publicLadderRows([row({ displayName: null }), row({ rank: 2, displayName: '   ' })], 'Anon', label)
    expect(a).toMatchObject({ name: 'Anon', badgeId: null, badgeTier: 0, sub: '7 closed', isSelf: false })
    expect(b.name).toBe('Anon')
  })
  it('named rows keep name, badge, score and unique keys', () => {
    const rows = publicLadderRows([row({}), row({ rank: 1, displayName: 'Bob' })], 'Anon', label)
    expect(rows[0]).toMatchObject({ rank: 1, name: 'Alice', badgeId: 'arena', badgeTier: 2, score: 0.12 })
    expect(new Set(rows.map((r) => r.key)).size).toBe(2)
  })
})

describe('shouldSendView', () => {
  it('fires once per competition per session store', () => {
    const m = new Map<string, string>()
    const read = (k: string) => m.get(k) ?? null
    const write = (k: string, v: string) => m.set(k, v)
    expect(shouldSendView('c1', read, write)).toBe(true)
    expect(shouldSendView('c1', read, write)).toBe(false)
    expect(shouldSendView('c2', read, write)).toBe(true)
  })
})

// 类型层面：公开载荷可以直接喂给站内的时钟/状态组件（结构兼容）。
// Type-level: the public payload is structurally usable where the in-app summary helpers expect one.
export const _typecheck = (p: PublicCompetition) => publicCta(p, NOW)
