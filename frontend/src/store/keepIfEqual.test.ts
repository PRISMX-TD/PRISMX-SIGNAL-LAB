import { describe, it, expect } from 'vitest'
import { keepIfEqual, shallowEqual } from './keepIfEqual'

describe('shallowEqual', () => {
  it('同字段同值视为相等 / same flat fields are equal', () => {
    expect(shallowEqual({ a: 1, b: 'x' }, { a: 1, b: 'x' })).toBe(true)
  })
  it('字段数或值不同即不等 / differing keys or values are not equal', () => {
    expect(shallowEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false)
    expect(shallowEqual({ a: 1 }, { a: 2 })).toBe(false)
  })
  it('嵌套对象按引用比 / nested objects compare by reference', () => {
    expect(shallowEqual({ a: { x: 1 } }, { a: { x: 1 } })).toBe(false)
  })
  it('数组与对象不混为一谈 / an array is never equal to an object', () => {
    expect(shallowEqual([], {})).toBe(false)
  })
})

describe('keepIfEqual', () => {
  it('数组逐项浅等则沿用旧引用 / arrays of equal records keep the old reference', () => {
    const prev = [{ ticket: 1, profit: 2 }, { ticket: 2, profit: -1 }]
    const next = [{ ticket: 1, profit: 2 }, { ticket: 2, profit: -1 }]
    expect(keepIfEqual(prev, next)).toBe(prev)
  })
  it('数组任一项变化即换新 / any changed item yields the new array', () => {
    const prev = [{ ticket: 1, profit: 2 }]
    const next = [{ ticket: 1, profit: 3 }]
    expect(keepIfEqual(prev, next)).toBe(next)
  })
  it('数组长度变化即换新 / a length change yields the new array', () => {
    const prev = [{ ticket: 1 }]
    const next: { ticket: number }[] = []
    expect(keepIfEqual(prev, next)).toBe(next)
  })
  it('字典逐值浅比较：接口回来的新对象内容没变就沿用 / dictionaries of equal records keep the old reference', () => {
    // refreshAll 每次都用 Object.fromEntries 造一份新的 {symbol: Quote}，以前直接
    // setState 就是整站重渲染。/ refreshAll rebuilds {symbol: Quote} every time.
    const prev = { XAUUSD: { symbol: 'XAUUSD', bid: 1, ask: 2 }, EURUSD: { symbol: 'EURUSD', bid: 3, ask: 4 } }
    const next = { XAUUSD: { symbol: 'XAUUSD', bid: 1, ask: 2 }, EURUSD: { symbol: 'EURUSD', bid: 3, ask: 4 } }
    expect(keepIfEqual(prev, next)).toBe(prev)
  })
  it('字典任一值变化即换新 / any changed value yields the new dictionary', () => {
    const prev = { XAUUSD: { bid: 1 } }
    const next = { XAUUSD: { bid: 1.5 } }
    expect(keepIfEqual(prev, next)).toBe(next)
  })
  it('字典键集合不同即换新 / a different key set yields the new dictionary', () => {
    const prev: Record<string, { bid: number }> = { A: { bid: 1 } }
    const next: Record<string, { bid: number }> = { B: { bid: 1 } }
    expect(keepIfEqual(prev, next)).toBe(next)
  })
  it('原始值字典（浮盈表）照旧 / primitive-valued maps still work', () => {
    const prev = { '1001': 12.5 }
    expect(keepIfEqual(prev, { '1001': 12.5 })).toBe(prev)
    const changed = { '1001': 13 }
    expect(keepIfEqual(prev, changed)).toBe(changed)
  })
  it('null 与对象之间切换 / switching between null and an object', () => {
    const lock = { partner: 'x' }
    expect(keepIfEqual<typeof lock | null>(null, lock)).toBe(lock)
    expect(keepIfEqual<typeof lock | null>(lock, null)).toBe(null)
  })
  it('第三层嵌套不同时绝不吞掉变化 / never swallows a change nested three levels deep', () => {
    const prev = { A: { spec: { tickSize: 1 } } }
    const next = { A: { spec: { tickSize: 1 } } }
    // 第三层按引用比，保守地判为「变了」/ third level compares by reference: conservatively "changed"
    expect(keepIfEqual(prev, next)).toBe(next)
  })
})
