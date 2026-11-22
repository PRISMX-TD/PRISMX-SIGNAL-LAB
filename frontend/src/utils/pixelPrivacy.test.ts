import { describe, expect, it } from 'vitest'
import { isPixelAllowedPath, isPixelBlocked } from './pixelPrivacy'

describe('isPixelBlocked', () => {
  it('公开页、登录 / 注册页、升级页上报 / public pages, login and upgrade report', () => {
    for (const p of [
      '/',
      '/en',
      '/en/',
      '/intro',
      '/en/intro',
      '/login',
      '/Login',
      '/terms',
      '/privacy',
      '/risk',
      '/en/terms',
      '/faq',
      '/en/faq',
      '/c',
      '/c/abc',
      '/upgrade',
    ]) {
      expect(isPixelBlocked(p)).toBe(false)
      expect(isPixelAllowedPath(p)).toBe(true)
    }
    expect(isPixelBlocked('/c', '?ref=AB12&lang=en')).toBe(false)
    expect(isPixelBlocked('/login', '?mytoken_hint=1')).toBe(false)
  })

  it('登录后的工作页面不上报 / signed-in working pages never report', () => {
    for (const p of [
      '/charts',
      '/dashboard',
      '/app',
      '/app/strategy/abc',
      '/orders',
      '/strategies',
      '/competitions',
      '/leaderboard',
      '/achievements',
      '/lucky',
      '/lucky/prizes',
      '/persona',
      '/bind',
      '/download',
      '/app-download',
      '/announcements/1',
      '/u/abcdef',
    ]) {
      expect(isPixelBlocked(p)).toBe(true)
    }
  })

  it('敏感页及其子路径不发 / sensitive paths and sub-paths stay blocked', () => {
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

  it('名单按整段路径匹配，不是按前缀字符 / matches whole segments, not string prefixes', () => {
    // '/c' 不该放行 /charts、/competitions；'/en' 不该放行 /entries；'/' 只认首页。
    for (const p of ['/charts', '/competitions', '/cx', '/entries', '/login-help', '/upgrades', '/faqs', '/unknown']) {
      expect(isPixelBlocked(p)).toBe(true)
    }
  })

  it('带 token 参数的任何页面都不发 / any URL with a token param is blocked', () => {
    expect(isPixelBlocked('/', '?token=abc')).toBe(true)
    expect(isPixelBlocked('/login', '?x=1&TOKEN=abc')).toBe(true)
  })
})
