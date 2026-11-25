// 图表指标纯数学（TradingView 口径）：所有函数输入按时间升序，输出与输入等长，
// 算不出的位置为 null。口径以 TradingView 内置指标 / Pine `ta.*` 为准。
//
// Pure indicator math for the chart, benchmarked against TradingView's built-in
// indicators (Pine `ta.*` semantics). Inputs are ascending by time; every output
// has the input's length, with null wherever no value can be computed.
//
// 空值规则 / null rules:
// - 窗口类（sma/wma/stdev/highest…）：窗口未满或窗口内含 null → null。
//   Window-based: null until the window is full, and whenever it holds a null.
// - 递推类（ema/rma 及其衍生）：在第一个「连续 len 个非空值」处以 SMA 作种子；
//   之后遇到 null 输出 null，但递推状态保留，下一个非空值接着上一个值继续算
//   （同 TV 内置函数跳过 na 的行为，避免一个空洞把整段均线清空）。
//   Recursive (ema/rma and friends): seeded with the SMA of the first full
//   window of non-null values; afterwards a null input gives a null output but
//   the state is kept and the next value continues from the last one (like TV's
//   built-ins skipping na, so one gap doesn't wipe out a whole stretch).
// - 分母为 0（stoch / cci / willr 窗口无波动）→ null，同 Pine 的 na。
//   Zero denominators (flat stoch / cci / willr windows) → null, like Pine's na.
// - len < 1 或非数字 → 全 null；非整数长度向下取整。
//   len < 1 or NaN → all nulls; fractional lengths are floored.
import type { Candle } from '../../../api/types'

export type Src = readonly (number | null)[]
export type Out = (number | null)[]
export type MaType = 'sma' | 'ema' | 'wma' | 'rma' | 'hma' | 'dema' | 'tema' | 'vwma' | 'alma' | 'lsma'
export type SrcKind = 'open' | 'high' | 'low' | 'close' | 'hl2' | 'hlc3' | 'ohlc4' | 'hlcc4' | 'volume'

export type Bands = { basis: Out; upper: Out; lower: Out }

const nulls = (n: number): Out => new Array<number | null>(n).fill(null)
const toLen = (len: number): number => (len >= 1 ? Math.floor(len) : 0)

// null 个数前缀和，O(1) 判断窗口是否全非空 / prefix count of nulls: O(1) "window is full" check
function nullPrefix(s: Src): Int32Array {
  const p = new Int32Array(s.length + 1)
  for (let i = 0; i < s.length; i++) p[i + 1] = p[i] + (s[i] == null ? 1 : 0)
  return p
}
const fullAt = (p: Int32Array, i: number, L: number): boolean => i >= L - 1 && p[i + 1] - p[i + 1 - L] === 0

// 对每个完整窗口调用 f(起点, 终点)，其余为 null / call f(start, end) for every full window
function windowed(s: Src, len: number, f: (a: number, b: number) => number | null): Out {
  const n = s.length
  const out = nulls(n)
  const L = toLen(len)
  if (!L) return out
  const p = nullPrefix(s)
  for (let i = L - 1; i < n; i++) if (fullAt(p, i, L)) out[i] = f(i - L + 1, i)
  return out
}

// 逐元素组合，任一为 null 则 null / element-wise combine; null if any input is null
function zip(a: Src, b: Src, f: (x: number, y: number) => number | null): Out {
  return a.map((x, i) => {
    const y = b[i]
    return x == null || y == null ? null : f(x, y)
  })
}

// ───────── 数据源 / sources ─────────

export function src(bars: Candle[], kind: SrcKind): number[] {
  switch (kind) {
    case 'open': return bars.map((b) => b.o)
    case 'high': return bars.map((b) => b.h)
    case 'low': return bars.map((b) => b.l)
    case 'close': return bars.map((b) => b.c)
    case 'hl2': return bars.map((b) => (b.h + b.l) / 2)
    case 'hlc3': return bars.map((b) => (b.h + b.l + b.c) / 3)
    case 'ohlc4': return bars.map((b) => (b.o + b.h + b.l + b.c) / 4)
    case 'hlcc4': return bars.map((b) => (b.h + b.l + 2 * b.c) / 4)
    case 'volume': return bars.map((b) => b.v)
  }
}

