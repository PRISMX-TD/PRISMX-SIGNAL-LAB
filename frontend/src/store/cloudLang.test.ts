import { describe, expect, it } from 'vitest'
import { cloudLangWins, localLangNewer, readCloudLang } from './cloudLang'

describe('readCloudLang', () => {
  it('reads lang + at, at defaults to 0 for older builds', () => {
    expect(readCloudLang({ lang: { lang: 'en', at: 5 } })).toEqual({ lang: 'en', at: 5 })
    expect(readCloudLang({ lang: { lang: 'th' } })).toEqual({ lang: 'th', at: 0 })
  })
  it('ignores missing or unknown languages', () => {
    expect(readCloudLang({})).toBeNull()
    expect(readCloudLang({ lang: { lang: 'xx', at: 5 } })).toBeNull()
    expect(readCloudLang(null)).toBeNull()
  })
})

describe('cloudLangWins', () => {
  it('a stale cloud value never flips a newer local choice (the iOS PWA bug)', () => {
    expect(cloudLangWins({ lang: 'en', at: 100 }, 'zh', 200)).toBe(false)
    // 旧版本云端没有时间戳，本机切过（带时间戳）
    expect(cloudLangWins({ lang: 'en', at: 0 }, 'th', 200)).toBe(false)
  })
  it('keeps the device when neither side has a stamp', () => {
    expect(cloudLangWins({ lang: 'en', at: 0 }, 'zh', 0)).toBe(false)
  })
  it('a newer choice from another device wins', () => {
    expect(cloudLangWins({ lang: 'ja', at: 300 }, 'zh', 200)).toBe(true)
  })
  it('a device with no stored language takes the cloud value', () => {
    expect(cloudLangWins({ lang: 'vi', at: 0 }, null, 0)).toBe(true)
  })
  it('no cloud language, nothing to apply', () => {
    expect(cloudLangWins(null, null, 0)).toBe(false)
  })
})

describe('localLangNewer', () => {
  it('pushes a stamped local choice newer than the cloud', () => {
    expect(localLangNewer({ lang: 'en', at: 100 }, 'zh', 200)).toBe(true)
    expect(localLangNewer(null, 'zh', 200)).toBe(true)
  })
  it('never pushes an unstamped (older-build) local value', () => {
    expect(localLangNewer({ lang: 'en', at: 0 }, 'zh', 0)).toBe(false)
  })
  it('does not push when the cloud is as new or newer', () => {
    expect(localLangNewer({ lang: 'zh', at: 200 }, 'zh', 200)).toBe(false)
  })
})
