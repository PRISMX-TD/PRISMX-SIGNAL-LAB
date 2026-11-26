// 指标要用的「别的 K 线」：另一个品种（相关系数、价差）或本品种的日线（52 周高低、区间表现）。
// 指标计算是同步的：第一次要时返回 null 并在后台拉一页历史，到了通知引擎重算；之后每次被要到、
// 距上次拉取超过 30 秒就补拉最新几根合进去。请求与看图的人完全同形（chartApi / 派生周期），
// 落在 /chart/history 的共享缓存键上。十分钟没人要的条目在缓存满时清掉。
// "Other" bars for indicators: another symbol (correlation, spread) or this symbol's daily bars
// (52-week high/low, performance). Compute is synchronous: the first ask returns null and fetches a
// page of history in the background, notifying the engine to recompute when it lands; later asks
// more than 30 s after the last fetch merge the newest few bars. Requests have the same shape as a
// chart viewer's (chartApi / derived intervals), hitting /chart/history's shared cache keys.
// Entries unused for ten minutes are dropped when the cache is full.
import type { Candle } from '../../../api/types'
import { createChartFeed, derivedSpec, type ChartFeed } from '../derivedIntervals'

const REFRESH_MS = 30_000
const RETRY_MS = 60_000
const IDLE_MS = 10 * 60_000
const MAX_ENTRIES = 12
const PAGE = 1000

interface Entry {
  feed: ChartFeed
  bars: Candle[] | null
  loading: boolean
  lastFetch: number
  lastUse: number
  failed: boolean
}

const cache = new Map<string, Entry>()
const subs = new Set<() => void>()
const notify = () => subs.forEach((f) => { try { f() } catch { /* 订阅方自己的错 / subscriber error */ } })

function merge(old: Candle[], fresh: Candle[]): Candle[] {
  if (fresh.length === 0) return old
  const first = fresh[0].t
  const keep = old.filter((b) => b.t < first)
  return [...keep, ...fresh].slice(-PAGE * 2)
}

function load(e: Entry, now: number) {
  e.loading = true
  e.lastFetch = now
  const p: Promise<Candle[]> = e.bars
    ? e.feed.latest(3).then((r) => merge(e.bars ?? [], r?.bars ?? []))
    : e.feed.history(PAGE).then((r) => r?.bars ?? [])
  p.then((bars) => {
    const changed = bars !== e.bars
    e.bars = bars
    e.failed = false
    if (changed) notify()
  }).catch(() => { e.failed = true }).finally(() => { e.loading = false })
}

function evict(now: number) {
  if (cache.size <= MAX_ENTRIES) return
  for (const [k, e] of cache) if (now - e.lastUse > IDLE_MS && !e.loading) cache.delete(k)
}

export function otherBars(symbol: string, interval: string): Candle[] | null {
  if (!symbol || !interval) return null
  const k = `${symbol}|${interval}`
  const now = Date.now()
  let e = cache.get(k)
  if (!e) {
    evict(now)
    e = { feed: createChartFeed(symbol, interval), bars: null, loading: false, lastFetch: 0, lastUse: now, failed: false }
    cache.set(k, e)
  }
  e.lastUse = now
  const wait = e.failed ? RETRY_MS : e.bars ? REFRESH_MS : 0
  if (!e.loading && now - e.lastFetch >= wait) load(e, now)
  return e.bars
}

// 别处（对比品种）已经取到的同周期 K 线顺手放进来，相关系数 / 价差指标就不用再拉一遍。
// 只在本缓存还没有数据、或新数据更长时才收；不改 lastFetch，之后照常按 30 秒补最新。
// Bars another feature (compare symbols) already fetched for the same interval are dropped in, so
// correlation / spread indicators don't fetch them again. Taken only when this cache is empty or
// the new data is longer; lastFetch is untouched, so the 30 s latest refresh carries on as usual.
export function seedOtherBars(symbol: string, interval: string, bars: readonly Candle[]) {
  // 只收原生周期：派生周期的 feed 没走过首页，尾巴是空的，之后补最新会把形成中那根合成错
  // Native intervals only: a derived feed that never loaded its first page has an empty tail, and
  // the later latest refresh would mis-aggregate the forming bar
  if (!symbol || !interval || bars.length === 0 || derivedSpec(interval)) return
  const k = `${symbol}|${interval}`
  const now = Date.now()
  let e = cache.get(k)
  if (!e) {
    evict(now)
    e = { feed: createChartFeed(symbol, interval), bars: null, loading: false, lastFetch: now, lastUse: now, failed: false }
    cache.set(k, e)
  }
  if (e.bars && e.bars.length >= bars.length) return
  e.bars = bars.slice(-PAGE * 2)
  e.failed = false
  notify()
}

// 数据到了就回调（引擎用它触发重算）/ called when data arrives (the engine recomputes)
export function subscribeOtherBars(fn: () => void): () => void {
  subs.add(fn)
  return () => { subs.delete(fn) }
}

// 测试用 / for tests
export function resetOtherBars() { cache.clear(); subs.clear() }
