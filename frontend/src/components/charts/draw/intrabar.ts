// 成交量分布的「区间内小周期 K 线」（对标 TradingView FRVP 的取数）：
// TradingView 按 1 / 5 / 15 / 30 / 60 / 240 / 日线的顺序挑最小的、区间内根数够少的周期，用小周期 K 线
// 把量落到真正成交的价位上；只用图上周期的话，一根大阳线的量会被平均摊满它的整段高低区间。
// 我们的原生周期没有 30 分钟，阶梯是 1 / 5 / 15 / 60 / 240，且只取比图表周期小的；区间内最多 3000 根
// （3 次 1000 根的 /chart/history），超过就往上一级。
// 画图是同步的：第一次要时返回 null（调用方先用图上的 K 线画），停稳 350 ms 后才去拉（拖动区间时
// 不连发请求），到了通知重画。已拉过的时间段记下来，拖动边缘不出区间就不再请求；区间伸到最新
// 那根时每 30 秒补拉最新 3 根。库里小周期历史不够（1 分钟线只留 30 天）时这一级记为不可用，
// 换上一级；都不行就一直返回 null（与 TradingView 一样退回图表周期）。
// Lower-timeframe bars inside a volume profile's range, the way TradingView's FRVP gets them:
// TradingView walks 1 / 5 / 15 / 30 / 60 / 240 / 1D and takes the smallest timeframe that keeps the
// range's bar count low, so volume lands on the prices that actually traded; with only chart bars a
// big candle's volume is smeared over its whole high-low range. Our natives have no 30m, so the ladder
// is 1 / 5 / 15 / 60 / 240, below the chart's timeframe, with at most 3000 bars (three 1000-bar
// /chart/history pages) before stepping up. Painting is synchronous: the first ask returns null (the
// caller paints with chart bars), the fetch starts once the range has been still for 350 ms (no
// request storm while dragging), and arrival triggers a redraw. Loaded spans are remembered so edge
// drags inside them don't refetch; a range reaching the newest bar merges the latest 3 bars every 30 s.
// When the database lacks history at a level (1-minute bars are kept 30 days) that level is marked
// unusable and the next one is tried; if none works the answer stays null (TradingView likewise falls
// back to the chart timeframe).
import { chartApi } from '../../../api/client'
import type { Candle } from '../../../api/types'
import { barSpacingSeconds } from '../chartConfig'

const LADDER: readonly [string, number][] = [['1', 60], ['5', 300], ['15', 900], ['60', 3600], ['240', 14400]]
export const MAX_BARS = 3000
const PAGE = 1000
const LIVE_MS = 30_000
const DEBOUNCE_MS = 350
const MAX_SERIES = 10

interface Span { a: number; b: number; ok: boolean }
interface Series { bars: Map<number, Candle>; sorted: Candle[] | null; spans: Span[]; liveAt: number; loading: boolean; lastUse: number }

const store = new Map<string, Series>()
const timers = new Map<string, { sig: string; id: ReturnType<typeof setTimeout> }>()
const subs = new Set<() => void>()
const onArrive = () => subs.forEach((f) => { try { f() } catch { /* 订阅方自己的错 / subscriber error */ } })

/** 数据到了要重画（每个图表一份订阅）/ repaint when data lands (one subscription per chart) */
export function subscribeIntrabar(fn: () => void): () => void {
  subs.add(fn)
  return () => { subs.delete(fn) }
}

/** 照 TradingView 的阶梯挑候选周期（从小到大）/ candidate timeframes, smallest first, TradingView's ladder */
export function intrabarLadder(chartSec: number, span: number): { code: string; sec: number }[] {
  const out: { code: string; sec: number }[] = []
  for (const [code, sec] of LADDER) {
    if (sec >= chartSec) break
    if (span / sec <= MAX_BARS) out.push({ code, sec })
  }
  return out
}

function seriesOf(k: string): Series {
  let s = store.get(k)
  if (!s) {
    if (store.size >= MAX_SERIES) {
      // 最久没用的那份让位 / the least recently used one makes room
      let old: string | null = null, at = Infinity
      for (const [kk, v] of store) if (!v.loading && v.lastUse < at) { at = v.lastUse; old = kk }
      if (old) store.delete(old)
    }
    s = { bars: new Map(), sorted: null, spans: [], liveAt: 0, loading: false, lastUse: Date.now() }
    store.set(k, s)
  }
  s.lastUse = Date.now()
  return s
}

function absorb(s: Series, bars: Candle[]) {
  for (const b of bars) s.bars.set(b.t, b)
  if (bars.length) s.sorted = null
}