// ───────── 均线 / moving averages ─────────

// 每个窗口直接求和而不是滑动加减：滑动和会累积浮点漂移，平盘时得出 1e-15 级的
// 假波动、0..100 的振荡器越界。
// Sums each window directly instead of a sliding add/subtract: the sliding sum
// drifts, producing 1e-15 noise on flat data and pushing 0..100 oscillators out of range.
export function sma(s: Src, len: number): Out {
  const L = toLen(len)
  return windowed(s, L, (a, b) => {
    let t = 0
    for (let j = a; j <= b; j++) t += s[j] as number
    return t / L
  })
}

// 递推均线公共体：SMA 种子 + 跳过 null 继续递推（见文件头）
// Shared recursive core: SMA seed, nulls skipped without resetting (see header)
function recursive(s: Src, L: number, alpha: number): Out {
  const n = s.length
  const out = nulls(n)
  if (!L) return out
  let prev: number | null = null
  let run = 0
  for (let i = 0; i < n; i++) {
    const v = s[i]
    if (prev == null) {
      if (v == null) { run = 0; continue }
      if (++run < L) continue
      let t = 0
      for (let j = i - L + 1; j <= i; j++) t += s[j] as number
      prev = t / L
      out[i] = prev
    } else if (v != null) {
      prev = alpha * v + (1 - alpha) * prev
      out[i] = prev
    }
  }
  return out
}

export function ema(s: Src, len: number): Out {
  const L = toLen(len)
  return recursive(s, L, 2 / (L + 1))
}

// Wilder / SMMA，alpha = 1/len
export function rma(s: Src, len: number): Out {
  const L = toLen(len)
  return recursive(s, L, 1 / L)
}

// 线性加权，最新一根权重 len / linear weights, newest bar weighs len
export function wma(s: Src, len: number): Out {
  const L = toLen(len)
  const norm = (L * (L + 1)) / 2
  return windowed(s, L, (a, b) => {
    let t = 0
    for (let j = a; j <= b; j++) t += (s[j] as number) * (j - a + 1)
    return t / norm
  })
}

// ta.hma：wma(2·wma(len/2) − wma(len), round(√len))，len/2 向下取整
// ta.hma: wma(2·wma(len/2) − wma(len), round(√len)), len/2 floored
export function hma(s: Src, len: number): Out {
  const L = toLen(len)
  if (!L) return nulls(s.length)
  const half = wma(s, Math.max(1, Math.floor(L / 2)))
  const full = wma(s, L)
  return wma(zip(half, full, (h, f) => 2 * h - f), Math.max(1, Math.round(Math.sqrt(L))))
}

export function dema(s: Src, len: number): Out {
  const e1 = ema(s, len)
  return zip(e1, ema(e1, len), (a, b) => 2 * a - b)
}

export function tema(s: Src, len: number): Out {
  const e1 = ema(s, len)
  const e2 = ema(e1, len)
  const e3 = ema(e2, len)
  return e1.map((a, i) => {
    const b = e2[i]
    const c = e3[i]
    return a == null || b == null || c == null ? null : 3 * (a - b) + c
  })
}

export function vwma(s: Src, vol: Src, len: number): Out {
  const pv = sma(zip(s, vol, (x, v) => x * v), len)
  return zip(pv, sma(vol, len), (a, b) => (b === 0 ? null : a / b))
}

