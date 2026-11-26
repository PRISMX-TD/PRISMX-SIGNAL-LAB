// K 线回放的纯逻辑：起点定位、单步 / 播放的状态判断、速度档位、按时间窗分块取数、派生周期分块拼接。
// 不碰图表、不碰网络，单测直接覆盖（replayModel.test.ts）。
// Pure bar-replay logic: locating the start bar, step / play state, speed steps, time-window
// chunking and derived-interval chunk stitching. No chart, no network — covered directly by
// replayModel.test.ts.
import type { Candle } from '../../../api/types'
import { aggregateBars, type DerivedSpec } from '../derivedIntervals'

// 速度档位（每秒几根）。1× = 每秒一根，10× = 每 100ms 一根。
// Speed steps in bars per second. 1× = one bar a second, 10× = one every 100 ms.
export const REPLAY_SPEEDS = [0.5, 1, 2, 3, 5, 10] as const
export const DEFAULT_REPLAY_SPEED = 1

export function speedMs(x: number): number {
  return Math.round(1000 / (x > 0 ? x : 1))
}

// 不在档位里的值落到最近的一档 / snap any value to the nearest step
export function snapSpeed(x: number): number {
  let best: number = REPLAY_SPEEDS[0]
  for (const s of REPLAY_SPEEDS) if (Math.abs(s - x) < Math.abs(best - x)) best = s
  return best
}

// 最后一根 t <= time 的下标；全部更晚时 -1。bars 按 t 升序。
// Index of the last bar with t <= time; -1 when every bar is later. bars ascend by t.
export function indexAtOrBefore(bars: readonly Candle[], time: number): number {
  let lo = 0
  let hi = bars.length - 1
  let ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (bars[mid].t <= time) { ans = mid; lo = mid + 1 } else hi = mid - 1
  }
  return ans
}

// 起点：time 落在第几根。早于第一根 / 早于库里最早一根 → 从第一根开始并标记 clamped。
// The start: which bar time falls on. Earlier than the first bar or the stored earliest → start
// at the first bar and flag clamped.
export function resolveStart(bars: readonly Candle[], time: number, earliest: number | null): { idx: number; clamped: boolean } | null {
  if (bars.length === 0) return null
  let idx = indexAtOrBefore(bars, time)
  let clamped = earliest != null && time < earliest
  if (idx < 0) { idx = 0; clamped = true }
  return { idx, clamped }
}

// 下一步能不能走：ok = 有下一根；wait = 下一根还没取到（或派生周期的最后一桶可能不完整）；end = 到头了。
// Whether the next step can run: ok = a next bar exists; wait = not fetched yet (or the last
// derived bucket may be partial); end = nothing left.
export type StepState = 'ok' | 'wait' | 'end'
export function stepState(len: number, idx: number, done: boolean, tailPartial: boolean): StepState {
  const next = idx + 1
  if (next >= len) return done ? 'end' : 'wait'
  if (next === len - 1 && tailPartial && !done) return 'wait'
  return 'ok'
}

// 离已取数据的右端不到 ahead 根时预取下一块 / prefetch once fewer than `ahead` bars remain
export function needsMore(len: number, idx: number, done: boolean, ahead = 300): boolean {
  return !done && len - 1 - idx < ahead
}

// 取数窗口（源周期根数 × 源周期间隔）。原生周期最多 1 根 / 间隔，1500 + 3000 根远低于 range 的 5000 上限，
// 所以永远不会被截断（被截断时后端保留最新一段，起点附近就缺了）。
// Fetch windows, in source bars × source spacing. Native data holds at most one bar per
// spacing, so 1500 + 3000 stays under range's 5000 cap and is never truncated (a truncated
// response keeps the newest part, which would leave a hole around the start).
export const REPLAY_BEFORE_SRC = 1500
export const REPLAY_AHEAD_SRC = 3000

export function startWindow(t: number, srcSpacing: number, nowSec: number): { from: number; to: number } {
  return { from: Math.floor(t - REPLAY_BEFORE_SRC * srcSpacing), to: Math.min(nowSec, Math.floor(t + REPLAY_AHEAD_SRC * srcSpacing)) }
}

