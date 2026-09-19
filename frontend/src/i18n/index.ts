import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import zh from './zh.json'
import en from './en.json'
import { langFromPath } from '../seo/meta'
import { readStorage, writeStorage } from '../utils/safeStorage'

// 初始语言判定，按优先级：
// ① 公开页 URL（/en 前缀 = 英文）——公开页语言由 URL 决定，这也保证预渲染
//    HTML（英文）与客户端首帧（若按 localStorage 是中文）不会闪一次错语言；
// ② localStorage 记忆（登录后的应用路由走这里）；
// ③ 默认中文。
// SSR（预渲染构建）环境三者皆无：window/localStorage 不存在，用 zh 起步，
// 预渲染脚本渲染前会显式 changeLanguage，这里只需不崩。
// 存储访问走 safeStorage：这一行在**模块顶层**，被 main.tsx 的第三条 import 拉起，
// 比 React 挂载还早。Safari 无痕 / 企业策略禁用站点数据时裸 localStorage 会同步抛
// SecurityError，整个入口包就此起不来——用户看到的是白屏，且换个浏览器设置才好。
// Reads go through safeStorage because this line runs at *module scope*, pulled
// in by main.tsx's third import, before React mounts at all. A bare localStorage
// access throws SecurityError synchronously in Safari private mode or when site
// data is disabled by policy, which takes the whole entry bundle down to a blank
// page that only a browser-settings change can fix.
const canUseDom = typeof window !== 'undefined'
const urlLang = canUseDom ? langFromPath(window.location.pathname) : null
const saved = urlLang || (canUseDom && readStorage('prismx_lang')) || 'zh'

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
  // 关掉命名空间分隔符。i18next 默认把 key 里的第一个 `:` 当成「命名空间:键名」
  // 的分隔，而本项目只有一个命名空间，却有带冒号的真实 key（页面访问统计里的
  // `admin.pageStats.page./u/:publicId` 这类路由模板）。默认行为下这些 key 会被
  // 静默切成不存在的命名空间，t() 原样吐回 key 文本。此前靠每个调用点自己传
  // `nsSeparator: false` 绕过（目前只有 PageStatsCard 一处），漏一处就是界面上
  // 冒出一行 key——这个坑踩过一次，在这里一次性填掉。
  // keySeparator 显式写出默认值 '.'：关掉 ns 之后它是唯一还在解析 key 的规则，
  // 写出来免得下一个人以为两个分隔符一起关了。
  // Turn off the namespace separator. i18next treats the first `:` in a key as
  // "namespace:key", but this project has a single namespace and several real
  // keys containing colons (route templates such as
  // `admin.pageStats.page./u/:publicId` in the page-stats section). By default
  // those get silently split into a namespace that doesn't exist and t() echoes
  // the raw key back. It used to be worked around per call site with
  // `nsSeparator: false` (only PageStatsCard does so today) — miss one and a key
  // string shows up in the UI. Fixing it once, here. keySeparator is spelled out
  // at its default '.' so the next reader doesn't assume both were disabled.
  nsSeparator: false,
  keySeparator: '.',
})

applyHtmlLang(saved)

export function setLanguage(lang: 'zh' | 'en') {
  i18n.changeLanguage(lang)
  writeStorage('prismx_lang', lang)
  applyHtmlLang(lang)
}

// 同步界面语言但不写偏好：公开页按 URL 被动同步时用——访客点开 /en 不该
// 悄悄覆盖他 localStorage 里的语言偏好；主动点语言切换才走 setLanguage。
export function syncLanguage(lang: 'zh' | 'en') {
  if (i18n.language !== lang) i18n.changeLanguage(lang)
  applyHtmlLang(lang)
}

export default i18n
