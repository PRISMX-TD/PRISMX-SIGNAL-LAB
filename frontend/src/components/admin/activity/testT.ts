// 单测用的真 t：按 i18n/index.ts 的同一套选项建一个独立的 i18next 实例，装上核心包 + 按需包，
// 让操作日志的句子在 zh / en 下按真实文案拼出来（不是回显 key）。只给 *.test.ts 用。
// A real `t` for tests: a standalone i18next instance with the same options as
// i18n/index.ts and both locale halves loaded, so activity sentences are built from the
// real zh / en copy rather than echoed keys. Test-only.
import i18next, { type i18n as I18n, type TFunction } from 'i18next'
import zhCore from '../../../i18n/zh.json'
import zhMore from '../../../i18n/zh.more.json'
import enCore from '../../../i18n/en.json'
import enMore from '../../../i18n/en.more.json'

export function makeI18n(lang: 'zh' | 'en'): I18n {
  const inst = i18next.createInstance()
  void inst.init({
    lng: lang,
    resources: { zh: { translation: zhCore }, en: { translation: enCore } },
    fallbackLng: false,
    initImmediate: false,
    interpolation: { escapeValue: false },
    nsSeparator: false,
    keySeparator: '.',
  })
  inst.addResourceBundle('zh', 'translation', zhMore, true, true)
  inst.addResourceBundle('en', 'translation', enMore, true, true)
  return inst
}

export function makeT(lang: 'zh' | 'en'): TFunction {
  return makeI18n(lang).getFixedT(lang)
}
