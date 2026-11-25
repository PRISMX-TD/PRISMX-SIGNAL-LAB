// 阶段 4 第三批指标的计算：成交量分布、TPO、K 线形态、自动图表形态、自动斐波那契、多周期 K 线箱体、
// 52 周高低、区间表现、技术评级、跨品种对齐与相关系数。纯函数，输入 K 线、输出数组或图形描述。
// Phase 4 batch 3 math: volume profile, TPO, candlestick patterns, auto chart patterns, auto Fibonacci,
// higher-timeframe candle boxes, 52-week high/low, performance, technical ratings, cross-symbol
// alignment and correlation. Pure: bars in, arrays or shape descriptions out.
import type { Candle } from '../../../api/types'
import { ao, cci, dmi, ema, hma, ichimoku, macd, mom, rsi, sma, stoch, stochRsi, vwma, willr, zigzag, type Out, type Src } from './math'
import { ultimate } from './math2'

const nulls = (n: number): Out => new Array<number | null>(n).fill(null)

// ── 拐点（ZigZag 的点列）/ pivots (ZigZag points) ──
export interface Pivot { i: number; v: number; hi: boolean }
export function pivotPoints(bars: Candle[], deviationPct: number, depth: number): Pivot[] {
  const z = zigzag(bars, deviationPct, depth)
  const pts: { i: number; v: number }[] = []
  z.forEach((v, i) => { if (v != null) pts.push({ i, v }) })
  // ZigZag 收尾追加的未确认点不检查偏离，走得不够远的去掉 / drop a trailing unconfirmed point that moved too little
  if (pts.length >= 2) {
    const a = pts[pts.length - 2].v
    const b = pts[pts.length - 1].v
    if (a !== 0 && (Math.abs(b - a) / Math.abs(a)) * 100 < deviationPct) pts.pop()
  }
  return pts.map((p, k) => {
    const nb = pts[k + 1] ?? pts[k - 1]
    // 和相邻点比：比邻点高就是高点 / higher than its neighbour = a high
    const hi = nb ? p.v > nb.v : p.v === bars[p.i].h
    return { i: p.i, v: p.v, hi }
  })
}

// ── 成交量分布 / volume profile ──
export interface Profile {
  i1: number
  i2: number
  lo: number
  step: number
  up: number[]
  dn: number[]
  poc: number
  vah: number
  val: number
}

// 价值区：从 POC 起每次并入相邻两行里量大的一行，直到占总量 vaPct%。
// Value area: grow from the POC, each step taking the bigger adjacent row, until vaPct% of the total.
export function valueArea(tot: number[], poc: number, vaPct: number): [number, number] {
  const total = tot.reduce((a, b) => a + b, 0)
  let lo = poc
  let hi = poc
  let acc = tot[poc] ?? 0
  const goal = (total * vaPct) / 100
  while (acc < goal && (lo > 0 || hi < tot.length - 1)) {
    const up = hi < tot.length - 1 ? tot[hi + 1] : -1
    const dn = lo > 0 ? tot[lo - 1] : -1
    if (up >= dn) { hi++; acc += up } else { lo--; acc += dn }
  }
  return [lo, hi]
}

// 一段 K 线的成交量分布：每根的量按 [低, 高] 与各行的重叠比例摊开；收 ≥ 开记为上涨量。
// Volume profile of a bar range: each bar's volume spread across rows by overlap with [low, high];
// close ≥ open counts as up volume.
export function volumeProfile(bars: Candle[], i1: number, i2: number, rows: number, vaPct = 70): Profile | null {
  const a = Math.max(0, i1)
  const b = Math.min(bars.length - 1, i2)
  if (b < a) return null
  let lo = Infinity
  let hi = -Infinity
  for (let i = a; i <= b; i++) { if (bars[i].l < lo) lo = bars[i].l; if (bars[i].h > hi) hi = bars[i].h }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null
  const R = Math.max(1, Math.round(rows))
  const step = hi > lo ? (hi - lo) / R : Math.max(Math.abs(hi) * 1e-6, 1e-9)
  const up = new Array<number>(R).fill(0)
  const dn = new Array<number>(R).fill(0)
  for (let i = a; i <= b; i++) {
    const k = bars[i]
    const v = k.v ?? 0
    if (v <= 0) continue
    const dst = k.c >= k.o ? up : dn
    const r0 = Math.min(R - 1, Math.max(0, Math.floor((k.l - lo) / step)))
    const r1 = Math.min(R - 1, Math.max(0, Math.floor((k.h - lo) / step)))
    const span = k.h - k.l
    if (span <= 0 || r0 === r1) { dst[r0] += v; continue }
    for (let r = r0; r <= r1; r++) {
      const top = Math.min(k.h, lo + (r + 1) * step)
      const bot = Math.max(k.l, lo + r * step)
      if (top > bot) dst[r] += (v * (top - bot)) / span
    }
  }
  const tot = up.map((u, r) => u + dn[r])
  let poc = 0
  for (let r = 1; r < R; r++) if (tot[r] > tot[poc]) poc = r
  const [val, vah] = valueArea(tot, poc, vaPct)
  return { i1: a, i2: b, lo, step, up, dn, poc, vah, val }
}

