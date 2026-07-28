import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import zh from './zh.json'
import en from './en.json'

const saved = localStorage.getItem('prismx_lang') || 'zh'

// <html lang> 必须跟着界面语言走，而不是一直停在 index.html 里写死的初值。
// 它决定屏幕阅读器用哪种语言发音、浏览器要不要弹「翻译此页」、以及搜索引擎
// 判定页面语种——切到英文界面后仍然声明 zh，这三件事全都是错的。
// 单独抽成函数并在 setLanguage 里调用，而不是塞进某个组件的 effect：语言可以在
// 组件挂载之前就从 localStorage 恢复，放组件里会慢一拍。
// <html lang> has to follow the UI language rather than sitting on whatever
// index.html hardcoded. It drives screen-reader pronunciation, whether the
// browser offers "translate this page", and how search engines classify the
// page — all three are wrong if it still says zh after switching to English.
// Kept as a standalone function called from setLanguage rather than a component
// effect, since the language is restored from localStorage before any component
// mounts and an effect would apply it a beat late.
function applyHtmlLang(lang: string) {
  document.documentElement.lang = lang === 'en' ? 'en' : 'zh-CN'
}

i18n.use(initReactI18next).init({
  resources: {
    zh: { translation: zh },
    en: { translation: en },
  },
  lng: saved,
  fallbackLng: 'zh',
  interpolation: { escapeValue: false },
})

applyHtmlLang(saved)

export function setLanguage(lang: 'zh' | 'en') {
  i18n.changeLanguage(lang)
  localStorage.setItem('prismx_lang', lang)
  applyHtmlLang(lang)
}

export default i18n
