// 阶段 4 第二批指标的纯数学（口径同 math.ts：TradingView 内置指标 / Pine `ta.*`，输入按时间升序，
// 输出等长，算不出为 null）。第一批的基础函数从 math.ts 复用。
// Pure math for the phase 4 batch 2 indicators (same rules as math.ts: TradingView built-ins /
// Pine `ta.*`, ascending input, equal-length output, null where undefined). Reuses math.ts basics.
import type { Candle } from '../../../api/types'
import {
  atr, bollinger, change, ema, highest, lowest, roc, rsi, sma, src, stdev, sum, trueRange, wma,
  type Out, type Src,
} from './math'

const nulls = (n: number): Out => new Array<number | null>(n).fill(null)
const toLen = (len: number): number => (len >= 1 ? Math.floor(len) : 0)
function zip(a: Src, b: Src, f: (x: number, y: number) => number | null): Out {
  return a.map((x, i) => {
    const y = b[i]
    return x == null || y == null ? null : f(x, y)
  })
}
const back = (s: Src, k: number) => (i: number): number | null => (i - k >= 0 ? s[i - k] ?? null : null)
// 线性组合，任一为 null 则 null / weighted sum; null if any term is null
function combo(parts: [Src, number][]): Out {
  const n = parts[0]?.[0].length ?? 0
  const out = nulls(n)
  for (let i = 0; i < n; i++) {
    let t = 0
    let ok = true
    for (const [s, w] of parts) { const v = s[i]; if (v == null) { ok = false; break } t += v * w }
    if (ok) out[i] = t
  }
  return out
}

// ───────── 均线 / moving averages ─────────

// 考夫曼自适应：效率比 ER 决定平滑系数；以首个可算点的价格为种子
// Kaufman adaptive: the efficiency ratio sets the smoothing; seeded with the price at the first computable bar
export function kama(s: Src, len = 10, fast = 2, slow = 30): Out {
  const L = toLen(len)
  const n = s.length
  const out = nulls(n)
  if (!L) return out
  const fsc = 2 / (fast + 1)
  const ssc = 2 / (slow + 1)
  let prev: number | null = null
  for (let i = L; i < n; i++) {
    const v = s[i]
    const o = s[i - L]
    if (v == null || o == null) continue
    let vol = 0
    let ok = true
    for (let j = i - L + 1; j <= i; j++) { const a = s[j]; const b = s[j - 1]; if (a == null || b == null) { ok = false; break } vol += Math.abs(a - b) }
    if (!ok) continue
    const er = vol === 0 ? 0 : Math.abs(v - o) / vol
    const sc = (er * (fsc - ssc) + ssc) ** 2
    prev = prev == null ? v : prev + sc * (v - prev)
    out[i] = prev
  }
  return out
}

// 麦金利动态线：mg += (src − mg) / (len · (src/mg)^4)，以 EMA 为种子（同 TV）
// McGinley Dynamic: mg += (src − mg) / (len · (src/mg)^4), seeded with the EMA (as on TV)
export function mcginley(s: Src, len = 14): Out {
  const L = toLen(len)
  const e = ema(s, L)
  const out = nulls(s.length)
  let prev: number | null = null
  for (let i = 0; i < s.length; i++) {
    const v = s[i]
    if (v == null) continue
    if (prev == null) { prev = e[i]; out[i] = prev; continue }
    const r: number = prev === 0 ? 1 : v / prev
    prev = prev + (v - prev) / (L * r ** 4)
    out[i] = prev
  }
  return out
}

// ───────── 趋势 / trend ─────────

