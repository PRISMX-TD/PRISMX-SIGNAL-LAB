// 第四批指标的计算：周期成交量分布（PVP-R，按日 / 周 / 月切开，可用小周期 K 线）与 CRP（大周期开盘价 ±
// k·σ 的投影价位，σ = 大周期涨跌幅 (收−开)/开 的标准差 × 本期开盘价）。纯函数。
// Batch 4 math: periodic volume profile (PVP-R, split by day / week / month, optionally from
// lower-timeframe bars) and CRP (projection levels at the higher-timeframe open ± k·σ, where σ is the
// standard deviation of the HTF's (close − open) / open times this period's open). Pure functions.
import type { Candle } from '../../../api/types'
import { brokerBucketStart, brokerOffsetSec, isBrokerAnchored, parseInterval } from '../intervals'
import type { Profile } from './math3'
import { brokerDay, brokerMonth, brokerWeek } from './periods'

// ── PVP-R ──
export type VolMode = 'updown' | 'total' | 'delta'

// 价值区：从 POC 起每次比较上下各一行，并入较大者（相等取上面）；再并就超过目标时停下。
// Value area: from the POC compare the rows just above and below, take the bigger (ties go up);
// stop when the next row would push past the target.
export function valueAreaStop(tot: number[], poc: number, vaPct: number): [number, number] {
  const n = tot.length
  const total = tot.reduce((a, b) => a + b, 0)
  const target = (total * vaPct) / 100
  let lo = poc
  let hi = poc
  let acc = tot[poc] ?? 0
  while (acc < target && (lo > 0 || hi < n - 1)) {
    const hasUp = hi < n - 1
    const hasDn = lo > 0
    const above = hasUp ? tot[hi + 1] : 0
    const below = hasDn ? tot[lo - 1] : 0
    const goUp = hasUp && (!hasDn || above >= below)
    const add = goUp ? above : below
    if (acc + add > target) break
    if (goUp) hi++
    else lo--
    acc += add
  }
  return [lo, hi]
}

// 一根「量单位」（小周期 K 线或图上 K 线）：高低、量、算上涨还是下跌
// One volume unit (a lower-timeframe bar or a chart bar): high, low, volume and whether it counts as up
export interface VolUnit { h: number; l: number; v: number; up: boolean }

// 收 > 开 为涨，收 < 开 为跌，相等时跟上一根收盘比（没有上一根算涨）；prev 跨调用接着用
// Close > open is up, close < open down; a tie compares with the previous close (none = up); prev carries across calls
export function toUnits(bars: Candle[], prev: { c: number | null }): VolUnit[] {
  return bars.map((b) => {
    const up = b.c > b.o ? true : b.c < b.o ? false : prev.c == null ? true : b.c >= prev.c
    prev.c = b.c
    return { h: b.h, l: b.l, v: b.v ?? 0, up }
  })
}

// 一个周期的分布。hi / lo 来自图上 K 线；layout 'ticks' 时每行 rowSize 个跳动点（行数超上限就均分）。
// 上涨/下跌模式最多 200 行，其余 400 行。
// One period's profile. hi / lo come from the chart bars; with layout 'ticks' each row is rowSize
// ticks (spread evenly once the row cap is hit). The cap is 200 rows in up/down mode, else 400.
export function pvpProfile(units: VolUnit[], hiIn: number, loIn: number, opt: {
  i1: number; i2: number; mode: VolMode; vaPct: number; layout: 'rows' | 'ticks'; rowSize: number; tick: number
}): Profile {
  const lo = loIn
  const hi = hiIn > loIn ? hiIn : loIn + opt.tick
  const maxR = opt.mode === 'updown' ? 200 : 400
  let n = Math.max(1, Math.min(Math.round(opt.rowSize), maxR))
  let step = (hi - lo) / n
  if (opt.layout === 'ticks') {
    step = Math.max(1, Math.round(opt.rowSize)) * opt.tick
    n = Math.max(1, Math.ceil((hi - lo) / step - 1e-9))
    if (n > maxR) { n = maxR; step = (hi - lo) / n }
  }
  const up = new Array<number>(n).fill(0)
  const dn = new Array<number>(n).fill(0)
  for (const u of units) {
    if (!(u.v > 0)) continue
    const dst = u.up ? up : dn
    const r0 = Math.max(0, Math.min(n - 1, Math.floor((u.l - lo) / step)))
    const r1 = Math.max(0, Math.min(n - 1, Math.floor((u.h - lo) / step)))
    if (u.h <= u.l || r0 === r1) { dst[r0] += u.v; continue }
    const rng = u.h - u.l
    for (let r = r0; r <= r1; r++) {
      const bot = lo + r * step
      const ov = Math.min(u.h, bot + step) - Math.max(u.l, bot)
      if (ov > 0) dst[r] += (u.v * ov) / rng
    }
  }
  const tot = up.map((x, r) => x + dn[r])
  let poc = 0
  for (let r = 1; r < n; r++) if (tot[r] > tot[poc]) poc = r
  const [val, vah] = valueAreaStop(tot, poc, opt.vaPct)
  return { i1: opt.i1, i2: opt.i2, lo, step, up, dn, poc, vah, val }
}