export function chunkWindow(lastT: number, srcSpacing: number, nowSec: number): { from: number; to: number } {
  return { from: lastT + 1, to: Math.min(nowSec, Math.floor(lastT + REPLAY_AHEAD_SRC * srcSpacing)) }
}

// 随机起点：库里最早一根往后留 300 根历史，离现在至少 100 根。
// Random start: 300 bars of history after the earliest stored bar, at least 100 bars before now.
export function randomStartTime(earliest: number, nowSec: number, spacing: number, rnd: () => number = Math.random): number {
  const lo = earliest + 300 * spacing
  const hi = nowSec - 100 * spacing
  if (hi <= lo) return Math.max(earliest, Math.floor((earliest + nowSec) / 2))
  return Math.floor(lo + rnd() * (hi - lo))
}

// 追加更新的 bar：只要比现有最后一根新的；同一时间的替换最后一根。
// Append newer bars: only those after the current last; one with the same time replaces it.
export function appendNewer(bars: readonly Candle[], newer: readonly Candle[]): Candle[] {
  const out = bars.slice()
  for (const b of newer) {
    const lastT = out.length ? out[out.length - 1].t : -Infinity
    if (b.t > lastT) out.push(b)
    else if (b.t === lastT) out[out.length - 1] = b
  }
  return out
}

// 往左补的更早 bar：只要早于现有第一根的 / older bars: only those before the current first
export function prependOlder(bars: readonly Candle[], older: readonly Candle[]): { bars: Candle[]; inserted: number } {
  const first = bars.length ? bars[0].t : Infinity
  const add = older.filter((b) => b.t < first)
  if (add.length === 0) return { bars: bars.slice(), inserted: 0 }
  return { bars: [...add, ...bars], inserted: add.length }
}

// ── 派生周期 / derived intervals ──
// 回放数据按图表周期存（派生 bar），另外记着「最后一桶」的源 bar，下一块源数据到了把它们一起重新合成。
// Replay data is kept at the chart interval (derived bars) plus the source bars of the last
// bucket, which are re-aggregated together with the next source chunk when it lands.
export interface DerivedChunk { bars: Candle[]; srcTail: Candle[] }

// 第一块：合成；最早那桶可能只拿到后半截（hasOlder 时一定丢掉不确定的头桶）。
// First chunk: aggregate; the oldest bucket may be partial (dropped when older data exists and
// its first source bar isn't certainly the bucket start).
export function buildDerived(src: readonly Candle[], spec: DerivedSpec, hasOlder: boolean): DerivedChunk {
  if (src.length === 0) return { bars: [], srcTail: [] }
  let bars = aggregateBars(src as Candle[], spec)
  if (hasOlder && bars.length > 1 && !spec.startsBucket(src[0].t)) bars = bars.slice(1)
  const lastKey = spec.bucketKey(src[src.length - 1].t)
  return { bars, srcTail: src.filter((b) => spec.bucketKey(b.t) === lastKey) }
}

// 后续块：把旧的最后一桶（可能不完整）连同新源 bar 一起重合成，替换掉旧的最后一根。
// Later chunks: re-aggregate the old (possibly partial) last bucket with the new source bars and
// replace the old last bar.
export function mergeDerived(prev: DerivedChunk, chunk: readonly Candle[], spec: DerivedSpec): DerivedChunk {
  const lastSrcT = prev.srcTail.length ? prev.srcTail[prev.srcTail.length - 1].t : -Infinity
  const fresh = chunk.filter((b) => b.t > lastSrcT)
  if (fresh.length === 0) return prev
  if (prev.bars.length === 0) return buildDerived(fresh, spec, false)
  const combined = [...prev.srcTail, ...fresh]
  const agg = aggregateBars(combined, spec)
  // srcTail 为空（第一块没有源 bar）时不替换 / no tail → nothing to replace
  const keep = prev.srcTail.length ? prev.bars.slice(0, -1) : prev.bars
  const lastKey = spec.bucketKey(combined[combined.length - 1].t)
  return { bars: [...keep, ...agg], srcTail: combined.filter((b) => spec.bucketKey(b.t) === lastKey) }
}
