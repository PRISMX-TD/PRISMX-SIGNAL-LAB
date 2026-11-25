// 非标准图表类型的 K 线变换：平均 K 线（Heikin Ashi）、砖形图（Renko）、新价线（Line Break）、
// 卡吉图（Kagi）、点数图（Point & Figure）。纯函数、O(n)，实时更新每 ~500 ms 整段重算一次。
// Bar transforms for non-standard chart types: Heikin Ashi, Renko, Line Break, Kagi and
// Point & Figure. Pure and O(n); the whole series is recomputed on every live update (~500 ms).
//
// 时间规则 / Time rule
//   输出的 t 严格递增且为整数（lightweight-charts 要求）。每根输出 bar 取「产生它的源 bar」的 t；
//   与上一根相同或更早（同一根源 bar 产出多根砖、或前面已被往后推）时改用 prev.t + 1。
//   所以一次连出很多砖时，t 可能暂时跑到后面源 bar 的时间之后；源 bar 间隔足够时会追平。
//   · Renko 砖、新价线：t = 完成它的源 bar。
//   · Kagi 线段、点数图的列会随后续 bar 继续延伸：t = 开始它的源 bar，实时更新时不跳。
//   Output t is a strictly ascending integer (lightweight-charts requirement). Each output bar
//   takes the t of the source bar that produced it; when that is not after the previous output
//   (several bricks from one source bar, or earlier ones were pushed forward) it becomes
//   prev.t + 1. A burst of many bricks can therefore run ahead of later source times for a while;
//   it catches up once source bars are spaced widely enough.
//   · Renko bricks and Line Break lines: t = the source bar that completed them.
//   · Kagi segments and P&F columns keep growing with later bars: t = the source bar that
//     started them, so it stays put across live updates.
//
// 价位 / Price levels
//   砖与格子的价位一律由整数 k 算出（anchor + k * box），不做累加，并四舍五入到 12 位有效数字，
//   避免浮点漂移（如 1.2000000000000002）。
//   Brick / box levels are always computed from an integer k (anchor + k * box), never by
//   repeated addition, then rounded to 12 significant digits to avoid float drift.
import type { Candle } from '../../api/types'

export interface XBar {
  t: number
  o: number
  h: number
  l: number
  c: number
  v: number
  // 方向：上涨 / 下跌的砖、列、线 / up or down brick, column, line
  dir?: 1 | -1
  // Kagi：阳线（粗）/ 阴线（细）/ Kagi: yang (thick) vs yin (thin)
  thick?: boolean
  // Renko / 点数图本次使用的格值 / Renko / P&F box size used for this bar
  box?: number
  // 点数图：本列 X 或 O 的个数 / P&F: number of X or O boxes in the column
  boxes?: number
}

export type BoxSizeMode =
  | { type: 'atr'; length: number }
  | { type: 'fixed'; size: number }
  | { type: 'percent'; pct: number }

export type PriceSource = 'close' | 'hl'

export interface RenkoOptions {
  box: number
  source?: PriceSource
  wicks?: boolean
}
export interface LineBreakOptions {
  lines?: number
}
export interface KagiOptions {
  reversal: number
  source?: 'close'
}
export interface PointFigureOptions {
  box: number
  reversal?: number
  source?: PriceSource
}

export type TransformKind = 'none' | 'heikinAshi' | 'renko' | 'lineBreak' | 'kagi' | 'pointFigure'

// 各类型各自的参数；格值 / 反转幅度用 BoxSizeMode，由 autoBoxSize 从源序列算出。
// Per-type options; box / reversal sizes are a BoxSizeMode resolved by autoBoxSize.
export interface TransformOptions {
  // 格值默认 ATR(14)，取价默认收盘价 / box default ATR(14), source default close
  renko?: { boxMode?: BoxSizeMode; source?: PriceSource; wicks?: boolean }
  // 默认 3 线 / default 3 lines
  lineBreak?: { lines?: number }
  // 反转幅度（价格单位）默认 ATR(14) / reversal amount (price units), default ATR(14)
  kagi?: { reversalMode?: BoxSizeMode; source?: 'close' }
  // 格值默认 ATR(14)，反转默认 3 格 / box default ATR(14), reversal default 3 boxes
  pointFigure?: { boxMode?: BoxSizeMode; reversal?: number; source?: PriceSource }
  // 可选：把算出的格值取整到最小变动价位的整数倍 / optional: round box sizes to this tick
  tick?: number
}

