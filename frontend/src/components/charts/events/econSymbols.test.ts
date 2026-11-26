import { describe, expect, it } from 'vitest'
import { currenciesForSymbol, currencyOf } from './econSymbols'

describe('currenciesForSymbol', () => {
  it('forex pairs give both legs, CNH as CNY', () => {
    expect(currenciesForSymbol('EURUSD')).toEqual(['EUR', 'USD'])
    expect(currenciesForSymbol('USDJPY')).toEqual(['USD', 'JPY'])
    expect(currenciesForSymbol('USDCNH')).toEqual(['USD', 'CNY'])
    expect(currenciesForSymbol('EURGBP.m')).toEqual(['EUR', 'GBP'])
    expect(currenciesForSymbol('AUDUSDc')).toEqual(['AUD', 'USD'])
  })
  it('metals, energy, dollar index and crypto map to USD', () => {
    for (const s of ['XAUUSD', 'XAGUSD', 'USOIL', 'WTI', 'UKOIL', 'XNGUSD', 'USDX', 'BTCUSD', 'ETHUSD', 'SOLUSD']) {
      expect(currenciesForSymbol(s)).toEqual(['USD'])
    }
    expect(currenciesForSymbol('XAUEUR')).toEqual(['USD', 'EUR'])
  })
  it('indices map to their market currency', () => {
    expect(currenciesForSymbol('US30')).toEqual(['USD'])
    expect(currenciesForSymbol('US500')).toEqual(['USD'])
    expect(currenciesForSymbol('NAS100')).toEqual(['USD'])
    expect(currenciesForSymbol('GER40')).toEqual(['EUR'])
    expect(currenciesForSymbol('UK100')).toEqual(['GBP'])
    expect(currenciesForSymbol('JP225')).toEqual(['JPY'])
    expect(currenciesForSymbol('HK50')).toEqual(['HKD', 'CNY'])
    expect(currenciesForSymbol('CN50')).toEqual(['CNY'])
    expect(currenciesForSymbol('AUS200')).toEqual(['AUD'])
  })
  it('unknown symbols fall back to USD', () => {
    expect(currenciesForSymbol('FOOBAR1')).toEqual(['USD'])
    expect(currenciesForSymbol('')).toEqual(['USD'])
  })
})

describe('currencyOf', () => {
  it('uses the currency, else the country', () => {
    expect(currencyOf({ currency: 'usd', country: 'US' })).toBe('USD')
    expect(currencyOf({ currency: 'CNH', country: 'CN' })).toBe('CNY')
    expect(currencyOf({ currency: null, country: 'DE' })).toBe('EUR')
    expect(currencyOf({ currency: null, country: 'GB' })).toBe('GBP')
  })
})