// ta.alma：高斯权重，m = offset·(len−1)，σ' = len/sigma，最旧一根是 i=0
// ta.alma: Gaussian weights, m = offset·(len−1), s = len/sigma, oldest bar is i=0
export function alma(s: Src, len: number, offset = 0.85, sigma = 6): Out {
  const L = toLen(len)
  const m = offset * (L - 1)
  const sd = L / sigma
  const w: number[] = []
  let norm = 0
  for (let i = 0; i < L; i++) {
    const x = Math.exp(-((i - m) ** 2) / (2 * sd * sd))
    w.push(x)
    norm += x
  }
  return windowed(s, L, (a, b) => {
    let t = 0
    for (let j = a; j <= b; j++) t += (s[j] as number) * w[j - a]
    return t / norm
  })
}

// ta.linreg：最小二乘拟合（x=0 为最旧），取 x = len−1−offset 处的值
// ta.linreg: least squares (x=0 is oldest), evaluated at x = len−1−offset
export function lsma(s: Src, len: number, offset = 0): Out {
  const L = toLen(len)
  const sx = (L * (L - 1)) / 2
  const sxx = ((L - 1) * L * (2 * L - 1)) / 6
  const den = L * sxx - sx * sx
  return windowed(s, L, (a, b) => {
    let sy = 0
    let sxy = 0
    for (let j = a; j <= b; j++) {
      const y = s[j] as number
      sy += y
      sxy += (j - a) * y
    }
    const slope = den === 0 ? 0 : (L * sxy - sx * sy) / den
    const intercept = (sy - slope * sx) / L
    return intercept + slope * (L - 1 - offset)
  })
}

export function ma(type: MaType, s: Src, len: number, vol?: Src): Out {
  switch (type) {
    case 'sma': return sma(s, len)
    case 'ema': return ema(s, len)
    case 'wma': return wma(s, len)
    case 'rma': return rma(s, len)
    case 'hma': return hma(s, len)
    case 'dema': return dema(s, len)
    case 'tema': return tema(s, len)
    case 'vwma': return vol ? vwma(s, vol, len) : sma(s, len)
    case 'alma': return alma(s, len)
    case 'lsma': return lsma(s, len)
  }
}

// ───────── 统计 / stats & windows ─────────

// 总体标准差（除以 len，同 ta.stdev 默认 biased=true）/ population stdev like ta.stdev
export function stdev(s: Src, len: number): Out {
  const L = toLen(len)
  return windowed(s, L, (a, b) => {
    let m = 0
    for (let j = a; j <= b; j++) m += s[j] as number
    m /= L
    let q = 0
    for (let j = a; j <= b; j++) q += ((s[j] as number) - m) ** 2
    return Math.sqrt(q / L)
  })
}

export function highest(s: Src, len: number): Out {
  return windowed(s, len, (a, b) => {
    let v = -Infinity
    for (let j = a; j <= b; j++) if ((s[j] as number) > v) v = s[j] as number
    return v
  })
}

export function lowest(s: Src, len: number): Out {
  return windowed(s, len, (a, b) => {
    let v = Infinity
    for (let j = a; j <= b; j++) if ((s[j] as number) < v) v = s[j] as number
    return v
  })
}

export function change(s: Src, len = 1): Out {
  const L = toLen(len)
  return s.map((v, i) => {
    if (!L || i < L) return null
    const o = s[i - L]
    return v == null || o == null ? null : v - o
  })
}

export function sum(s: Src, len: number): Out {
  return windowed(s, len, (a, b) => {
    let t = 0
    for (let j = a; j <= b; j++) t += s[j] as number
    return t
  })
}

// ───────── 波幅 / range ─────────

// ta.tr(true)：首根没有前收盘，取 h−l / first bar has no prior close → h−l
export function trueRange(bars: Candle[]): number[] {
  return bars.map((b, i) =>
    i === 0 ? b.h - b.l : Math.max(b.h - b.l, Math.abs(b.h - bars[i - 1].c), Math.abs(b.l - bars[i - 1].c)),
  )
}

export function atr(bars: Candle[], len: number, smoothing: 'rma' | 'sma' | 'ema' | 'wma' = 'rma'): Out {
  return ma(smoothing, trueRange(bars), len)
}

// ───────── 通道 / bands & channels ─────────

