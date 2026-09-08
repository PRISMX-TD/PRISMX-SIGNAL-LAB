// 纯技术指标计算：输入按时间升序排列的收盘价（或完整 K 线），返回与输入等长
// 的数值数组，头部预热期（数据不足以算出第一个值的那些位置）填 null，交由
// 调用方（ChartsPage）过滤/转换成 lightweight-charts 的 series 数据点。
// 这里只做纯数学，不碰任何图表 API，方便单独验证正确性。
//
// Pure technical-indicator math: takes an ascending-by-time series of closes
// (or full candles), returns an array of the same length with `null` for the
// warm-up head (not enough data yet for a value). The caller (ChartsPage)
// filters/converts these into lightweight-charts series data points. Kept
// free of any charting API so the math itself is easy to verify in isolation.
import type { Candle } from '../api/types'

// 简单移动平均 / simple moving average
export function sma(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null)
  let sum = 0
  for (let i = 0; i < values.length; i++) {
    sum += values[i]
    if (i >= period) sum -= values[i - period]
    if (i >= period - 1) out[i] = sum / period
  }
  return out
}

// 指数移动平均：首个有效值用同周期 SMA 作种子（业界通用做法），此后递推。
// exponential moving average: seeded with the SMA of the first `period`
// values (the standard convention), recursive thereafter.
export function ema(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null)
  if (values.length < period) return out
  const k = 2 / (period + 1)
  let seed = 0
  for (let i = 0; i < period; i++) seed += values[i]
  seed /= period
  out[period - 1] = seed
  let prev = seed
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k)
    out[i] = prev
  }
  return out
}

function stddevAroundSma(values: number[], smaArr: (number | null)[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null)
  for (let i = period - 1; i < values.length; i++) {
    const mean = smaArr[i]
    if (mean == null) continue
    let sq = 0
    for (let j = i - period + 1; j <= i; j++) sq += (values[j] - mean) ** 2
    out[i] = Math.sqrt(sq / period)
  }
  return out
}

export interface BollBands {
  mid: (number | null)[]
  upper: (number | null)[]
  lower: (number | null)[]
}

// 布林带：中轨=SMA，上下轨=中轨 ± mult 倍标准差 / Bollinger Bands: mid=SMA,
// upper/lower = mid +/- mult standard deviations
export function bollinger(values: number[], period = 20, mult = 2): BollBands {
  const mid = sma(values, period)
  const sd = stddevAroundSma(values, mid, period)
  const upper = mid.map((m, i) => (m == null || sd[i] == null ? null : m + mult * (sd[i] as number)))
  const lower = mid.map((m, i) => (m == null || sd[i] == null ? null : m - mult * (sd[i] as number)))
  return { mid, upper, lower }
}

// RSI（Wilder 平滑，与主流平台一致，不是简单移动平均版本）
// RSI using Wilder's smoothing (matches mainstream platforms; not the plain
// moving-average variant)
export function rsi(values: number[], period = 14): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null)
  if (values.length <= period) return out
  let gainSum = 0
  let lossSum = 0
  for (let i = 1; i <= period; i++) {
    const diff = values[i] - values[i - 1]
    if (diff >= 0) gainSum += diff
    else lossSum -= diff
  }
  let avgGain = gainSum / period
  let avgLoss = lossSum / period
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)
  for (let i = period + 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1]
    const gain = diff > 0 ? diff : 0
    const loss = diff < 0 ? -diff : 0
    avgGain = (avgGain * (period - 1) + gain) / period
    avgLoss = (avgLoss * (period - 1) + loss) / period
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)
  }
  return out
}

export interface MacdResult {
  macd: (number | null)[]
  signal: (number | null)[]
  hist: (number | null)[]
}

// MACD：DIF=快慢 EMA 之差，DEA(signal)=DIF 的 EMA，柱=DIF-DEA
// MACD: DIF = fast EMA - slow EMA, signal (DEA) = EMA of DIF, histogram = DIF - signal
export function macd(values: number[], fast = 12, slow = 26, signalPeriod = 9): MacdResult {
  const fastEma = ema(values, fast)
  const slowEma = ema(values, slow)
  const macdLine: (number | null)[] = values.map((_, i) =>
    fastEma[i] == null || slowEma[i] == null ? null : (fastEma[i] as number) - (slowEma[i] as number)
  )
  // signal 是对 macdLine 的 EMA，但 macdLine 头部有 null（慢线预热期），要先
  // 抽出从第一个非空值开始的连续段再算 EMA，再把结果按原位置拼回去。
  // signal is an EMA over macdLine, but macdLine has a null head (the slow
  // EMA's warm-up); pull out the dense run starting at the first non-null
  // value, run EMA over that, then splice the result back into position.
  const firstValid = macdLine.findIndex((v) => v != null)
  const signal: (number | null)[] = new Array(values.length).fill(null)
  if (firstValid >= 0) {
    const dense = macdLine.slice(firstValid) as number[]
    const denseSignal = ema(dense, signalPeriod)
    for (let i = 0; i < denseSignal.length; i++) signal[firstValid + i] = denseSignal[i]
  }
  const hist: (number | null)[] = values.map((_, i) =>
    macdLine[i] == null || signal[i] == null ? null : (macdLine[i] as number) - (signal[i] as number)
  )
  return { macd: macdLine, signal, hist }
}