// 按时段（日 / 周…）切开的成交量分布 / volume profiles per session (day / week…)
export function sessionProfiles(bars: Candle[], key: (t: number) => number, rows: number, vaPct = 70, maxCount = 60): Profile[] {
  const out: Profile[] = []
  let start = 0
  for (let i = 1; i <= bars.length; i++) {
    if (i === bars.length || key(bars[i].t) !== key(bars[start].t)) {
      const p = volumeProfile(bars, start, i - 1, rows, vaPct)
      if (p) out.push(p)
      start = i
    }
  }
  return out.slice(-maxCount)
}

// ── TPO（市场轮廓）/ TPO (market profile) ──
export interface Tpo {
  i1: number
  i2: number
  lo: number
  step: number
  // 每行出现过的时段序号（升序）/ period numbers seen in each row (ascending)
  rows: number[][]
  // 每个时段从第几根 K 线开始 / first bar of each period
  periodBar: number[]
  poc: number
  vah: number
  val: number
  // 初始平衡区（前两个时段）高低 / initial balance (first two periods)
  ibHi: number
  ibLo: number
}

export function tpoProfiles(bars: Candle[], key: (t: number) => number, periodSec: number, rowCount: number, vaPct = 70, maxCount = 20): Tpo[] {
  const out: Tpo[] = []
  let start = 0
  const R = Math.max(4, Math.round(rowCount))
  for (let i = 1; i <= bars.length; i++) {
    if (i < bars.length && key(bars[i].t) === key(bars[start].t)) continue
    const a = start
    const b = i - 1
    start = i
    let lo = Infinity
    let hi = -Infinity
    for (let j = a; j <= b; j++) { if (bars[j].l < lo) lo = bars[j].l; if (bars[j].h > hi) hi = bars[j].h }
    if (!(hi >= lo)) continue
    const step = hi > lo ? (hi - lo) / R : Math.max(Math.abs(hi) * 1e-6, 1e-9)
    const rows: number[][] = Array.from({ length: R }, () => [])
    const periodBar: number[] = []
    let ibHi = -Infinity
    let ibLo = Infinity
    const t0 = bars[a].t
    for (let j = a; j <= b; j++) {
      const p = Math.max(0, Math.floor((bars[j].t - t0) / Math.max(60, periodSec)))
      while (periodBar.length <= p) periodBar.push(j)
      if (p < 2) { ibHi = Math.max(ibHi, bars[j].h); ibLo = Math.min(ibLo, bars[j].l) }
      const r0 = Math.min(R - 1, Math.max(0, Math.floor((bars[j].l - lo) / step)))
      const r1 = Math.min(R - 1, Math.max(0, Math.floor((bars[j].h - lo) / step)))
      for (let r = r0; r <= r1; r++) {
        const row = rows[r]
        if (row[row.length - 1] !== p) row.push(p)
      }
    }
    const tot = rows.map((r) => r.length)
    // POC：字母最多的行，并列时取离中间最近的 / most letters; ties go to the row nearest the middle
    let poc = 0
    const mid = (R - 1) / 2
    for (let r = 1; r < R; r++) if (tot[r] > tot[poc] || (tot[r] === tot[poc] && Math.abs(r - mid) < Math.abs(poc - mid))) poc = r
    const [val, vah] = valueArea(tot, poc, vaPct)
    out.push({ i1: a, i2: b, lo, step, rows, periodBar, poc, vah, val, ibHi, ibLo })
  }
  return out.slice(-maxCount)
}

