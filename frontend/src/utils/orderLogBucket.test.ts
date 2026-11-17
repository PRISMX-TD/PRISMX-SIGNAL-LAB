import { describe, expect, it } from 'vitest'
import { orderLogBucket, visibleStatusFilters } from './orderLogBucket'

describe('orderLogBucket', () => {
  it('puts a successful pending-order cancel under Cancelled, where its slip stamp says it is', () => {
    expect(orderLogBucket({ status: 'FILLED', action: 'CANCEL_PENDING' })).toBe('CANCELLED')
  })

  it('keeps every other row on its stored status', () => {
    expect(orderLogBucket({ status: 'FILLED', action: 'ORDER' })).toBe('FILLED')
    expect(orderLogBucket({ status: 'FILLED', action: 'CLOSE' })).toBe('FILLED')
    expect(orderLogBucket({ status: 'PLACED', action: 'PENDING' })).toBe('PLACED')
    expect(orderLogBucket({ status: 'REJECTED', action: 'CANCEL_PENDING' })).toBe('REJECTED')
    expect(orderLogBucket({ status: 'CANCELLED', action: 'ORDER' })).toBe('CANCELLED')
  })

  it('every row lands in exactly one chip, so the chip counts add up to All', () => {
    const rows = [
      { status: 'FILLED', action: 'ORDER' },
      { status: 'FILLED', action: 'CANCEL_PENDING' },
      { status: 'PLACED', action: 'PENDING' },
      { status: 'REJECTED', action: 'ORDER' },
      { status: 'PENDING', action: 'CLOSE' },
    ] as const
    const counts: Record<string, number> = {}
    for (const r of rows) counts[orderLogBucket(r)] = (counts[orderLogBucket(r)] ?? 0) + 1
    const chips = visibleStatusFilters(counts, 'ALL').filter((s) => s !== 'ALL')
    expect(chips.reduce((n, s) => n + (counts[s] ?? 0), 0)).toBe(rows.length)
  })
})

describe('visibleStatusFilters', () => {
  it('hides the Placed chip when there is nothing placed', () => {
    expect(visibleStatusFilters({ ALL: 3, FILLED: 3 }, 'ALL')).not.toContain('PLACED')
    expect(visibleStatusFilters(null, 'ALL')).not.toContain('PLACED')
  })

  it('shows it when there are placed rows, or while it is selected', () => {
    expect(visibleStatusFilters({ ALL: 1, PLACED: 1 }, 'ALL')).toContain('PLACED')
    expect(visibleStatusFilters({ ALL: 0 }, 'PLACED')).toContain('PLACED')
  })
})
