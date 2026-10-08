// 公开比赛页的语言与路径判定（设计 §4）。App.tsx（核心包）也 import 本文件——
// 所以这里**不能出现任何 i18n 键的字符串**，否则 i18n.test.ts 会要求这些键进核心包。
// Language and path rules for the public competition page (spec §4). App.tsx (core
// bundle) imports this file too, so it must not contain any i18n key string, or
// i18n.test.ts would demand those keys live in the core bundle.
import { isAppLang, type AppLang } from '../i18n'
import type { PublicLang } from '../seo/meta'

const PUBLIC_COMP_PATH_RE = /^\/c(?:\/[^/]+)?\/?$/

export function isPublicCompPath(pathname: string): boolean {
  return PUBLIC_COMP_PATH_RE.test(pathname)
}

const two = (v: string | null | undefined) => (v ?? '').trim().toLowerCase().slice(0, 2)

// ?lang= → 浏览器语言列表里第一个支持的 → en。不读也不写本机偏好：访客点开链接
// 不该改掉他自己选过的语言（注册成功后由 Part D 的 persistLanguageIfUnset 持久化）。
// ?lang= → first supported browser language → en. Neither reads nor writes the stored
// preference: opening a link must not change a language someone chose (Part D persists
// it after signup via persistLanguageIfUnset).
export function pickPublicLang(search: string, navLangs: readonly string[]): AppLang {
  const q = two(new URLSearchParams(search).get('lang'))
  if (isAppLang(q)) return q
  for (const raw of navLangs) {
    const l = two(raw)
    if (isAppLang(l)) return l
  }
  return 'en'
}

export function browserLangs(): string[] {
  if (typeof navigator === 'undefined') return []
  const list = Array.isArray(navigator.languages) && navigator.languages.length > 0 ? navigator.languages : [navigator.language]
  return list.filter((x): x is string => typeof x === 'string')
}

// 法务页只有中英两套 URL；ja/th/vi 指向英文版。/ Legal pages exist in zh + en only.
export function legalLang(lang: AppLang): PublicLang {
  return lang === 'zh' ? 'zh' : 'en'
}