// 线性回归通道：只画最近 len 根（同 TV），带宽 = mult × 残差标准差
// Linear regression channel over the last len bars only (as on TV); width = mult × residual stdev
export function linregChannel(s: Src, len = 100, mult = 2): { basis: Out; upper: Out; lower: Out } {
  const n = s.length
  const basis = nulls(n)
  const upper = nulls(n)
  const lower = nulls(n)
  const L = Math.min(toLen(len), n)
  if (L < 2) return { basis, upper, lower }
  const a0 = n - L
  for (let j = a0; j < n; j++) if (s[j] == null) return { basis, upper, lower }
  let sx = 0; let sy = 0; let sxy = 0; let sxx = 0
  for (let j = 0; j < L; j++) { const y = s[a0 + j] as number; sx += j; sy += y; sxy += j * y; sxx += j * j }
  const slope = (L * sxy - sx * sy) / (L * sxx - sx * sx)
  const icpt = (sy - slope * sx) / L
  let q = 0
  for (let j = 0; j < L; j++) q += ((s[a0 + j] as number) - (icpt + slope * j)) ** 2
  const dev = Math.sqrt(q / L)
  for (let j = 0; j < L; j++) {
    const b = icpt + slope * j
    basis[a0 + j] = b
    upper[a0 + j] = b + mult * dev
    lower[a0 + j] = b - mult * dev
  }
  return { basis, upper, lower }
}

// 价格通道：前 len 根（不含当根）的最高 / 最低 / Price channel: highest / lowest of the previous len bars
export function priceChannel(bars: Candle[], len = 20): { upper: Out; lower: Out; mid: Out } {
  const hh = highest(src(bars, 'high'), len)
  const ll = lowest(src(bars, 'low'), len)
  const upper = hh.map((_, i) => (i > 0 ? hh[i - 1] : null))
  const lower = ll.map((_, i) => (i > 0 ? ll[i - 1] : null))
  return { upper, lower, mid: zip(upper, lower, (a, b) => (a + b) / 2) }
}

export function vortex(bars: Candle[], len = 14): { plus: Out; minus: Out } {
  const vmp = bars.map((b, i) => (i === 0 ? null : Math.abs(b.h - bars[i - 1].l)))
  const vmm = bars.map((b, i) => (i === 0 ? null : Math.abs(b.l - bars[i - 1].h)))
  const tr = trueRange(bars).map((v, i) => (i === 0 ? null : v))
  const st = sum(tr, len)
  return { plus: zip(sum(vmp, len), st, (a, b) => (b === 0 ? null : a / b)), minus: zip(sum(vmm, len), st, (a, b) => (b === 0 ? null : a / b)) }
}

// 多空分两条线（同超级趋势的画法），翻转处给出下标 / long / short as two lines (like Supertrend) plus flip indices
export type StopOut = { long: Out; short: Out; flips: { i: number; dir: 1 | -1 }[] }

// 吊灯止损（TV：用收盘价求极值）/ Chandelier Exit (TV: extremes of the close)
export function chandelier(bars: Candle[], len = 22, mult = 3): StopOut {
  const n = bars.length
  const a = atr(bars, len)
  const c = src(bars, 'close')
  const hh = highest(c, len)
  const ll = lowest(c, len)
  const long = nulls(n)
  const short = nulls(n)
  const flips: StopOut['flips'] = []
  let ls: number | null = null
  let ss: number | null = null
  let dir = 1
  for (let i = 0; i < n; i++) {
    const x = a[i]; const h = hh[i]; const l = ll[i]
    if (x == null || h == null || l == null) continue
    let nl = h - mult * x
    let ns = l + mult * x
    if (ls != null && i > 0 && c[i - 1] > ls) nl = Math.max(nl, ls)
    if (ss != null && i > 0 && c[i - 1] < ss) ns = Math.min(ns, ss)
    const pd = dir
    if (ss != null && c[i] > ss) dir = 1
    else if (ls != null && c[i] < ls) dir = -1
    if (ls != null && dir !== pd) flips.push({ i, dir: dir as 1 | -1 })
    ls = nl
    ss = ns
    if (dir === 1) long[i] = nl
    else short[i] = ns
  }
  return { long, short, flips }
}

// 波动止损（TV Volatility Stop）/ TV's Volatility Stop
export function volStop(bars: Candle[], len = 20, mult = 2): StopOut {
  const n = bars.length
  const a = atr(bars, len)
  const c = src(bars, 'close')
  const long = nulls(n)
  const short = nulls(n)
  const flips: StopOut['flips'] = []
  let mx = -Infinity
  let mn = Infinity
  let stop: number | null = null
  let up = true
  for (let i = 0; i < n; i++) {
    const x = a[i]
    if (x == null) continue
    const m = x * mult
    const v = c[i]
    mx = Math.max(mx, v)
    mn = Math.min(mn, v)
    if (stop == null) { stop = v - m; up = true }
    else stop = up ? Math.max(stop, mx - m) : Math.min(stop, mn + m)
    const nu: boolean = v - stop >= 0
    if (nu !== up) {
      up = nu
      mx = v
      mn = v
      stop = up ? mx - m : mn + m
      flips.push({ i, dir: up ? 1 : -1 })
    }
    if (up) long[i] = stop
    else short[i] = stop
  }
  return { long, short, flips }
}

