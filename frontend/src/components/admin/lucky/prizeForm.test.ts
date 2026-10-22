import { describe, expect, it } from 'vitest'
import type { LuckyPrizeAdmin } from '../../../api/luckyTypes'
import { autoColor, blankRow, fromAdmin, problems, toInput, totalPct, totalQty } from './prizeForm'

const ok = (kind: Parameters<typeof blankRow>[0], p: Record<string, unknown> = {}) => ({ ...blankRow(kind), name: 'x', ...p })

describe('prizeForm · 按概率 prob', () => {
  it('sums to 100 with two decimals', () => {
    const rows = [{ ...blankRow('pro_days'), name: 'A', probPct: '10.55', proDays: '7' },
                  { ...blankRow('none'), name: '谢谢', probPct: '89.45' }]
    expect(totalPct(rows)).toBe(100)
    expect(problems(rows, 'prob')).toEqual([])
    expect(toInput(rows, 'prob')[0]).toMatchObject({ kind: 'pro_days', proDays: 7, probPct: 10.55, stock: null })
  })
  it('flags a bad total, days and claim mode', () => {
    const rows = [{ ...blankRow('custom'), name: 'W', probPct: '50', stock: '1' },
                  { ...blankRow('pro_days'), name: 'P', probPct: '40' }]
    expect(problems(rows, 'prob')).toEqual(expect.arrayContaining(
      ['admin.lucky.err.total', 'admin.lucky.err.days', 'admin.lucky.err.claimMode']))
  })
  it('no longer needs a thanks-for-playing slot, and a none slot may carry a cap', () => {
    // v2 去掉了「必须有谢谢参与格」和「谢谢参与不能设库存」/ v2 dropped both v1 rules
    expect(problems([ok('custom', { probPct: '50', stock: '1', claimMode: 'form' }), ok('retry', { probPct: '50' })], 'prob')).toEqual([])
    expect(problems([ok('none', { probPct: '50', stock: '3' }), ok('retry', { probPct: '50' })], 'prob')).toEqual([])
  })
  it('does not lose a cent to float error: 33.33 + 33.33 + 33.34 = 100', () => {
    const rows = [ok('none', { probPct: '33.33' }), ok('retry', { probPct: '33.33' }), ok('retry', { probPct: '33.34' })]
    expect(totalPct(rows)).toBe(100)
    expect(problems(rows, 'prob')).toEqual([])
    expect(toInput(rows, 'prob').map((r) => r.probPct)).toEqual([33.33, 33.33, 33.34])
  })
  it('treats the stock cap as optional: blank = unlimited, else an integer >= 0', () => {
    const none = ok('none', { probPct: '50' })
    for (const bad of ['abc', '1.5', '-1', '1e2']) {
      expect(problems([ok('retry', { probPct: '50', stock: bad }), none], 'prob')).toContain('admin.lucky.err.capNumber')
    }
    expect(problems([ok('retry', { probPct: '50', stock: '0' }), none], 'prob')).toEqual([])
    expect(problems([ok('retry', { probPct: '50', stock: '  ' }), none], 'prob')).toEqual([])
    expect(toInput([ok('retry', { stock: '  ' })], 'prob')[0]).toMatchObject({ stock: null })
  })
  it('flags a cap below what was already given out', () => {
    const rows = [ok('retry', { probPct: '50', stock: '1', stockUsed: 2 }), ok('none', { probPct: '50' })]
    expect(problems(rows, 'prob')).toContain('admin.lucky.err.stockBelowUsed')
  })
  it('rejects a negative / over-100 / over-precise per-slot probability', () => {
    const rest = ok('none', { probPct: '100' })
    expect(problems([ok('retry', { probPct: '-5' }), rest], 'prob')).toContain('admin.lucky.err.prob')
    expect(problems([ok('retry', { probPct: '101' }), rest], 'prob')).toContain('admin.lucky.err.prob')
    expect(problems([ok('retry', { probPct: 'abc' }), rest], 'prob')).toContain('admin.lucky.err.prob')
    expect(problems([ok('retry', { probPct: '10.123' }), ok('none', { probPct: '89.877' })], 'prob')).toContain('admin.lucky.err.decimals')
    expect(problems([ok('retry', { probPct: '10.12' }), ok('none', { probPct: '89.88' })], 'prob')).toEqual([])
  })
})