function slice(s: Series, t0: number, end: number): Candle[] {
  if (!s.sorted) s.sorted = [...s.bars.values()].sort((x, y) => x.t - y.t)
  const arr = s.sorted
  let lo = 0, hi = arr.length
  while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m].t < t0) lo = m + 1; else hi = m }
  const out: Candle[] = []
  for (let i = lo; i < arr.length && arr[i].t < end; i++) out.push(arr[i])
  return out
}

// 拉 [t0, end)：从 end 往左一页页取，直到盖过 t0 或没有更多 / page left from `end` until t0 is covered
async function load(symbol: string, code: string, sec: number, s: Series, t0: number, end: number, live: boolean) {
  s.loading = true
  try {
    let before: number | undefined = live ? undefined : Math.ceil(end / sec) * sec
    let earliest = Infinity
    let more = true
    for (let page = 0; page < Math.ceil(MAX_BARS / PAGE) && more && earliest > t0; page++) {
      const r = await chartApi.history(symbol, code, PAGE, before)
      absorb(s, r.bars)
      more = r.hasMore
      if (!r.bars.length) break
      earliest = Math.min(earliest, r.bars[0].t)
      before = r.bars[0].t
    }
    // 小周期最早一根离区间起点还差一根图表 K 线以上：这一级历史不够，标记不可用
    // The earliest lower-timeframe bar starts well after the range: not enough history at this level
    const ok = earliest <= t0 + Math.max(sec, 3600)
    s.spans.push({ a: t0, b: live ? Infinity : end, ok })
    if (live) s.liveAt = Date.now()
    onArrive()
  } catch {
    // 失败不记跨度，下次再要时重试 / no span on failure, so the next ask retries
  } finally {
    s.loading = false
  }
}

async function refreshLive(symbol: string, code: string, s: Series) {
  s.loading = true
  s.liveAt = Date.now()
  try {
    const r = await chartApi.latest(symbol, code, 3)
    const before = s.bars.size
    absorb(s, r.bars)
    if (r.bars.length || s.bars.size !== before) onArrive()
  } catch { /* 下次再补 / next time */ } finally { s.loading = false }
}

/**
 * 区间 [t0, tEnd) 内的小周期 K 线；tEnd = Infinity 表示一直到最新（锚定分布）。
 * 还没有、或者这个区间用不了小周期时返回 null，调用方用图表周期的 K 线。
 * Lower-timeframe bars in [t0, tEnd); tEnd = Infinity means up to the newest bar (anchored).
 * Null while not loaded or when no lower timeframe fits; the caller then uses chart bars.
 */
export function intrabarBars(symbol: string, chartInterval: string, t0: number, tEnd: number, key: string, only?: string): { code: string; bars: Candle[] } | null {
  const chartSec = barSpacingSeconds(chartInterval)
  if (!symbol || !chartSec || !Number.isFinite(t0)) return null
  const nowSec = Date.now() / 1000
  const live = !Number.isFinite(tEnd) || tEnd > nowSec
  const end = live ? nowSec + chartSec : tEnd
  // only = 只用这一级（指标自己挑好了周期）/ only = use just this level (an indicator already chose it)
  for (const { code, sec } of intrabarLadder(chartSec, end - t0).filter((x) => !only || x.code === only)) {
    const s = seriesOf(`${symbol}|${code}`)
    const span = s.spans.find((x) => x.a <= t0 && x.b >= (live ? Infinity : end))
    if (span && !span.ok) continue
    if (span) {
      if (live && !s.loading && Date.now() - s.liveAt > LIVE_MS) void refreshLive(symbol, code, s)
      return { code, bars: slice(s, t0, end) }
    }
    // 这一级历史早已知道不够（更早的区间都不够，更晚的区间才可能够）就跳过
    // Skip a level already known short for a range ending at or after this one's start
    if (s.spans.some((x) => !x.ok && x.a >= t0)) continue
    // 同一条画线只留最后一次的计时：拖动中不断重排，停稳才真的去拉
    // One pending timer per drawing: dragging keeps resetting it, so the fetch waits until it settles
    // 区间没变的重画（十字光标移动等）不重排计时 / repaints with the same range (crosshair moves) keep the timer
    if (!s.loading) {
      const sig = `${symbol}|${code}|${t0}|${live ? 'live' : end}`
      const prev = timers.get(key)
      if (prev?.sig !== sig) {
        if (prev) clearTimeout(prev.id)
        timers.set(key, { sig, id: setTimeout(() => {
          timers.delete(key)
          if (!s.loading) void load(symbol, code, sec, s, t0, end, live)
        }, DEBOUNCE_MS) })
      }
    }
    return null
  }
  return null
}

// 测试用 / for tests
export function resetIntrabar() {
  store.clear()
  for (const t of timers.values()) clearTimeout(t.id)
  timers.clear()
  subs.clear()
}