// 钱德-克罗尔止损 / Chande Kroll Stop
export function chandeKroll(bars: Candle[], p = 10, x = 1, q = 9): { long: Out; short: Out } {
  const a = atr(bars, p)
  const fh = zip(highest(src(bars, 'high'), p), a, (h, r) => h - x * r)
  const fl = zip(lowest(src(bars, 'low'), p), a, (l, r) => l + x * r)
  return { short: highest(fh, q), long: lowest(fl, q) }
}

// ───────── 动量 / momentum ─────────

export function ppo(s: Src, fast = 12, slow = 26, signal = 9): { ppo: Out; signal: Out; hist: Out } {
  const p = zip(ema(s, fast), ema(s, slow), (a, b) => (b === 0 ? null : ((a - b) / b) * 100))
  const sg = ema(p, signal)
  return { ppo: p, signal: sg, hist: zip(p, sg, (a, b) => a - b) }
}

export function trix(s: Src, len = 18): Out {
  const lg = s.map((v) => (v == null || v <= 0 ? null : Math.log(v)))
  return change(ema(ema(ema(lg, len), len), len), 1).map((v) => (v == null ? null : v * 10000))
}

export function ultimate(bars: Candle[], f = 7, m = 14, sl = 28): Out {
  const bp = bars.map((b, i) => (i === 0 ? null : b.c - Math.min(b.l, bars[i - 1].c)))
  const tr = bars.map((b, i) => (i === 0 ? null : Math.max(b.h, bars[i - 1].c) - Math.min(b.l, bars[i - 1].c)))
  const avg = (L: number) => zip(sum(bp, L), sum(tr, L), (a, b) => (b === 0 ? null : a / b))
  const a1 = avg(f); const a2 = avg(m); const a3 = avg(sl)
  return a1.map((x, i) => { const y = a2[i]; const z = a3[i]; return x == null || y == null || z == null ? null : (100 * (4 * x + 2 * y + z)) / 7 })
}

export function cmo(s: Src, len = 9): Out {
  const ch = change(s, 1)
  const up = sum(ch.map((v) => (v == null ? null : v >= 0 ? v : 0)), len)
  const dn = sum(ch.map((v) => (v == null ? null : v >= 0 ? 0 : -v)), len)
  return zip(up, dn, (a, b) => (a + b === 0 ? null : (100 * (a - b)) / (a + b)))
}

// 去趋势：src − 往回 len/2+1 根的 SMA（不居中，TV 默认）/ src − SMA from len/2+1 bars back (not centred, TV default)
export function dpo(s: Src, len = 21): Out {
  const m = sma(s, len)
  const k = Math.floor(toLen(len) / 2) + 1
  const mb = back(m, k)
  return s.map((v, i) => { const x = mb(i); return v == null || x == null ? null : v - x })
}

export function fisher(bars: Candle[], len = 9): { fisher: Out; trigger: Out } {
  const n = bars.length
  const h = src(bars, 'hl2')
  const hh = highest(h, len)
  const ll = lowest(h, len)
  const fish = nulls(n)
  const trig = nulls(n)
  let val = 0
  let f1: number | null = null
  for (let i = 0; i < n; i++) {
    const a = hh[i]; const b = ll[i]
    if (a == null || b == null) continue
    const x = a === b ? 0 : (h[i] - b) / (a - b) - 0.5
    val = Math.max(-0.999, Math.min(0.999, 0.66 * x + 0.67 * val))
    const prev: number | null = f1
    f1 = 0.5 * Math.log((1 + val) / (1 - val)) + 0.5 * (prev ?? 0)
    fish[i] = f1
    trig[i] = prev
  }
  return { fisher: fish, trigger: trig }
}

