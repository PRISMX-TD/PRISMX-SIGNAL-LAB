import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { clearStoredToken, loadStoredToken, readTokenParam, saveStoredToken, stripTokenParam } from './urlToken'

// vitest 跑在 node 环境，没有 sessionStorage：给一个最小实现。
// Tests run in node without sessionStorage; provide a minimal one.
class MemStorage {
  private m = new Map<string, string>()
  getItem(k: string) {
    return this.m.has(k) ? this.m.get(k)! : null
  }
  setItem(k: string, v: string) {
    this.m.set(k, String(v))
  }
  removeItem(k: string) {
    this.m.delete(k)
  }
}
const g = globalThis as unknown as { sessionStorage?: unknown }

describe('stripTokenParam / readTokenParam', () => {
  it('只去掉 token，其余参数保留 / removes only token', () => {
    expect(stripTokenParam('?token=abc')).toBe('')
    expect(stripTokenParam('?lang=en&token=abc&x=1')).toBe('?lang=en&x=1')
    expect(stripTokenParam('')).toBe('')
    expect(stripTokenParam('?lang=en')).toBe('?lang=en')
  })
  it('读取并去空白 / reads and trims', () => {
    expect(readTokenParam('?token=%20abc%20')).toBe('abc')
    expect(readTokenParam('?x=1')).toBe('')
  })
})

describe('stored token', () => {
  beforeEach(() => {
    g.sessionStorage = new MemStorage()
  })
  afterEach(() => {
    delete g.sessionStorage
  })

  it('同一路径才取得到 / only the same path gets it back', () => {
    saveStoredToken('k', '/reset-password', 'tok')
    expect(loadStoredToken('k', '/reset-password')).toBe('tok')
    expect(loadStoredToken('k', '/Reset-Password/')).toBe('tok')
    expect(loadStoredToken('k', '/forgot-password')).toBe('')
  })

  it('清除后取不到 / cleared token is gone', () => {
    saveStoredToken('k', '/verify-email', 'tok')
    clearStoredToken('k')
    expect(loadStoredToken('k', '/verify-email')).toBe('')
  })

  it('坏数据与存储不可用都返回空 / bad data or no storage yields empty', () => {
    ;(g.sessionStorage as MemStorage).setItem('k', '{not json')
    expect(loadStoredToken('k', '/verify-email')).toBe('')
    delete g.sessionStorage
    expect(() => saveStoredToken('k', '/verify-email', 'tok')).not.toThrow()
    expect(loadStoredToken('k', '/verify-email')).toBe('')
    expect(() => clearStoredToken('k')).not.toThrow()
  })
})