describe('prizeForm · 按份量 qty', () => {
  it('needs a stock on every slot and ignores the odds', () => {
    const rows = [ok('pro_days', { proDays: '7', stock: '5', probPct: '12' }), ok('none', { stock: '95', probPct: '' })]
    expect(problems(rows, 'qty')).toEqual([])
    expect(totalQty(rows)).toBe(100)
    expect(toInput(rows, 'qty').map((r) => [r.stock, r.probPct])).toEqual([[5, 0], [95, 0]])
  })
  it('flags a missing or malformed stock', () => {
    expect(problems([ok('retry', { stock: '' }), ok('none', { stock: '3' })], 'qty')).toContain('admin.lucky.err.stockRequired')
    expect(problems([ok('retry', { stock: '  ' }), ok('none', { stock: '3' })], 'qty')).toContain('admin.lucky.err.stockRequired')
    for (const bad of ['abc', '1.5', '-1', '1e2']) {
      expect(problems([ok('retry', { stock: bad }), ok('none', { stock: '3' })], 'qty')).toContain('admin.lucky.err.stockNumber')
    }
  })
  it('allows a slot with 0 left but not an all-zero wheel', () => {
    expect(problems([ok('retry', { stock: '0' }), ok('none', { stock: '3' })], 'qty')).toEqual([])
    expect(problems([ok('retry', { stock: '0' }), ok('none', { stock: '0' })], 'qty')).toEqual(['admin.lucky.err.qtyTotal'])
  })
  it('does not check the odds total in qty mode', () => {
    const rows = [ok('retry', { stock: '1', probPct: '3' }), ok('none', { stock: '1', probPct: '3' })]
    expect(problems(rows, 'qty')).toEqual([])
    expect(problems(rows, 'prob')).toContain('admin.lucky.err.total')
  })
  it('flags stock below what was already given out', () => {
    const rows = [ok('retry', { stock: '1', stockUsed: 2 }), ok('none', { stock: '5' })]
    expect(problems(rows, 'qty')).toContain('admin.lucky.err.stockBelowUsed')
  })
})

describe('prizeForm · shared', () => {
  it('round-trips fromAdmin -> toInput and keeps the id', () => {
    const p: LuckyPrizeAdmin = {
      id: 'p1', name: ' Gift ', description: 'd', imageUrl: 'https://x/y.png', color: '#112233', kind: 'custom',
      proDays: null, probBp: 1055, stock: 5, stockUsed: 2, claimMode: 'form', claimHint: ' hint ',
    }
    expect(toInput([fromAdmin(p)], 'prob')[0]).toEqual({
      id: 'p1', name: 'Gift', description: 'd', imageUrl: 'https://x/y.png', color: '#112233', kind: 'custom',
      proDays: null, probPct: 10.55, stock: 5, claimMode: 'form', claimHint: 'hint',
    })
    expect(toInput([blankRow('none')], 'qty')[0]).not.toHaveProperty('id')
  })
  it('nulls fields that do not belong to the kind', () => {
    const stale = { proDays: '9', claimMode: 'form' as const, claimHint: 'h', color: 'not-a-color' }
    const [none, retry, pro, custom] = toInput([ok('none', stale), ok('retry', stale), ok('pro_days', stale), ok('custom', stale)], 'prob')
    for (const r of [none, retry]) expect(r).toMatchObject({ proDays: null, claimMode: null, claimHint: null, color: null })
    expect(pro).toMatchObject({ proDays: 9, claimMode: null, claimHint: null })
    expect(custom).toMatchObject({ proDays: null, claimMode: 'form', claimHint: 'h' })
  })
  it('checks slot count, names and fractional PRO days in both modes', () => {
    for (const mode of ['qty', 'prob'] as const) {
      expect(problems([ok('none', { probPct: '100', stock: '1' })], mode)).toContain('admin.lucky.err.slots')
      expect(problems([ok('none', { name: ' ', probPct: '50', stock: '1' }), ok('none', { probPct: '50', stock: '1' })], mode)).toContain('admin.lucky.err.name')
      expect(problems([ok('pro_days', { probPct: '50', proDays: '7.5', stock: '1' }), ok('none', { probPct: '50', stock: '1' })], mode)).toContain('admin.lucky.err.days')
    }
  })
  it('auto colour follows the wheel palette and wraps', () => {
    expect(autoColor(0)).toBe('#7c5cff')
    expect(autoColor(8)).toBe(autoColor(0))
  })
})
