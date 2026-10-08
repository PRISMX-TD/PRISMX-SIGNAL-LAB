import { describe, expect, it } from 'vitest'
import { isAgentOpenUrl, publicOpenAccountHref } from './openAccountLink'

const COMP = '0b6f3c1e-1111-4222-8333-444455556666'

describe('isAgentOpenUrl', () => {
  it('收 Make Capital 的 https 地址 / accepts https Make Capital links', () => {
    expect(isAgentOpenUrl('https://makecapital.com/open')).toBe(true)
    expect(isAgentOpenUrl('  https://my.makecapital.com/r?ib=1 ')).toBe(true)
    expect(isAgentOpenUrl('https://MY.MakeCapital.com/x')).toBe(true)
  })
  it('其余一律不收 / rejects everything else', () => {
    for (const bad of [
      '',
      '   ',
      'http://makecapital.com/open',
      'https://evilmakecapital.com/',
      'https://makecapital.com.evil.io/',
      'https://evil.io/makecapital.com',
      'https://makecapital.com@evil.io/',
      'https://evil.io@makecapital.com/',
      'makecapital.com/open',
      'javascript:alert(1)',
      'https://makecapital.com/a b',
      'https://makecapital.com/' + 'a'.repeat(480),
    ]) {
      expect(isAgentOpenUrl(bad), bad).toBe(false)
    }
  })
  it('500 字符边界 / 500-char boundary', () => {
    const base = 'https://makecapital.com/'
    expect(isAgentOpenUrl(base + 'a'.repeat(500 - base.length))).toBe(true)
    expect(isAgentOpenUrl(base + 'a'.repeat(501 - base.length))).toBe(false)
  })
})

describe('publicOpenAccountHref', () => {
  it('带 refs（逗号连接后整体转义）/ with refs', () => {
    expect(publicOpenAccountHref('https://api.x.com', COMP, ['ab12cd34', 'zz99'])).toBe(
      `https://api.x.com/api/public/competitions/${COMP}/open-account?refs=ab12cd34%2Czz99`,
    )
  })
  it('没有 refs 就不带参数 / omits refs when empty', () => {
    expect(publicOpenAccountHref('', COMP, [])).toBe(`/api/public/competitions/${COMP}/open-account`)
  })
  it('id 被转义 / id is encoded', () => {
    expect(publicOpenAccountHref('', 'a/b', ['x'])).toBe('/api/public/competitions/a%2Fb/open-account?refs=x')
  })
})