export function bollinger(s: Src, len: number, mult: number, maType: MaType = 'sma'): Bands {
  const basis = ma(maType, s, len)
  const sd = stdev(s, len)
  return {
    basis,
    upper: zip(basis, sd, (b, d) => b + mult * d),
    lower: zip(basis, sd, (b, d) => b - mult * d),
  }
}

// TV Keltner：中轨 EMA/SMA(src)，宽度 = mult × ATR(atrLen)（默认「Average True Range」样式）
// TV Keltner: basis EMA/SMA of src, width = mult × ATR(atrLen) (default band style)
export function keltner(bars: Candle[], s: Src, len: number, mult: number, atrLen: number, useEma = true): Bands {
  const basis = useEma ? ema(s, len) : sma(s, len)
  const r = atr(bars, atrLen)
  return {
    basis,
    upper: zip(basis, r, (b, x) => b + mult * x),
    lower: zip(basis, r, (b, x) => b - mult * x),
  }
}

// 含当根（TV 口径，与 utils/indicators 的回测版 donchianHigh 不同）
// Includes the current bar (TV), unlike the backtest-facing donchianHigh in utils/indicators
export function donchian(bars: Candle[], len: number): { upper: Out; lower: Out; basis: Out } {
  const upper = highest(src(bars, 'high'), len)
  const lower = lowest(src(bars, 'low'), len)
  return { upper, lower, basis: zip(upper, lower, (u, l) => (u + l) / 2) }
}

// pct 为百分数（2 表示 ±2%）/ pct is a percentage (2 means ±2%)
export function envelope(s: Src, len: number, pct: number, maType: MaType = 'sma'): Bands {
  const basis = ma(maType, s, len)
  const k = pct / 100
  return {
    basis,
    upper: basis.map((b) => (b == null ? null : b * (1 + k))),
    lower: basis.map((b) => (b == null ? null : b * (1 - k))),
  }
}

// ───────── 趋势 / trend ─────────

// 未平移：调用方把 spanA/spanB 右移 base−1 根、收盘价左移得到迟行线
// Not shifted: the caller displaces spanA/spanB and the lagging span
export function ichimoku(bars: Candle[], conv = 9, base = 26, spanB = 52): { conv: Out; base: Out; spanA: Out; spanB: Out } {
  const mid = (len: number) => donchian(bars, len).basis
  const c = mid(conv)
  const b = mid(base)
  return { conv: c, base: b, spanA: zip(c, b, (x, y) => (x + y) / 2), spanB: mid(spanB) }
}

// TV DMI：ta.tr 首根为 na，故 +DI/−DI 首值在第 diLen 根；分母为 0 时沿用上一值（fixnan）
// TV DMI: ta.tr is na on bar 0, so +DI/−DI start at index diLen; a zero TR average
// keeps the previous value (fixnan)
export function dmi(bars: Candle[], diLen = 14, adxSmooth = 14): { plus: Out; minus: Out; adx: Out } {
  const n = bars.length
  const tr: Out = trueRange(bars)
  const pdm = nulls(n)
  const mdm = nulls(n)
  if (n) tr[0] = null
  for (let i = 1; i < n; i++) {
    const up = bars[i].h - bars[i - 1].h
    const dn = bars[i - 1].l - bars[i].l
    pdm[i] = up > dn && up > 0 ? up : 0
    mdm[i] = dn > up && dn > 0 ? dn : 0
  }
  const trur = rma(tr, diLen)
  const fixnan = (x: Out): Out => {
    let last: number | null = null
    return x.map((v, i) => {
      const t = trur[i]
      if (v == null || t == null) return null
      if (t !== 0) last = (100 * v) / t
      return last
    })
  }
  const plus = fixnan(rma(pdm, diLen))
  const minus = fixnan(rma(mdm, diLen))
  const dx = zip(plus, minus, (p, m) => Math.abs(p - m) / (p + m === 0 ? 1 : p + m))
  return { plus, minus, adx: rma(dx, adxSmooth).map((v) => (v == null ? null : 100 * v)) }
}

