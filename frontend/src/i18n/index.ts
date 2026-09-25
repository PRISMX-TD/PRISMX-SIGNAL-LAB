import i18n, { type BackendModule, type ResourceKey } from 'i18next'
import { initReactI18next } from 'react-i18next'
import zh from './zh.json'
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

// 语言包按需加载：只有中文（默认语言 + fallbackLng，绝大多数用户）静态打进入口包，
// 英文包（~160 KB）走动态 import，第一次用到时才拉。此前两份 JSON 都在入口包里，
// 中文用户每次冷启动都白白下载、解析一份永远不看的英文。
// 以 i18next backend 插件的形式接入，而不是在 setLanguage 里手动拉：store/prefs.tsx
// 会按云端偏好直接调 i18n.changeLanguage('en')，backend 让 i18next 自己在切换前把
// 资源加载完（changeLanguage 等 loadResources 回调后才改 language、发
// languageChanged），任何调用点都不会看到裸 key。
// partialBundledLanguages：resources 里只有 zh，缺的语言仍交给 backend。
// read 回 (err, true) 让 BackendConnector 按 350ms 起指数退避重试（最多 5 次）——
// 大陆拉 Vercel chunk 丢包是常态，与 utils/lazyRetry.ts 同一个理由。
// SSR（seo/entry-server.tsx）在渲染前把 en 包静态 addResourceBundle 进来，不走这里。
// Locale bundles load on demand: only zh (default + fallbackLng, most users) is
// bundled into the entry; en (~160 KB) is a dynamic import fetched on first use.
// Wired as an i18next backend rather than a manual fetch in setLanguage, because
// store/prefs.tsx calls i18n.changeLanguage('en') directly from cloud prefs; with
// a backend, i18next itself loads resources before switching (language and
// languageChanged only change after loadResources), so no call site ever sees raw
// keys. read() answers (err, true) so BackendConnector retries with backoff.
// SSR (seo/entry-server.tsx) adds the en bundle statically before rendering.
const LAZY_LOCALES: Record<string, () => Promise<{ default: ResourceKey }>> = {
  en: () => import('./en.json'),
}

const localeBackend: BackendModule = {
  type: 'backend',
  init() {},
  read(lng, _ns, cb) {
    if (lng === 'zh') return cb(null, zh)
    const load = LAZY_LOCALES[lng]
    // 未知语言（不会出现，兜底）：给空包，让 fallbackLng 接手 / unknown: empty, fallback takes over
    if (!load) return cb(null, {})
    load().then(
      (m) => cb(null, m.default),
      (err) => cb(err, true),
    )
  },
}

// 首屏渲染前要等它：初始语言是 en 时，init 要等英文包到位才完成；在此之前
// useTranslation 会 suspend，把预渲染内容清成 Suspense 占位（见 main.tsx）。
// 初始语言是 zh 时它同步完成（资源已在包里），等一个 microtask 而已。
// Awaited before the first render: with an initial en, init completes only once
// the en bundle is in; until then useTranslation suspends and would blank the
// prerendered markup (see main.tsx). With zh it completes synchronously.
export const i18nReady: Promise<unknown> = i18n
  .use(localeBackend)
  .use(initReactI18next)
  .init({
  resources: {
    zh: { translation: zh },
  },
  partialBundledLanguages: true,
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
  // 英文包连重试都拉不下来时 init 仍会 resolve（界面按 fallbackLng 显示中文），
  // 这里只防 reject 冒成未处理的 Promise 错误。
  // init still resolves if the en bundle never arrives (UI falls back to zh);
  // this only keeps a rejection from surfacing as unhandled.
  .catch(() => {})

applyHtmlLang(saved)

// 用户主动切语言：先把语言包 load 完，再 changeLanguage。记下「最后一次要的语言」：
// 连点两下（en 还在下载时又点回 zh）时，晚到的 en 不该把界面再翻回英文。
// User-initiated switch: load the bundle first, then changeLanguage. The last
// requested language wins, so a late en bundle can't flip the UI back after the
// user already toggled to zh again.
let wantedLang: 'zh' | 'en' | null = null
export function setLanguage(lang: 'zh' | 'en') {
  wantedLang = lang
  writeStorage('prismx_lang', lang)
  void i18n.loadLanguages(lang).then(() => {
    if (wantedLang !== lang) return
    void i18n.changeLanguage(lang)
    applyHtmlLang(lang)
  })
}

// 同步界面语言但不写偏好：公开页按 URL 被动同步时用——访客点开 /en 不该
// 悄悄覆盖他 localStorage 里的语言偏好；主动点语言切换才走 setLanguage。
export function syncLanguage(lang: 'zh' | 'en') {
  if (i18n.language !== lang) i18n.changeLanguage(lang)
  applyHtmlLang(lang)
}

export default i18n
