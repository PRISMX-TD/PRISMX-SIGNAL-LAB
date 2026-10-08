// 比赛成绩卡的二维码：比赛可公开时指向 /c/<id>，否则仍是首页。
// The competition card's QR: /c/<id> when the competition is public, else the home page.
import { describe, expect, it } from 'vitest'
import type { TFunction } from 'i18next'
import { SHARE_LINK, buildEnvData, compCard, compPublicLink } from './cardEnv'

const t = ((k: string) => k) as unknown as TFunction

describe('buildEnvData user.link', () => {
  it('defaults to the site root', () => {
    expect(buildEnvData({ comp: compCard('Cup', 2, 12.5, 40) }, t, 'nick').user.link).toBe(SHARE_LINK)
    expect(buildEnvData({}, t, 'nick').user.link).toBe(SHARE_LINK)
  })
  it('uses the public competition page when the card has one', () => {
    const link = compPublicLink('c1')
    expect(buildEnvData({ comp: compCard('Cup', 2, 12.5, 40, link) }, t, 'nick').user.link).toBe(link)
  })
})