// 原脚本挑小周期的规则（我们没有 30 分钟，阶梯 1 / 5 / 15 / 60 / 240）：≤1 分钟不用，≤15 分钟用 1，
// ≤1 小时用 5，≤4 小时用 15，≤日线用 60，其余 240。返回从这一级起、比图表周期小的候选。
// The script's lower-timeframe rule (we have no 30m; ladder 1 / 5 / 15 / 60 / 240): none at ≤1m,
// 1 at ≤15m, 5 at ≤1h, 15 at ≤4h, 60 at ≤1D, else 240. Returns the candidates from that level up,
// all below the chart's timeframe.
const LTF: readonly [string, number][] = [['1', 60], ['5', 300], ['15', 900], ['60', 3600], ['240', 14400]]
export function pvpLtfLadder(chartSec: number): { code: string; sec: number }[] {
  if (chartSec <= 60) return []
  const first = chartSec <= 900 ? 60 : chartSec <= 3600 ? 300 : chartSec <= 14400 ? 900 : chartSec <= 86400 ? 3600 : 14400
  return LTF.filter(([, s]) => s >= first && s < chartSec).map(([code, sec]) => ({ code, sec }))
}

// 图上 K 线按周期分段：[起, 止] 下标 / chart bars split into periods: [start, end] indices
export function periodRanges(bars: Candle[], key: (t: number) => number): [number, number][] {
  const out: [number, number][] = []
  let s = 0
  for (let i = 1; i <= bars.length; i++) {
    if (i === bars.length || key(bars[i].t) !== key(bars[s].t)) { out.push([s, i - 1]); s = i }
  }
  return out
}

// ── CRP ──
// 大周期每根的 σ：前 len 根 (收−开)/开 的总体标准差 × 这根的开盘价（Pine 的 ta.stdev(...)[1] * open，
// lookahead 开：本期一开盘就定了，不重绘）。不够 len 根时 null。
// Per-HTF-bar σ: population stdev of (close − open) / open over the previous len bars, times this
// bar's open (Pine's ta.stdev(...)[1] * open with lookahead on: fixed at the period's open, no
// repaint). Null until len bars exist.
export function crpSigma(htf: Candle[], len: number): (number | null)[] {
  const n = htf.length
  const r = htf.map((b) => (b.o ? (b.c - b.o) / b.o : 0))
  const out = new Array<number | null>(n).fill(null)
  let s = 0
  let s2 = 0
  for (let j = 0; j < n; j++) {
    // 此时窗口是 r[j-len .. j-1] / the window is r[j-len .. j-1] here
    if (j >= len) {
      const mean = s / len
      const v = Math.max(0, s2 / len - mean * mean)
      out[j] = Math.sqrt(v) * htf[j].o
    }
    s += r[j]; s2 += r[j] * r[j]
    if (j - len >= 0) { s -= r[j - len]; s2 -= r[j - len] * r[j - len] }
  }
  return out
}

// 启用的倍数（镜像时加上负的），升序；同时记下每个来自第几级（配色、线型用）
// Enabled multiples (plus negatives when mirrored), ascending, each with the level it came from (for colour and style)
export function crpLevels(levels: { on: boolean; k: number }[], mirror: boolean): { k: number; j: number }[] {
  const out: { k: number; j: number }[] = []
  levels.forEach((l, j) => {
    if (!l.on) return
    out.push({ k: l.k, j })
    if (mirror && l.k !== 0) out.push({ k: -l.k, j })
  })
  // 稳定排序，与原脚本的冒泡一致 / stable sort, matching the script's bubble sort
  return out.map((x, i) => ({ ...x, i })).sort((a, b) => a.k - b.k || a.i - b.i).map(({ k, j }) => ({ k, j }))
}

// 大周期这一根什么时候收（下一根的开盘时间，UTC 秒）/ when the HTF bar holding t closes (the next one's open, UTC s)
export function periodEnd(code: string, t: number): number | null {
  const p = parseInterval(code)
  if (!p) return null
  const off = brokerOffsetSec(t)
  if (p.unit === 'min') {
    const len = p.n * 60
    if (isBrokerAnchored(p.n)) return brokerBucketStart(p.n, t) + len - off
    return Math.floor(t / len) * len + len
  }
  if (p.unit === 'D') return (Math.floor(brokerDay(t) / p.n) * p.n + p.n) * 86400 - off
  if (p.unit === 'W') return ((Math.floor(brokerWeek(t) / p.n) * p.n + p.n) * 7 - 3) * 86400 - off
  const m = Math.floor(brokerMonth(t) / p.n) * p.n + p.n
  return Date.UTC(Math.floor(m / 12), m % 12, 1) / 1000 - off
}

// 倒计时文字：'1d 02:03:04' / '02:03:04' / countdown text
export function countdownText(sec: number): string {
  const t = Math.max(0, Math.floor(sec))
  const d = Math.floor(t / 86400)
  const h = Math.floor((t % 86400) / 3600)
  const m = Math.floor((t % 3600) / 60)
  const s = t % 60
  const p2 = (x: number) => String(x).padStart(2, '0')
  return `${d > 0 ? `${d}d ` : ''}${p2(h)}:${p2(m)}:${p2(s)}`
}
