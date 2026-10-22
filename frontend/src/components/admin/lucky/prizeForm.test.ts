import { describe, expect, it } from 'vitest'
import type { LuckyPrizeAdmin } from '../../../api/luckyTypes'
import { autoColor, blankRow, fromAdmin, problems, toInput, totalPct } from './prizeForm'

const ok = (kind: Parameters<typeof blankRow>[0], p: Record<string, unknown> = {}) => ({ ...blankRow(kind), name: 'x', ...p })

describe('prizeForm', () => {
  it('sums to 100 with two decimals', () => {
    const rows = [{ ...blankRow('pro_days'), name: 'A', probPct: '10.55', proDays: '7' },
                  { ...blankRow('none'), name: '谢谢', probPct: '89.45' }]
    expect(totalPct(rows)).toBe(100)
    expect(problems(rows)).toEqual([])
    expect(toInput(rows)[0]).toMatchObject({ kind: 'pro_days', proDays: 7, probPct: 10.55, stock: null })
  })
  it('flags missing fallback, days and claim mode', () => {
    const rows = [{ ...blankRow('custom'), name: 'W', probPct: '50', stock: '1' },
                  { ...blankRow('pro_days'), name: 'P', probPct: '40' }]
    expect(problems(rows)).toEqual(expect.arrayContaining(
      ['admin.lucky.err.total', 'admin.lucky.err.days', 'admin.lucky.err.claimMode', 'admin.lucky.err.fallback']))
  })
  it('does not lose a cent to float error: 33.33 + 33.33 + 33.34 = 100', () => {
    const rows = [ok('none', { probPct: '33.33' }), ok('retry', { probPct: '33.33' }), ok('retry', { probPct: '33.34' })]
    expect(totalPct(rows)).toBe(100)
    expect(problems(rows)).toEqual([])
    expect(toInput(rows).map((r) => r.probPct)).toEqual([33.33, 33.33, 33.34])
  })
  it('round-trips fromAdmin -> toInput and keeps the id', () => {
    const p: LuckyPrizeAdmin = {
      id: 'p1', name: ' Gift ', description: 'd', imageUrl: 'https://x/y.png', color: '#112233', kind: 'custom',
      proDays: null, probBp: 1055, stock: 5, stockUsed: 2, perUserLimit: 1, onSoldOut: 'redistribute',
      claimMode: 'form', claimHint: ' hint ',
    }
    expect(toInput([fromAdmin(p)])[0]).toEqual({
      id: 'p1', name: 'Gift', description: 'd', imageUrl: 'https://x/y.png', color: '#112233', kind: 'custom',
      proDays: null, probPct: 10.55, stock: 5, perUserLimit: 1, onSoldOut: 'redistribute', claimMode: 'form', claimHint: 'hint',
    })
    expect(toInput([blankRow('none')])[0]).not.toHaveProperty('id')
  })
  it('nulls fields that do not belong to the kind', () => {
    const stale = { proDays: '9', claimMode: 'form' as const, claimHint: 'h', color: 'not-a-color' }
    const [none, retry, pro, custom] = toInput([ok('none', stale), ok('retry', stale), ok('pro_days', stale), ok('custom', stale)])
    for (const r of [none, retry]) expect(r).toMatchObject({ proDays: null, claimMode: null, claimHint: null, color: null })
    expect(pro).toMatchObject({ proDays: 9, claimMode: null, claimHint: null })
    expect(custom).toMatchObject({ proDays: null, claimMode: 'form', claimHint: 'h' })
  })
  it('flags limits on a none slot', () => {
    const base = [ok('retry', { probPct: '50' })]
    expect(problems([...base, ok('none', { probPct: '50', stock: '3' })])).toContain('admin.lucky.err.noneLimited')
    expect(problems([...base, ok('none', { probPct: '50', perUserLimit: '1' })])).toContain('admin.lucky.err.noneLimited')
    expect(problems([...base, ok('none', { probPct: '50', stock: '   ' })])).toEqual([])
  })
  it('flags stock below what was already given out', () => {
    const rows = [ok('retry', { probPct: '50', stock: '1', stockUsed: 2, onSoldOut: 'redistribute' }), ok('none', { probPct: '50' })]
    expect(problems(rows)).toContain('admin.lucky.err.stockBelowUsed')
  })
  it('rejects garbage stock / cap instead of silently making the prize unlimited', () => {
    const none = ok('none', { probPct: '50' })
    for (const bad of ['abc', '1.5', '-1', '1e2']) {
      expect(problems([ok('retry', { probPct: '50', stock: bad }), none])).toContain('admin.lucky.err.number')
    }
    for (const bad of ['abc', '0', '-2', '2.5']) {
      expect(problems([ok('retry', { probPct: '50', perUserLimit: bad }), none])).toContain('admin.lucky.err.number')
    }
    // stock 0 is a valid "sold out", cap 0 is not; whitespace counts as empty, i.e. unlimited
    expect(problems([ok('retry', { probPct: '50', stock: '0' }), none])).not.toContain('admin.lucky.err.number')
    expect(problems([ok('retry', { probPct: '50', stock: '  ', perUserLimit: ' ' }), none])).toEqual([])
    expect(toInput([ok('retry', { stock: '  ', perUserLimit: ' ' })])[0]).toMatchObject({ stock: null, perUserLimit: null })
  })
  it('rejects a negative / over-100 / over-precise per-slot probability', () => {
    const rest = ok('none', { probPct: '100' })
    expect(problems([ok('retry', { probPct: '-5' }), rest])).toContain('admin.lucky.err.prob')
    expect(problems([ok('retry', { probPct: '101' }), rest])).toContain('admin.lucky.err.prob')
    expect(problems([ok('retry', { probPct: 'abc' }), rest])).toContain('admin.lucky.err.prob')
    expect(problems([ok('retry', { probPct: '10.123' }), ok('none', { probPct: '89.877' })])).toContain('admin.lucky.err.decimals')
    expect(problems([ok('retry', { probPct: '10.12' }), ok('none', { probPct: '89.88' })])).toEqual([])
  })
  it('rejects fractional PRO days', () => {
    const rows = [ok('pro_days', { probPct: '50', proDays: '7.5' }), ok('none', { probPct: '50' })]
    expect(problems(rows)).toContain('admin.lucky.err.days')
  })
  it('auto colour follows the wheel palette and wraps', () => {
    expect(autoColor(0)).toBe('#7c5cff')
    expect(autoColor(8)).toBe(autoColor(0))
  })
})
