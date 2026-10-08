import i18n, { type BackendModule, type ResourceKey } from 'i18next'
import { initReactI18next } from 'react-i18next'
import zh from './zh.json'
import { langFromPath } from '../seo/meta'
import { readStorage, writeStorage } from '../utils/safeStorage'

// 语言包拆成「核心 + 按需」两份：
//   zh.json / en.json           核心：入口、Layout、公开页（落地/法务/FAQ/登录）、预渲染用到的键
//   zh.more.json / en.more.json 按需：只有登录后的功能页（管理后台、策略、图表、订单……）用到的键
// 文件名沿用 zh.json / en.json，是因为 seo/entry-server.tsx 与 scripts/prerender.mjs 按这两个名字
// 引用英文核心包（公开页只用核心键）。按需包由 App.tsx 的 lazyPage 在页面 chunk 旁一起拉
// （ensureMoreLocale），页面渲染前必然就绪。新增键放哪一份，由 i18n.test.ts 按代码里的实际
// 引用关系校验：入口/Layout/公开页用到的键必须在核心包里。
// The bundle is split into core + on-demand halves. zh.json / en.json keep their names
// because seo/entry-server.tsx and scripts/prerender.mjs import them (public pages only need
// core keys). The `.more.json` halves are fetched by App.tsx's lazyPage next to the page chunk
// (ensureMoreLocale), so they are always in before a page renders. i18n.test.ts verifies the
// placement against real usage: keys used by the entry / Layout / public pages must be core.

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
// 界面支持的语言。zh / en 是完整的两套；ja / th / vi 只覆盖界面文案——公开页（落地、
// 法务、FAQ）仍只有中英两套 URL，管理后台只给运营用，这两块缺的键按 fallbackLng 落到英文。
// 公告、邮件这类后台内容只存中英两份，新语言一律显示英文那份（见 api/utils 的 pickLang）。
// Supported UI languages. zh / en are complete; ja / th / vi cover the app UI only — the
// public pages (landing, legal, FAQ) still exist only as zh / en URLs and the admin console is
// operator-only, so keys missing there fall back to English. Announcements / emails are stored
// in zh + en only; the new languages read the English half (see pickLang in api/utils).
export type AppLang = 'zh' | 'en' | 'ja' | 'th' | 'vi'
export const APP_LANGS: { code: AppLang; label: string; short: string }[] = [
  { code: 'zh', label: '简体中文', short: '中' },
  { code: 'en', label: 'English', short: 'EN' },
  { code: 'ja', label: '日本語', short: 'JA' },
  { code: 'th', label: 'ไทย', short: 'TH' },
  { code: 'vi', label: 'Tiếng Việt', short: 'VI' },
]
export function isAppLang(v: unknown): v is AppLang {
  return typeof v === 'string' && APP_LANGS.some((l) => l.code === v)
}
// 当前界面语言归一成 AppLang（i18n.language 可能是 undefined 或带地区后缀）。
// Current UI language normalised to an AppLang.
export function currentLang(): AppLang {
  const l = (i18n.language || '').slice(0, 2)
  return isAppLang(l) ? l : 'zh'
}
// Intl 用的地区标签 / BCP-47 tag for Intl and <html lang>
export const LOCALE_TAG: Record<AppLang, string> = {
  zh: 'zh-CN', en: 'en-GB', ja: 'ja-JP', th: 'th-TH', vi: 'vi-VN',
}

const stored = canUseDom ? readStorage('prismx_lang') : null // = LANG_KEY
const saved: AppLang = urlLang || (isAppLang(stored) ? stored : 'zh')

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
  document.documentElement.lang = lang === 'en' ? 'en' : isAppLang(lang) ? LOCALE_TAG[lang] : 'zh-CN'
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
  ja: () => import('./ja.json'),
  th: () => import('./th.json'),
  vi: () => import('./vi.json'),
}

// 按需包（见文件头）。/ On-demand halves (see the file header).
const MORE_LOCALES: Record<string, () => Promise<{ default: ResourceKey }>> = {
  zh: () => import('./zh.more.json'),
  en: () => import('./en.more.json'),
  ja: () => import('./ja.more.json'),
  th: () => import('./th.more.json'),
  vi: () => import('./vi.more.json'),
}
// 新语言缺的键（公开页 / 管理后台）落到英文，所以按需包也要连英文的一起补。
// The new languages fall back to English for keys they lack, so their on-demand half
// brings the English one along.
const MORE_FALLBACK: Record<string, string> = { ja: 'en', th: 'en', vi: 'en' }
const moreLoaded = new Set<string>()
const moreLoading = new Map<string, Promise<void>>()

function loadMore(lng: string): Promise<void> {
  const fb = MORE_FALLBACK[lng]
  if (fb) return Promise.all([loadMore(fb), loadOwnMore(lng)]).then(() => {})
  return loadOwnMore(lng)
}

