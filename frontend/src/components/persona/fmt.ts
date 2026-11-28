// 交易报告各处共用的数字、日期格式（原来在 PersonaPage 里，2026-11-28 新增的几个面板也要用，拆出来）。
// Number and date formatting shared across the trading report (lifted out of PersonaPage for the panels
// added 2026-11-28).
import { LOCALE_TAG, currentLang } from '../../i18n'
import { EMPTY } from '../../utils/format'

export type T = (k: string, o?: Record<string, unknown>) => string

export const money = (v: number | null | undefined, sign = true) => {
  if (v == null || !Number.isFinite(v)) return EMPTY
  const s = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return `${sign ? (v > 0 ? '+' : v < 0 ? '−' : '') : v < 0 ? '−' : ''}$${s}`
}
export const pct = (v: number | null | undefined, digits = 0) => (v == null || !Number.isFinite(v) ? EMPTY : `${(v * 100).toFixed(digits)}%`)
export const num = (v: number | null | undefined, digits = 2) => (v == null || !Number.isFinite(v) ? EMPTY : v.toFixed(digits))
export const tone = (v: number | null | undefined) => (v == null ? '' : v > 0 ? 'is-up' : v < 0 ? 'is-down' : '')

export function intlTag(lang: string) {
  const tag = LOCALE_TAG[currentLang()] ?? lang
  return tag.startsWith('th') ? `${tag}-u-ca-gregory` : tag
}

export function monthLabel(period: string, lang: string, month: 'short' | 'long' = 'short') {
  const [y, m] = period.split('-').map(Number)
  try {
    return new Intl.DateTimeFormat(intlTag(lang), { year: 'numeric', month, timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, 1)))
  } catch {
    return period
  }
}

// 只有月份、不带年（年度报告的逐月图用）/ month only, no year (annual month-by-month chart)
export function monthOnly(period: string, lang: string) {
  const [y, m] = period.split('-').map(Number)
  try {
    return new Intl.DateTimeFormat(intlTag(lang), { month: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, 1)))
  } catch {
    return String(m)
  }
}

export function dayLabel(period: string, day: number, lang: string) {
  const [y, m] = period.split('-').map(Number)
  try {
    return new Intl.DateTimeFormat(intlTag(lang), { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, day)))
  } catch {
    return `${m}-${day}`
  }
}

/** 'YYYY-MM-DD'（或 ISO 时间）→ 「11月3日」这样的短日期，按 UTC。/ A short UTC date from 'YYYY-MM-DD' or an ISO time. */
export function shortDate(iso: string | null | undefined, lang: string) {
  if (!iso) return EMPTY
  const d = new Date(iso.length <= 10 ? `${iso}T00:00:00Z` : iso)
  if (Number.isNaN(d.getTime())) return EMPTY
  try {
    return new Intl.DateTimeFormat(intlTag(lang), { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(d)
  } catch {
    return iso.slice(5, 10)
  }
}

export function fmtMinutes(t: T, m: number) {
  if (m < 1) return t('persona.unit.sec', { n: Math.max(1, Math.round(m * 60)) })
  if (m < 90) return t('persona.unit.min', { n: Math.round(m) })
  return t('persona.unit.hour', { n: (m / 60).toFixed(1) })
}

export const shortMoney = (v: number) => {
  const a = Math.abs(v)
  const s = a >= 1000 ? `${(a / 1000).toFixed(1)}k` : a >= 100 ? a.toFixed(0) : a.toFixed(1)
  return `${v < 0 ? '−' : '+'}${s}`
}
