import { describe, expect, it } from 'vitest'
import { countdownParts, fmtWindow } from './luckyCountdown'

describe('countdownParts', () => {
  const now = Date.UTC(2026, 9, 22, 0, 0, 0)

  it('reads a naive backend datetime as UTC, not local time', () => {
    // 2 天 3 小时 4 分 5 秒之后，且字符串不带 Z
    const c = countdownParts('2026-10-24T03:04:05', now)
    expect(c).toEqual({ d: 2, h: 3, m: 4, s: 5, done: false })
  })

  it('accepts an explicit timezone suffix too', () => {
    expect(countdownParts('2026-10-22T00:00:10Z', now)).toEqual({ d: 0, h: 0, m: 0, s: 10, done: false })
  })

  it('clamps to zero once the time has passed', () => {
    expect(countdownParts('2026-10-21T23:59:59', now)).toEqual({ d: 0, h: 0, m: 0, s: 0, done: true })
  })

  it('returns null for missing or invalid input', () => {
    expect(countdownParts(undefined, now)).toBeNull()
    expect(countdownParts(null, now)).toBeNull()
    expect(countdownParts('not-a-date', now)).toBeNull()
  })
})

describe('fmtWindow', () => {
  it('shows both ends in UTC+8, day first, without seconds', () => {
    expect(fmtWindow('2026-10-21T07:00:00', '2026-10-29T07:30:00Z')).toBe('21/10 15:00 ～ 29/10 15:30 UTC+8')
  })

  it('rolls past midnight into the next UTC+8 day as 00:00', () => {
    expect(fmtWindow('2026-10-21T16:00:00Z', '2026-10-21T16:05:00Z')).toBe('22/10 00:00 ～ 22/10 00:05 UTC+8')
  })

  it('shows a dash for a missing or broken end', () => {
    expect(fmtWindow(null, 'nope')).toBe('- ～ - UTC+8')
  })
})
