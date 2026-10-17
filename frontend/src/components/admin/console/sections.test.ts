import { describe, expect, it } from 'vitest'
import { ADMIN_GROUPS, groupOf, isAdminSection, legacyAdminTarget, readLogsDeepLink, sectionsOf } from './sections'

describe('admin console sections', () => {
  it('lists every section exactly once', () => {
    const all = ADMIN_GROUPS.flatMap((g) => g.sections)
    expect(new Set(all).size).toBe(all.length)
  })

  it('keeps every legacy tab key reachable', () => {
    // 原来的 15 个页签 key（support 除外）都必须还是合法分区，否则旧深链会掉到默认页。
    // The old 15 tab keys (bar support) must all still be sections, or old deep links fall through.
    const legacy = ['data', 'health', 'winrate', 'users', 'logs', 'invites', 'ops', 'system', 'guide', 'announcements', 'email', 'tickets', 'gamification', 'competitions']
    for (const key of legacy) expect(isAdminSection(key)).toBe(true)
  })

  it('maps sections to their group', () => {
    expect(groupOf('logs')).toBe('users')
    expect(groupOf('approvals')).toBe('support')
    expect(sectionsOf('settings')).toEqual(['ops', 'system'])
  })

  it('redirects legacy ?tab= links and keeps the other params', () => {
    expect(legacyAdminTarget('?tab=tickets&ticket=abc')).toBe('/admin/tickets?ticket=abc')
    expect(legacyAdminTarget('?tab=users&q=a%40b.com')).toBe('/admin/users?q=a%40b.com')
    expect(legacyAdminTarget('?tab=support')).toBe('/admin/staff')
  })

  it('consumes the activity-log user filter instead of carrying it', () => {
    expect(legacyAdminTarget('?tab=logs&user=u1&login=123')).toBe('/admin/logs')
    expect(readLogsDeepLink('/admin', '?tab=logs&user=u1&login=123')).toEqual({ userId: 'u1', login: '123' })
    expect(readLogsDeepLink('/admin/logs', '?login=88')).toEqual({ userId: null, login: '88' })
    expect(readLogsDeepLink('/admin/users', '?user=u1')).toBeNull()
    expect(readLogsDeepLink('/admin', '?tab=logs')).toBeNull()
  })

  it('falls back to the dashboard for a missing or unknown tab', () => {
    expect(legacyAdminTarget('')).toBe('/admin/data')
    expect(legacyAdminTarget('?tab=nope')).toBe('/admin/data')
    expect(legacyAdminTarget('?range=month')).toBe('/admin/data?range=month')
  })
})