export const DEFAULT_BOX_MODE: BoxSizeMode = { type: 'atr', length: 14 }
export const DEFAULT_PNF_REVERSAL = 3
export const DEFAULT_LINE_BREAK = 3
// Renko 输出上限：格值极小时只保留最近这么多根，防内存爆掉。
// Renko output cap: with a tiny box only the most recent bricks are kept.
export const MAX_RENKO_BRICKS = 100_000

// 以格为单位的容差，吸收 (p - anchor) / box 的浮点误差 / tolerance in box units for float error
const EPS = 1e-9

const vol = (b: Candle) => (Number.isFinite(b.v) ? b.v : 0)
const clean = (x: number) => +x.toPrecision(12)

// 严格递增整数时间 / strictly ascending integer time
function makeClock() {
  let last = -Infinity
  return (t: number) => {
    const ti = Math.floor(t)
    const x = ti > last ? ti : last + 1
    last = x
    return x
  }
}

function fillHL(out: XBar[]) {
  for (const x of out) {
    x.h = x.o > x.c ? x.o : x.c
    x.l = x.o < x.c ? x.o : x.c
  }
  return out
}

// ── Heikin Ashi ──────────────────────────────────────────────────────────────

// 标准平均 K 线：首根 haOpen = (o+c)/2；保留源 t、v。
// Standard Heikin Ashi; first bar haOpen = (o+c)/2. Keeps source t and v.
export function heikinAshi(bars: readonly Candle[]): XBar[] {
  const n = bars.length
  const out: XBar[] = new Array(n)
  let po = 0
  let pc = 0
  for (let i = 0; i < n; i++) {
    const b = bars[i]
    const c = (b.o + b.h + b.l + b.c) / 4
    const o = i === 0 ? (b.o + b.c) / 2 : (po + pc) / 2
    const h = Math.max(b.h, o, c)
    const l = Math.min(b.l, o, c)
    out[i] = { t: b.t, o, h, l, c, v: vol(b), dir: c >= o ? 1 : -1 }
    po = o
    pc = c
  }
  return out
}

// ── ATR / box size ───────────────────────────────────────────────────────────

// Wilder ATR（与 TradingView ta.atr 一致：首根 TR = h-l，RMA 以前 length 根 TR 的均值起步），
// 返回整段序列最后一根的 ATR；bar 数不足 length 返回 null。
// Wilder ATR (matches TradingView ta.atr: first TR = h-l, RMA seeded with the SMA of the first
// `length` TRs). Returns the final value for the whole series; null when bars < length.
export function atr(bars: readonly Candle[], length: number): number | null {
  const len = Math.floor(length)
  const n = bars.length
  if (!(len >= 1) || n < len) return null
  let sum = 0
  let a = 0
  for (let i = 0; i < n; i++) {
    const b = bars[i]
    let tr = b.h - b.l
    if (i > 0) {
      const pc = bars[i - 1].c
      const up = Math.abs(b.h - pc)
      const dn = Math.abs(b.l - pc)
      if (up > tr) tr = up
      if (dn > tr) tr = dn
    }
    if (i < len) {
      sum += tr
      if (i === len - 1) a = sum / len
    } else {
      a = (a * (len - 1) + tr) / len
    }
  }
  return Number.isFinite(a) ? a : null
}