// ── K 线形态 / candlestick patterns ──
export interface CandlePat { i: number; key: string; dir: 1 | -1 | 0 }
export const CANDLE_PATTERNS = [
  'doji', 'dragonfly', 'gravestone', 'hammer', 'hangingMan', 'invHammer', 'shootingStar', 'marubozuW', 'marubozuB', 'spinningTop',
  'engulfBull', 'engulfBear', 'haramiBull', 'haramiBear', 'piercing', 'darkCloud', 'tweezerTop', 'tweezerBottom',
  'morningStar', 'eveningStar', 'soldiers', 'crows',
] as const

// 趋势判定同 TradingView 形态指标：SMA50（或不判定 = 两个方向都算）。
// Trend rule as in TradingView's pattern scripts: SMA50, or none (= both directions qualify).
export function candlePatterns(bars: Candle[], trendRule: 'sma50' | 'none' = 'sma50', want: { bull: boolean; bear: boolean; neutral: boolean } = { bull: true, bear: true, neutral: true }): CandlePat[] {
  const n = bars.length
  const close = bars.map((b) => b.c)
  const s50 = sma(close, 50)
  const body = bars.map((b) => Math.abs(b.c - b.o))
  const bodyAvg = ema(body, 14)
  const out: CandlePat[] = []
  const up = (i: number) => (trendRule === 'none' ? true : s50[i] != null && close[i] > (s50[i] as number))
  const dn = (i: number) => (trendRule === 'none' ? true : s50[i] != null && close[i] < (s50[i] as number))
  for (let i = 0; i < n; i++) {
    const b = bars[i]
    const rng = b.h - b.l
    if (rng <= 0) continue
    const bd = body[i]
    const top = Math.max(b.o, b.c)
    const bot = Math.min(b.o, b.c)
    const upSh = b.h - top
    const loSh = bot - b.l
    const avg = bodyAvg[i] ?? bd
    const longBody = bd > avg
    const smallBody = bd < avg
    const white = b.c > b.o
    const black = b.c < b.o
    const add = (key: string, dir: 1 | -1 | 0) => {
      if ((dir === 1 && want.bull) || (dir === -1 && want.bear) || (dir === 0 && want.neutral)) out.push({ i, key, dir })
    }
    // 单根 / single bar
    const doji = bd <= rng * 0.05
    if (doji) {
      if (upSh <= rng * 0.1) add('dragonfly', 1)
      else if (loSh <= rng * 0.1) add('gravestone', -1)
      else add('doji', 0)
    } else {
      const hammerShape = smallBody && loSh >= bd * 2 && upSh <= bd * 0.5
      const invShape = smallBody && upSh >= bd * 2 && loSh <= bd * 0.5
      if (hammerShape && dn(i)) add('hammer', 1)
      if (hammerShape && up(i)) add('hangingMan', -1)
      if (invShape && dn(i)) add('invHammer', 1)
      if (invShape && up(i)) add('shootingStar', -1)
      if (longBody && upSh <= rng * 0.05 && loSh <= rng * 0.05) add(white ? 'marubozuW' : 'marubozuB', white ? 1 : -1)
      if (!hammerShape && !invShape && bd < rng / 3 && upSh > bd && loSh > bd) add('spinningTop', 0)
    }
    if (i < 1) continue
    // 两根 / two bars
    const p = bars[i - 1]
    const pTop = Math.max(p.o, p.c)
    const pBot = Math.min(p.o, p.c)
    const pWhite = p.c > p.o
    const pBlack = p.c < p.o
    if (dn(i - 1) && pBlack && white && b.c >= p.o && b.o <= p.c && bd > body[i - 1]) add('engulfBull', 1)
    if (up(i - 1) && pWhite && black && b.c <= p.o && b.o >= p.c && bd > body[i - 1]) add('engulfBear', -1)
    if (dn(i - 1) && pBlack && body[i - 1] > (bodyAvg[i - 1] ?? 0) && white && top <= pTop && bot >= pBot && bd < body[i - 1]) add('haramiBull', 1)
    if (up(i - 1) && pWhite && body[i - 1] > (bodyAvg[i - 1] ?? 0) && black && top <= pTop && bot >= pBot && bd < body[i - 1]) add('haramiBear', -1)
    const pMid = (p.o + p.c) / 2
    if (dn(i - 1) && pBlack && white && b.o < p.l && b.c > pMid && b.c < p.o) add('piercing', 1)
    if (up(i - 1) && pWhite && black && b.o > p.h && b.c < pMid && b.c > p.o) add('darkCloud', -1)
    const tol = Math.max(rng, p.h - p.l) * 0.05
    if (up(i - 1) && pWhite && black && Math.abs(b.h - p.h) <= tol) add('tweezerTop', -1)
    if (dn(i - 1) && pBlack && white && Math.abs(b.l - p.l) <= tol) add('tweezerBottom', 1)
    if (i < 2) continue
    // 三根 / three bars
    const q = bars[i - 2]
    const qBody = body[i - 2]
    const qAvg = bodyAvg[i - 2] ?? qBody
    const qMid = (q.o + q.c) / 2
    if (dn(i - 2) && q.c < q.o && qBody > qAvg && body[i - 1] < qBody / 2 && pTop < q.c && white && b.c > qMid) add('morningStar', 1)
    if (up(i - 2) && q.c > q.o && qBody > qAvg && body[i - 1] < qBody / 2 && pBot > q.c && black && b.c < qMid) add('eveningStar', -1)
    const w3 = [q, p, b].every((x) => x.c > x.o) && p.c > q.c && b.c > p.c && p.o > q.o && p.o < q.c && b.o > p.o && b.o < p.c
    const b3 = [q, p, b].every((x) => x.c < x.o) && p.c < q.c && b.c < p.c && p.o < q.o && p.o > q.c && b.o < p.o && b.o > p.c
    if (w3 && [i - 2, i - 1, i].every((k) => body[k] > (bodyAvg[k] ?? 0) * 0.5)) add('soldiers', 1)
    if (b3 && [i - 2, i - 1, i].every((k) => body[k] > (bodyAvg[k] ?? 0) * 0.5)) add('crows', -1)
  }
  return out
}

