// 注册成功后把访客当前的界面语言存下来（公开比赛页用 syncLanguage 临时切换、不落盘）。
// 已存过语言的绝不覆盖；at=0 是「弱」记录，留给云端带时间戳的偏好覆盖。
// After signup, persist the visitor's current UI language (the public competition page
// switches with syncLanguage, unpersisted). Never overwrite a stored choice; at=0 is a weak
// write a stamped cloud preference may override.
import { afterEach, describe, expect, it, vi } from 'vitest'

async function load(initial: Record<string, string> = {}) {
  vi.resetModules()
  const store = new Map(Object.entries(initial))
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
    location: { pathname: '/login' },
  })
  const mod = await import('./index')
  await mod.i18nReady
  return { mod, store }
}

// i18next 本身在 node_modules 里、不随 resetModules 重置：每次 load() 都对同一个实例重新
// init（lng 取自桩出来的存储），这正是我们要的「全新页面」语义。
// i18next lives in node_modules and is not reset by resetModules: each load() re-inits the
// same instance (lng from the stubbed storage), which gives the "fresh page" semantics needed.
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('persistLanguageIfUnset', () => {
  it('stores the current language with a timestamp when nothing is stored', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_000_000)
    const { mod, store } = await load()
    expect(mod.persistLanguageIfUnset()).toBe(true)
    expect(store.get('prismx_lang')).toBe('zh')
    expect(store.get('prismx_lang_at')).toBe('1000000')
  })

  it('stores a language switched via syncLanguage-style changeLanguage', async () => {
    const { mod, store } = await load()
    await mod.default.changeLanguage('en')
    expect(mod.persistLanguageIfUnset(0)).toBe(true)
    expect(store.get('prismx_lang')).toBe('en')
    expect(mod.storedLangAt()).toBe(0)
  })

  it('never overwrites an existing choice', async () => {
    const { mod, store } = await load({ prismx_lang: 'th', prismx_lang_at: '5' })
    expect(mod.persistLanguageIfUnset()).toBe(false)
    expect(store.get('prismx_lang')).toBe('th')
    expect(store.get('prismx_lang_at')).toBe('5')
  })
})
