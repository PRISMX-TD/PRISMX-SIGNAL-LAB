// K 线回放控制器（每张图一个，由 useChartData 持有）。
// 开始回放时把实时 K 线整段存起来（live），图上换成回放数据的前 idx+1 根；单步 / 播放往 candlesRef
// 追加一根再交给引擎增量重画（renderTail）并重算指标；退出时把存起来的实时数据原样放回，并让数据层
// 立即补拉一次最新价（中间缺的会被 tailHasHole 发现并重拉尾部）。回放数据按时间窗向 /chart/range
// 分块取（replayModel.startWindow / chunkWindow），派生周期取源周期再合成。
// 回放期间 dataKeyRef 改成 'replay|…'：页面的 LiveBarSync 只在数据键等于「品种|周期」时才往图上钉报价，
// 即使页面忘了停掉它，也不会把实时报价写进回放的 K 线。
// Bar-replay controller (one per chart, owned by useChartData).
// Starting a replay stashes the live candles (live) and shows the first idx+1 replay bars; a step
// / play tick appends one bar to candlesRef, lets the engine redraw incrementally (renderTail) and
// recomputes indicators; exit puts the stashed live data back verbatim and has the data layer poll
// latest at once (any gap is caught by tailHasHole and refilled). Replay data comes from
// /chart/range in time-window chunks (replayModel.startWindow / chunkWindow); derived intervals
// fetch their source interval and aggregate.
// While replaying, dataKeyRef becomes 'replay|…': the page's LiveBarSync only pins quotes when the
// key equals "symbol|interval", so even if the page forgot to suspend it, live quotes never reach
// the replay candles.
import type { IChartApi } from 'lightweight-charts'
import type { Candle, ChartRangeOut } from '../../../api/types'
import { chartApi } from '../../../api/client'
import { barSpacingSeconds } from '../chartConfig'
import { derivedSpec, type DerivedSpec } from '../derivedIntervals'
import {
  DEFAULT_REPLAY_SPEED, buildDerived, chunkWindow, mergeDerived, appendNewer, needsMore, prependOlder,
  randomStartTime, resolveStart, snapSpeed, speedMs, startWindow, stepState, type StepState,
} from './replayModel'

export type ReplayHintKind = 'clamped' | 'noData' | 'failed' | 'end'
export interface ReplayHint { kind: ReplayHintKind; t?: number; id: number }

export interface ReplayState {
  // 正在回放（图上是回放数据）/ replaying (the chart shows replay data)
  active: boolean
  // 正在选起点（页面显示选择遮罩）/ picking the start bar (the page shows the select overlay)
  selecting: boolean
  // 在取数据（首块或播放时等下一块）/ fetching (first chunk, or a play tick waiting for the next one)
  loading: boolean
  playing: boolean
  // 每秒几根 / bars per second
  speed: number
  // 当前回放到的那根 / the bar the replay currently stands on
  cursorTime: number | null
  atEnd: boolean
  // 库里该品种该周期最早一根（可回放范围的起点；未知 null）/ earliest stored bar (replay range start; null = unknown)
  earliest: number | null
  hint: ReplayHint | null
}

export const REPLAY_IDLE: ReplayState = {
  active: false, selecting: false, loading: false, playing: false, speed: DEFAULT_REPLAY_SPEED,
  cursorTime: null, atEnd: false, earliest: null, hint: null,
}

// 控制器要用的引擎部件（useChartEngine 的返回值满足它）/ the engine parts the controller uses (useChartEngine's return satisfies it)
export interface ReplayEngine {
  chartRef: { current: IChartApi | null }
  candlesRef: { current: Candle[] }
  lastTimeRef: { current: number }
  hasMoreHistoryRef: { current: boolean }
  isFollowingLiveRef: { current: boolean }
  renderAll: () => void
  renderTail: () => void
  recomputeIndicators: () => void
}

// 当前这次「品种 + 周期」的绑定，由 useChartData 的数据 effect 挂上 / the current symbol + interval binding, attached by useChartData's data effect
export interface ReplayBinding {
  symbol: string
  interval: string
  dataKeyRef?: { current: string }
  // 回放跳到某根时（页面的最新价 / 画线重绘侦测用）/ the replay moved to a bar
  onCursor?: (bar: Candle) => void
  // 实时数据放回图上之后（数据层恢复数据键、最新价并立即轮询）/ after the live data is back on the chart
  onLiveRestored?: () => void
}

