import { describe, expect, it } from 'vitest'
import { ticketSerial } from './TicketWallet'

describe('ticketSerial', () => {
  it('prints the issue day, month and 1-based batch position', () => {
    expect(ticketSerial('2026-10-22T12:00:00', 0)).toBe('№ 2210·01')
    expect(ticketSerial('2026-03-05T12:00:00', 11)).toBe('№ 0503·12')
  })

  it('reads the backend zoneless UTC time in Beijing time, like the date line', () => {
    // 17:30 UTC on the 21st is 01:30 on the 22nd in Beijing
    expect(ticketSerial('2026-10-21T17:30:00.123456', 0)).toBe('№ 2210·01')
  })

  it('falls back to zeros for an unreadable date', () => {
    expect(ticketSerial('not a date', 2)).toBe('№ 0000·03')
  })
})
