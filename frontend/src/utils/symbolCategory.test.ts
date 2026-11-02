import { describe, expect, it } from 'vitest'
import { symbolCategory } from './symbolCategory'

describe('symbolCategory', () => {
  it('classifies the symbols the EA pushes today', () => {
    expect(symbolCategory('XAUUSD')).toBe('commodity')
    expect(symbolCategory('XAGUSD')).toBe('commodity')
    expect(symbolCategory('WTI')).toBe('commodity')
    expect(symbolCategory('EURUSD')).toBe('forex')
    expect(symbolCategory('GBPUSD')).toBe('forex')
    expect(symbolCategory('USDJPY')).toBe('forex')
    expect(symbolCategory('BTCUSDT')).toBe('crypto')
    expect(symbolCategory('ETHUSD')).toBe('crypto')
    expect(symbolCategory('US500')).toBe('index')
  })

  it('strips broker suffixes', () => {
    expect(symbolCategory('XAUUSD.m')).toBe('commodity')
    expect(symbolCategory('EURUSDc')).toBe('forex')
    expect(symbolCategory('US500.cash')).toBe('index')
    expect(symbolCategory('BTCUSD#')).toBe('crypto')
  })

  it('covers common additions', () => {
    for (const s of ['NAS100', 'US30', 'GER40', 'JP225', 'HK50', 'UK100']) expect(symbolCategory(s)).toBe('index')
    for (const s of ['UKOIL', 'XNGUSD', 'XPTUSD', 'COPPER']) expect(symbolCategory(s)).toBe('commodity')
    for (const s of ['AUDCAD', 'NZDJPY', 'USDCNH', 'EURGBP', 'TRYJPY']) expect(symbolCategory(s)).toBe('forex')
    for (const s of ['SOLUSD', 'XRPUSDT', 'DOGEUSD']) expect(symbolCategory(s)).toBe('crypto')
  })

  it('leaves unknown codes as other', () => {
    expect(symbolCategory('AAPL')).toBe('other')
    expect(symbolCategory('ABCDEF')).toBe('other')
    expect(symbolCategory('')).toBe('other')
  })
})