function loadOwnMore(lng: string): Promise<void> {
  const load = MORE_LOCALES[lng]
  if (!load || moreLoaded.has(lng)) return Promise.resolve()
  let p = moreLoading.get(lng)
  if (!p) {
    // 先确保核心包已在库里：i18next 见到「该语言已有资源」就不再走 backend，
    // 若先塞按需包，英文核心包会永远没人去拉。
    // Core first: once a language has any resources i18next skips the backend, so adding
    // the on-demand half first would leave the en core bundle never fetched.
    p = i18n
      .loadLanguages(lng)
      .then(() => load())
      .then((m) => {
        i18n.addResourceBundle(lng, 'translation', m.default, true, true)
        moreLoaded.add(lng)
      })
      .finally(() => moreLoading.delete(lng))
    moreLoading.set(lng, p)
  }
  return p
}

// 登录后功能页渲染前调用（App.tsx 的 lazyPage）：拉当前语言的按需包。之后切换语言时
// changeLanguage 会先把新语言的按需包补上，所以各调用点（含 store/prefs.tsx 直接调
// changeLanguage）都不会看到裸 key。失败会 reject，由调用方（lazyRetry）重试。
// Called before a signed-in feature page renders (lazyPage in App.tsx): fetches the current
// language's on-demand half. After that, changeLanguage adds the new language's half first,
// so no call site (including store/prefs.tsx calling changeLanguage directly) sees raw keys.
// Rejects on failure so the caller (lazyRetry) can retry.
let moreWanted = false
export function ensureMoreLocale(): Promise<void> {
  moreWanted = true
  return loadMore(i18n.language || saved)
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
  fallbackLng: { ja: ['en'], th: ['en'], vi: ['en'], default: ['zh'] },
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

// 已经用过按需包之后，任何路径的切换语言都先补上目标语言的按需包（补不上也照常切，
// 缺的键按 fallbackLng 显示，好过界面卡住）。
// Once the on-demand half has been used, every language switch first adds the target's
// half (a failure still switches; missing keys fall back rather than blocking the UI).
const rawChangeLanguage = i18n.changeLanguage.bind(i18n)
i18n.changeLanguage = ((lng?: string, callback?: Parameters<typeof rawChangeLanguage>[1]) => {
  const pre = moreWanted && lng ? loadMore(lng).catch(() => {}) : Promise.resolve()
  return pre.then(() => rawChangeLanguage(lng, callback))
}) as typeof i18n.changeLanguage

applyHtmlLang(saved)

// 用户主动切语言：先把语言包 load 完，再 changeLanguage。记下「最后一次要的语言」：
// 连点两下（en 还在下载时又点回 zh）时，晚到的 en 不该把界面再翻回英文。
// User-initiated switch: load the bundle first, then changeLanguage. The last
// requested language wins, so a late en bundle can't flip the UI back after the
// user already toggled to zh again.
//
// at = 这次选择发生的时间，和语言一起存（prismx_lang_at）并随云端偏好同步。云端偏好
// 只有比本机更新时才覆盖本机（见 store/prefs.tsx 的 applyCloudLanguage）。此前云端
// 无条件覆盖：iOS PWA 切完语言立刻退到后台/被杀，500ms 防抖的云端保存没发出去（或
// 发失败后不再重试），之后每次冷启动云端那份旧语言都把界面翻回去。
// at = when this choice was made, stored with the language (prismx_lang_at) and
// synced with the cloud prefs. Cloud prefs only override the device when newer (see
// applyCloudLanguage in store/prefs.tsx). They used to override unconditionally: an
// iOS PWA backgrounded/killed right after switching never sent the debounced save
// (or it failed and was never retried), and every cold start flipped back.
const LANG_KEY = 'prismx_lang'
const LANG_AT_KEY = 'prismx_lang_at'

/** 本机存的界面语言；没有或读不到为 null / the device's stored UI language */
export function storedLang(): AppLang | null {
  const s = readStorage(LANG_KEY)
  return isAppLang(s) ? s : null
}

/** 本机语言选择的时间戳；旧版本存的没有时间戳，记 0 / when it was chosen, 0 if unknown */
export function storedLangAt(): number {
  const n = Number(readStorage(LANG_AT_KEY))
  return Number.isFinite(n) && n > 0 ? n : 0
}

let wantedLang: AppLang | null = null
export function setLanguage(lang: AppLang, at: number = Date.now()) {
  wantedLang = lang
  writeStorage(LANG_KEY, lang)
  writeStorage(LANG_AT_KEY, String(at))
  void i18n.loadLanguages(lang).then(() => {
    if (wantedLang !== lang) return
    void i18n.changeLanguage(lang)
    applyHtmlLang(lang)
  })
}

// 同步界面语言但不写偏好：公开页按 URL 被动同步时用——访客点开 /en 不该
// 悄悄覆盖他 localStorage 里的语言偏好；主动点语言切换才走 setLanguage。
export function syncLanguage(lang: AppLang) {
  if (i18n.language !== lang) i18n.changeLanguage(lang)
  applyHtmlLang(lang)
}

export default i18n
