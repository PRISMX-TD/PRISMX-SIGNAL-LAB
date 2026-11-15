import { describe, expect, it } from 'vitest'
import type { Quote } from '../../api/types'
import { SPARK_LEN, createWatchTicks } from './watchTicks'

const quote = (symbol: string, bid: number): Quote => ({ symbol, bid, ask: bid + 1 })

describe('createWatchTicks', () => {
  it('第一笔报价只记价、不上色 / the first quote records the price without a direction', () => {
    const book = createWatchTicks()
    book.ingest({ XAUUSD: quote('XAUUSD', 100) })
    expect(book.get('XAUUSD')).toEqual({ bid: 100, dir: null, hist: [100] })
  })

  it('跳价上色，只通知那个品种 / a tick colours the row and notifies only that symbol', () => {
    const book = createWatchTicks()
    const eur = quote('EURUSD', 1.1)
    book.ingest({ XAUUSD: quote('XAUUSD', 100), EURUSD: eur })
    let goldCalls = 0
    let eurCalls = 0
    book.subscribe('XAUUSD', () => { goldCalls += 1 })
    book.subscribe('EURUSD', () => { eurCalls += 1 })
    book.ingest({ XAUUSD: quote('XAUUSD', 101), EURUSD: eur })
    expect(book.get('XAUUSD').dir).toBe('up')
    expect(book.get('XAUUSD').hist).toEqual([100, 101])
    expect(goldCalls).toBe(1)
    expect(eurCalls).toBe(0)
  })

  it('下一帧没跳的品种颜色褪回，走势不变 / a symbol that did not tick next frame fades back', () => {
    const book = createWatchTicks()
    const eur = quote('EURUSD', 1.1)
    book.ingest({ XAUUSD: quote('XAUUSD', 100), EURUSD: eur })
    const gold2 = quote('XAUUSD', 99)
    book.ingest({ XAUUSD: gold2, EURUSD: eur })
    expect(book.get('XAUUSD').dir).toBe('down')
    const hist = book.get('XAUUSD').hist
    book.ingest({ XAUUSD: gold2, EURUSD: quote('EURUSD', 1.2) })
    expect(book.get('XAUUSD').dir).toBeNull()
    expect(book.get('XAUUSD').hist).toBe(hist)
  })

  it('同一张报价表重复喂入什么都不变 / re-ingesting the same map changes nothing', () => {
    const book = createWatchTicks()
    const quotes = { XAUUSD: quote('XAUUSD', 100) }
    book.ingest(quotes)
    const cell = book.get('XAUUSD')
    let calls = 0
    book.subscribe('XAUUSD', () => { calls += 1 })
    book.ingest(quotes)
    expect(book.get('XAUUSD')).toBe(cell)
    expect(calls).toBe(0)
  })

  it('走势最多保留 SPARK_LEN 个点 / the sparkline keeps at most SPARK_LEN points', () => {
    const book = createWatchTicks()
    for (let i = 0; i < SPARK_LEN + 5; i++) book.ingest({ XAUUSD: quote('XAUUSD', 100 + i) })
    const hist = book.get('XAUUSD').hist
    expect(hist.length).toBe(SPARK_LEN)
    expect(hist[hist.length - 1]).toBe(100 + SPARK_LEN + 4)
  })

  it('没有报价的品种返回空格子 / an unknown symbol returns the empty cell', () => {
    expect(createWatchTicks().get('NOPE')).toEqual({ bid: null, dir: null, hist: [] })
  })
})