// TV Aroon：窗口 len+1 根，最高/最低并列时取最近一根
// TV Aroon: len+1 bar window; ties resolve to the most recent bar
export function aroon(bars: Candle[], len = 14): { up: Out; down: Out } {
  const n = bars.length
  const up = nulls(n)
  const down = nulls(n)
  const L = toLen(len)
  if (!L) return { up, down }
  for (let i = L; i < n; i++) {
    let hi = i
    let lo = i
    for (let j = i - 1; j >= i - L; j--) {
      if (bars[j].h > bars[hi].h) hi = j
      if (bars[j].l < bars[lo].l) lo = j
    }
    up[i] = (100 * (L - (i - hi))) / L
    down[i] = (100 * (L - (i - lo))) / L
  }
  return { up, down }
}

// 仿 TV ZigZag 库：左右各 max(2, depth/2) 根确认的高低点；同向更极端则替换上一点，
// 反向且偏离上一点 ≥ deviationPct% 才成为新拐点。最后追加一个未确认的「当前腿」端点：
// 上一拐点之后若出现同向更极端值则把上一点挪过去，否则取之后的反向极值。
// Modelled on TV's ZigZag library: pivots confirmed by max(2, depth/2) bars each
// side; a same-direction more extreme pivot replaces the last point, an opposite
// one needs ≥ deviationPct% move. A final unconfirmed leg end is appended: if a
// more extreme same-direction value followed the last pivot, the last point moves
// there; otherwise the opposite extreme after it is added.
export function zigzag(bars: Candle[], deviationPct = 5, depth = 10): Out {
  const n = bars.length
  const out = nulls(n)
  const d = Math.max(2, Math.floor(depth / 2))
  type P = { i: number; v: number; hi: boolean }
  const pts: P[] = []
  const add = (i: number, v: number, hi: boolean) => {
    const last = pts[pts.length - 1]
    if (!last) pts.push({ i, v, hi })
    else if (last.hi === hi) {
      if (hi ? v > last.v : v < last.v) pts[pts.length - 1] = { i, v, hi }
    } else {
      const dev = last.v === 0 ? Infinity : (Math.abs(v - last.v) / Math.abs(last.v)) * 100
      if (dev >= deviationPct) pts.push({ i, v, hi })
    }
  }
  for (let i = d; i + d < n; i++) {
    let isH = true
    let isL = true
    for (let k = 1; k <= d && (isH || isL); k++) {
      if (!(bars[i].h > bars[i - k].h && bars[i].h >= bars[i + k].h)) isH = false
      if (!(bars[i].l < bars[i - k].l && bars[i].l <= bars[i + k].l)) isL = false
    }
    // 同根既是高点又是低点（大阳/大阴）：先处理与上一点反向的那个
    // outside bar that is both: process the direction opposite the last point first
    const lastHi = pts.length ? pts[pts.length - 1].hi : false
    if (lastHi) {
      if (isL) add(i, bars[i].l, false)
      if (isH) add(i, bars[i].h, true)
    } else {
      if (isH) add(i, bars[i].h, true)
      if (isL) add(i, bars[i].l, false)
    }
  }
  const last = pts[pts.length - 1]
  if (last && last.i < n - 1) {
    let ext = last.i + 1
    let opp = last.i + 1
    for (let j = last.i + 1; j < n; j++) {
      if (last.hi ? bars[j].h > bars[ext].h : bars[j].l < bars[ext].l) ext = j
      if (last.hi ? bars[j].l < bars[opp].l : bars[j].h > bars[opp].h) opp = j
    }
    const extV = last.hi ? bars[ext].h : bars[ext].l
    if (last.hi ? extV > last.v : extV < last.v) pts[pts.length - 1] = { i: ext, v: extV, hi: last.hi }
    else pts.push({ i: opp, v: last.hi ? bars[opp].l : bars[opp].h, hi: !last.hi })
  }
  for (const p of pts) out[p.i] = p.v
  return out
}