// ── 自动图表形态 / auto chart patterns ──
export interface ChartPat {
  key: string
  dir: 1 | -1 | 0
  // 形态轮廓点 / outline points
  pts: { i: number; v: number }[]
  // 边线（颈线、上下轨）/ boundary lines (neckline, upper / lower rails)
  lines: { i1: number; v1: number; i2: number; v2: number }[]
}

const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol
// 过两点的直线在 x 处的值 / value at x on the line through two points
const lineAt = (i1: number, v1: number, i2: number, v2: number, x: number) => (i2 === i1 ? v1 : v1 + ((v2 - v1) * (x - i1)) / (i2 - i1))

// 在 ZigZag 拐点上找：双顶 / 双底、头肩顶 / 底、三角形（对称 / 上升 / 下降）、楔形（上升 / 下降）、通道。
// 从最新往前扫，形态之间不重叠，最多 maxCount 个。tolPct = 等高判定容差（相对波段高度）。
// Searched on ZigZag pivots: double top / bottom, head & shoulders (and inverse), triangles
// (symmetric / ascending / descending), wedges (rising / falling) and channels. Scans newest first,
// patterns don't overlap, at most maxCount. tolPct = equal-level tolerance relative to the swing height.
export function chartPatterns(bars: Candle[], deviationPct: number, depth: number, tolPct = 15, maxCount = 4): ChartPat[] {
  const pv = pivotPoints(bars, deviationPct, depth)
  const tolOf = (a: number, b: number) => (Math.abs(a - b) * tolPct) / 100
  type Hit = { pat: ChartPat; from: number; to: number }
  // 反转形态：头肩（5 点）、双顶 / 双底（3 点），之后还要有一个拐点越过颈线才算成立
  // Reversal patterns: head & shoulders (5 points) or double top / bottom (3), confirmed only once
  // the following pivot crosses the neckline
  const reversalAt = (end: number): Hit | null => {
    const brk = pv[end]
    if (!brk) return null
    if (end >= 5) {
      const [a, b, c, d, e] = pv.slice(end - 5, end)
      const tol = tolOf(c.v, (b.v + d.v) / 2)
      const neckAt = (x: number) => lineAt(b.i, b.v, d.i, d.v, x)
      const neck = [{ i1: b.i, v1: b.v, i2: brk.i, v2: neckAt(brk.i) }]
      if (a.hi && c.hi && e.hi && c.v - Math.max(a.v, e.v) > tol && near(a.v, e.v, tol) && Math.min(a.v, e.v) > Math.max(b.v, d.v) && brk.v < neckAt(brk.i)) {
        return { pat: { key: 'hs', dir: -1, pts: [a, b, c, d, e, brk], lines: neck }, from: end - 5, to: end }
      }
      if (!a.hi && !c.hi && !e.hi && Math.min(a.v, e.v) - c.v > tol && near(a.v, e.v, tol) && Math.max(a.v, e.v) < Math.min(b.v, d.v) && brk.v > neckAt(brk.i)) {
        return { pat: { key: 'ihs', dir: 1, pts: [a, b, c, d, e, brk], lines: neck }, from: end - 5, to: end }
      }
    }
    if (end >= 3) {
      const [a, b, c] = pv.slice(end - 3, end)
      const tol = tolOf(a.v, b.v)
      const neck = [{ i1: b.i, v1: b.v, i2: brk.i, v2: b.v }]
      if (a.hi && c.hi && near(a.v, c.v, tol) && b.v < Math.min(a.v, c.v) && brk.v < b.v) {
        return { pat: { key: 'doubleTop', dir: -1, pts: [a, b, c, brk], lines: neck }, from: end - 3, to: end }
      }
      if (!a.hi && !c.hi && near(a.v, c.v, tol) && b.v > Math.max(a.v, c.v) && brk.v > b.v) {
        return { pat: { key: 'doubleBottom', dir: 1, pts: [a, b, c, brk], lines: neck }, from: end - 3, to: end }
      }
    }
    return null
  }
  // 三角形 / 楔形 / 通道：5 个交替拐点 / triangles, wedges, channels: 5 alternating pivots
  const geometryAt = (end: number): Hit | null => {
    if (end < 5) return null
    const s = pv.slice(end - 5, end)
    const hs = s.filter((p) => p.hi)
    const ls = s.filter((p) => !p.hi)
    if (hs.length < 2 || ls.length < 2) return null
    const h1 = hs[0]
    const h2 = hs[hs.length - 1]
    const l1 = ls[0]
    const l2 = ls[ls.length - 1]
    const i0 = s[0].i
    const i9 = s[4].i
    const span = Math.max(1, i9 - i0)
    const height = Math.max(h1.v, h2.v) - Math.min(l1.v, l2.v)
    if (!(height > 0)) return null
    // 斜率按「整段跨度内的变化 / 高度」归一 / slopes normalized: change over the span / height
    const su = (((h2.v - h1.v) / Math.max(1, h2.i - h1.i)) * span) / height
    const sl = (((l2.v - l1.v) / Math.max(1, l2.i - l1.i)) * span) / height
    const flat = 0.12
    const wStart = lineAt(h1.i, h1.v, h2.i, h2.v, i0) - lineAt(l1.i, l1.v, l2.i, l2.v, i0)
    const wEnd = lineAt(h1.i, h1.v, h2.i, h2.v, i9) - lineAt(l1.i, l1.v, l2.i, l2.v, i9)
    const converging = wEnd < wStart * 0.8 && wEnd > 0
    let key: string | null = null
    let dir: 1 | -1 | 0 = 0
    if (Math.abs(su) <= flat && sl > flat && converging) { key = 'triAsc'; dir = 1 }
    else if (su < -flat && Math.abs(sl) <= flat && converging) { key = 'triDesc'; dir = -1 }
    else if (su < -flat && sl > flat && converging) key = 'triSym'
    else if (su > flat && sl > flat && converging) { key = 'wedgeUp'; dir = -1 }
    else if (su < -flat && sl < -flat && converging) { key = 'wedgeDown'; dir = 1 }
    else if (Math.abs(su - sl) <= 0.15 && wEnd > 0) key = su > flat ? 'channelUp' : su < -flat ? 'channelDown' : 'range'
    if (!key) return null
    return { pat: { key, dir, pts: s, lines: [{ i1: h1.i, v1: h1.v, i2: h2.i, v2: h2.v }, { i1: l1.i, v1: l1.v, i2: l2.i, v2: l2.v }] }, from: end - 5, to: end - 1 }
  }
  // 候选按结束拐点从新到旧挑，互不重叠；同一处结束时已确认的反转形态优先
  // Candidates picked newest end first without overlap; at the same end a confirmed reversal wins
  const cands: (Hit & { rev: boolean })[] = []
  for (let end = pv.length; end >= 3; end--) {
    const r = reversalAt(end)
    if (r) cands.push({ ...r, rev: true })
    const g = geometryAt(end)
    if (g) cands.push({ ...g, rev: false })
  }
  cands.sort((a, b) => b.to - a.to || Number(b.rev) - Number(a.rev))
  const taken: Hit[] = []
  for (const h of cands) if (taken.every((x) => h.to < x.from || h.from > x.to)) taken.push(h)
  return taken.sort((a, b) => b.to - a.to).slice(0, maxCount).map((h) => h.pat)
}

