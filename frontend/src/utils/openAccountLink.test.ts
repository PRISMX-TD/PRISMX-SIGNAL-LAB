import { describe, expect, it } from 'vitest'
import { competitionOpenAccountUrl, isAgentOpenUrl, publicOpenAccountHref, safeOpenAccountUrl } from './openAccountLink'

const COMP = '0b6f3c1e-1111-4222-8333-444455556666'

describe('isAgentOpenUrl', () => {
  it('收 Make Capital 的 https 地址 / accepts https Make Capital links', () => {
    expect(isAgentOpenUrl('https://makecapital.com/open')).toBe(true)
    expect(isAgentOpenUrl('  https://my.makecapital.com/r?ib=1 ')).toBe(true)
    expect(isAgentOpenUrl('https://MY.MakeCapital.com/x')).toBe(true)
    expect(isAgentOpenUrl('https://makecapital.com:443/open')).toBe(true)
    // 主机段之后允许百分号编码 / percent-encoding allowed after the authority
    expect(isAgentOpenUrl('https://portal.makecapital.com/register?x=a%20b')).toBe(true)
    expect(isAgentOpenUrl('https://makecapital.com/p%C3%A9#f%20g')).toBe(true)
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
      'https://evil.io\\.makecapital.com/',
      'https://evil.io%5c.makecapital.com/',
      'https://evil.io%2fx.makecapital.com/',
      'https://mäkecapital.com/',
      'https://makecapital.com/\tx',
      'https://makecapital.com/\u0001',
      'https://makecapital.com:99999999/',
      'https://@makecapital.com/',
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

describe('safeOpenAccountUrl', () => {
  it('白名单内原样（去空白）返回 / allowlisted URLs pass through, trimmed', () => {
    expect(safeOpenAccountUrl(' https://portal.makecapital.com/register?ib=1 ')).toBe('https://portal.makecapital.com/register?ib=1')
  })
  it('白名单外一律空串（不渲染）/ anything else is empty (not rendered)', () => {
    for (const bad of [null, undefined, '', 'https://evil.io/open', 'http://makecapital.com/', 'https://makecapital.com@evil.io/', 'javascript:alert(1)']) {
      expect(safeOpenAccountUrl(bad)).toBe('')
    }
  })
})

describe('competitionOpenAccountUrl', () => {
  it('比赛自己的（管理员填的）可以是任意 https 券商 / the competition own URL may be any https broker', () => {
    expect(competitionOpenAccountUrl('https://broker.example.com/open?ib=9')).toBe('https://broker.example.com/open?ib=9')
    expect(competitionOpenAccountUrl(' https://portal.makecapital.com/r ')).toBe('https://portal.makecapital.com/r')
    expect(competitionOpenAccountUrl('javascript:alert(1)')).toBe('')
    expect(competitionOpenAccountUrl(null)).toBe('')
  })
  it('代理的只放行 Make Capital 白名单 / an agent URL must pass the allowlist', () => {
    expect(competitionOpenAccountUrl('https://broker.example.com/open?ib=9', true)).toBe('')
    expect(competitionOpenAccountUrl('https://portal.makecapital.com/r?ib=1', true)).toBe('https://portal.makecapital.com/r?ib=1')
  })
})
