// 画线坐标：时间 ⇄ 像素（支持超出最新 K 线的空白区）。
// lightweight-charts 的 timeToCoordinate / coordinateToTime 只在有数据的区间内有效——最新 K 线右侧
// （或最早 K 线左侧）的空白区会返回 null，画线就画不到、也渲染不到未来区域。这里改走「逻辑索引」：
// 逻辑索引与像素是线性且无界的，配合已加载的 bar 时间数组外推，就能把时间映射到空白区并反向还原，
// 存的仍是真实 / 外推出的时间（跨周期不漂移）。
// Drawing coordinates: time ⇄ pixel, including the whitespace past the last bar. The engine's
// conversions only work inside the data range, so we bridge through the logical index (linear and
// unbounded) and extrapolate with the loaded bar times; stored values stay real / extrapolated times.
import type { IChartApi, Logical, UTCTimestamp } from 'lightweight-charts'

// 每个图表实例各自的 bar 时间访问器（WeakMap：实例互不干扰，图表销毁后自动回收）。
// Per-chart bar-times accessor (a WeakMap, so charts don't clash and entries go with the chart).
const barTimesByChart = new WeakMap<IChartApi, () => number[]>()
export const registerBarTimes = (chart: IChartApi, fn: () => number[]) => { barTimesByChart.set(chart, fn) }
export const barTimesOf = (chart: IChartApi): number[] => barTimesByChart.get(chart)?.() ?? []

export function barInterval(bt: number[]): number {
  const n = bt.length
  if (n < 2) return 0
  return bt[n - 1] - bt[n - 2]
}

// 时间 → 逻辑索引（可外推到数据范围之外，返回小数 / 负数）/ time → logical (extrapolates)
export function timeToLogical(bt: number[], t: number): number | null {
  const n = bt.length
  if (n === 0) return null
  if (n === 1) return 0
  const iv = barInterval(bt)
  if (t <= bt[0]) return iv ? (t - bt[0]) / iv : 0
  if (t >= bt[n - 1]) return iv ? (n - 1) + (t - bt[n - 1]) / iv : n - 1
  let lo = 0, hi = n - 1
  while (lo < hi) { const mid = (lo + hi) >> 1; if (bt[mid] < t) lo = mid + 1; else hi = mid }
  if (bt[lo] === t) return lo
  const prev = lo - 1
  const span = bt[lo] - bt[prev] || 1
  return prev + (t - bt[prev]) / span
}

// 逻辑索引 → 时间（同样支持外推）/ logical → time (extrapolates too)
export function logicalToTime(bt: number[], logical: number): number | null {
  const n = bt.length
  if (n === 0) return null
  if (n === 1) return bt[0]
  const iv = barInterval(bt)
  if (logical <= 0) return Math.round(bt[0] + logical * iv)
  if (logical >= n - 1) return Math.round(bt[n - 1] + (logical - (n - 1)) * iv)
  const lo = Math.floor(logical), hi = Math.ceil(logical)
  if (lo === hi) return bt[lo]
  return Math.round(bt[lo] + (bt[hi] - bt[lo]) * (logical - lo))
}

// 时间 → x：先走原生转换（快路径），落空则经逻辑索引外推 / time → x: native first, then extrapolate
export function timeToX(chart: IChartApi, t: number): number | null {
  const ts = chart.timeScale()
  const c = ts.timeToCoordinate(t as UTCTimestamp) as number | null
  if (c != null) return c
  const lg = timeToLogical(barTimesOf(chart), t)
  if (lg == null) return null
  return ts.logicalToCoordinate(lg as Logical) as number | null
}

// x → 时间 / x → time
export function xToTime(chart: IChartApi, x: number): number | null {
  const ts = chart.timeScale()
  const t = ts.coordinateToTime(x) as number | null
  if (t != null) return t
  const lg = ts.coordinateToLogical(x) as number | null
  if (lg == null) return null
  return logicalToTime(barTimesOf(chart), lg)
}

// 两个时间之间隔了几根 K 线（日期范围工具用）/ bars between two times (date-range tools)
export function barsBetween(chart: IChartApi, t1: number, t2: number): number {
  const bt = barTimesOf(chart)
  const a = timeToLogical(bt, t1), b = timeToLogical(bt, t2)
  if (a == null || b == null) return 0
  return Math.round(b - a)
}
