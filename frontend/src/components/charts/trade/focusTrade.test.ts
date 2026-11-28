// 为什么要测：报告里点一单跳图表，时间错 8 小时、周期选了没数据的 1 分钟线、路由 state 里混进
// 脏数据，页面都不会报错，只是跳到一片空白或标错位置。
// Why: a wrong hour offset, an interval with no stored bars or junk in the router state would not
// throw — the chart would just land on nothing or mark the wrong spot.
import { describe, expect, it } from 'vitest'
import { focusFromRef, focusInterval, focusLeg, focusPhase, readFocusState } from './focusTrade'

const REF = {
  symbol: 'xauusd.m', side: 'SELL', openAt: '2026-11-03T08:00:00+00:00', closeAt: '2026-11-03T08:20:00+00:00',
  openPrice: 2700.5, closePrice: 2695.1, profit: 54, unrealized: false,
}
const T1 = Date.UTC(2026, 10, 3, 8, 0, 0) / 1000

describe('focusFromRef', () => {
  it('reads UTC times, prices and the base symbol', () => {
    const f = focusFromRef(REF)!
    expect(f).toMatchObject({ symbol: 'XAUUSD', side: 'SELL', t1: T1, p1: 2700.5, t2: T1 + 1200, p2: 2695.1, profit: 54 })
  })
  it('treats a time without a zone as UTC', () => {
    expect(focusFromRef({ ...REF, openAt: '2026-11-03T08:00:00' })!.t1).toBe(T1)
  })
  it('gives a fresh id per call so a repeat click re-centres', () => {
    expect(focusFromRef(REF)!.id).not.toBe(focusFromRef(REF)!.id)
  })
  it('has no exit for a still-open trade and no prices for an old archive', () => {
    const open = focusFromRef({ ...REF, unrealized: true })!
    expect(open.t2).toBeNull()
    expect(open.p2).toBeNull()
    const old = focusFromRef({ ...REF, openPrice: undefined, closePrice: null })!
    expect(old.p1).toBeNull()
    expect(focusLeg(old)).toBeNull()
  })
  it('returns null without a readable open time', () => {
    expect(focusFromRef({ ...REF, openAt: '' })).toBeNull()
  })
})

describe('focusInterval', () => {
  const now = T1 + 5 * 86400
  it('uses one-minute bars for a short recent trade', () => {
    expect(focusInterval({ t1: T1, t2: T1 + 1200 }, now)).toBe('1')
  })
  it('avoids one-minute bars past their retention', () => {
    expect(focusInterval({ t1: T1, t2: T1 + 1200 }, T1 + 40 * 86400)).toBe('5')
  })
  it('grows with the holding time', () => {
    expect(focusInterval({ t1: T1, t2: T1 + 6 * 3600 }, now)).toBe('5')
    expect(focusInterval({ t1: T1, t2: T1 + 2 * 86400 }, now)).toBe('15')
    expect(focusInterval({ t1: T1, t2: T1 + 10 * 86400 }, now + 10 * 86400)).toBe('60')
    expect(focusInterval({ t1: T1, t2: T1 + 30 * 86400 }, now + 30 * 86400)).toBe('240')
  })
  it('measures an open trade up to now', () => {
    expect(focusInterval({ t1: T1, t2: null }, T1 + 2 * 86400)).toBe('15')
  })
})

// 回放这一单：开仓、平仓要等放到那一根才出现，早一根就是剧透，晚一根就是标记消失。
// Replaying the trade: entry and exit must appear exactly when their bars are reached.
describe('focusPhase', () => {
  const bars = (last: number) => Array.from({ length: 5 }, (_, i) => last - (4 - i) * 60)
  it('is before the entry until the entry bar is on screen', () => {
    expect(focusPhase(bars(T1 - 120), T1 + 10, T1 + 600)).toBe('before')
    expect(focusPhase(bars(T1 - 60), T1 + 10, T1 + 600)).toBe('before')
    expect(focusPhase(bars(T1), T1 + 10, T1 + 600)).toBe('open')
  })
  it('stays open until the exit bar, then closes', () => {
    expect(focusPhase(bars(T1 + 480), T1 + 10, T1 + 600)).toBe('open')
    expect(focusPhase(bars(T1 + 540), T1 + 10, T1 + 600)).toBe('open')
    expect(focusPhase(bars(T1 + 600), T1 + 10, T1 + 600)).toBe('closed')
  })
  it('treats a trade without an exit as fully shown once entered, and no bars as before', () => {
    expect(focusPhase(bars(T1), T1 + 10, null)).toBe('closed')
    expect(focusPhase([], T1, T1 + 60)).toBe('before')
  })
})

describe('readFocusState', () => {
  it('round-trips what the report sends', () => {
    const f = focusFromRef(REF)!
    expect(readFocusState({ focusTrade: f })).toEqual(f)
  })
  it('rejects anything else', () => {
    expect(readFocusState(null)).toBeNull()
    expect(readFocusState({ tab: 'persona' })).toBeNull()
    expect(readFocusState({ focusTrade: { symbol: 'XAUUSD', id: 'x', t1: 'soon' } })).toBeNull()
    expect(readFocusState({ focusTrade: { symbol: '', id: 'x', t1: 1 } })).toBeNull()
  })
  it('drops non-positive prices', () => {
    expect(readFocusState({ focusTrade: { symbol: 'XAUUSD', id: 'x', t1: 1, p1: 0, p2: -3 } })).toMatchObject({ p1: null, p2: null })
  })
})