// 唐奇安通道上轨：每个位置取该 bar 之前（不含当根）最近 period 根的最高价。
// 排除当根与后端 indicators.py 的 donchian_high 一致，必须一致——回测的突破条件
// 判断的是"当根价格是否超过之前的极值"，把当根算进去突破永远不成立，画出来的线
// 就会比判定所用的那条高，看上去像"标记打在没突破的地方"。
// Donchian upper band: for each position, the highest high of the `period` bars
// strictly before it. Excluding the current bar matches the backend's
// donchian_high and has to: the breakout condition asks whether the current price
// exceeds the prior extreme, and including the current bar makes a breakout
// impossible — the drawn line would sit above the one actually used for the
// verdict, making markers look like they fired without a breakout.
export function donchianHigh(highs: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(highs.length).fill(null)
  for (let i = period; i < highs.length; i++) {
    let hi = -Infinity
    for (let j = i - period; j < i; j++) if (highs[j] > hi) hi = highs[j]
    out[i] = hi
  }
  return out
}

// 唐奇安通道下轨，见 donchianHigh / Donchian lower band; see donchianHigh
export function donchianLow(lows: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(lows.length).fill(null)
  for (let i = period; i < lows.length; i++) {
    let lo = Infinity
    for (let j = i - period; j < i; j++) if (lows[j] < lo) lo = lows[j]
    out[i] = lo
  }
  return out
}

// 从完整 K 线数组里取收盘价，供上面几个函数直接使用 / pull closes out of full
// candles for the functions above to consume directly
export function closes(bars: Candle[]): number[] {
  return bars.map((b) => b.c)
}

// ───────── 2026-09-08 指标库扩充 / indicator library expansion ─────────
// 下面这些都吃完整 K 线（要用到高低价 / 成交量），返回与输入等长、预热期为 null 的数组。
// These take full candles (they need highs/lows/volume) and return same-length
// arrays with null over the warm-up head, like everything above.

// 真实波幅（Wilder 平滑）/ Average True Range with Wilder smoothing
export function atr(bars: Candle[], period = 14): (number | null)[] {
  const out: (number | null)[] = new Array(bars.length).fill(null)
  if (bars.length <= period) return out
  const tr = bars.map((b, i) => (i === 0 ? b.h - b.l : Math.max(b.h - b.l, Math.abs(b.h - bars[i - 1].c), Math.abs(b.l - bars[i - 1].c))))
  let sum = 0
  for (let i = 1; i <= period; i++) sum += tr[i]
  let prev = sum / period
  out[period] = prev
  for (let i = period + 1; i < bars.length; i++) {
    prev = (prev * (period - 1) + tr[i]) / period
    out[i] = prev
  }
  return out
}

export interface SuperTrendResult {
  // 多头段（线在价格下方）与空头段（线在价格上方）分成两条，各自在不属于自己的
  // 区间填 null，这样两条不同颜色的 series 拼起来就是一条会变色的线。
  // Bull segments (line below price) and bear segments (above) as two arrays,
  // each null where the other owns the bar, so two colored series read as one
  // line that changes color.
  bull: (number | null)[]
  bear: (number | null)[]
}

// 超级趋势：ATR 通道 + 方向翻转规则（标准实现）/ SuperTrend: ATR bands with the standard flip rule
export function superTrend(bars: Candle[], period = 10, mult = 3): SuperTrendResult {
  const n = bars.length
  const bull: (number | null)[] = new Array(n).fill(null)
  const bear: (number | null)[] = new Array(n).fill(null)
  const a = atr(bars, period)
  let finalUpper = 0
  let finalLower = 0
  let dir = 1
  let started = false
  for (let i = 0; i < n; i++) {
    const av = a[i]
    if (av == null) continue
    const hl2 = (bars[i].h + bars[i].l) / 2
    const upper = hl2 + mult * av
    const lower = hl2 - mult * av
    if (!started) {
      finalUpper = upper
      finalLower = lower
      started = true
    } else {
      const prevClose = bars[i - 1].c
      finalUpper = upper < finalUpper || prevClose > finalUpper ? upper : finalUpper
      finalLower = lower > finalLower || prevClose < finalLower ? lower : finalLower
    }
    const c = bars[i].c
    if (dir === 1 && c < finalLower) dir = -1
    else if (dir === -1 && c > finalUpper) dir = 1
    if (dir === 1) bull[i] = finalLower
    else bear[i] = finalUpper
  }
  return { bull, bear }
}