export type RangeFetcher = (symbol: string, interval: string, from: number, to: number, limit?: number) => Promise<ChartRangeOut>

interface LiveStash { bars: Candle[]; lastTime: number; hasMore: boolean; dataKey: string }

interface ReplayData {
  bars: Candle[]
  idx: number
  // 已经取到现在了 / fetched all the way to now
  done: boolean
  // 下一块从这个时间之后取 / the next chunk starts after this
  fetchedTo: number
  // 派生周期：最后一桶的源 bar / derived: source bars of the last bucket
  srcTail: Candle[]
  spec: DerivedSpec | null
  src: string
  srcSpacing: number
}

// 每个「品种|源周期」库里最早一根，进程内缓存 / earliest stored bar per "symbol|source", cached in memory
const earliestCache = new Map<string, number | null>()
export function resetReplayCaches() { earliestCache.clear() }

const MAX_HALVINGS = 4
const RETRY_MS = 5000

export class ReplayController {
  private state: ReplayState = REPLAY_IDLE
  private subs = new Set<() => void>()
  private eng: ReplayEngine | null = null
  private bind: ReplayBinding | null = null
  private live: LiveStash | null = null
  private data: ReplayData | null = null
  private gen = 0
  private fetching = false
  private retryAt = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private hintSeq = 0
  private fetchRange: RangeFetcher
  private nowMs: () => number

  constructor(fetchRange?: RangeFetcher, nowMs?: () => number) {
    this.fetchRange = fetchRange ?? ((s, i, f, t, l) => chartApi.range(s, i, f, t, l))
    this.nowMs = nowMs ?? (() => Date.now())
  }

  // ── 订阅（useSyncExternalStore）/ subscription ──
  subscribe = (fn: () => void) => { this.subs.add(fn); return () => { this.subs.delete(fn) } }
  getState = () => this.state
  private set(patch: Partial<ReplayState>) {
    this.state = { ...this.state, ...patch }
    this.subs.forEach((f) => { try { f() } catch { /* 订阅方自己的错 / subscriber error */ } })
  }
  private hint(kind: ReplayHintKind, t?: number) { this.set({ hint: { kind, t, id: ++this.hintSeq } }) }

  isActive() { return this.state.active }

  setEngine(e: ReplayEngine) { this.eng = e }

  // 新的品种 / 周期：正在回放就放弃（数据层马上整段重载，不用恢复）/ a new symbol / interval: abandon any replay
  attach(b: ReplayBinding) {
    if (this.bind && (this.bind.symbol !== b.symbol || this.bind.interval !== b.interval)) this.abandon()
    this.bind = b
    const key = this.earliestKey()
    if (key) this.set({ earliest: earliestCache.get(key) ?? null })
  }

  // 数据 effect 收尾：返回实时 K 线（存快照用），并放弃回放 / data-effect cleanup: hand back the live bars (for the snapshot) and abandon
  detach(): Candle[] | null {
    const liveBars = this.live?.bars ?? null
    this.abandon()
    return liveBars
  }

  private abandon() {
    this.gen++
    this.stopTimer()
    if (this.live && this.bind?.dataKeyRef) this.bind.dataKeyRef.current = this.live.dataKey
    this.live = null
    this.data = null
    if (this.state.active || this.state.selecting || this.state.playing || this.state.loading) {
      this.set({ ...REPLAY_IDLE, speed: this.state.speed, earliest: this.state.earliest })
    }
  }

  private srcOf(): { spec: DerivedSpec | null; src: string; srcSpacing: number } | null {
    const b = this.bind
    if (!b) return null
    const spec = derivedSpec(b.interval)
    const src = spec?.source ?? b.interval
    return { spec, src, srcSpacing: barSpacingSeconds(src) ?? 60 }
  }
  private earliestKey(): string | null {
    const s = this.srcOf()
    return s && this.bind ? `${this.bind.symbol}|${s.src}` : null
  }

