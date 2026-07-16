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

// 从完整 K 线数组里取收盘价，供上面几个函数直接使用 / pull closes out of full
// candles for the functions above to consume directly
export function closes(bars: Candle[]): number[] {
  return bars.map((b) => b.c)
}
