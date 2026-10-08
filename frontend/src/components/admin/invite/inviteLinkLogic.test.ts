import { describe, expect, it } from 'vitest'
import type { InviteLink, InviteLinkKind } from '../../../api/types'
import {
  ALL_CHANNELS,
  CHANNEL_MAX,
  DEFAULT_FILTER,
  NO_CHANNEL,
  channelOptions,
  filterLinks,
  hasUnchanneled,
  kindBadgeClass,
  kindCounts,
  labelPatch,
  linkKind,
  matchesSearch,
  normalizeChannel,
  secondaryLine,
  summarize,
} from './inviteLinkLogic'

let seq = 0
function mk(over: Partial<InviteLink> = {}): InviteLink {
  seq += 1
  return {
    id: `id${seq}`,
    code: `code${seq}`,
    label: `L${seq}`,
    clicks: 0,
    registrations: 0,
    isActive: true,
    grantsTrial: false,
    createdAt: null,
    agents: [],
    competitionId: null,
    competitionName: null,
    channel: null,
    kind: 'platform',
    entries: 0,
    ...over,
  }
}

const agentA = { userId: 'u1', email: 'kol@example.com', nickname: '小王', assignedAt: null }

describe('linkKind', () => {
  it('后端给了 kind 就用它 / trusts the backend kind', () => {
    expect(linkKind(mk({ kind: 'agent' }))).toBe('agent')
    expect(linkKind(mk({ kind: 'competition', competitionId: 'c1' }))).toBe('competition')
  })
  it('旧后端没给 kind 时按数据推导 / derives it when absent', () => {
    const noKind = (over: Partial<InviteLink>) => mk({ ...over, kind: undefined as unknown as InviteLinkKind })
    expect(linkKind(noKind({ competitionId: 'c1', agents: [agentA] }))).toBe('competition')
    expect(linkKind(noKind({ agents: [agentA] }))).toBe('agent')
    expect(linkKind(noKind({}))).toBe('platform')
  })
})

describe('search / filter', () => {
  const plat = mk({ label: 'Google 投放', code: 'GGL01', channel: 'Google广告' })
  const agent = mk({ label: 'KOL-小王', code: 'KOLW', kind: 'agent', agents: [agentA] })
  const comp = mk({ label: 'FB-10月', code: 'FBOCT', kind: 'competition', competitionId: 'c1', competitionName: '十月模拟赛', channel: 'FB广告' })
  const off = mk({ label: '旧合作', code: 'OLD', isActive: false, channel: '合作方' })
  const all = [plat, agent, comp, off]

  it('搜索标记 / 码 / 代理昵称 / 代理邮箱 / 比赛名，忽略大小写与首尾空格', () => {
    expect(matchesSearch(plat, '  google ')).toBe(true)
    expect(matchesSearch(plat, 'ggl0')).toBe(true)
    expect(matchesSearch(agent, '小王')).toBe(true)
    expect(matchesSearch(agent, 'KOL@EXAMPLE')).toBe(true)
    expect(matchesSearch(comp, '十月')).toBe(true)
    expect(matchesSearch(comp, 'nothing')).toBe(false)
    expect(matchesSearch(comp, '   ')).toBe(true)
  })

  it('默认隐藏已停用 / hides disabled by default', () => {
    expect(filterLinks(all, DEFAULT_FILTER).map((l) => l.id)).toEqual([plat.id, agent.id, comp.id])
    expect(filterLinks(all, { ...DEFAULT_FILTER, showInactive: true })).toHaveLength(4)
  })

  it('按类型 / by kind', () => {
    expect(filterLinks(all, { ...DEFAULT_FILTER, kind: 'agent' })).toEqual([agent])
    expect(filterLinks(all, { ...DEFAULT_FILTER, kind: 'competition' })).toEqual([comp])
    expect(filterLinks(all, { ...DEFAULT_FILTER, kind: 'platform', showInactive: true })).toEqual([plat, off])
  })

  it('按渠道：全部 / 指定 / 未设 / by channel', () => {
    expect(filterLinks(all, { ...DEFAULT_FILTER, channel: ALL_CHANNELS })).toHaveLength(3)
    expect(filterLinks(all, { ...DEFAULT_FILTER, channel: 'FB广告' })).toEqual([comp])
    expect(filterLinks(all, { ...DEFAULT_FILTER, channel: NO_CHANNEL })).toEqual([agent])
  })

  it('条件叠加 / filters combine', () => {
    expect(filterLinks(all, { kind: 'platform', channel: '合作方', q: 'old', showInactive: true })).toEqual([off])
    expect(filterLinks(all, { kind: 'platform', channel: '合作方', q: 'old', showInactive: false })).toEqual([])
  })

  it('分段按钮上的计数跟随「显示已停用」/ kind counts follow show-inactive', () => {
    expect(kindCounts(all, false)).toEqual({ all: 3, agent: 1, platform: 1, competition: 1 })
    expect(kindCounts(all, true)).toEqual({ all: 4, agent: 1, platform: 2, competition: 1 })
  })
})

