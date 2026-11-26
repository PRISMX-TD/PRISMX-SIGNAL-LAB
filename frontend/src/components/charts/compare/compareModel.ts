// 对比品种的纯逻辑：按主图 K 线时间对齐、价格轴模式的临时覆盖与恢复、各条目放在哪条价格轴 / 哪个窗格、
// 默认配色。单测见 compareModel.test.ts。
// Pure compare-symbol logic: alignment to the main chart's bar times, the temporary price-scale
// override and its restore, which scale / pane each entry goes on, default colours. Tested in
// compareModel.test.ts.
import type { Candle } from '../../../api/types'
import type { ScaleMode } from '../chartPrefs'
import type { CompareEntry } from '../layout/paneState'

export const MAX_COMPARE = 5

// 默认配色：与主图涨跌色、品牌紫都拉开 / default colours, clear of the up/down colours and the brand violet
export const COMPARE_COLORS = ['#f59e0b', '#22d3ee', '#f472b6', '#a3e635', '#60a5fa', '#fb923c', '#e879f9'] as const

export function nextCompareColor(entries: readonly CompareEntry[]): string {
  const used = new Set(entries.map((e) => e.color.toLowerCase()))
  return COMPARE_COLORS.find((c) => !used.has(c)) ?? COMPARE_COLORS[entries.length % COMPARE_COLORS.length]
}

// 把对比品种的收盘价对齐到主图的每根 K 线（同一时间轴，线才对得上；对比品种多出来的 bar 不能给图表
// 加新时间点，否则主图会被挤开）。没有对应 bar 的位置是 null（画成缺口）。
//   · keyOf（派生周期）：同一个桶 key 就算同一根——派生 bar 的时间取桶内第一根源 bar，某品种周一休市时它那一周从周二起算，时间不等但同桶；
//   · 否则对比 bar 落在 [T_i, min(T_{i+1}, T_i + spacing)) 里就归第 i 根，多根取最后一根的收盘（周末多出来的
//     日线落在 T_i + spacing 之后，丢掉）。
// Align a compare symbol's closes to each main bar (one time axis or the lines don't line up;
// extra compare bars must not add time points, which would squeeze the main bars). Positions
// without a matching bar are null (drawn as gaps).
//   · keyOf (derived intervals): same bucket key = same bar — a derived bar's time is its first
//     source bar, so a Monday holiday starts one symbol's week on Tuesday: different times, same bucket;
//   · otherwise a compare bar in [T_i, min(T_{i+1}, T_i + spacing)) belongs to bar i, the last
//     one's close winning (extra weekend dailies fall past T_i + spacing and are dropped).
export function alignCloses(
  mainTimes: readonly number[],
  cmp: readonly Candle[],
  spacing: number | null,
  keyOf?: (t: number) => number,
): (number | null)[] {
  const out: (number | null)[] = new Array(mainTimes.length).fill(null)
  if (mainTimes.length === 0 || cmp.length === 0) return out
  if (keyOf) {
    const byKey = new Map<number, number>()
    for (const b of cmp) byKey.set(keyOf(b.t), b.c)
    for (let i = 0; i < mainTimes.length; i++) out[i] = byKey.get(keyOf(mainTimes[i])) ?? null
    return out
  }
  let j = 0
  for (let i = 0; i < mainTimes.length; i++) {
    const lo = mainTimes[i]
    const next = i + 1 < mainTimes.length ? mainTimes[i + 1] : Infinity
    const hi = spacing != null ? Math.min(next, lo + spacing) : next
    while (j < cmp.length && cmp[j].t < lo) j++
    let k = j
    let v: number | null = null
    while (k < cmp.length && cmp[k].t < hi) { v = cmp[k].c; k++ }
    out[i] = v
    j = k
  }
  return out
}