// ── 自动斐波那契：最后一段已确认波段 / auto Fibonacci: the last swing ──
export function lastSwing(bars: Candle[], deviationPct: number, depth: number): { i1: number; v1: number; i2: number; v2: number } | null {
  const pv = pivotPoints(bars, deviationPct, depth)
  if (pv.length < 2) return null
  const a = pv[pv.length - 2]
  const b = pv[pv.length - 1]
  return { i1: a.i, v1: a.v, i2: b.i, v2: b.v }
}

// ── 多周期 K 线箱体 / higher-timeframe candle boxes ──
export interface HtfBox { i1: number; i2: number; o: number; h: number; l: number; c: number }
export function htfBoxes(bars: Candle[], key: (t: number) => number, maxCount = 300): HtfBox[] {
  const out: HtfBox[] = []
  let cur = NaN
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]
    const k = key(b.t)
    if (k !== cur || out.length === 0) {
      cur = k
      out.push({ i1: i, i2: i, o: b.o, h: b.h, l: b.l, c: b.c })
    } else {
      const x = out[out.length - 1]
      x.i2 = i
      if (b.h > x.h) x.h = b.h
      if (b.l < x.l) x.l = b.l
      x.c = b.c
    }
  }
  return out.slice(-maxCount)
}

// ── 52 周高低 / 52-week high & low ──
// 图上 K 线按时间滚动 365 天取极值，再与「之前各天的日线极值」合并（图上历史通常只有几周，日线补足一年；
// 日线落后几天时图上 K 线兜底）。
// Roll the chart's own bars over 365 days by time, then merge with the daily extremes of earlier days
// (chart history usually spans weeks, daily bars cover the year; if daily lags, the chart bars cover it).
export function highLow52(bars: Candle[], daily: Candle[] | null, dayOf: (t: number) => number, windowDays = 365): { hi: Out; lo: Out } {
  const n = bars.length
  const hi = nulls(n)
  const lo = nulls(n)
  const win = windowDays * 86400
  const qh: number[] = []
  const ql: number[] = []
  let a = 0
  for (let i = 0; i < n; i++) {
    while (qh.length && bars[qh[qh.length - 1]].h <= bars[i].h) qh.pop()
    qh.push(i)
    while (ql.length && bars[ql[ql.length - 1]].l >= bars[i].l) ql.pop()
    ql.push(i)
    while (bars[a].t <= bars[i].t - win) a++
    while (qh[0] < a) qh.shift()
    while (ql[0] < a) ql.shift()
    hi[i] = bars[qh[0]].h
    lo[i] = bars[ql[0]].l
  }
  if (!daily || daily.length === 0) return { hi, lo }
  // 日线窗口 [da, db)：这根所在日期之前、365 天以内 / daily window [da, db): days before this bar's, within 365
  const dd = daily.map((d) => dayOf(d.t))
  const dh: number[] = []
  const dl: number[] = []
  let da = 0
  let db = 0
  let day = NaN
  let dHi: number | null = null
  let dLo: number | null = null
  for (let i = 0; i < n; i++) {
    const d = dayOf(bars[i].t)
    if (d !== day) {
      day = d
      while (db < daily.length && dd[db] < d) {
        while (dh.length && daily[dh[dh.length - 1]].h <= daily[db].h) dh.pop()
        dh.push(db)
        while (dl.length && daily[dl[dl.length - 1]].l >= daily[db].l) dl.pop()
        dl.push(db)
        db++
      }
      while (da < db && dd[da] < d - windowDays) da++
      while (dh.length && dh[0] < da) dh.shift()
      while (dl.length && dl[0] < da) dl.shift()
      dHi = dh.length ? daily[dh[0]].h : null
      dLo = dl.length ? daily[dl[0]].l : null
    }
    if (dHi != null) hi[i] = Math.max(hi[i] as number, dHi)
    if (dLo != null) lo[i] = Math.min(lo[i] as number, dLo)
  }
  return { hi, lo }
}