// 按模式算格值，保证返回正的有限数：算不出（ATR 数据不够 / 为 0、参数非法）就用最新收盘价的 1%，
// 再不行用 1。传 tick 时取整到 tick 的整数倍（至少 1 个 tick）。
// Box size for a mode; always a positive finite number. Falls back to 1% of the last close when the
// mode can't produce one (too few bars / zero ATR / bad parameter), then to 1. With `tick`, the
// result is rounded to a multiple of tick (at least one tick).
export function autoBoxSize(bars: readonly Candle[], mode: BoxSizeMode, tick?: number): number {
  const last = bars.length ? Math.abs(bars[bars.length - 1].c) : NaN
  let v: number | null = null
  if (mode.type === 'atr') v = atr(bars, mode.length)
  else if (mode.type === 'fixed') v = mode.size
  else if (mode.type === 'percent') v = (last * mode.pct) / 100
  if (!(v != null && Number.isFinite(v) && v > 0)) {
    v = Number.isFinite(last) && last > 0 ? last * 0.01 : 1
  }
  if (tick != null && Number.isFinite(tick) && tick > 0) {
    v = Math.max(1, Math.round(v / tick)) * tick
    v = clean(v)
  }
  return v
}

// ── Renko ────────────────────────────────────────────────────────────────────

// 传统砖形图：价位 = 首根收盘价 + k * box。顺势 1 格出新砖，反转需 2 格（从上一块砖的另一端起算）。
// 只输出已完成的砖。'hl' 取价：顺势先看极值（上涨看最高价）能否出砖，不能再看反向极值是否反转。
// 影线（wicks）：自上一次出砖以来源 bar 的最高 / 最低价。本次连出的第一块砖拿反方向那一侧
//   （上涨砖的下影 = 期间最低价），最后一块拿顺方向那一侧（上涨砖的上影 = 期间最高价）。
// 成交量：自上一次出砖以来的源成交量（含完成砖的那根），平均分给这次连出的几块砖（近似）。
// Traditional Renko: levels = first close + k * box. One box continues the trend, a reversal needs
// two (measured from the far side of the last brick). Only completed bricks are emitted.
// 'hl' source: check the trend-side extreme first (high in an up trend); only if it makes no brick,
// check the opposite extreme for a reversal.
// Wicks: the high / low of source bars since the last brick. In a burst, the first brick gets the
//   counter-trend side (up brick's lower wick = lowest low) and the last one the trend side.
// Volume: source volume since the last brick (including the completing bar), split evenly over the
//   bricks of that burst (approximation).
export function renko(bars: readonly Candle[], opts: RenkoOptions): XBar[] {
  const { box, source = 'close', wicks = false } = opts
  let out: XBar[] = []
  const n = bars.length
  if (!(box > 0) || !Number.isFinite(box) || n === 0) return out
  const anchor = bars[0].c
  const lvl = (k: number) => clean(anchor + k * box)
  const clock = makeClock()
  // 最后一块砖的上下沿（格序号），尚无砖时都为 0 / last brick's top / bottom index (0 / 0 before any)
  let top = 0
  let bot = 0
  let dir = 0
  let pendV = vol(bars[0])
  let pendHi = bars[0].h
  let pendLo = bars[0].l

  const finish = (count: number, d: 1 | -1) => {
    const first = out[out.length - count]
    const lastB = out[out.length - 1]
    const each = pendV / count
    for (let j = out.length - count; j < out.length; j++) out[j].v = each
    if (wicks) {
      if (d === 1) {
        if (pendLo < first.l) first.l = pendLo
        if (pendHi > lastB.h) lastB.h = pendHi
      } else {
        if (pendHi > first.h) first.h = pendHi
        if (pendLo < lastB.l) lastB.l = pendLo
      }
    }
    pendV = 0
    if (out.length > 2 * MAX_RENKO_BRICKS) out = out.slice(out.length - MAX_RENKO_BRICKS)
  }
  const tryUp = (p: number, t: number) => {
    const k = Math.floor((p - anchor) / box + EPS)
    if (k <= top) return false
    for (let j = top; j < k; j++) {
      const o = lvl(j)
      const c = lvl(j + 1)
      out.push({ t: clock(t), o, h: c, l: o, c, v: 0, dir: 1, box })
    }
    const count = k - top
    top = k
    bot = k - 1
    dir = 1
    finish(count, 1)
    return true
  }
  const tryDown = (p: number, t: number) => {
    const k = Math.ceil((p - anchor) / box - EPS)
    if (k >= bot) return false
    for (let j = bot; j > k; j--) {
      const o = lvl(j)
      const c = lvl(j - 1)
      out.push({ t: clock(t), o, h: o, l: c, c, v: 0, dir: -1, box })
    }
    const count = bot - k
    bot = k
    top = k + 1
    dir = -1
    finish(count, -1)
    return true
  }

  for (let i = 1; i < n; i++) {
    const b = bars[i]
    pendV += vol(b)
    if (b.h > pendHi) pendHi = b.h
    if (b.l < pendLo) pendLo = b.l
    let made: boolean
    if (source === 'close') {
      made = tryUp(b.c, b.t) || tryDown(b.c, b.t)
    } else {
      const upFirst = dir === 1 || (dir === 0 && b.c >= b.o)
      made = upFirst ? tryUp(b.h, b.t) || tryDown(b.l, b.t) : tryDown(b.l, b.t) || tryUp(b.h, b.t)
    }
    if (made) {
      pendHi = b.c
      pendLo = b.c
    }
  }
  return out
}