  // ── 选起点 / start selection ──
  beginSelect() {
    if (!this.bind || !this.eng) return
    this.pause()
    this.set({ selecting: true, hint: null })
    void this.loadEarliest()
  }
  cancelSelect() { if (this.state.selecting) this.set({ selecting: false }) }

  // 库里最早一根（随机起点、可回放范围提示用）。取一次就缓存。
  // The earliest stored bar (random start, range hint). Fetched once, then cached.
  async loadEarliest(): Promise<number | null> {
    const key = this.earliestKey()
    const s = this.srcOf()
    if (!key || !s || !this.bind) return null
    if (earliestCache.has(key)) {
      const v = earliestCache.get(key) ?? null
      if (this.state.earliest !== v) this.set({ earliest: v })
      return v
    }
    const nowSec = Math.floor(this.nowMs() / 1000)
    const bind = this.bind
    try {
      const r = await this.fetchRange(bind.symbol, s.src, nowSec - 10 * s.srcSpacing, nowSec, 1)
      earliestCache.set(key, r.earliest ?? null)
      if (this.bind === bind) this.set({ earliest: r.earliest ?? null })
      return r.earliest ?? null
    } catch {
      return null
    }
  }

  async startRandom() {
    const s = this.srcOf()
    if (!s || !this.bind) return
    const earliest = await this.loadEarliest()
    if (earliest == null) { this.set({ selecting: false }); this.hint('noData'); return }
    const spacing = barSpacingSeconds(this.bind.interval) ?? s.srcSpacing * (s.spec?.pageFactor ?? 1)
    await this.start(randomStartTime(earliest, Math.floor(this.nowMs() / 1000), spacing))
  }

  // 半截被截断时把窗口往 anchor 收拢再取（截断保留的是最新一段，起点附近会缺）。
  // When truncated, shrink the window toward the anchor and refetch (a cut keeps the newest part).
  private async fetchSafe(symbol: string, src: string, from: number, to: number, anchor: number): Promise<ChartRangeOut> {
    let f = from
    let t = to
    let r = await this.fetchRange(symbol, src, f, t, 5000)
    for (let i = 0; r.truncated && i < MAX_HALVINGS; i++) {
      f = Math.floor(anchor - (anchor - f) / 2)
      t = Math.floor(anchor + (t - anchor) / 2)
      r = await this.fetchRange(symbol, src, f, t, 5000)
    }
    return r
  }

  // 从 t 开始回放（选中的那根是最后一根可见的）。回放中再选：在已取范围内直接跳，否则重新取一段。
  // Start replaying at t (the picked bar is the last visible one). Re-picking during a replay
  // jumps within the fetched range, or fetches a new window.
  async start(t: number) {
    const e = this.eng
    const b = this.bind
    const s = this.srcOf()
    if (!e || !b || !s) return
    this.pause()
    const myGen = ++this.gen
    this.set({ selecting: false, atEnd: false, hint: null })
    const d = this.data
    if (d && this.state.active && d.bars.length > 0 && t >= d.bars[0].t && t <= d.bars[d.bars.length - 1].t) {
      const res = resolveStart(d.bars, t, this.state.earliest)
      if (res) { this.show(res.idx); return }
    }
    const nowSec = Math.floor(this.nowMs() / 1000)
    const start = Math.min(t, nowSec)
    const win = startWindow(start, s.srcSpacing, nowSec)
    this.set({ loading: true })
    let r: ChartRangeOut
    try {
      r = await this.fetchSafe(b.symbol, s.src, win.from, win.to, start)
    } catch {
      if (myGen !== this.gen) return
      this.set({ loading: false })
      this.hint('failed')
      return
    }
    if (myGen !== this.gen || this.bind !== b) return
    const earliest = r.earliest ?? null
    const key = this.earliestKey()
    if (key) earliestCache.set(key, earliest)
    const src = r.bars
    const hasOlder = earliest == null ? src.length > 0 : src.length > 0 && src[0].t > earliest
    let bars: Candle[]
    let srcTail: Candle[] = []
    if (s.spec) {
      const ch = buildDerived(src, s.spec, hasOlder)
      bars = ch.bars
      srcTail = ch.srcTail
    } else {
      bars = src.slice()
    }
    const fetchedTo = Math.max(win.to, src.length ? src[src.length - 1].t : win.to)
    const done = win.to >= nowSec - 1
    const res = resolveStart(bars, start, earliest)
    if (!res) {
      this.set({ loading: false, earliest })
      this.hint('noData', start)
      return
    }
    if (!this.live) {
      this.live = {
        bars: e.candlesRef.current,
        lastTime: e.lastTimeRef.current,
        hasMore: e.hasMoreHistoryRef.current,
        dataKey: b.dataKeyRef?.current ?? '',
      }
    }
    this.data = { bars, idx: res.idx, done, fetchedTo, srcTail, spec: s.spec, src: s.src, srcSpacing: s.srcSpacing }
    if (b.dataKeyRef) b.dataKeyRef.current = `replay|${b.symbol}|${b.interval}`
    e.hasMoreHistoryRef.current = hasOlder
    this.set({ active: true, loading: false, earliest })
    this.show(res.idx)
    if (res.clamped) this.hint('clamped', bars[res.idx].t)
    void this.maybePrefetch()
  }