// 比尔·威廉斯分形（严格大于/小于左右各 n 根），标记在中间那根
// Bill Williams fractals (strictly beyond n bars each side), flagged on the middle bar
export function fractals(bars: Candle[], n = 2): { up: boolean[]; down: boolean[] } {
  const len = bars.length
  const up = new Array<boolean>(len).fill(false)
  const down = new Array<boolean>(len).fill(false)
  const N = toLen(n)
  if (!N) return { up, down }
  for (let i = N; i + N < len; i++) {
    let u = true
    let dn = true
    for (let k = 1; k <= N; k++) {
      if (!(bars[i].h > bars[i - k].h && bars[i].h > bars[i + k].h)) u = false
      if (!(bars[i].l < bars[i - k].l && bars[i].l < bars[i + k].l)) dn = false
    }
    up[i] = u
    down[i] = dn
  }
  return { up, down }
}

// 鳄鱼线：hl2 的 SMMA(13/8/5)，未平移（调用方右移 8/5/3）
// Alligator: SMMA(13/8/5) of hl2, not shifted (caller shifts by 8/5/3)
export function alligatorLines(bars: Candle[]): { jaw: Out; teeth: Out; lips: Out } {
  const h = src(bars, 'hl2')
  return { jaw: rma(h, 13), teeth: rma(h, 8), lips: rma(h, 5) }
}

// ───────── 振荡器 / oscillators ─────────

// ta.rsi：rma 平滑涨跌；跌幅均值为 0 → 100，涨幅为 0 → 0（同 TV RSI 脚本）
// ta.rsi on rma-smoothed gains/losses; zero down → 100, zero up → 0 (TV's RSI script)
export function rsi(s: Src, len = 14): Out {
  const ch = change(s, 1)
  const u = rma(ch.map((v) => (v == null ? null : Math.max(v, 0))), len)
  const d = rma(ch.map((v) => (v == null ? null : Math.max(-v, 0))), len)
  return zip(u, d, (a, b) => (b === 0 ? 100 : a === 0 ? 0 : 100 - 100 / (1 + a / b)))
}

// ta.stoch：100·(c − LL)/(HH − LL)，HH = LL 时为 null / null when HH == LL
function rawStoch(c: Src, h: Src, l: Src, len: number): Out {
  const hh = highest(h, len)
  const ll = lowest(l, len)
  return c.map((v, i) => {
    const a = hh[i]
    const b = ll[i]
    return v == null || a == null || b == null || a === b ? null : (100 * (v - b)) / (a - b)
  })
}

export function stoch(bars: Candle[], kLen = 14, kSmooth = 1, dLen = 3): { k: Out; d: Out } {
  const k = sma(rawStoch(src(bars, 'close'), src(bars, 'high'), src(bars, 'low'), kLen), kSmooth)
  return { k, d: sma(k, dLen) }
}

export function stochRsi(s: Src, rsiLen = 14, stochLen = 14, k = 3, d = 3): { k: Out; d: Out } {
  const r = rsi(s, rsiLen)
  const kk = sma(rawStoch(r, r, r, stochLen), k)
  return { k: kk, d: sma(kk, d) }
}

export function macd(
  s: Src,
  fast = 12,
  slow = 26,
  signal = 9,
  oscMa: 'ema' | 'sma' = 'ema',
  sigMa: 'ema' | 'sma' = 'ema',
): { macd: Out; signal: Out; hist: Out } {
  const m = zip(ma(oscMa, s, fast), ma(oscMa, s, slow), (a, b) => a - b)
  const sg = ma(sigMa, m, signal)
  return { macd: m, signal: sg, hist: zip(m, sg, (a, b) => a - b) }
}

// ta.cci：(src − SMA) / (0.015 × 平均绝对偏差)，偏差为 0 → null
// ta.cci: (src − SMA) / (0.015 × mean absolute deviation); zero deviation → null
export function cci(s: Src, len = 20): Out {
  const L = toLen(len)
  return windowed(s, L, (a, b) => {
    let m = 0
    for (let j = a; j <= b; j++) m += s[j] as number
    m /= L
    let dev = 0
    for (let j = a; j <= b; j++) dev += Math.abs((s[j] as number) - m)
    dev /= L
    return dev === 0 ? null : ((s[b] as number) - m) / (0.015 * dev)
  })
}