// ── Line Break ───────────────────────────────────────────────────────────────

// 新价线（默认三线）按收盘价：起点 = 首根收盘价，第一条线在收盘价首次不同于它时画出。
// 顺势：收盘创出上一条线的新高 / 新低就画一条；反转：要突破最近 `lines` 条线的最低 / 最高点，
// 反转线从上一条线的起点画到收盘价。成交量 = 自上一条线以来的源成交量。
// Line Break (default 3) on close. Starts at the first close; the first line is drawn at the first
// close that differs. Continuation: close beyond the last line's end. Reversal: close beyond the
// extreme of the last `lines` lines; the reversal line runs from the last line's start to the close.
// Volume = source volume since the previous line.
export function lineBreak(bars: readonly Candle[], opts: LineBreakOptions = {}): XBar[] {
  const N = Math.max(1, Math.floor(opts.lines ?? DEFAULT_LINE_BREAK) || DEFAULT_LINE_BREAK)
  const out: XBar[] = []
  const n = bars.length
  if (n === 0) return out
  const clock = makeClock()
  const ref = bars[0].c
  let pendV = vol(bars[0])
  const push = (o: number, c: number, t: number) => {
    out.push({
      t: clock(t), o, c, h: o > c ? o : c, l: o < c ? o : c, v: pendV, dir: c > o ? 1 : -1,
    })
    pendV = 0
  }
  for (let i = 1; i < n; i++) {
    const b = bars[i]
    const p = b.c
    pendV += vol(b)
    const m = out.length
    if (m === 0) {
      if (p !== ref) push(ref, p, b.t)
      continue
    }
    const last = out[m - 1]
    const from = m > N ? m - N : 0
    if (last.dir === 1) {
      if (p > last.c) push(last.c, p, b.t)
      else {
        let lo = Infinity
        for (let j = from; j < m; j++) if (out[j].l < lo) lo = out[j].l
        if (p < lo) push(last.o, p, b.t)
      }
    } else {
      if (p < last.c) push(last.c, p, b.t)
      else {
        let hi = -Infinity
        for (let j = from; j < m; j++) if (out[j].h > hi) hi = out[j].h
        if (p > hi) push(last.o, p, b.t)
      }
    }
  }
  return out
}

// ── Kagi ─────────────────────────────────────────────────────────────────────