  // 把回放数据的前 idx+1 根放上图，视窗跟到最右 / put the first idx+1 bars on the chart and follow the right edge
  private show(idx: number) {
    const e = this.eng
    const d = this.data
    if (!e || !d || d.bars.length === 0) return
    d.idx = Math.max(0, Math.min(idx, d.bars.length - 1))
    const bar = d.bars[d.idx]
    e.candlesRef.current = d.bars.slice(0, d.idx + 1)
    e.lastTimeRef.current = bar.t
    e.renderAll()
    e.recomputeIndicators()
    e.isFollowingLiveRef.current = true
    try { e.chartRef.current?.timeScale().scrollToRealTime() } catch { /* 图表已销毁 / disposed */ }
    this.bind?.onCursor?.(bar)
    this.set({ cursorTime: bar.t, atEnd: false })
  }

  // 往右走一根 / advance one bar
  step(): StepState {
    const e = this.eng
    const d = this.data
    if (!this.state.active || !e || !d) return 'end'
    const s = stepState(d.bars.length, d.idx, d.done, !!d.spec && !d.done)
    if (s === 'ok') {
      d.idx++
      const bar = d.bars[d.idx]
      const vis = e.candlesRef.current
      // 图上的数组应当正好是前 idx 根；对不上（别处改过）就整段重设
      // The chart array should be exactly the first idx bars; if something changed it, reset it whole
      if (vis.length === d.idx && (d.idx === 0 || vis[d.idx - 1].t === d.bars[d.idx - 1].t)) {
        vis.push(bar)
        e.lastTimeRef.current = bar.t
        e.renderTail()
      } else {
        e.candlesRef.current = d.bars.slice(0, d.idx + 1)
        e.lastTimeRef.current = bar.t
        e.renderAll()
      }
      e.recomputeIndicators()
      if (e.isFollowingLiveRef.current) { try { e.chartRef.current?.timeScale().scrollToRealTime() } catch { /* disposed */ } }
      this.bind?.onCursor?.(bar)
      this.set({ cursorTime: bar.t, loading: false })
    } else if (s === 'end') {
      this.stopTimer()
      this.set({ playing: false, loading: false, atEnd: true })
      this.hint('end')
    } else {
      // 等下一块数据 / waiting for the next chunk
      if (!this.state.loading) this.set({ loading: true })
    }
    void this.maybePrefetch()
    return s
  }