// ── 区间表现 / performance ──
export const PERF_KEYS = ['w1', 'm1', 'm3', 'm6', 'ytd', 'y1'] as const
// 图表形态的 key（文案 charts.ind.mk.ch_<key>）/ chart pattern keys (texts charts.ind.mk.ch_<key>)
export const CHART_PATTERNS = ['hs', 'ihs', 'doubleTop', 'doubleBottom', 'triAsc', 'triDesc', 'triSym', 'wedgeUp', 'wedgeDown', 'channelUp', 'channelDown', 'range'] as const
export type PerfKey = typeof PERF_KEYS[number]
// 用日线算：最新收盘相对 N 天前（之前最近一根）的涨跌幅；YTD 对去年最后一根。
// From daily bars: the latest close vs the close N days back (nearest earlier bar); YTD vs last year's final bar.
export function performance(daily: Candle[], last: number, nowT: number, yearOf: (t: number) => number): Record<PerfKey, number | null> {
  const back = (days: number): number | null => {
    const lim = nowT - days * 86400
    let k = -1
    for (let i = daily.length - 1; i >= 0; i--) if (daily[i].t <= lim) { k = i; break }
    return k >= 0 && daily[k].c ? ((last - daily[k].c) / daily[k].c) * 100 : null
  }
  const y = yearOf(nowT)
  let ytdBase: number | null = null
  for (let i = daily.length - 1; i >= 0; i--) if (yearOf(daily[i].t) < y) { ytdBase = daily[i].c; break }
  return {
    w1: back(7), m1: back(30), m3: back(91), m6: back(182),
    ytd: ytdBase ? ((last - ytdBase) / ytdBase) * 100 : null,
    y1: back(365),
  }
}

