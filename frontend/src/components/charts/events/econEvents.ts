// 图表财经事件的纯函数：日历分组 → 图上的事件、请求窗口的切分、按像素聚簇。
// 没有 React / 图表库依赖，单测直接跑。
// Pure helpers for chart econ events: calendar groups → chart events, request-window
// splitting, and clustering by pixel. No React / chart-library dependency, unit-tested directly.
import type { EconGroup } from '../../../api/econTypes'
import { currencyOf } from './econSymbols'

export interface EconEvent {
  key: string
  /** 公布时刻（unix 秒）；全天事件 = 当天 00:00 UTC / release time (unix s); all-day = 00:00 UTC */
  t: number
  currency: string
  importance: number
  allDay: boolean
  group: EconGroup
}

const DAY = 86400

export function eventTime(g: EconGroup): number | null {
  if (g.at) {
    const ms = Date.parse(g.at)
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : null
  }
  if (g.date) {
    const ms = Date.parse(`${g.date}T00:00:00Z`)
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : null
  }
  return null
}

/** 日历分组 → 图上的事件：按货币、重要度过滤，去掉取消的，按时间排序、按 key 去重。
 *  Groups → chart events: filter by currency and importance, drop cancelled, sort by time, dedupe by key. */
export function toEvents(groups: Iterable<EconGroup>, currencies: readonly string[], minImportance: number): EconEvent[] {
  const want = new Set(currencies)
  const seen = new Set<string>()
  const out: EconEvent[] = []
  for (const g of groups) {
    if (seen.has(g.key) || g.status === 'cancelled' || g.importance < minImportance) continue
    const ccy = currencyOf(g)
    if (!want.has(ccy)) continue
    const t = eventTime(g)
    if (t == null) continue
    seen.add(g.key)
    out.push({ key: g.key, t, currency: ccy, importance: g.importance, allDay: g.allDay || !g.at, group: g })
  }
  return out.sort((a, b) => a.t - b.t || b.importance - a.importance)
}

// ── 请求窗口 / request windows ──
// 接口一次最多 14 天。按固定的 12 天块切分（块号 = 天数 / 12），每块请求「块起点前一天起的 14 天」，
// 两边各多一天，后端按哪个时区切日期都不会漏。块固定，缓存键就稳定，平移图表不会重复请求。
// The endpoint takes ≤14 days. Time is cut into fixed 12-day blocks (block = day / 12); each
// block requests the 14 days starting the day before it, one spare day on each side so the
// backend's day boundary can't drop events. Fixed blocks make stable cache keys, so panning
// never refetches.
export const BLOCK_DAYS = 12
export const REQ_DAYS = 14
export const MAX_BACK_DAYS = 120
export const MAX_AHEAD_DAYS = 14

const ymdUtc = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 10)

export interface ReqWindow {
  /** 缓存键 = 请求起始日 / cache key = request start date */
  start: string
  days: number
  /** 这一块覆盖的时间（秒）/ the block's span (s) */
  from: number
  to: number
}

/** 覆盖 [from, to] 的请求窗口，限制在 now−120 天到 now+14 天之间。
 *  Windows covering [from, to], clamped to now−120 days … now+14 days. */
export function windowsFor(from: number, to: number, nowSec: number): ReqWindow[] {
  if (!Number.isFinite(from) || !Number.isFinite(to)) return []
  const lo = Math.max(Math.min(from, to), nowSec - MAX_BACK_DAYS * DAY)
  const hi = Math.min(Math.max(from, to), nowSec + MAX_AHEAD_DAYS * DAY)
  if (hi < lo) return []
  const span = BLOCK_DAYS * DAY
  const out: ReqWindow[] = []
  for (let b = Math.floor(lo / span); b <= Math.floor(hi / span) && out.length < 16; b++) {
    const s = b * span
    out.push({ start: ymdUtc(s - DAY), days: REQ_DAYS, from: s, to: s + span })
  }
  return out
}

// ── 聚簇 / clustering ──
export interface Placed<T> { x: number; item: T }
export interface Cluster<T> {
  /** 簇中心 x（簇内各点的平均）/ cluster centre x (mean of members) */
  x: number
  items: T[]
}

/** 按 x 聚簇：排序后，与簇里第一个点相距不到 gap 像素的并进同一簇。
 *  Cluster by x: after sorting, a point within `gap` px of the cluster's first point joins it. */
export function clusterByX<T>(points: Placed<T>[], gap: number): Cluster<T>[] {
  const sorted = [...points].sort((a, b) => a.x - b.x)
  const out: Cluster<T>[] = []
  let start = Number.NEGATIVE_INFINITY
  let cur: { xs: number[]; items: T[] } | null = null
  const flush = () => {
    if (!cur) return
    out.push({ x: cur.xs.reduce((s, v) => s + v, 0) / cur.xs.length, items: cur.items })
  }
  for (const p of sorted) {
    if (cur && p.x - start < gap) {
      cur.xs.push(p.x)
      cur.items.push(p.item)
    } else {
      flush()
      start = p.x
      cur = { xs: [p.x], items: [p.item] }
    }
  }
  flush()
  return out
}

/** 命中测试：返回离 (x, y) 最近、在 r 像素内的簇下标 / nearest cluster within r px of (x, y) */
export function hitCluster(xs: readonly number[], cy: number, x: number, y: number, r: number): number {
  if (Math.abs(y - cy) > r) return -1
  let best = -1
  let bd = r
  for (let i = 0; i < xs.length; i++) {
    const d = Math.abs(xs[i] - x)
    if (d <= bd) { bd = d; best = i }
  }
  return best
}

/** 簇的稳定 id（第一个事件的 key + 个数）/ a stable cluster id */
export const clusterId = (c: Cluster<EconEvent>) => `${c.items[0]?.key ?? ''}#${c.items.length}`
