import { describe, expect, it } from 'vitest'
import { ORIGIN } from '../seo/meta'
import { agentCompetitionUrl, competitionPublicUrl, inviteUrl, promoLinkUrl } from './promoLinkUrl'

const COMP = '0b6f3c1e-1111-4222-8333-444455556666'

describe('promoLinkUrl', () => {
  it('普通 / 代理链接走首页 ?ref= / plain and agent links go to the home page', () => {
    expect(inviteUrl('ab12CD')).toBe(`${ORIGIN}/?ref=ab12CD`)
    expect(promoLinkUrl({ code: 'ab12CD', competitionId: null })).toBe(`${ORIGIN}/?ref=ab12CD`)
    expect(promoLinkUrl({ code: 'ab12CD' })).toBe(`${ORIGIN}/?ref=ab12CD`)
  })

  it('比赛推广链接直达本场公开页 / competition links open that competition', () => {
    expect(promoLinkUrl({ code: 'x9', competitionId: COMP })).toBe(`${ORIGIN}/c/${COMP}?ref=x9`)
    expect(competitionPublicUrl(COMP)).toBe(`${ORIGIN}/c/${COMP}`)
  })

  it('代理的比赛链接固定为 /c / the agent competition link is the fixed /c', () => {
    expect(agentCompetitionUrl('ab12CD')).toBe(`${ORIGIN}/c?ref=ab12CD`)
  })

  it('永远是正式域名 / always the canonical origin', () => {
    expect(ORIGIN).toBe('https://www.prismxsignallab.com')
    expect(inviteUrl('a').startsWith('https://www.prismxsignallab.com/')).toBe(true)
  })

  it('码与 id 被转义 / code and id are URL-encoded', () => {
    expect(inviteUrl('a b&c')).toBe(`${ORIGIN}/?ref=a%20b%26c`)
    expect(promoLinkUrl({ code: 'k', competitionId: 'x/y' })).toBe(`${ORIGIN}/c/x%2Fy?ref=k`)
  })
})