// ── 技术评级（TradingView Technical Ratings 口径）/ technical ratings (TradingView's method) ──
const sign = (b: boolean, s: boolean) => (b ? 1 : s ? -1 : 0)
export function techRating(bars: Candle[]): { all: Out; ma: Out; osc: Out } {
  const n = bars.length
  const close = bars.map((b) => b.c)
  const vol = bars.map((b) => b.v ?? 0)
  const mas: Out[] = [10, 20, 30, 50, 100, 200].flatMap((l) => [sma(close, l), ema(close, l)])
  mas.push(vwma(close, vol, 20), hma(close, 9))
  const ich = ichimoku(bars, 9, 26, 52)
  const r = rsi(close, 14)
  const st = stoch(bars, 14, 3, 3)
  const cc = cci(close, 20)
  const dm = dmi(bars, 14, 14)
  const a = ao(bars)
  const m = mom(close, 10)
  const md = macd(close, 12, 26, 9)
  const sr = stochRsi(close, 14, 14, 3, 3)
  const wr = willr(bars, 14)
  const e13 = ema(close, 13)
  const uo = ultimate(bars, 7, 14, 28)
  const s50 = sma(close, 50)
  const all = nulls(n)
  const maR = nulls(n)
  const oscR = nulls(n)
  const v = (x: Out, i: number) => x[i]
  for (let i = 1; i < n; i++) {
    const c = close[i]
    const up = s50[i] != null && c > (s50[i] as number)
    const dn = s50[i] != null && c < (s50[i] as number)
    // 均线组 / MA group
    const mr: number[] = []
    for (const x of mas) { const y = v(x, i); if (y != null) mr.push(sign(y < c, y > c)) }
    // 一目：基准线、转换线、云图都在价格下方且云为多 → 买 / Ichimoku
    const [cv, bs, la, lb] = [ich.conv[i], ich.base[i], i >= 26 ? ich.spanA[i - 26] : null, i >= 26 ? ich.spanB[i - 26] : null]
    if (cv != null && bs != null && la != null && lb != null) {
      mr.push(sign(la > lb && bs > la && cv > bs && c > cv, la < lb && bs < la && cv < bs && c < cv))
    }
    // 振荡组 / oscillator group
    const or: number[] = []
    const r0 = r[i]; const r1 = r[i - 1]
    if (r0 != null && r1 != null) or.push(sign(r0 < 30 && r1 < r0, r0 > 70 && r1 > r0))
    const k = st.k[i]; const d = st.d[i]
    if (k != null && d != null) or.push(sign(k < 20 && d < 20 && k > d, k > 80 && d > 80 && k < d))
    const c0 = cc[i]; const c1 = cc[i - 1]
    if (c0 != null && c1 != null) or.push(sign(c0 < -100 && c0 > c1, c0 > 100 && c0 < c1))
    const ad = dm.adx[i]; const p0 = dm.plus[i]; const p1 = dm.plus[i - 1]; const m0 = dm.minus[i]; const m1 = dm.minus[i - 1]
    if (ad != null && p0 != null && p1 != null && m0 != null && m1 != null) or.push(sign(ad > 20 && p1 < m1 && p0 > m0, ad > 20 && p1 > m1 && p0 < m0))
    const a0 = a[i]; const a1 = a[i - 1]; const a2 = i >= 2 ? a[i - 2] : null
    if (a0 != null && a1 != null && a2 != null) {
      or.push(sign((a0 > 0 && a1 < 0) || (a0 > 0 && a1 > 0 && a0 > a1 && a2 > a1), (a0 < 0 && a1 > 0) || (a0 < 0 && a1 < 0 && a0 < a1 && a2 < a1)))
    }
    const mo0 = m[i]; const mo1 = m[i - 1]
    if (mo0 != null && mo1 != null) or.push(sign(mo0 > mo1, mo0 < mo1))
    const mc = md.macd[i]; const sg = md.signal[i]
    if (mc != null && sg != null) or.push(sign(mc > sg, mc < sg))
    const sk = sr.k[i]; const sd = sr.d[i]
    if (sk != null && sd != null) or.push(sign(dn && sk < 20 && sd < 20 && sk > sd, up && sk > 80 && sd > 80 && sk < sd))
    const w0 = wr[i]; const w1 = wr[i - 1]
    if (w0 != null && w1 != null) or.push(sign(w0 < -80 && w0 > w1, w0 > -20 && w0 < w1))
    const e0 = e13[i]; const e1 = e13[i - 1]
    if (e0 != null && e1 != null) {
      const bear0 = bars[i].l - e0; const bear1 = bars[i - 1].l - e1
      const bull0 = bars[i].h - e0; const bull1 = bars[i - 1].h - e1
      or.push(sign(up && bear0 < 0 && bear0 > bear1, dn && bull0 > 0 && bull0 < bull1))
    }
    const u = uo[i]
    if (u != null) or.push(sign(u > 70, u < 30))
    const avg = (x: number[]) => (x.length ? x.reduce((p, q) => p + q, 0) / x.length : null)
    const ma0 = avg(mr)
    const os0 = avg(or)
    maR[i] = ma0
    oscR[i] = os0
    all[i] = ma0 != null && os0 != null ? (ma0 + os0) / 2 : ma0 ?? os0
  }
  return { all, ma: maR, osc: oscR }
}