  private async maybePrefetch() {
    const d = this.data
    const b = this.bind
    if (!d || !b || this.fetching || !needsMore(d.bars.length, d.idx, d.done)) return
    if (this.nowMs() < this.retryAt) return
    this.fetching = true
    const myGen = this.gen
    const nowSec = Math.floor(this.nowMs() / 1000)
    const win = chunkWindow(d.fetchedTo, d.srcSpacing, nowSec)
    try {
      // 截断时往起点收（保证与已有数据连续）/ on a cut shrink toward the start (keeps it contiguous)
      const r = await this.fetchSafe(b.symbol, d.src, win.from, win.to, win.from)
      if (myGen !== this.gen || this.data !== d) return
      const lastVisibleBefore = d.bars[d.idx]
      if (d.spec) {
        const ch = mergeDerived({ bars: d.bars, srcTail: d.srcTail }, r.bars, d.spec)
        d.bars = ch.bars
        d.srcTail = ch.srcTail
      } else {
        d.bars = appendNewer(d.bars, r.bars)
      }
      const got = r.bars.length ? r.bars[r.bars.length - 1].t : win.from
      // 截断后实际只到 got；没截断就到窗口右端 / after a cut we only reached `got`, else the window end
      d.fetchedTo = r.truncated ? got : Math.max(win.to, got)
      d.done = !r.truncated && win.to >= nowSec - 1
      // 当前所在那根被重新合成了（派生周期的不完整尾桶）：图上那根也换掉
      // The bar under the cursor was re-aggregated (a partial derived tail): swap it on the chart too
      const cur = d.bars[d.idx]
      const e = this.eng
      if (e && cur && lastVisibleBefore && cur.t === lastVisibleBefore.t && cur !== lastVisibleBefore) {
        const vis = e.candlesRef.current
        if (vis.length === d.idx + 1) { vis[d.idx] = cur; e.renderTail(); e.recomputeIndicators() }
      }
      this.retryAt = 0
    } catch {
      this.retryAt = this.nowMs() + RETRY_MS
    } finally {
      this.fetching = false
    }
  }

  // ── 播放 / playback ──
  play() {
    if (!this.state.active || this.state.atEnd || this.state.playing) return
    this.set({ playing: true })
    this.schedule()
  }
  pause() {
    this.stopTimer()
    if (this.state.playing) this.set({ playing: false, loading: false })
  }
  toggle() { if (this.state.playing) this.pause(); else this.play() }
  setSpeed(x: number) {
    const v = snapSpeed(x)
    if (v === this.state.speed) return
    this.set({ speed: v })
    if (this.state.playing) this.schedule()
  }
  private schedule() {
    this.stopTimer()
    this.timer = setTimeout(() => {
      this.timer = undefined
      if (!this.state.playing) return
      const s = this.step()
      if (s !== 'end' && this.state.playing) this.schedule()
    }, speedMs(this.state.speed))
  }
  private stopTimer() {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
  }

  // 退出回放：实时数据原样放回、跟到最新、让数据层立即轮询 / exit: live data back, follow live, poll now
  exit() {
    const e = this.eng
    const live = this.live
    const b = this.bind
    this.gen++
    this.stopTimer()
    if (this.state.active && live && e) {
      e.candlesRef.current = live.bars
      e.lastTimeRef.current = live.lastTime
      e.hasMoreHistoryRef.current = live.hasMore
      if (b?.dataKeyRef) b.dataKeyRef.current = live.dataKey
      e.renderAll()
      e.recomputeIndicators()
      e.isFollowingLiveRef.current = true
      try { e.chartRef.current?.timeScale().scrollToRealTime() } catch { /* disposed */ }
    }
    this.live = null
    this.data = null
    this.set({ ...REPLAY_IDLE, speed: this.state.speed, earliest: this.state.earliest })
    if (live) b?.onLiveRestored?.()
  }

  dismissHint() { if (this.state.hint) this.set({ hint: null }) }

  // ── 给数据层用 / for the data layer ──
  // 回放中往左翻页：更早的 bar 并进回放数据，返回新的可见数组（前 idx+1 根）。
  // Paging left during a replay: merge older bars into the replay data and return the new visible array.
  prependOlderVisible(older: readonly Candle[]): Candle[] | null {
    const d = this.data
    if (!d) return null
    const r = prependOlder(d.bars, older)
    d.bars = r.bars
    d.idx += r.inserted
    return d.bars.slice(0, d.idx + 1)
  }

  // 回放开始后实时历史才回来：更新存着的实时数据 / live history landed after the replay started: update the stash
  replaceLive(bars: Candle[], hasMore: boolean, dataKey?: string) {
    if (!this.live || bars.length === 0) return
    this.live = { ...this.live, bars, lastTime: bars[bars.length - 1].t, hasMore, dataKey: dataKey ?? this.live.dataKey }
  }
}
