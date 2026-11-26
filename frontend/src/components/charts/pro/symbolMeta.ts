// 品种的交易时段 / 合约规格（阶段 6 后端 /chart/sessions、/chart/spec）：每个品种只拉一次，进程内缓存，
// 失败的不缓存（下次打开再试）。以及把服务器日的分钟数换成图表时区的显示。单测见 symbolMeta.test.ts。
// A symbol's trading sessions / contract spec (phase-6 backend /chart/sessions, /chart/spec): fetched
// once per symbol and cached in memory; failures aren't cached (retried next time). Plus converting
// server-day minutes into the chart timezone for display. Tests in symbolMeta.test.ts.
import { useEffect, useState } from 'react'
import { chartApi } from '../../../api/client'
import type { ChartSessions, ChartSymbolSpec } from '../../../api/types'

type Entry<T> = { v?: T; p?: Promise<T | null> }
const sessCache = new Map<string, Entry<ChartSessions>>()
const specCache = new Map<string, Entry<ChartSymbolSpec>>()

function load<T>(cache: Map<string, Entry<T>>, key: string, fetch: () => Promise<T>): Promise<T | null> {
  const hit = cache.get(key)
  if (hit?.v) return Promise.resolve(hit.v)
  if (hit?.p) return hit.p
  const p = fetch().then((v) => { cache.set(key, { v }); return v }).catch(() => { cache.delete(key); return null })
  cache.set(key, { p })
  return p
}

function useCached<T>(cache: Map<string, Entry<T>>, symbol: string | null, fetch: (s: string) => Promise<T>): { data: T | null; loading: boolean } {
  const [state, setState] = useState<{ sym: string | null; data: T | null; loading: boolean }>(() => ({ sym: symbol, data: symbol ? cache.get(symbol)?.v ?? null : null, loading: false }))
  useEffect(() => {
    if (!symbol) { setState({ sym: null, data: null, loading: false }); return }
    const hit = cache.get(symbol)?.v
    if (hit) { setState({ sym: symbol, data: hit, loading: false }); return }
    let alive = true
    setState({ sym: symbol, data: null, loading: true })
    void load(cache, symbol, () => fetch(symbol)).then((v) => { if (alive) setState({ sym: symbol, data: v, loading: false }) })
    return () => { alive = false }
  }, [symbol, cache, fetch])
  return state.sym === symbol ? state : { data: null, loading: !!symbol }
}

const fetchSessions = (s: string) => chartApi.sessions(s)
const fetchSpec = (s: string) => chartApi.spec(s)
export const useSymbolSessions = (symbol: string | null) => useCached(sessCache, symbol, fetchSessions)
export const useChartSpec = (symbol: string | null) => useCached(specCache, symbol, fetchSpec)
export function _resetSymbolMeta() { sessCache.clear(); specCache.clear() }

// ── 时段换算 / session conversion ──
// 一段：图表时区里的星期几（0=周日）+ 起止分钟（同一天内；跨零点的拆成两段）
// A segment: weekday in the chart timezone (0 = Sun) + start / end minutes (within one day; ones crossing midnight are split)
export interface SessionSeg { day: number; from: number; to: number }

const WEEK = 7 * 1440

// 服务器日的 {day, open, close} → 图表时区的段。offsetMin = 图表时区相对 UTC 的分钟数，serverOffsetSec 同理。
// Server-day {day, open, close} → segments in the chart timezone. offsetMin = chart tz minutes from UTC; serverOffsetSec likewise.
export function convertSessions(sessions: readonly { day: number; open: number; close: number }[], serverOffsetSec: number, offsetMin: number): SessionSeg[] {
  const shift = offsetMin - Math.round(serverOffsetSec / 60)
  const out: SessionSeg[] = []
  for (const s of sessions) {
    if (!(s.close > s.open) || s.day < 0 || s.day > 6) continue
    let a = ((s.day * 1440 + s.open + shift) % WEEK + WEEK) % WEEK
    let len = s.close - s.open
    while (len > 0) {
      const day = Math.floor(a / 1440)
      const from = a - day * 1440
      const take = Math.min(len, 1440 - from)
      out.push({ day, from, to: from + take })
      len -= take
      a = (a + take) % WEEK
    }
  }
  // 同一天相接的段合并 / merge touching segments of the same day
  out.sort((x, y) => x.day - y.day || x.from - y.from)
  const merged: SessionSeg[] = []
  for (const s of out) {
    const last = merged[merged.length - 1]
    if (last && last.day === s.day && s.from <= last.to) last.to = Math.max(last.to, s.to)
    else merged.push({ ...s })
  }
  return merged
}

export const fmtMin = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
