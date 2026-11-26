// 图表财经事件的数据：按可见时间范围分块拉日历（每块 ≤14 天，最远往回 120 天），块结果放在
// 模块级缓存里（多个图表、切品种、来回平移都不重复请求）。含「今天」的块每 2 分钟重拉一次，
// 公布值出来后图上能看到；全在过去的块本次会话不再重拉；全在未来的 30 分钟一次。
// 请求一律按重要度 ≥2 拉，1 档的黄色数据图上不画；切到「只看 3 档」在本地过滤。
// 日历没对用户开放时后端返回空列表（public=false），这里照样缓存，不反复打。
// Chart econ events data: fetch the calendar in blocks covering the visible range (≤14 days per
// call, at most 120 days back) and cache each block at module level, so multiple charts, symbol
// switches and panning never refetch. The block containing today refetches every 2 min so actuals
// show up; fully past blocks never refetch this session; fully future ones every 30 min. Requests
// always use importance ≥2 (yellow level-1 data is never drawn); "level 3 only" filters locally.
// A non-public calendar returns an empty list (public=false), cached the same way.
import { useEffect, useMemo, useState } from 'react'
import { econApi } from '../../../api/client'
import type { EconGroup } from '../../../api/econTypes'
import { currenciesForSymbol } from './econSymbols'
import { BLOCK_DAYS, toEvents, windowsFor, type EconEvent, type ReqWindow } from './econEvents'

const FETCH_MIN_IMP = 2
const TODAY_TTL = 2 * 60_000
const FUTURE_TTL = 30 * 60_000
const ERROR_TTL = 5 * 60_000
const POLL_MS = 60_000

interface Entry {
  items: EconGroup[]
  public: boolean
  at: number
  error: boolean
  inflight: Promise<void> | null
}

const cache = new Map<string, Entry>()
const listeners = new Set<() => void>()
const notify = () => listeners.forEach((fn) => fn())

function ttlOf(w: ReqWindow, e: Entry, nowMs: number): number {
  if (e.error) return ERROR_TTL
  const now = nowMs / 1000
  if (w.to + 86400 < now) return Number.POSITIVE_INFINITY
  if (w.from - 86400 > now) return FUTURE_TTL
  return TODAY_TTL
}

function ensure(w: ReqWindow, nowMs: number): void {
  const e = cache.get(w.start)
  if (e && (e.inflight || nowMs - e.at < ttlOf(w, e, nowMs))) return
  const entry: Entry = e ?? { items: [], public: true, at: 0, error: false, inflight: null }
  entry.inflight = econApi.calendar(w.start, w.days, FETCH_MIN_IMP)
    .then((r) => {
      entry.items = Array.isArray(r.items) ? r.items : []
      entry.public = r.public !== false
      entry.error = false
    })
    .catch(() => { entry.error = true })
    .finally(() => {
      entry.at = Date.now()
      entry.inflight = null
      notify()
    })
  cache.set(w.start, entry)
}

/** 测试用：清空模块缓存 / tests: clear the module cache */
export function _resetEconCache() { cache.clear() }

export interface EconEventsOpts {
  enabled?: boolean
  /** 2 = 中 + 高（默认）；3 = 只看高 / 2 = medium + high (default); 3 = high only */
  minImportance?: number
}

export interface EconEventsResult {
  events: EconEvent[]
  /** false = 日历未对用户开放 / the calendar is not public */
  public: boolean
  loading: boolean
  nowMs: number
}

/** visibleFrom / visibleTo：图表可见时间范围（unix 秒），含最新 K 线右侧的空白区更好。
 *  visibleFrom / visibleTo: the chart's visible time range in unix seconds (ideally incl. the whitespace past the last bar). */
export function useEconEvents(symbol: string, visibleFrom: number | null, visibleTo: number | null, opts: EconEventsOpts = {}): EconEventsResult {
  const enabled = opts.enabled !== false
  const minImp = opts.minImportance ?? 2
  const [nowMs, setNow] = useState(() => Date.now())
  const [, setRev] = useState(0)

  // 每分钟走一次：更新「即将公布」状态并按 TTL 重拉今天的块；页面隐藏时不走
  // Tick once a minute: refresh the upcoming state and refetch today's block per TTL; idle while hidden
  useEffect(() => {
    if (!enabled) return
    const tick = () => { if (typeof document === 'undefined' || !document.hidden) setNow(Date.now()) }
    const id = window.setInterval(tick, POLL_MS)
    const onVis = () => { if (!document.hidden) setNow(Date.now()) }
    document.addEventListener('visibilitychange', onVis)
    return () => { window.clearInterval(id); document.removeEventListener('visibilitychange', onVis) }
  }, [enabled])

  useEffect(() => {
    if (!enabled) return
    const fn = () => setRev((r) => r + 1)
    listeners.add(fn)
    return () => { listeners.delete(fn) }
  }, [enabled])

  const wins = useMemo(
    () => (enabled && visibleFrom != null && visibleTo != null ? windowsFor(visibleFrom, visibleTo, nowMs / 1000) : []),
    // 分块是固定的：只要块的集合不变，平移不会换出新的数组 / fixed blocks: panning keeps the same set
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [enabled, blockKey(visibleFrom, visibleTo, nowMs)],
  )

  useEffect(() => {
    for (const w of wins) ensure(w, nowMs)
  }, [wins, nowMs])

  const ccys = useMemo(() => currenciesForSymbol(symbol), [symbol])
  const entries = wins.map((w) => cache.get(w.start))
  const sig = entries.map((e) => (e ? `${e.at}` : '-')).join('|')
  const events = useMemo(() => {
    const all: EconGroup[] = []
    for (const e of entries) if (e) all.push(...e.items)
    return toEvents(all, ccys, minImp)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, ccys, minImp])
  return {
    events,
    public: entries.every((e) => !e || e.public),
    loading: entries.some((e) => !e || (e.at === 0 && e.inflight != null)),
    nowMs,
  }
}

// 可见范围落在哪几块 + 今天是哪一天，作为 memo 键 / which blocks are visible + today, as a memo key
function blockKey(from: number | null, to: number | null, nowMs: number): string {
  if (from == null || to == null) return ''
  const span = BLOCK_DAYS * 86400
  return `${Math.floor(from / span)}:${Math.floor(to / span)}:${Math.floor(nowMs / 86400_000)}`
}