// 评级档位：强卖 / 卖 / 中性 / 买 / 强买（TV 的 ±0.1、±0.5 分界）
// Rating bands: strong sell / sell / neutral / buy / strong buy (TV thresholds ±0.1, ±0.5)
export function ratingBand(v: number | null): 0 | 1 | 2 | 3 | 4 | null {
  if (v == null) return null
  if (v > 0.5) return 4
  if (v > 0.1) return 3
  if (v >= -0.1) return 2
  if (v >= -0.5) return 1
  return 0
}

// ── 跨品种 / cross-symbol ──
// 把另一个品种的收盘价按时间对齐到图上 K 线：取时间 ≤ 这根的最近一根（向前补），太久没有就留空。
// Align another symbol's closes to the chart bars: the latest bar at or before each one (forward
// filled); gaps longer than maxGapSec stay empty.
export function alignCloses(bars: Candle[], other: Candle[], maxGapSec: number): Out {
  const out = nulls(bars.length)
  let j = 0
  for (let i = 0; i < bars.length; i++) {
    const t = bars[i].t
    while (j + 1 < other.length && other[j + 1].t <= t) j++
    if (other.length && other[j].t <= t && t - other[j].t <= maxGapSec) out[i] = other[j].c
  }
  return out
}

// 皮尔逊相关系数（ta.correlation）/ Pearson correlation over len bars (ta.correlation)
export function correlation(a: Src, b: Src, len: number): Out {
  const n = a.length
  const out = nulls(n)
  const L = Math.max(2, Math.round(len))
  for (let i = L - 1; i < n; i++) {
    let sa = 0; let sb = 0; let ok = true
    for (let k = i - L + 1; k <= i; k++) { const x = a[k]; const y = b[k]; if (x == null || y == null) { ok = false; break } sa += x; sb += y }
    if (!ok) continue
    const ma = sa / L
    const mb = sb / L
    let cov = 0; let va = 0; let vb = 0
    for (let k = i - L + 1; k <= i; k++) {
      const x = (a[k] as number) - ma
      const y = (b[k] as number) - mb
      cov += x * y; va += x * x; vb += y * y
    }
    out[i] = va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : null
  }
  return out
}
