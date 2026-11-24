// 网络层失败的浏览器原话（Failed to fetch 等）换成界面语言的说明；后端报错照旧。
// 2026-11-23：用户在 App 登录页看到裸的 "Failed to fetch"。
// The browsers' network-failure wording becomes a message in the UI language; backend errors
// are handled as before. A user saw a bare "Failed to fetch" on the App's login page.
import { afterEach, describe, expect, it } from 'vitest'
import i18n from '../i18n'
import { isNetworkErrorMessage, localizeApiError } from './utils'

describe('localizeApiError: network failures', () => {
  afterEach(async () => {
    await i18n.changeLanguage('zh')
  })

  it('各浏览器的「连不上」原话都认 / every browser wording is recognised', () => {
    for (const m of [
      'Failed to fetch',
      'NetworkError when attempting to fetch resource.',
      'Load failed',
      'The network connection was lost.',
      ' failed to fetch ',
    ]) {
      expect(isNetworkErrorMessage(m)).toBe(true)
    }
  })

  it('按界面语言给说明，不再露出英文原话 / says it in the UI language', async () => {
    await i18n.changeLanguage('zh')
    expect(localizeApiError('Failed to fetch')).toBe('网络连接失败，请检查网络后重试')
    for (const lang of ['en', 'ja', 'th', 'vi']) {
      await i18n.changeLanguage(lang)
      const text = localizeApiError('Failed to fetch')
      expect(text).not.toBe('Failed to fetch')
      expect(text).not.toBe('common.networkError')
      expect(text).not.toBe('网络连接失败，请检查网络后重试')
    }
  })

  it('只整句匹配：后端报错和带这几个词的长句不受影响 / whole-string only', async () => {
    await i18n.changeLanguage('zh')
    expect(isNetworkErrorMessage('Failed to fetch quotes for XAUUSD')).toBe(false)
    expect(localizeApiError('邮箱或密码错误 / Invalid email or password')).toBe('邮箱或密码错误')
    expect(localizeApiError('HTTP 500')).toBe('HTTP 500')
  })
})