// ── 价格轴模式 / price-scale mode ──
// 有可见的百分比对比时把主价格轴切到百分比（普通 / 对数 → 百分比；用户本来就是百分比 / 指数化 100 就不动）。
// 激活后用户自己再切模式 → 以用户为准，放开覆盖，直到百分比对比全部消失再重置。用户设置从来不写，
// 撤掉覆盖就是原样恢复。
// While a percent compare is visible the main scale goes to percent (normal / log → percent; a
// user already on percent / indexed-to-100 is left alone). If the user switches modes while it's
// active, the user wins and the override is released until every percent compare is gone. The
// user's setting is never written, so dropping the override restores it exactly.
export interface ScaleForce { active: boolean; baseline: ScaleMode | null }
export const SCALE_FORCE_IDLE: ScaleForce = { active: false, baseline: null }

export function nextScaleForce(prev: ScaleForce, percentVisible: boolean, userMode: ScaleMode): ScaleForce {
  if (!percentVisible) return prev.active || prev.baseline !== null ? SCALE_FORCE_IDLE : prev
  // 刚出现百分比对比：记下用户当时的模式并接管 / a percent compare just appeared: remember the mode, take over
  if (prev.baseline === null) return { active: true, baseline: userMode }
  // 接管期间用户换了模式：放开，以后不再抢 / the user changed modes meanwhile: release for good
  if (prev.active && userMode !== prev.baseline) return { active: false, baseline: userMode }
  return prev
}

// 实际要用的覆盖值（null = 不覆盖）/ the override to apply (null = none)
export function scaleOverrideOf(force: ScaleForce, userMode: ScaleMode): ScaleMode | null {
  if (!force.active) return null
  return userMode === 0 || userMode === 1 ? 2 : null
}

// ── 放在哪 / placement ──
// percent → 主图右轴；scale → 第一个用左轴（指标没占时），其余各自一条叠加轴（库的叠加轴不显示刻度，值看图例）；
// pane → 自己的窗格（按条目顺序，隐藏的不占窗格）。
// percent → the main right scale; scale → the first one takes the left scale (when indicators
// don't use it), the rest get their own overlay scale (the library draws no ticks for overlay
// scales; the legend shows the value); pane → its own pane (entry order; hidden ones take none).
export interface Placement { scaleId: string; pane: boolean }

export function placeEntries(entries: readonly CompareEntry[], leftTaken: boolean): { place: Map<string, Placement>; wantsLeft: boolean; panes: string[] } {
  const place = new Map<string, Placement>()
  const panes: string[] = []
  let leftFree = !leftTaken
  let wantsLeft = false
  for (const e of entries) {
    if (e.mode === 'pane') {
      place.set(e.symbol, { scaleId: 'right', pane: true })
      if (!e.hidden) panes.push(e.symbol)
    } else if (e.mode === 'scale') {
      if (leftFree && !e.hidden) {
        place.set(e.symbol, { scaleId: 'left', pane: false })
        leftFree = false
        wantsLeft = true
      } else {
        place.set(e.symbol, { scaleId: `cmp-${e.symbol}`, pane: false })
      }
    } else {
      place.set(e.symbol, { scaleId: 'right', pane: false })
    }
  }
  return { place, wantsLeft, panes }
}

export const comparePaneId = (symbol: string) => `cmp:${symbol}`

// 没有券商位数时按价位猜个小数位 / guess decimals from the price level when the broker digits are unknown
export function guessDigits(price: number | null | undefined): number {
  const p = Math.abs(price ?? 0)
  if (!(p > 0)) return 2
  if (p < 2) return 5
  if (p < 50) return 4
  if (p < 1000) return 3
  return 2
}

// 列表里能加的品种：去掉主图品种和已加的 / symbols that can still be added
export function addableSymbols(all: readonly string[], main: string, entries: readonly CompareEntry[]): string[] {
  const taken = new Set([main, ...entries.map((e) => e.symbol)].map((s) => s.toUpperCase()))
  return all.filter((s) => !taken.has(s.toUpperCase()))
}
