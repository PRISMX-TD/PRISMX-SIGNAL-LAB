import { describe, expect, it } from 'vitest'
import { isPixelBlocked } from './pixelPrivacy'

describe('isPixelBlocked', () => {
  it('敏感页及其子路径不发 / blocks sensitive paths and sub-paths', () => {
    for (const p of [
      '/reset-password',
      '/reset-password/',
      '/Reset-Password',
      '/verify-email',
      '/forgot-password',
      '/admin',
      '/admin/x',
      '/support',
      '/agent',
      '/unsubscribe',
      '/simulator',
      '/account',
      '/complete-profile',
    ]) {
      expect(isPixelBlocked(p)).toBe(true)
    }
  })

  it('带 token 参数的任何页面都不发 / any URL with a token param is blocked', () => {
    expect(isPixelBlocked('/', '?token=abc')).toBe(true)
    expect(isPixelBlocked('/login', '?x=1&TOKEN=abc')).toBe(true)
  })

  it('普通页照常发 / ordinary pages still report', () => {
    for (const p of ['/', '/en', '/login', '/c/abc', '/competitions', '/upgrade', '/dashboard', '/administrator-faq', '/supporting']) {
      expect(isPixelBlocked(p)).toBe(false)
    }
    expect(isPixelBlocked('/c', '?ref=AB12&lang=en')).toBe(false)
    expect(isPixelBlocked('/login', '?mytoken_hint=1')).toBe(false)
  })
})
