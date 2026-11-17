// 显示用的品种名不带券商后缀（2026-11-16 体验报告 L5）：持仓、平仓 / 改单记录带着 MT5 的
// 名字（XAUUSD.s），图表和开仓记录用的是不带后缀的，同一笔交易前后两个叫法。
// Display names carry no broker suffix: positions and close / modify records hold MT5's
// name (XAUUSD.s) while the chart and open records use the bare one.
import { describe, expect, it } from 'vitest'
import { baseSymbol, displaySymbol } from './utils'
import { DEFAULT_SYMBOL_META, SYMBOL_META, symbolMeta } from '../utils/symbolMeta'

describe('displaySymbol', () => {
  it('去掉券商后缀 / drops the broker suffix', () => {
    expect(displaySymbol('XAUUSD.s')).toBe('XAUUSD')
    expect(displaySymbol('XAUUSD.p')).toBe('XAUUSD')
    expect(displaySymbol('EURUSD_r')).toBe('EURUSD')
    expect(displaySymbol('US30-cash')).toBe('US30')
    expect(displaySymbol(' XAUUSD.s ')).toBe('XAUUSD')
  })

  it('没有后缀的原样返回 / bare names are unchanged', () => {
    for (const s of ['XAUUSD', 'EURUSD', 'USOIL', 'ETHUSDT', 'WTI']) expect(displaySymbol(s)).toBe(s)
  })

  it('比特币带不带后缀都显示成 BTCUSDT / bitcoin reads BTCUSDT either way', () => {
    expect(displaySymbol('BTCUSD')).toBe('BTCUSDT')
    expect(displaySymbol('BTCUSD.s')).toBe('BTCUSDT')
    expect(displaySymbol('BTCUSDT')).toBe('BTCUSDT')
  })

  it('只去后缀、不改名：信号页按这个值筛选和去重 / suffix only, no renames', () => {
    // baseSymbol 会把 USOIL 归一成 WTI、ETHUSDT 归一成 ETHUSD；显示名不能跟着变。
    expect(baseSymbol('USOIL.s')).toBe('WTI')
    expect(displaySymbol('USOIL.s')).toBe('USOIL')
    expect(displaySymbol('ETHUSDT')).toBe('ETHUSDT')
  })

  it('以分隔符开头、或粘在一起的后缀不动 / leading separators and glued suffixes are left alone', () => {
    expect(displaySymbol('#AAPL')).toBe('#AAPL')
    expect(displaySymbol('XAUUSDm')).toBe('XAUUSDm')
    expect(displaySymbol('UKOil')).toBe('UKOil')
  })
})

describe('symbolMeta', () => {
  it('带后缀的品种拿到和不带后缀一样的色块 / a suffixed name gets the same chip', () => {
    expect(symbolMeta('XAUUSD.s')).toBe(SYMBOL_META.XAUUSD)
    expect(symbolMeta('xauusd.s')).toBe(SYMBOL_META.XAUUSD)
    expect(symbolMeta('BTCUSD.s')).toBe(SYMBOL_META.BTCUSD)
    expect(symbolMeta('XAUUSD')).toBe(SYMBOL_META.XAUUSD)
  })

  it('不认识的品种取去后缀后的前三位，中性色 / unknown symbols: first three letters, neutral', () => {
    expect(symbolMeta('NZDCAD.s')).toEqual({ letter: 'NZD', ...DEFAULT_SYMBOL_META })
    expect(symbolMeta('#AAPL')).toEqual({ letter: '#AA', ...DEFAULT_SYMBOL_META })
    expect(symbolMeta('')).toEqual({ letter: '?', ...DEFAULT_SYMBOL_META })
  })
})