// 卡吉图按收盘价：起点 = 首根收盘价，价格首次偏离满 reversal 才画第一条线（向上为阳、向下为阴）。
// 同向就延长当前线，逆向满 reversal 就从当前线端点起画反向线。
// 阴阳：上行线突破上一个肩（前一条上行线的顶）变阳（粗），下行线跌破上一个腰（前一条下行线的底）
// 变阴（细）。一条线中途变粗细就在肩 / 腰价位拆成两根输出 bar（t 连续），每根只有一种粗细。
// 每根输出 bar 是一段竖线 o → c；成交量记到处理完该源 bar 后的当前线段。
// Kagi on close. Starts at the first close; the first line is drawn once price has moved
// `reversal` away (up = yang, down = yin). Same direction extends the current line; a move of
// `reversal` against it starts a new line from its end.
// Yang / yin: an up line rising above the previous shoulder (top of the previous up line) turns
// thick; a down line falling below the previous waist (bottom of the previous down line) turns thin.
// A line that changes thickness is split at the shoulder / waist into two output bars (consecutive
// t), each with a single thickness. Each output bar is one vertical segment o → c; a source bar's
// volume goes to the segment that is current after processing it.
export function kagi(bars: readonly Candle[], opts: KagiOptions): XBar[] {
  const R = opts.reversal
  const out: XBar[] = []
  const n = bars.length
  if (!(R > 0) || !Number.isFinite(R) || n === 0) return out
  const eps = R * EPS
  const clock = makeClock()
  const ref = bars[0].c
  let pendV = vol(bars[0])
  let dir: 1 | -1 = 1
  let thick = true
  let shoulder = NaN
  let waist = NaN

  const piece = (o: number, c: number, t: number) => {
    out.push({ t: clock(t), o, h: 0, l: 0, c, v: 0, dir, thick })
  }
  // 当前线走到 p，必要时在肩 / 腰拆段 / move the current line to p, splitting at shoulder / waist
  const moveTo = (p: number, t: number) => {
    const cur = out[out.length - 1]
    if (dir === 1 && !thick && p > shoulder) {
      cur.c = shoulder
      thick = true
      piece(shoulder, p, t)
    } else if (dir === -1 && thick && p < waist) {
      cur.c = waist
      thick = false
      piece(waist, p, t)
    } else {
      cur.c = p
    }
  }

  for (let i = 1; i < n; i++) {
    const b = bars[i]
    const p = b.c
    pendV += vol(b)
    if (out.length === 0) {
      if (Math.abs(p - ref) + eps >= R) {
        dir = p > ref ? 1 : -1
        thick = dir === 1
        piece(ref, p, b.t)
      }
    } else {
      const end = out[out.length - 1].c
      if (dir === 1) {
        if (p > end) moveTo(p, b.t)
        else if (end - p + eps >= R) {
          shoulder = end
          dir = -1
          piece(end, end, b.t)
          moveTo(p, b.t)
        }
      } else {
        if (p < end) moveTo(p, b.t)
        else if (p - end + eps >= R) {
          waist = end
          dir = 1
          piece(end, end, b.t)
          moveTo(p, b.t)
        }
      }
    }
    if (out.length) {
      out[out.length - 1].v += pendV
      pendV = 0
    }
  }
  return fillHL(out)
}

// ── Point & Figure ───────────────────────────────────────────────────────────

