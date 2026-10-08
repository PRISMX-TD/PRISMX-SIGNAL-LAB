import { describe, expect, it } from 'vitest'
import { loggedOutRedirect } from './loggedOutRedirect'

const ID = 'caf4c14f-af1f-4e0c-bf79-9f2224a84cc0'

describe('loggedOutRedirect', () => {
  it('站内比赛详情 → 公开比赛页 / in-app competition detail → public page', () => {
    expect(loggedOutRedirect('/competitions', `?c=${ID}`)).toBe(`/c/${ID}`)
    expect(loggedOutRedirect('/competitions/', `?c=${ID.toUpperCase()}`)).toBe(`/c/${ID}`)
  })
  it('带 ref 原样保留 / keeps ref', () => {
    expect(loggedOutRedirect('/competitions', `?c=${ID}&ref=abc23456`)).toBe(`/c/${ID}?ref=abc23456`)
  })
  it('比赛列表或坏 id → 主推比赛 / list or bad id → featured', () => {
    expect(loggedOutRedirect('/competitions', '')).toBe('/c')
    expect(loggedOutRedirect('/competitions', '?c=//evil.example')).toBe('/c')
  })
  it('其他受保护页面照旧去登录 / other protected pages still go to login', () => {
    expect(loggedOutRedirect('/dashboard', '')).toBe('/login')
    expect(loggedOutRedirect('/competitionsx', `?c=${ID}`)).toBe('/login')
  })
})