// ta.percentrank：前 len 个值里不大于当前值的比例 / share of the previous len values ≤ the current one
export function percentRank(s: Src, len: number): Out {
  const L = toLen(len)
  return s.map((v, i) => {
    if (v == null || !L || i < L) return null
    let c = 0
    for (let j = i - L; j < i; j++) { const x = s[j]; if (x == null) return null; if (x <= v) c++ }
    return (100 * c) / L
  })
}

export function connorsRsi(s: Src, lenRsi = 3, lenUd = 2, lenRoc = 100): Out {
  const ud = nulls(s.length)
  let st = 0
  for (let i = 0; i < s.length; i++) {
    const v = s[i]; const p = i > 0 ? s[i - 1] : null
    if (v == null) continue
    if (p == null) { ud[i] = 0; continue }
    st = v === p ? 0 : v > p ? (st <= 0 ? 1 : st + 1) : (st >= 0 ? -1 : st - 1)
    ud[i] = st
  }
  const r1 = rsi(s, lenRsi)
  const r2 = rsi(ud, lenUd)
  const pr = percentRank(roc(s, 1), lenRoc)
  return r1.map((a, i) => { const b = r2[i]; const c = pr[i]; return a == null || b == null || c == null ? null : (a + b + c) / 3 })
}

// ta.swma：(x[3] + 2x[2] + 2x[1] + x) / 6
export function swma(s: Src): Out {
  return s.map((v, i) => {
    if (i < 3 || v == null) return null
    const a = s[i - 1]; const b = s[i - 2]; const c = s[i - 3]
    return a == null || b == null || c == null ? null : (c + 2 * b + 2 * a + v) / 6
  })
}

// 相对活力指数 / Relative Vigor Index
export function rvi(bars: Candle[], len = 10): { rvi: Out; signal: Out } {
  const num = swma(bars.map((b) => b.c - b.o))
  const den = swma(bars.map((b) => b.h - b.l))
  const r = zip(sum(num, len), sum(den, len), (a, b) => (b === 0 ? null : a / b))
  return { rvi: r, signal: swma(r) }
}

// 随机动量指数 SMI（TV 口径）/ Stochastic Momentum Index (TV)
export function smi(bars: Candle[], kLen = 10, dLen = 3, emaLen = 3): { smi: Out; signal: Out } {
  const hh = highest(src(bars, 'high'), kLen)
  const ll = lowest(src(bars, 'low'), kLen)
  const diff = zip(hh, ll, (a, b) => a - b)
  const rdiff = bars.map((b, i) => { const a = hh[i]; const c = ll[i]; return a == null || c == null ? null : b.c - (a + c) / 2 })
  const ee = (x: Src) => ema(ema(x, dLen), dLen)
  const s = zip(ee(rdiff), ee(diff), (a, b) => (b === 0 ? 0 : (a / (b / 2)) * 100))
  return { smi: s, signal: ema(s, emaLen) }
}

// 真实强度指数 / True Strength Index
export function tsi(s: Src, long = 25, short = 13, signal = 13): { tsi: Out; signal: Out } {
  const pc = change(s, 1)
  const ds = (x: Src) => ema(ema(x, long), short)
  const t = zip(ds(pc), ds(pc.map((v) => (v == null ? null : Math.abs(v)))), (a, b) => (b === 0 ? null : (100 * a) / b))
  return { tsi: t, signal: ema(t, signal) }
}

export function coppock(s: Src, wmaLen = 10, longRoc = 14, shortRoc = 11): Out {
  return wma(zip(roc(s, longRoc), roc(s, shortRoc), (a, b) => a + b), wmaLen)
}

export function kst(s: Src, r = [10, 15, 20, 30], m = [10, 10, 10, 15], signal = 9): { kst: Out; signal: Out } {
  const k = combo(r.map((len, i) => [sma(roc(s, len), m[i]), i + 1] as [Src, number]))
  return { kst: k, signal: sma(k, signal) }
}