// 抛物线转向 SAR（Wilder）/ Parabolic SAR
export function parabolicSar(bars: Candle[], step = 0.02, max = 0.2): (number | null)[] {
  const n = bars.length
  const out: (number | null)[] = new Array(n).fill(null)
  if (n < 2) return out
  let up = bars[1].c >= bars[0].c
  let sar = up ? bars[0].l : bars[0].h
  let ep = up ? bars[0].h : bars[0].l
  let af = step
  for (let i = 1; i < n; i++) {
    const b = bars[i]
    sar = sar + af * (ep - sar)
    if (up) {
      sar = Math.min(sar, bars[i - 1].l, i >= 2 ? bars[i - 2].l : bars[i - 1].l)
      if (b.l < sar) {
        up = false
        sar = ep
        ep = b.l
        af = step
      } else if (b.h > ep) {
        ep = b.h
        af = Math.min(max, af + step)
      }
    } else {
      sar = Math.max(sar, bars[i - 1].h, i >= 2 ? bars[i - 2].h : bars[i - 1].h)
      if (b.h > sar) {
        up = true
        sar = ep
        ep = b.h
        af = step
      } else if (b.l < ep) {
        ep = b.l
        af = Math.min(max, af + step)
      }
    }
    out[i] = sar
  }
  return out
}

// 成交量加权均价，按自然日（UTC+8，与图表坐标轴同一时区）重置锚点。
// VWAP anchored to the natural day (UTC+8, same zone as the chart axis).
export function vwap(bars: Candle[]): (number | null)[] {
  const out: (number | null)[] = new Array(bars.length).fill(null)
  const TZ = 8 * 3600
  let day = -1
  let pv = 0
  let vol = 0
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]
    const d = Math.floor((b.t + TZ) / 86400)
    if (d !== day) {
      day = d
      pv = 0
      vol = 0
    }
    const tp = (b.h + b.l + b.c) / 3
    pv += tp * b.v
    vol += b.v
    out[i] = vol > 0 ? pv / vol : null
  }
  return out
}

export interface KdjResult {
  k: (number | null)[]
  d: (number | null)[]
  j: (number | null)[]
}

// KDJ：RSV 的两级平滑（国内软件通用的 9/3/3 口径），J = 3K − 2D。
// KDJ: two-stage smoothed RSV (the common 9/3/3 convention), J = 3K − 2D.
export function kdj(bars: Candle[], period = 9, kSmooth = 3, dSmooth = 3): KdjResult {
  const n = bars.length
  const k: (number | null)[] = new Array(n).fill(null)
  const d: (number | null)[] = new Array(n).fill(null)
  const j: (number | null)[] = new Array(n).fill(null)
  let kPrev = 50
  let dPrev = 50
  for (let i = period - 1; i < n; i++) {
    let hi = -Infinity
    let lo = Infinity
    for (let x = i - period + 1; x <= i; x++) {
      if (bars[x].h > hi) hi = bars[x].h
      if (bars[x].l < lo) lo = bars[x].l
    }
    const rsv = hi === lo ? 50 : ((bars[i].c - lo) / (hi - lo)) * 100
    kPrev = ((kSmooth - 1) * kPrev + rsv) / kSmooth
    dPrev = ((dSmooth - 1) * dPrev + kPrev) / dSmooth
    k[i] = kPrev
    d[i] = dPrev
    j[i] = 3 * kPrev - 2 * dPrev
  }
  return { k, d, j }
}

// 顺势指标 CCI = (TP − SMA(TP)) / (0.015 × 平均绝对偏差)
// Commodity Channel Index = (TP − SMA(TP)) / (0.015 × mean absolute deviation)
export function cci(bars: Candle[], period = 20): (number | null)[] {
  const tp = bars.map((b) => (b.h + b.l + b.c) / 3)
  const mean = sma(tp, period)
  return tp.map((v, i) => {
    const m = mean[i]
    if (m == null) return null
    let dev = 0
    for (let x = i - period + 1; x <= i; x++) dev += Math.abs(tp[x] - m)
    dev /= period
    return dev === 0 ? 0 : (v - m) / (0.015 * dev)
  })
}

// 威廉指标 %R = (Hn − C) / (Hn − Ln) × −100，范围 −100 到 0
// Williams %R = (Hn − C) / (Hn − Ln) × −100, ranging −100 to 0
export function williamsR(bars: Candle[], period = 14): (number | null)[] {
  return bars.map((b, i) => {
    if (i < period - 1) return null
    let hi = -Infinity
    let lo = Infinity
    for (let x = i - period + 1; x <= i; x++) {
      if (bars[x].h > hi) hi = bars[x].h
      if (bars[x].l < lo) lo = bars[x].l
    }
    return hi === lo ? -50 : ((hi - b.c) / (hi - lo)) * -100
  })
}

// 能量潮：收涨累加成交量，收跌累减 / On-Balance Volume
export function obv(bars: Candle[]): (number | null)[] {
  const out: (number | null)[] = new Array(bars.length).fill(null)
  let acc = 0
  for (let i = 0; i < bars.length; i++) {
    if (i > 0) {
      if (bars[i].c > bars[i - 1].c) acc += bars[i].v
      else if (bars[i].c < bars[i - 1].c) acc -= bars[i].v
    }
    out[i] = acc
  }
  return out
}
