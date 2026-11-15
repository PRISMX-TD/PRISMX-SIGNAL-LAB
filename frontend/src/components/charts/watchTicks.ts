// 自选表的逐品种跳价簿。喂给它整张全站报价表（每一帧都喂），它算出每个品种的
// 最新价、这一帧的跳动方向和最近 SPARK_LEN 个价（迷你走势），并且只通知真正
// 变了的品种：跳了价的，以及上一帧上了色、这一帧没动该褪回的。
// 为什么不让每一行直接 useGlobalQuote：后端只广播变化了的报价，没跳价的品种
// 拿到的一直是同一个对象，行收不到任何通知，颜色会永远停在最后一次跳动上。
// 规则与原来 WatchlistPanel 里的 effect 完全一致：方向看 bid；第一笔报价只记价
// 不上色；走势只在 bid 变了时追加一个点。
// Per-symbol tick book for the watchlist. Fed the whole site-wide quote map on every
// frame, it derives each symbol's latest bid, this frame's direction and the last
// SPARK_LEN bids (sparkline), and notifies only the symbols that changed: those that
// ticked, and those coloured last frame that didn't move this frame and fade back.
// Rows can't just useGlobalQuote: the backend broadcasts changed quotes only, so a quiet
// symbol keeps the same object, its row is never notified and its colour would stick on
// the last tick forever. Same rules as the effect that used to live in WatchlistPanel:
// direction from bid; the first quote records the price without a colour; a sparkline
// point is appended only when the bid moved.
import type { Quote } from '../../api/types'

export type Dir = 'up' | 'down' | null
export const SPARK_LEN = 40

export interface WatchTick {
  /** 最新 bid；还没收到报价时为 null / latest bid, null before the first quote */
  bid: number | null
  /** 这一帧的跳动方向，没动为 null / this frame's direction, null when it didn't move */
  dir: Dir
  /** 最近 SPARK_LEN 个不同的 bid，只在变化时换新数组 / last SPARK_LEN bids; a new array only on change */
  hist: number[]
}

export interface WatchTicks {
  ingest: (quotes: Record<string, Quote>) => void
  get: (sym: string) => WatchTick
  subscribe: (sym: string, cb: () => void) => () => void
}

const EMPTY: WatchTick = { bid: null, dir: null, hist: [] }

export function createWatchTicks(): WatchTicks {
  const ticks: Record<string, WatchTick> = {}
  const seen: Record<string, Quote> = {}
  const subs: Record<string, Set<() => void>> = {}
  let lastMap: Record<string, Quote> | null = null
  return {
    ingest(quotes) {
      if (quotes === lastMap) return
      lastMap = quotes
      const changed: string[] = []
      for (const sym in quotes) {
        const q = quotes[sym]
        if (!q) continue
        const prev = ticks[sym]
        let next: WatchTick | null = null
        if (q !== seen[sym]) {
          seen[sym] = q
          const bid = q.bid
          if (!prev) {
            next = { bid, dir: null, hist: [bid] }
          } else if (bid !== prev.bid) {
            const hist = prev.hist.length >= SPARK_LEN ? prev.hist.slice(1) : prev.hist.slice()
            hist.push(bid)
            next = { bid, dir: prev.bid == null ? null : bid > prev.bid ? 'up' : 'down', hist }
          } else if (prev.dir !== null) {
            next = { bid: prev.bid, dir: null, hist: prev.hist }
          }
        } else if (prev && prev.dir !== null) {
          next = { bid: prev.bid, dir: null, hist: prev.hist }
        }
        if (next) {
          ticks[sym] = next
          changed.push(sym)
        }
      }
      for (const sym of changed) {
        const set = subs[sym]
        if (set) set.forEach((fn) => fn())
      }
    },
    get: (sym) => ticks[sym] ?? EMPTY,
    subscribe(sym, cb) {
      const set = subs[sym] ?? new Set<() => void>()
      subs[sym] = set
      set.add(cb)
      return () => { set.delete(cb) }
    },
  }
}
