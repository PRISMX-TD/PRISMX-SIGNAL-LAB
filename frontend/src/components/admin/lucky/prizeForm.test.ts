import { describe, expect, it } from 'vitest'
import { blankRow, problems, toInput, totalPct } from './prizeForm'

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
})
