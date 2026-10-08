import { describe, expect, it } from 'vitest'
import type { CompetitionFunnel, CompetitionIntegrityFlag } from '../../../api/types'
import {
  FUNNEL_STEPS,
  convRate,
  formPromoIssues,
  formatFlagDetail,
  funnelTotals,
  isHttpsUrl,
  needsAck,
  openAccountUrlValue,
  publicViewIssues,
  rankFlags,
} from './promoLogic'

describe('isHttpsUrl', () => {
  it('只认完整的 https 网址', () => {
    expect(isHttpsUrl('https://broker.example.com/open?ib=1')).toBe(true)
    expect(isHttpsUrl('  https://a.b  ')).toBe(true)
    expect(isHttpsUrl('http://broker.example.com')).toBe(false)
    expect(isHttpsUrl('broker.example.com')).toBe(false)
    expect(isHttpsUrl('javascript:alert(1)')).toBe(false)
    expect(isHttpsUrl('')).toBe(false)
  })
})

describe('publicViewIssues（§1.7）', () => {
  const ok = { track: 'demo' as const, enrollment: 'signup' as const, openAccountUrl: 'https://x.com/open' }
  it('模拟赛 + 报名制 + https → 无问题', () => {
    expect(publicViewIssues(ok)).toEqual([])
  })
  it('逐条列出 / lists every problem', () => {
    expect(publicViewIssues({ track: 'real', enrollment: 'auto', openAccountUrl: '' })).toEqual(['notDemo', 'notSignup', 'noUrl'])
    expect(publicViewIssues({ ...ok, openAccountUrl: 'http://x.com' })).toEqual(['urlNotHttps'])
  })
})

describe('formPromoIssues', () => {
  it('公开关闭时只校验已填的开户链接格式', () => {
    expect(formPromoIssues({ publicView: false, track: 'real', enrollment: 'auto', openAccountUrl: '' })).toEqual([])
    expect(formPromoIssues({ publicView: false, track: 'real', enrollment: 'auto', openAccountUrl: 'ftp://x' })).toEqual(['urlNotHttps'])
  })
  it('公开打开时全量校验', () => {
    expect(formPromoIssues({ publicView: true, track: 'real', enrollment: 'signup', openAccountUrl: 'https://x.com' })).toEqual(['notDemo'])
  })
})

describe('openAccountUrlValue', () => {
  it('去空格，空串为 null', () => {
    expect(openAccountUrlValue('  https://x.com ')).toBe('https://x.com')
    expect(openAccountUrlValue('   ')).toBeNull()
  })
})

describe('funnel', () => {
  const f: CompetitionFunnel = {
    links: [
      { code: 'a', label: 'A', channel: null, clicks: 10, views: 8, ctas: 4, openAccounts: 3, registrations: 2, verified: 2, bound: 1, entries: 1 },
      { code: 'b', label: 'B', channel: 'FB广告', clicks: 5, views: 5, ctas: 1, openAccounts: 0, registrations: 1, verified: 0, bound: 0, entries: 0 },
    ],
    noRef: { views: 7, ctas: 2, openAccounts: 1 },
  }
  it('合计含无来源的三步 / totals include the no-ref steps', () => {
    expect(funnelTotals(f)).toEqual({ clicks: 15, views: 20, ctas: 7, openAccounts: 4, registrations: 3, verified: 2, bound: 1, entries: 1 })
  })
  it('空漏斗全 0', () => {
    const z = funnelTotals({ links: [], noRef: { views: 0, ctas: 0, openAccounts: 0 } })
    expect(FUNNEL_STEPS.every((s) => z[s] === 0)).toBe(true)
  })
  it('转化率一位小数，分母 0 显示 —', () => {
    expect(convRate(1, 3)).toBe('33.3%')
    expect(convRate(3, 15)).toBe('20.0%')
    expect(convRate(0, 0)).toBe('—')
    expect(convRate(5, 4)).toBe('125.0%')
  })
})

describe('formatFlagDetail', () => {
  it('数字两位小数、跳过空值 / numbers to 2dp, empties skipped', () => {
    expect(formatFlagDetail({ netCashflow: 512.345, revokedReason: null, sources: ['gateway'], hedgePairs: [] })).toBe('netCashflow=512.35 · sources=gateway')
  })
  it('null → 空串 / null → empty', () => {
    expect(formatFlagDetail(null)).toBe('')
  })
})

describe('rankFlags / needsAck（§1.14）', () => {
  const flag = (participantId: string, kinds: string[] = ['hedgePair']): CompetitionIntegrityFlag => ({
    participantId,
    login: `L-${participantId}`,
    displayName: null,
    kinds,
    detail: null,
  })
  const parts = [
    { id: 'p1', liveRank: 3, finalRank: null },
    { id: 'p2', liveRank: 12, finalRank: null },
    { id: 'p3', liveRank: null, finalRank: 1 },
    { id: 'p4', liveRank: null, finalRank: null },
  ]
  it('按名次排序，未上榜在最后；finalRank 优先', () => {
    const r = rankFlags([flag('p4'), flag('p2'), flag('p1'), flag('p3')], parts)
    expect(r.map((x) => [x.participantId, x.rank, x.top])).toEqual([
      ['p3', 1, true],
      ['p1', 3, true],
      ['p2', 12, false],
      ['p4', null, false],
    ])
  })
  it('前 10 有标记才必须确认', () => {
    expect(needsAck(rankFlags([flag('p2'), flag('p4')], parts))).toBe(false)
    expect(needsAck(rankFlags([flag('p1')], parts))).toBe(true)
    expect(needsAck([])).toBe(false)
  })
  it('名单里找不到的参赛者按未上榜处理', () => {
    expect(rankFlags([flag('ghost')], parts)[0]).toMatchObject({ rank: null, top: false })
  })
})
