// 看板时间范围的前端状态：URL 读写、自定义区间校验、转请求参数。
// 预设 → 具体起止日期的换算在后端（stats_time.resolve_range），这里不算日期：
// 前端没有单测框架，"本周从周一起"这类规则放后端才能被 pytest 钉住。
// Dashboard range state: URL (de)serialisation, custom-range validation, and
// conversion to the API query. Preset → dates is resolved server-side.
import type { OverviewRangePreset, StatsRangeQuery } from '../../../api/types'

export type RangeState =
  | { kind: 'preset'; preset: OverviewRangePreset }
  | { kind: 'custom'; from: string; to: string }

export const PRESETS: OverviewRangePreset[] = ['week', 'month', 'last_month', 'quarter', 'year']
// 与后端 stats_time.MAX_RANGE_DAYS 一致 / mirrors the backend cap
export const MAX_RANGE_DAYS = 400
export const DEFAULT_RANGE: RangeState = { kind: 'preset', preset: 'month' }

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/

export function readRange(params: URLSearchParams): RangeState {
  const from = params.get('from')
  const to = params.get('to')
  if (from && to && ISO_DAY.test(from) && ISO_DAY.test(to)) return { kind: 'custom', from, to }
  const preset = params.get('range')
  if (preset && (PRESETS as string[]).includes(preset)) return { kind: 'preset', preset: preset as OverviewRangePreset }
  return DEFAULT_RANGE
}

export function writeRange(params: URLSearchParams, state: RangeState): URLSearchParams {
  const next = new URLSearchParams(params)
  next.delete('range'); next.delete('from'); next.delete('to')
  if (state.kind === 'preset') next.set('range', state.preset)
  else { next.set('from', state.from); next.set('to', state.to) }
  return next
}

export function toQuery(state: RangeState): StatsRangeQuery {
  return state.kind === 'preset' ? { preset: state.preset } : { from: state.from, to: state.to }
}

export function rangeKey(state: RangeState): string {
  return state.kind === 'preset' ? state.preset : `${state.from}..${state.to}`
}

export function todayIso(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1
}

// 返回错误码（对应 i18n admin.overview.range.error.*），合法返回 null。
// 浏览器本地"今天"与后端 STATS_TZ 的"今天"可能差一天，后端还会再校验一次。
// Error code for i18n, or null. The browser's "today" may differ from STATS_TZ
// by a day; the backend validates again.
export function customRangeError(from: string, to: string): 'order' | 'future' | 'tooLong' | 'incomplete' | null {
  if (!ISO_DAY.test(from) || !ISO_DAY.test(to)) return 'incomplete'
  if (from > to) return 'order'
  if (to > todayIso()) return 'future'
  if (daysBetween(from, to) > MAX_RANGE_DAYS) return 'tooLong'
  return null
}