// −100..0
export function willr(bars: Candle[], len = 14): Out {
  const hh = highest(src(bars, 'high'), len)
  const ll = lowest(src(bars, 'low'), len)
  return bars.map((b, i) => {
    const u = hh[i]
    const l = ll[i]
    return u == null || l == null || u === l ? null : (100 * (b.c - u)) / (u - l)
  })
}

export function mom(s: Src, len = 10): Out {
  return change(s, len)
}

export function roc(s: Src, len = 9): Out {
  const L = toLen(len)
  return s.map((v, i) => {
    if (!L || i < L) return null
    const o = s[i - L]
    return v == null || o == null || o === 0 ? null : (100 * (v - o)) / o
  })
}

export function ao(bars: Candle[]): Out {
  const h = src(bars, 'hl2')
  return zip(sma(h, 5), sma(h, 34), (a, b) => a - b)
}

export function ac(bars: Candle[]): Out {
  const a = ao(bars)
  return zip(a, sma(a, 5), (x, y) => x - y)
}

// ta.mfi(hlc3)：窗口为 len 个「有前值」的变化（首值在第 len 根）；负向资金流为 0 时
// 取 100（两者皆 0 则 null），避免 Pine 除零得 na 造成断线
// ta.mfi(hlc3) over len bar-to-bar changes (first value at index len); zero
// negative flow → 100 (both zero → null) instead of Pine's divide-by-zero na
export function mfi(bars: Candle[], len = 14): Out {
  const tp = src(bars, 'hlc3')
  const ch = change(tp, 1)
  const pos = ch.map((c, i) => (c == null ? null : c > 0 ? tp[i] * bars[i].v : 0))
  const neg = ch.map((c, i) => (c == null ? null : c < 0 ? tp[i] * bars[i].v : 0))
  return zip(sum(pos, len), sum(neg, len), (u, d) => (d === 0 ? (u === 0 ? null : 100) : 100 - 100 / (1 + u / d)))
}

// ───────── 成交量 / volume ─────────

// ta.cum(sign(change(close)) × volume)，首根为 0 / first bar is 0
export function obv(bars: Candle[]): Out {
  let acc = 0
  return bars.map((b, i) => {
    if (i > 0) acc += Math.sign(b.c - bars[i - 1].c) * b.v
    return acc
  })
}

// 锚定 VWAP（hlc3 × 量），periodKey 变化即重置；带宽用成交量加权标准差
// sqrt(Σv·p²/Σv − vwap²)，同 ta.vwap。成交量为 0 的 K 线按量 1 计，没有真实
// 成交量（只有 tick 量为 0）的品种也能画出等权均价。
// Anchored VWAP of hlc3, reset whenever periodKey changes; bands use the
// volume-weighted stdev like ta.vwap. A bar with 0 volume counts as volume 1 so
// volume-less data still yields an (equal-weight) average.
export function vwapAnchored(
  bars: Candle[],
  periodKey: (t: number) => number,
  bandMults: number[] = [],
): { vwap: Out; bands: { upper: Out; lower: Out }[] } {
  const n = bars.length
  const vw = nulls(n)
  const bands = bandMults.map(() => ({ upper: nulls(n), lower: nulls(n) }))
  let key: number | null = null
  let sv = 0
  let spv = 0
  let sp2v = 0
  for (let i = 0; i < n; i++) {
    const b = bars[i]
    const k = periodKey(b.t)
    if (k !== key) {
      key = k
      sv = spv = sp2v = 0
    }
    const p = (b.h + b.l + b.c) / 3
    const v = b.v > 0 ? b.v : 1
    sv += v
    spv += p * v
    sp2v += p * p * v
    const m = spv / sv
    vw[i] = m
    const sd = Math.sqrt(Math.max(sp2v / sv - m * m, 0))
    bandMults.forEach((mult, j) => {
      bands[j].upper[i] = m + mult * sd
      bands[j].lower[i] = m - mult * sd
    })
  }
  return { vwap: vw, bands }
}

