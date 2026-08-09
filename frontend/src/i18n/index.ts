import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import zh from './zh.json'
import en from './en.json'
import { langFromPath } from '../seo/meta'

// 初始语言判定，按优先级：
// ① 公开页 URL（/en 前缀 = 英文）——公开页语言由 URL 决定，这也保证预渲染
//    HTML（英文）与客户端首帧（若按 localStorage 是中文）不会闪一次错语言；
// ② localStorage 记忆（登录后的应用路由走这里）；
// ③ 默认中文。
// SSR（预渲染构建）环境三者皆无：window/localStorage 不存在，用 zh 起步，
// 预渲染脚本渲染前会显式 changeLanguage，这里只需不崩。
const canUseDom = typeof window !== 'undefined'
const urlLang = canUseDom ? langFromPath(window.location.pathname) : null
const saved = urlLang || (canUseDom && localStorage.getItem('prismx_lang')) || 'zh'

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
  if (typeof document === 'undefined') return
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

// 同步界面语言但不写偏好：公开页按 URL 被动同步时用——访客点开 /en 不该
// 悄悄覆盖他 localStorage 里的语言偏好；主动点语言切换才走 setLanguage。
export function syncLanguage(lang: 'zh' | 'en') {
  if (i18n.language !== lang) i18n.changeLanguage(lang)
  applyHtmlLang(lang)
}

export default i18n
