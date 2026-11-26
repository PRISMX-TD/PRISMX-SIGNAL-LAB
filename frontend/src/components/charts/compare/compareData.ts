// 对比品种的数据：每张图一个，按图表周期取（派生周期取源周期再合成）。
//   · 首次：新加的品种攒一拍后用 /chart/batch 一次取完（限流只算一次）；batch 失败退回逐个 /chart/history；
//     随后各补一次 latest(10) 接上形成中那根（库里只有已收盘的）。
//   · 之后每 5 秒 latest(3)（后台不轮询）。latest 读内存缓存、不限流，主图轮询本来就是 3 秒一次。
//   · 主图往左翻页 / 回放到更早时，按主图最早一根用 /chart/range 往左补（失败退回 history before）。
// 原生周期的数据顺手放进 ind/otherBars 的缓存，相关系数 / 价差指标就不再单独拉。
// Compare-symbol data, one store per chart, fetched at the chart interval (derived intervals
// fetch their source and aggregate).
//   · First load: newly added symbols are batched for a tick and fetched with one /chart/batch
//     (one rate-limit hit); on failure fall back to /chart/history per symbol; then one
//     latest(10) each joins the forming bar (the DB holds closed bars only).
//   · Then latest(3) every 5 s (not while backgrounded). latest reads the in-memory cache and isn't
//     rate-limited; the main chart already polls every 3 s.
//   · When the main chart pages left / replays further back, page left to its earliest bar with
//     /chart/range (falling back to history `before`).
// Native-interval data is dropped into ind/otherBars' cache so correlation / spread indicators
// don't fetch it separately.
import { chartApi } from '../../../api/client'
import type { Candle } from '../../../api/types'
import { barSpacingSeconds } from '../chartConfig'
import { derivedSpec, type DerivedSpec } from '../derivedIntervals'
import { seedOtherBars } from '../ind/otherBars'
import { buildDerived } from '../replay/replayModel'
import { startPolling } from '../../../utils/usePollWhileVisible'

export type CompareStatus = 'loading' | 'ok' | 'empty' | 'error'

export interface CompareApi {
  batch: typeof chartApi.batch
  range: typeof chartApi.range
  latest: typeof chartApi.latest
  history: typeof chartApi.history
}

interface SymState {
  src: Candle[]
  hasOlder: boolean
  loading: boolean
  older: boolean
  status: CompareStatus
  failedAt: number
  ver: number
  agg: { ver: number; bars: Candle[] } | null
}

export const COMPARE_POLL_MS = 5000
const FIRST_LIMIT = 500
const RETRY_MS = 30_000
// 单个品种源 bar 的上限（与主图 MAX_CLIENT_BARS 同量级）/ per-symbol source-bar cap
const MAX_SRC = 40_000

function mergeTail(old: Candle[], fresh: readonly Candle[]): Candle[] {
  if (fresh.length === 0) return old
  const first = fresh[0].t
  const keep = old.filter((b) => b.t < first)
  return [...keep, ...fresh]
}

export class CompareData {
  readonly interval: string
  readonly spec: DerivedSpec | null
  readonly src: string
  readonly srcSpacing: number
  private syms = new Map<string, SymState>()
  private pending = new Set<string>()
  private flushTimer: ReturnType<typeof setTimeout> | undefined
  private stopPoll: (() => void) | null = null
  private disposed = false
  private api: CompareApi
  private onChange: (symbol: string) => void
  private nowMs: () => number

  constructor(interval: string, onChange: (symbol: string) => void, api?: CompareApi, nowMs?: () => number) {
    this.interval = interval
    this.spec = derivedSpec(interval)
    this.src = this.spec?.source ?? interval
    this.srcSpacing = barSpacingSeconds(this.src) ?? 60
    this.onChange = onChange
    this.api = api ?? { batch: chartApi.batch, range: chartApi.range, latest: chartApi.latest, history: chartApi.history }
    this.nowMs = nowMs ?? (() => Date.now())
  }

  // 一桶大约几根源 bar（首页 / 补左侧时放大窗口用）/ source bars per bucket (scales the windows)
  private get factor() { return this.spec?.pageFactor ?? 1 }

  setSymbols(list: readonly string[]) {
    const want = new Set(list)
    for (const s of [...this.syms.keys()]) if (!want.has(s)) { this.syms.delete(s); this.pending.delete(s) }
    for (const s of want) {
      if (this.syms.has(s)) continue
      this.syms.set(s, { src: [], hasOlder: true, loading: true, older: false, status: 'loading', failedAt: 0, ver: 0, agg: null })
      this.pending.add(s)
    }
    if (this.pending.size > 0 && this.flushTimer === undefined) {
      this.flushTimer = setTimeout(() => { this.flushTimer = undefined; void this.flush() }, 0)
    }
  }

  symbols() { return [...this.syms.keys()] }

  status(symbol: string): CompareStatus { return this.syms.get(symbol)?.status ?? 'loading' }
  version(symbol: string): number { return this.syms.get(symbol)?.ver ?? -1 }