// 多空力量（Elder 的 Bull + Bear 合成一根柱，同 TV）/ Bull Bear Power (bull + bear as one column, as on TV)
export function bullBear(bars: Candle[], len = 13): Out {
  const e = ema(src(bars, 'close'), len)
  return bars.map((b, i) => { const x = e[i]; return x == null ? null : b.h - x + (b.l - x) })
}

// 均势 Balance of Power：(c − o) / (h − l)
export function bop(bars: Candle[]): Out {
  return bars.map((b) => (b.h === b.l ? 0 : (b.c - b.o) / (b.h - b.l)))
}

// ───────── 波动 / volatility ─────────

export function bbPercent(s: Src, len = 20, mult = 2): Out {
  const b = bollinger(s, len, mult)
  return s.map((v, i) => { const u = b.upper[i]; const l = b.lower[i]; return v == null || u == null || l == null || u === l ? null : (v - l) / (u - l) })
}

export function bbWidth(s: Src, len = 20, mult = 2): Out {
  const b = bollinger(s, len, mult)
  return b.basis.map((m, i) => { const u = b.upper[i]; const l = b.lower[i]; return m == null || u == null || l == null || m === 0 ? null : ((u - l) / m) * 100 })
}

// 历史波动率（年化 %）：日内与日线按 365 / 1，更大周期按 365 / 7
// Historical volatility (annualised %): intraday and daily use 365 / 1, larger timeframes 365 / 7
export function histVol(s: Src, len = 10, perDays = 1): Out {
  const lr = s.map((v, i) => { const p = i > 0 ? s[i - 1] : null; return v == null || p == null || v <= 0 || p <= 0 ? null : Math.log(v / p) })
  const k = 100 * Math.sqrt(365 / perDays)
  return stdev(lr, len).map((v) => (v == null ? null : v * k))
}

export function choppiness(bars: Candle[], len = 14): Out {
  const L = toLen(len)
  if (L < 2) return nulls(bars.length)
  const st = sum(trueRange(bars), L)
  const hh = highest(src(bars, 'high'), L)
  const ll = lowest(src(bars, 'low'), L)
  return st.map((t, i) => { const a = hh[i]; const b = ll[i]; return t == null || a == null || b == null || a === b ? null : (100 * Math.log10(t / (a - b))) / Math.log10(L) })
}

// 震荡区 Chop Zone：EMA34 的倾角分 9 档上色（TV 公式）/ EMA34 angle in 9 colour bands (TV formula)
export function chopZone(bars: Candle[]): { v: Out; c: (number | null)[] } {
  const n = bars.length
  const avg = src(bars, 'hlc3')
  const hh = highest(src(bars, 'high'), 30)
  const ll = lowest(src(bars, 'low'), 30)
  const e = ema(src(bars, 'close'), 34)
  const v = nulls(n)
  const c: (number | null)[] = nulls(n)
  for (let i = 1; i < n; i++) {
    const a = hh[i]; const b = ll[i]; const e0 = e[i]; const e1 = e[i - 1]
    if (a == null || b == null || e0 == null || e1 == null || a === b) continue
    const span = (25 / (a - b)) * b
    const y2 = ((e1 - e0) / avg[i]) * span
    const cc = Math.sqrt(1 + y2 * y2)
    const ang1 = Math.round((180 * Math.acos(1 / cc)) / Math.PI)
    const ang = y2 > 0 ? -ang1 : ang1
    v[i] = 1
    c[i] = ang >= 5 ? 0 : ang >= 3.57 ? 1 : ang >= 2.14 ? 2 : ang >= 0.71 ? 3 : ang <= -5 ? 8 : ang <= -3.57 ? 7 : ang <= -2.14 ? 6 : ang <= -0.71 ? 5 : 4
  }
  return { v, c }
}

export function massIndex(bars: Candle[], len = 10): Out {
  const span = bars.map((b) => b.h - b.l)
  const e1 = ema(span, 9)
  const e2 = ema(e1, 9)
  return sum(zip(e1, e2, (a, b) => (b === 0 ? null : a / b)), len)
}

export function ulcer(s: Src, len = 14): Out {
  const hh = highest(s, len)
  const dd = zip(s, hh, (v, h) => (h === 0 ? null : (100 * (v - h)) / h))
  return sma(dd.map((x) => (x == null ? null : x * x)), len).map((x) => (x == null ? null : Math.sqrt(x)))
}

