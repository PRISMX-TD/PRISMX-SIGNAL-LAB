// routeTitleKey / appTitle：登录后路由的标签页标题表。
// routeTitleKey / appTitle: the signed-in route → tab title table.
import { describe, expect, it } from 'vitest'
import { PAGE_OWNED, appTitle, routeTitleKey } from './routeTitle'

describe('routeTitleKey', () => {
  it('maps exact paths and their sub-paths', () => {
    expect(routeTitleKey('/dashboard')).toBe('nav.dashboard')
    expect(routeTitleKey('/app')).toBe('nav.signals')
    expect(routeTitleKey('/app/strategy/abc')).toBe('nav.signals')
    expect(routeTitleKey('/bind/bridge')).toBe('nav.bind')
    expect(routeTitleKey('/admin/users')).toBe('nav.admin')
    expect(routeTitleKey('/lucky/prizes')).toBe('nav.growth')
  })

  it('does not match on a bare prefix', () => {
    expect(routeTitleKey('/app-download')).toBe('nav.appDownload')
    expect(routeTitleKey('/support-desk/tickets/1')).toBe('nav.supportDesk')
    expect(routeTitleKey('/support')).toBe('nav.support')
    expect(routeTitleKey('/dashboards')).toBeNull()
  })

  it('leaves pages that set their own title alone', () => {
    expect(routeTitleKey('/agent')).toBe(PAGE_OWNED)
    expect(routeTitleKey('/announcements/42')).toBe(PAGE_OWNED)
    expect(routeTitleKey('/upgrade')).toBe(PAGE_OWNED)
  })

  it('returns null for unlisted routes', () => {
    expect(routeTitleKey('/u/abc')).toBeNull()
    expect(routeTitleKey('/download')).toBeNull()
  })
})

describe('appTitle', () => {
  it('suffixes the brand, or falls back to it', () => {
    expect(appTitle('仪表盘')).toBe('仪表盘 · Signal Lab')
    expect(appTitle('')).toBe('Signal Lab')
    expect(appTitle(null)).toBe('Signal Lab')
  })
})