  // 图表周期的 K 线（派生周期现合成，按版本缓存）/ bars at the chart interval (derived ones aggregated, cached per version)
  bars(symbol: string): Candle[] | null {
    const s = this.syms.get(symbol)
    if (!s || s.src.length === 0) return null
    if (!this.spec) return s.src
    if (s.agg && s.agg.ver === s.ver) return s.agg.bars
    const bars = buildDerived(s.src, this.spec, s.hasOlder).bars
    s.agg = { ver: s.ver, bars }
    return bars
  }

  private touch(symbol: string, s: SymState) {
    s.ver++
    if (!this.spec && s.src.length > 0) seedOtherBars(symbol, this.interval, s.src)
    if (!this.disposed) this.onChange(symbol)
  }

  private async flush() {
    if (this.disposed) return
    const list = [...this.pending].filter((s) => this.syms.has(s))
    this.pending.clear()
    if (list.length === 0) return
    const limit = Math.min(1000, Math.ceil(FIRST_LIMIT * this.factor))
    let got: Record<string, { bars: Candle[]; hasMore: boolean }> | null = null
    try {
      got = (await this.api.batch(list, this.src, limit)).series ?? {}
    } catch {
      got = null
    }
    if (this.disposed) return
    await Promise.all(list.map(async (sym) => {
      let r = got?.[sym]
      if (!r) {
        try { r = await this.api.history(sym, this.src, limit) } catch { r = undefined }
      }
      const s = this.syms.get(sym)
      if (!s || this.disposed) return
      s.loading = false
      if (!r) { s.status = 'error'; s.failedAt = this.nowMs(); this.onChange(sym); return }
      s.src = r.bars.slice()
      s.hasOlder = r.hasMore
      s.status = s.src.length ? 'ok' : 'empty'
      this.touch(sym, s)
      // 接上形成中那根 / join the forming bar
      await this.pollOne(sym, 10)
    }))
  }

  private async pollOne(sym: string, n: number) {
    const s = this.syms.get(sym)
    if (!s || s.loading) return
    try {
      const r = await this.api.latest(sym, this.src, n)
      const cur = this.syms.get(sym)
      if (!cur || this.disposed || cur !== s || r.bars.length === 0) return
      const next = mergeTail(s.src, r.bars)
      const last = s.src[s.src.length - 1]
      const nl = next[next.length - 1]
      if (next.length === s.src.length && last && nl && last.t === nl.t && last.c === nl.c && last.h === nl.h && last.l === nl.l) return
      s.src = next
      if (s.status !== 'ok') s.status = 'ok'
      this.touch(sym, s)
    } catch { /* 下一轮再试 / next round */ }
  }

  poll(): Promise<void> {
    return Promise.all(this.symbols().map((s) => this.pollOne(s, 3))).then(() => {})
  }

  startPolling(ms = COMPARE_POLL_MS) {
    if (this.stopPoll) return
    this.stopPoll = startPolling(() => this.poll(), ms, false)
  }

  // 主图最早一根早于对比数据时往左补 / page left when the main chart's earliest bar precedes the compare data
  ensureCoverage(fromT: number | undefined) {
    if (fromT == null || !Number.isFinite(fromT)) return
    const now = this.nowMs()
    for (const [sym, s] of this.syms) {
      if (s.loading || s.older || !s.hasOlder || s.src.length === 0) continue
      if (now - s.failedAt < RETRY_MS) continue
      const firstT = s.src[0].t
      // 派生周期多要一桶，免得头桶不完整 / one extra bucket for derived intervals so the head bucket is whole
      if (fromT >= firstT) continue
      void this.loadOlder(sym, s, fromT - this.srcSpacing * Math.ceil(this.factor) * 2, firstT)
    }
  }

  private async loadOlder(sym: string, s: SymState, from: number, firstT: number) {
    s.older = true
    try {
      let bars: Candle[]
      let hasOlder: boolean
      try {
        const r = await this.api.range(sym, this.src, from, firstT - 1, 5000)
        bars = r.bars
        // 截断 = 范围里还有更早的；否则看库里最早一根 / truncated = more inside the range; else compare with the earliest stored
        hasOlder = r.truncated || (r.earliest != null && bars.length > 0 && bars[0].t > r.earliest)
      } catch {
        // range 还没上线 / 失败：退回按页往左 / range not deployed or failing: fall back to paging
        const r = await this.api.history(sym, this.src, 1000, firstT)
        bars = r.bars
        hasOlder = r.hasMore
      }
      const cur = this.syms.get(sym)
      if (cur !== s || this.disposed) return
      const add = bars.filter((b) => b.t < firstT)
      s.hasOlder = hasOlder && add.length > 0
      if (add.length > 0) {
        s.src = [...add, ...s.src]
        if (s.src.length > MAX_SRC) s.hasOlder = false
        this.touch(sym, s)
      }
    } catch {
      s.failedAt = this.nowMs()
    } finally {
      s.older = false
    }
  }

  dispose() {
    this.disposed = true
    if (this.flushTimer !== undefined) clearTimeout(this.flushTimer)
    this.stopPoll?.()
    this.stopPoll = null
    this.syms.clear()
    this.pending.clear()
  }
}