export function adr(bars: Candle[], len = 14): Out {
  return sma(bars.map((b) => b.h - b.l), len)
}

// ───────── 成交量（tick 量）/ volume (tick volume) ─────────

const clv = (b: Candle) => (b.h === b.l ? 0 : (b.c - b.l - (b.h - b.c)) / (b.h - b.l))

// 累积/派发线 / Accumulation / Distribution
export function accDist(bars: Candle[]): Out {
  let acc = 0
  return bars.map((b) => (acc += clv(b) * b.v))
}

export function cmf(bars: Candle[], len = 20): Out {
  return zip(sum(bars.map((b) => clv(b) * b.v), len), sum(src(bars, 'volume'), len), (a, b) => (b === 0 ? null : a / b))
}

export function chaikinOsc(bars: Candle[], fast = 3, slow = 10): Out {
  const ad = accDist(bars)
  return zip(ema(ad, fast), ema(ad, slow), (a, b) => a - b)
}

export function efi(bars: Candle[], len = 13): Out {
  return ema(change(src(bars, 'close'), 1).map((v, i) => (v == null ? null : v * bars[i].v)), len)
}

// 简易波动 EOM：div × Δhl2 × (h − l) / v 的 SMA；量为 0 的根为 null
// Ease of Movement: SMA of div × Δhl2 × (h − l) / v; zero-volume bars are null
export function eom(bars: Candle[], len = 14, div = 10000): Out {
  const d = change(src(bars, 'hl2'), 1)
  return sma(d.map((x, i) => (x == null || bars[i].v === 0 ? null : (div * x * (bars[i].h - bars[i].l)) / bars[i].v)), len)
}

// 克林格（TV 简化口径：按 hlc3 涨跌给成交量正负号）/ Klinger (TV's simplified form: volume signed by the hlc3 change)
export function klinger(bars: Candle[], fast = 34, slow = 55, signal = 13): { kvo: Out; signal: Out } {
  const ch = change(src(bars, 'hlc3'), 1)
  const sv = ch.map((c, i) => (c == null ? null : c >= 0 ? bars[i].v : -bars[i].v))
  const k = zip(ema(sv, fast), ema(sv, slow), (a, b) => a - b)
  return { kvo: k, signal: ema(k, signal) }
}

export function pvt(bars: Candle[]): Out {
  let acc = 0
  return bars.map((b, i) => {
    if (i === 0) return 0
    const p = bars[i - 1].c
    if (p !== 0) acc += ((b.c - p) / p) * b.v
    return acc
  })
}

export function netVolume(bars: Candle[]): Out {
  return bars.map((b, i) => (i === 0 ? null : Math.sign(b.c - bars[i - 1].c) * b.v))
}

export function volumeOsc(bars: Candle[], short = 5, long = 10): Out {
  const v = src(bars, 'volume')
  return zip(ema(v, short), ema(v, long), (a, b) => (b === 0 ? null : (100 * (a - b)) / b))
}

// 时间加权均价：锚定期内 ohlc4 的等权平均 / TWAP: equal-weight mean of ohlc4 within the anchor period
export function twap(bars: Candle[], periodKey: (t: number) => number): Out {
  let key: number | null = null
  let s = 0
  let c = 0
  return bars.map((b) => {
    const k = periodKey(b.t)
    if (k !== key) { key = k; s = 0; c = 0 }
    s += (b.o + b.h + b.l + b.c) / 4
    c++
    return s / c
  })
}

// 交叉：+1 上穿 / −1 下穿 / crosses: +1 up, −1 down
export function crosses(a: Src, b: Src): { i: number; dir: 1 | -1 }[] {
  const out: { i: number; dir: 1 | -1 }[] = []
  for (let i = 1; i < a.length; i++) {
    const a0 = a[i - 1]; const b0 = b[i - 1]; const a1 = a[i]; const b1 = b[i]
    if (a0 == null || b0 == null || a1 == null || b1 == null) continue
    if (a0 <= b0 && a1 > b1) out.push({ i, dir: 1 })
    else if (a0 >= b0 && a1 < b1) out.push({ i, dir: -1 })
  }
  return out
}

