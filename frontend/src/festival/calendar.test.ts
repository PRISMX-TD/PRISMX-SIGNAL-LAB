import { describe, expect, it } from 'vitest'
import { detect, newYearNumber, nextWindow, parseYmd, windowId, windowsStartingIn } from './calendar'

const at = (s: string) => parseYmd(s) as Date

describe('festival calendar', () => {
  it('matches Mid-Autumn from three days before to one day after', () => {
    expect(detect(at('2026-09-21'))).toBeNull()
    expect(detect(at('2026-09-22'))?.key).toBe('midautumn')
    expect(detect(at('2026-09-26'))?.key).toBe('midautumn')
    expect(detect(at('2026-09-27'))).toBeNull()
  })

  it('opens Spring Festival the day before New Year’s Eve and closes after the Lantern Festival', () => {
    expect(detect(at('2027-02-03'))).toBeNull()
    expect(detect(at('2027-02-04'))?.key).toBe('spring')
    expect(detect(at('2027-02-20'))?.key).toBe('spring')
    expect(detect(at('2027-02-21'))).toBeNull()
  })

  it('covers Halloween and Christmas on fixed dates', () => {
    expect(detect(at('2026-10-31'))?.key).toBe('halloween')
    expect(detect(at('2026-11-01'))).toBeNull()
    expect(detect(at('2026-12-25'))?.key).toBe('christmas')
  })

  it('keeps New Year across the year boundary', () => {
    const eve = detect(at('2026-12-31'))
    const day = detect(at('2027-01-01'))
    expect(eve?.key).toBe('newyear')
    expect(day?.key).toBe('newyear')
    // 同一个窗口：1 月 1 日关掉的问候，与 12 月 31 日关掉的是同一条记录。
    // Same window, so a dismissal on 31 Dec still holds on 1 Jan.
    expect(windowId(eve!)).toBe(windowId(day!))
    expect(detect(at('2027-01-03'))).toBeNull()
  })

  it('shows the coming year in December and the current year in January', () => {
    expect(newYearNumber(at('2026-12-31'))).toBe(2027)
    expect(newYearNumber(at('2027-01-01'))).toBe(2027)
  })

  it('skips lunar festivals outside the table instead of failing', () => {
    const keys = windowsStartingIn(2031).map((w) => w.key)
    expect(keys).not.toContain('spring')
    expect(keys).not.toContain('midautumn')
    expect(keys).toContain('halloween')
  })

  it('finds the next window', () => {
    expect(nextWindow(at('2026-09-27'))?.key).toBe('halloween')
    expect(nextWindow(at('2026-12-31'))?.key).toBe('spring')
  })

  it('has no overlapping windows in any tabled year', () => {
    for (let y = 2026; y <= 2030; y++) {
      const ws = windowsStartingIn(y)
      for (let i = 1; i < ws.length; i++) expect(ws[i].start > ws[i - 1].end).toBe(true)
    }
  })
})