describe('channels', () => {
  it('建议值顺序在前，其余按字母 / suggestions first, then alphabetical', () => {
    const links = [mk({ channel: 'zeta' }), mk({ channel: '其他' }), mk({ channel: 'FB广告' }), mk({ channel: 'alpha' }), mk({ channel: 'FB广告' }), mk()]
    expect(channelOptions(links)).toEqual(['FB广告', '其他', 'alpha', 'zeta'])
  })
  it('hasUnchanneled', () => {
    expect(hasUnchanneled([mk({ channel: 'x' })])).toBe(false)
    expect(hasUnchanneled([mk({ channel: 'x' }), mk()])).toBe(true)
  })
  it('normalizeChannel：去空格、空串为 null、截到 32', () => {
    expect(normalizeChannel('  抖音 ')).toBe('抖音')
    expect(normalizeChannel('   ')).toBeNull()
    expect(normalizeChannel('x'.repeat(40))).toBe('x'.repeat(CHANNEL_MAX))
  })
})

describe('summarize', () => {
  it('全量统计（不受筛选影响）/ totals over every link', () => {
    const s = summarize([
      mk({ clicks: 10, registrations: 3 }),
      mk({ clicks: 5, registrations: 1, isActive: false }),
    ])
    expect(s).toEqual({ total: 2, active: 1, clicks: 15, registrations: 4, registrationsMonth: null })
  })
  it('后端给了本月注册才汇总 / month total only when the backend sends it', () => {
    const s = summarize([mk({ registrationsMonth: 2 }), mk({ registrationsMonth: 5 }), mk()])
    expect(s.registrationsMonth).toBe(7)
  })
  it('空列表 / empty', () => {
    expect(summarize([])).toEqual({ total: 0, active: 0, clicks: 0, registrations: 0, registrationsMonth: null })
  })
})

describe('row helpers', () => {
  it('第二行：比赛名 / 代理名 / 平台为空', () => {
    expect(secondaryLine(mk({ kind: 'competition', competitionId: 'c1', competitionName: '十月模拟赛' }))).toBe('十月模拟赛')
    expect(secondaryLine(mk({ kind: 'competition', competitionId: 'c1', competitionName: null }))).toBe('c1')
    expect(
      secondaryLine(mk({ kind: 'agent', agents: [agentA, { userId: 'u2', email: 'b@x.com', nickname: null, assignedAt: null }] })),
    ).toBe('小王、b@x.com')
    expect(secondaryLine(mk())).toBeNull()
  })
  it('三类徽标各不相同 / distinct badge classes', () => {
    const set = new Set((['agent', 'platform', 'competition'] as const).map(kindBadgeClass))
    expect(set.size).toBe(3)
  })
})

describe('labelPatch', () => {
  const link = { label: 'KOL-小王', channel: '抖音' as string | null }
  it('没改 → null', () => {
    expect(labelPatch(link, { label: ' KOL-小王 ', channel: '抖音 ' })).toBeNull()
  })
  it('只送改了的字段 / only changed fields', () => {
    expect(labelPatch(link, { label: 'KOL-小李', channel: '抖音' })).toEqual({ label: 'KOL-小李' })
    expect(labelPatch(link, { label: 'KOL-小王', channel: '小红书' })).toEqual({ channel: '小红书' })
    expect(labelPatch(link, { label: 'KOL-小王', channel: '' })).toEqual({ channel: null })
  })
  it('标记清空时不允许保存 / a blank label never saves', () => {
    expect(labelPatch(link, { label: '   ', channel: '小红书' })).toBeNull()
  })
  it('原来没渠道、草稿也空 → 不算改动', () => {
    expect(labelPatch({ label: 'a', channel: null }, { label: 'a', channel: '  ' })).toBeNull()
  })
})
