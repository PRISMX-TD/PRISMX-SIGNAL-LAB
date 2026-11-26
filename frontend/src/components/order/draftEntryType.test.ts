import { describe, expect, it } from 'vitest'
import { draftEntryType } from './useOrderForm'
import { getTicketSizing, setTicketSizing, subscribeTicketSizing } from './ticketSizing'

// 多空仓位工具「下单」时按入场价选单型 / order type picked from a drawing's entry
describe('draftEntryType', () => {
  const bid = 4000, ask = 4000.3
  it('treats an entry near the market as a market order', () => {
    expect(draftEntryType(true, 4000.5, bid, ask)).toBe('MARKET')
    expect(draftEntryType(false, 3999.6, bid, ask)).toBe('MARKET')
  })
  it('buy below ask is a limit, above is a stop', () => {
    expect(draftEntryType(true, 3980, bid, ask)).toBe('LIMIT')
    expect(draftEntryType(true, 4020, bid, ask)).toBe('STOP')
  })
  it('sell above bid is a limit, below is a stop', () => {
    expect(draftEntryType(false, 4020, bid, ask)).toBe('LIMIT')
    expect(draftEntryType(false, 3980, bid, ask)).toBe('STOP')
  })
  it('falls back to market with no quote', () => {
    expect(draftEntryType(true, 3980, null, null)).toBe('MARKET')
  })
  it('uses the spread as the tolerance when it is wider', () => {
    expect(draftEntryType(true, 1.1012, 1.1, 1.1015)).toBe('MARKET')
    expect(draftEntryType(true, 1.0990, 1.1, 1.1015)).toBe('LIMIT')
  })
})

describe('ticketSizing store', () => {
  it('notifies on change and skips identical values', () => {
    let n = 0
    const off = subscribeTicketSizing(() => { n++ })
    setTicketSizing({ mode: 'lots', lots: 0.2 })
    setTicketSizing({ mode: 'lots', lots: 0.2 })
    setTicketSizing({ mode: 'risk', pct: 1, equity: 5000, lots: 0.1 })
    off()
    setTicketSizing({ mode: 'lots', lots: 0.3 })
    expect(n).toBe(2)
    expect(getTicketSizing()).toEqual({ mode: 'lots', lots: 0.3 })
  })
})