// 点数图：格线 = k * box（对齐 box 的整数倍）。每个 X / O 画在一条格线上：
//   X 列 o = 最低那个 X 的价位、c = 最高那个 X；O 列 o = 最高那个 O、c = 最低那个 O；
//   boxes = 个数 = |c - o| / box + 1；h / l = 两端价位（渲染时每格占 ±box/2）。
// 起点格线 = 首根收盘价四舍五入到格线；离开起点 1 格就开第一列（不含起点格线）。
// X 列：收盘 ≥ 新格线就延长；跌到 顶 - reversal 格 以下就开 O 列，O 列从顶下一格开始
// （3 格反转 = 3 个 O）。O 列对称。
// 'hl' 取价：X 列先看最高价能否延长，不能再看最低价是否反转；O 列反之（标准高低点法）。
// Point & Figure: grid = k * box (aligned to multiples of box). Each X / O sits on a grid level:
//   X column o = lowest X level, c = highest; O column o = highest O, c = lowest;
//   boxes = count = |c - o| / box + 1; h / l = the two end levels (a renderer draws ±box/2 per mark).
// The start level is the first close rounded to the grid; the first column opens one box away from
// it (the start level itself is not marked).
// X column: a close at or above the next level extends it; a fall to top - reversal boxes opens an
// O column starting one box below the top (3-box reversal = 3 O's). O columns mirror this.
// 'hl' source: an X column first tries to extend with the high and only then reverses on the low;
// an O column the other way round (standard high/low method).
export function pointFigure(bars: readonly Candle[], opts: PointFigureOptions): XBar[] {
  const box = opts.box
  const r = Math.max(1, Math.floor(opts.reversal ?? DEFAULT_PNF_REVERSAL) || DEFAULT_PNF_REVERSAL)
  const source = opts.source ?? 'close'
  const out: XBar[] = []
  const n = bars.length
  if (!(box > 0) || !Number.isFinite(box) || n === 0) return out
  const lvl = (k: number) => clean(k * box)
  const fl = (p: number) => Math.floor(p / box + EPS)
  const ce = (p: number) => Math.ceil(p / box - EPS)
  const clock = makeClock()
  const kRef = Math.round(bars[0].c / box)
  let pendV = vol(bars[0])
  let dir = 0
  let top = 0
  let bot = 0
  let cur: XBar | null = null

  const open = (d: 1 | -1, hi: number, lo: number, t: number) => {
    dir = d
    top = hi
    bot = lo
    cur = {
      t: clock(t), o: d === 1 ? lvl(lo) : lvl(hi), c: d === 1 ? lvl(hi) : lvl(lo),
      h: 0, l: 0, v: 0, dir: d, box, boxes: hi - lo + 1,
    }
    out.push(cur)
  }
  const tryX = (p: number, t: number) => {
    const k = fl(p)
    if (dir === 0) {
      if (k <= kRef) return false
      open(1, k, kRef + 1, t)
    } else if (dir === 1) {
      if (k <= top) return false
      top = k
      cur!.c = lvl(k)
      cur!.boxes = top - bot + 1
    } else {
      if (k < bot + r) return false
      open(1, k, bot + 1, t)
    }
    return true
  }
  const tryO = (p: number, t: number) => {
    const k = ce(p)
    if (dir === 0) {
      if (k >= kRef) return false
      open(-1, kRef - 1, k, t)
    } else if (dir === -1) {
      if (k >= bot) return false
      bot = k
      cur!.c = lvl(k)
      cur!.boxes = top - bot + 1
    } else {
      if (k > top - r) return false
      open(-1, top - 1, k, t)
    }
    return true
  }

  for (let i = 1; i < n; i++) {
    const b = bars[i]
    pendV += vol(b)
    if (source === 'close') {
      if (!tryX(b.c, b.t)) tryO(b.c, b.t)
    } else {
      const xFirst = dir === 1 || (dir === 0 && b.c >= b.o)
      if (xFirst) {
        if (!tryX(b.h, b.t)) tryO(b.l, b.t)
      } else if (!tryO(b.l, b.t)) tryX(b.h, b.t)
    }
    if (out.length) {
      out[out.length - 1].v += pendV
      pendV = 0
    }
  }
  return fillHL(out)
}

// ── 调度 / dispatcher ────────────────────────────────────────────────────────

const plain = (b: Candle): XBar => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: vol(b) })

// 按图表类型变换；格值 / 反转幅度按 opts 的模式用 autoBoxSize 从源序列算出。
// Transform for a chart type; box / reversal sizes come from autoBoxSize on the source series.
export function transformBars(
  kind: TransformKind,
  bars: readonly Candle[],
  opts: TransformOptions = {},
): XBar[] {
  switch (kind) {
    case 'heikinAshi':
      return heikinAshi(bars)
    case 'renko': {
      const o = opts.renko ?? {}
      return renko(bars, {
        box: autoBoxSize(bars, o.boxMode ?? DEFAULT_BOX_MODE, opts.tick),
        source: o.source ?? 'close',
        wicks: o.wicks ?? false,
      })
    }
    case 'lineBreak':
      return lineBreak(bars, { lines: opts.lineBreak?.lines ?? DEFAULT_LINE_BREAK })
    case 'kagi':
      return kagi(bars, { reversal: autoBoxSize(bars, opts.kagi?.reversalMode ?? DEFAULT_BOX_MODE, opts.tick) })
    case 'pointFigure': {
      const o = opts.pointFigure ?? {}
      return pointFigure(bars, {
        box: autoBoxSize(bars, o.boxMode ?? DEFAULT_BOX_MODE, opts.tick),
        reversal: o.reversal ?? DEFAULT_PNF_REVERSAL,
        source: o.source ?? 'close',
      })
    }
    default:
      return bars.map(plain)
  }
}
