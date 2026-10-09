// /intro 是落地页的第二个地址（游客预览开着时首页换成带锁的仪表盘）：语言判定与中英互跳
// 都要把它当首页，但它不是首页根路径——首页模式判定只认 / 与 /en。
// /intro is the landing page's second address (with the guest preview on, home becomes the
// locked dashboard): language detection and the zh/en switch treat it as home, but it is not
// the home root — the home-mode decision applies to / and /en only.
import { describe, expect, it } from 'vitest'
import { counterpartPath, isHomeRoot, langFromPath, pageFromPath } from './meta'

describe('landing alias', () => {
  it('resolves /intro and /en/intro as the home page in each language', () => {
    expect(pageFromPath('/intro')).toMatchObject({ page: { id: 'home' }, lang: 'zh' })
    expect(pageFromPath('/en/intro/')).toMatchObject({ page: { id: 'home' }, lang: 'en' })
    expect(langFromPath('/en/intro')).toBe('en')
  })

  it('switches language within the alias instead of jumping to the home root', () => {
    expect(counterpartPath('/intro', 'en')).toBe('/en/intro')
    expect(counterpartPath('/en/intro', 'zh')).toBe('/intro')
    expect(counterpartPath('/', 'en')).toBe('/en')
  })

  it('only / and /en are the home root', () => {
    expect(isHomeRoot('/')).toBe(true)
    expect(isHomeRoot('/en')).toBe(true)
    expect(isHomeRoot('/en/')).toBe(true)
    expect(isHomeRoot('/intro')).toBe(false)
    expect(isHomeRoot('/en/intro')).toBe(false)
    expect(isHomeRoot('/faq')).toBe(false)
  })
})
