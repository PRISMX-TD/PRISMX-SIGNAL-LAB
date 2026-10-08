import { describe, expect, it } from 'vitest'
import { isPublicCompPath, legalLang, pickPublicLang } from './publicLang'

describe('pickPublicLang', () => {
  it('?lang= wins, case-insensitive, region suffix ignored', () => {
    expect(pickPublicLang('?lang=ja', ['zh-CN'])).toBe('ja')
    expect(pickPublicLang('lang=TH', [])).toBe('th')
    expect(pickPublicLang('?ref=abc&lang=vi-VN', ['en'])).toBe('vi')
  })
  it('falls back to the first supported browser language', () => {
    expect(pickPublicLang('?lang=fr', ['zh-CN'])).toBe('zh')
    expect(pickPublicLang('', ['fr-FR', 'vi-VN'])).toBe('vi')
    expect(pickPublicLang('', ['zh-TW'])).toBe('zh')
  })
  it('defaults to English', () => {
    expect(pickPublicLang('', [])).toBe('en')
    expect(pickPublicLang('?lang=', ['pt-BR', 'de'])).toBe('en')
  })
})

describe('isPublicCompPath', () => {
  it('matches /c and /c/<id> only', () => {
    expect(isPublicCompPath('/c')).toBe(true)
    expect(isPublicCompPath('/c/')).toBe(true)
    expect(isPublicCompPath('/c/0b7c8f7e-1d2a-4c3b-9e4f-5a6b7c8d9e0f')).toBe(true)
    expect(isPublicCompPath('/competitions')).toBe(false)
    expect(isPublicCompPath('/cx')).toBe(false)
    expect(isPublicCompPath('/c/a/b')).toBe(false)
  })
})

describe('legalLang', () => {
  it('zh keeps Chinese legal pages, everything else reads English', () => {
    expect(legalLang('zh')).toBe('zh')
    expect(legalLang('en')).toBe('en')
    expect(legalLang('ja')).toBe('en')
    expect(legalLang('th')).toBe('en')
    expect(legalLang('vi')).toBe('en')
  })
})
