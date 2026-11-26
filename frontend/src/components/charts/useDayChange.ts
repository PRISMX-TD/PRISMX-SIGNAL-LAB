// 自选表的日内涨跌：后端 /chart/day-refs 给每个活跃品种当前券商日的开盘价和前一日收盘价
// （后端缓存 60 秒），这里每 60 秒拉一次，现价（实时 bid）对前收算涨跌额 / 涨跌幅，没有前收就对今开。
// 拉取是模块级共享的：几张自选表（专业版面板、手机抽屉、经典版左栏）同时挂着也只有一路轮询，
// 订阅数归零就停；页面隐藏时不拉，回到前台若已过期立刻补一次。每个品种的基准对象只在数值变了时
// 才换新，memo 的行不会因为别的品种的基准刷新而重渲染。
// Watchlist day change: /chart/day-refs returns each active symbol's broker-day open and previous
// close (cached 60 s server-side). Polled every 60 s; change = live bid vs the previous close, or
// vs today's open when there is none. The poll is shared at module level: several watchlists
// (pro panel, phone sheet, classic column) mounted at once still make one request stream, which
// stops when the subscriber count hits zero; nothing is fetched while the page is hidden, and a
// stale cache refreshes as soon as it's visible again. A symbol's ref object is replaced only when
// its numbers change, so memoised rows don't re-render for other symbols' refreshes.
import { useMemo, useSyncExternalStore } from 'react'
import { chartApi } from '../../api/client'
import type { ChartDayRef } from '../../api/types'
import { usePrefs } from '../../store/prefs'
import { dirColorsOf, normalizeCandleColors } from './chartConfig'

export const DAY_REFS_POLL_MS = 60_000

type Refs = Readonly<Record<string, ChartDayRef>>
const EMPTY_REFS: Refs = Object.freeze({})

let refs: Refs = EMPTY_REFS
let lastAt = 0
let inflight = false
let timer: ReturnType<typeof setInterval> | null = null
const subs = new Set<() => void>()

/** 合并新一批基准：数值没变的品种沿用旧对象 / merge a new batch, keeping unchanged symbols' objects */
export function mergeDayRefs(prev: Refs, next: Record<string, ChartDayRef>): Refs {
  let changed = false
  const out: Record<string, ChartDayRef> = {}
  for (const [sym, r] of Object.entries(next)) {
    if (!r || typeof r.open !== 'number') continue
    const p = prev[sym]
    if (p && p.open === r.open && p.prevClose === r.prevClose && p.t === r.t) out[sym] = p
    else { out[sym] = r; changed = true }
  }
  // 有品种消失也算变了 / a symbol disappearing counts as a change too
  if (Object.keys(out).length !== Object.keys(prev).length) changed = true
  return changed ? out : prev
}

function fetchNow() {
  if (inflight) return
  inflight = true
  chartApi.dayRefs()
    .then((r) => {
      const next = mergeDayRefs(refs, r?.items ?? {})
      if (next !== refs) { refs = next; subs.forEach((fn) => fn()) }
    })
    .catch(() => { /* 未登录 / 网络错误：保留上一份，下个周期再试 / logged out or offline: keep the last batch */ })
    .finally(() => { inflight = false; lastAt = Date.now() })
}

const hidden = () => typeof document !== 'undefined' && document.hidden
const tick = () => { if (!hidden()) fetchNow() }
const onVisible = () => { if (!hidden() && Date.now() - lastAt >= DAY_REFS_POLL_MS) fetchNow() }

function subscribe(fn: () => void): () => void {
  subs.add(fn)
  if (subs.size === 1) {
    if (Date.now() - lastAt >= DAY_REFS_POLL_MS) tick()
    timer = setInterval(tick, DAY_REFS_POLL_MS)
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible)
  }
  return () => {
    subs.delete(fn)
    if (subs.size === 0) {
      if (timer) clearInterval(timer)
      timer = null
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible)
    }
  }
}
const getRefs = () => refs

/** 全部品种的日内基准（共享轮询）/ every symbol's day refs (shared poll) */
export function useDayRefs(): Refs {
  return useSyncExternalStore(subscribe, getRefs, getRefs)
}

export interface DayChange { chg: number; pct: number }

/** 现价对前收（没有前收对今开）的涨跌 / live price vs previous close (or today's open) */
export function calcDayChange(bid: number | null | undefined, ref: ChartDayRef | null | undefined): DayChange | null {
  if (bid == null || !Number.isFinite(bid) || !ref) return null
  const base = ref.prevClose != null && Number.isFinite(ref.prevClose) && ref.prevClose > 0 ? ref.prevClose : ref.open
  if (!Number.isFinite(base) || base <= 0) return null
  const chg = bid - base
  return { chg, pct: (chg / base) * 100 }
}

/** 涨跌幅文字：+0.42% / −1.30% / change % text */
export function fmtPct(pct: number): string {
  const a = Math.abs(pct)
  const s = a >= 100 ? a.toFixed(0) : a.toFixed(2)
  // 四舍五入后是 0 就不带符号 / no sign when it rounds to zero
  if (Number(s) === 0) return `${s}%`
  return `${pct >= 0 ? '+' : '−'}${s}%`
}

/** 日内涨跌：refs + 按现价算涨跌的函数 / day change: refs + a calculator for a live bid */
export function useDayChange(): { refs: Refs; changeOf: (symbol: string, bid: number | null | undefined) => DayChange | null } {
  const r = useDayRefs()
  return useMemo(() => ({ refs: r, changeOf: (symbol: string, bid: number | null | undefined) => calcDayChange(bid, r[symbol]) }), [r])
}

/** 涨跌提示色（用户在图表设置里选的红绿，见 dirColorsOf）/ the user's up/down cue colours (see dirColorsOf) */
export function useDirColors(): { up: string; down: string } {
  const { getPref } = usePrefs()
  const raw = getPref<unknown>('charts', 'candleColors', null)
  return useMemo(() => dirColorsOf(normalizeCandleColors(raw)), [raw])
}

/** 测试用 / tests only */
export function _resetDayRefs() { refs = EMPTY_REFS; lastAt = 0; inflight = false }