// ───────── 枢轴点 / pivots ─────────

export type PivotKind = 'traditional' | 'fibonacci' | 'woodie' | 'classic' | 'camarilla'
export type PivotLevels = { p: Out; r1: Out; r2: Out; r3: Out; s1: Out; s2: Out; s3: Out }

// TV「Pivot Points Standard」：每个周期用上一周期的 H/L/C（woodie 另用本周期开盘价）
// 算一组水平并在整个周期内保持；首个周期为 null。另外每个周期的最后一根也置 null，
// 让折线在周期之间断开而不是斜着连过去（数据最后一根所在周期尚未结束，不置 null）。
// TV "Pivot Points Standard": each period's levels come from the previous
// period's H/L/C (woodie also uses this period's open) and are held flat; null
// during the first period. The last bar of each period is also null so a line
// series breaks between periods instead of drawing a slanted joint (the final
// bar of the data is left alone — its period hasn't ended).
export function pivots(bars: Candle[], periodKey: (t: number) => number, kind: PivotKind): PivotLevels {
  const n = bars.length
  const r: PivotLevels = { p: nulls(n), r1: nulls(n), r2: nulls(n), r3: nulls(n), s1: nulls(n), s2: nulls(n), s3: nulls(n) }
  const keys = bars.map((b) => periodKey(b.t))
  let H = -Infinity
  let L = Infinity
  let C = 0
  let lv: number[] | null = null
  for (let i = 0; i < n; i++) {
    const b = bars[i]
    if (i > 0 && keys[i] !== keys[i - 1]) {
      lv = pivotLevels(kind, H, L, C, b.o)
      H = -Infinity
      L = Infinity
    }
    H = Math.max(H, b.h)
    L = Math.min(L, b.l)
    C = b.c
    if (!lv || (i + 1 < n && keys[i + 1] !== keys[i])) continue
    r.p[i] = lv[0]; r.r1[i] = lv[1]; r.r2[i] = lv[2]; r.r3[i] = lv[3]
    r.s1[i] = lv[4]; r.s2[i] = lv[5]; r.s3[i] = lv[6]
  }
  return r
}

// [p, r1, r2, r3, s1, s2, s3]
function pivotLevels(kind: PivotKind, H: number, L: number, C: number, O: number): number[] {
  const rg = H - L
  if (kind === 'woodie') {
    const p = (H + L + 2 * O) / 4
    return [p, 2 * p - L, p + rg, H + 2 * (p - L), 2 * p - H, p - rg, L - 2 * (H - p)]
  }
  const p = (H + L + C) / 3
  switch (kind) {
    case 'traditional': return [p, 2 * p - L, p + rg, 2 * p + (H - 2 * L), 2 * p - H, p - rg, 2 * p - (2 * H - L)]
    case 'fibonacci': return [p, p + 0.382 * rg, p + 0.618 * rg, p + rg, p - 0.382 * rg, p - 0.618 * rg, p - rg]
    case 'classic': return [p, 2 * p - L, p + rg, p + 2 * rg, 2 * p - H, p - rg, p - 2 * rg]
    case 'camarilla': {
      const k = 1.1 * rg
      return [p, C + k / 12, C + k / 6, C + k / 4, C - k / 12, C - k / 6, C - k / 4]
    }
  }
}

// ───────── 工具 / helpers ─────────

// k > 0 右移（往后），k < 0 左移，空位补 null / k > 0 moves right (later), k < 0 left
export function shift(s: Src, k: number): Out {
  const n = s.length
  const K = Math.trunc(k) || 0
  const out = nulls(n)
  for (let i = 0; i < n; i++) {
    const j = i + K
    if (j >= 0 && j < n) out[j] = s[i]
  }
  return out
}
