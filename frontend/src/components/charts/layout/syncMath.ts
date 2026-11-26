// 多图同步的换算（纯函数）：把一张图的逻辑下标 / 时间换到另一张图上。两张图的周期、历史长度都可能
// 不同，所以按时间对齐：先把源图的逻辑范围换成时间，再在目标图的 K 线时间里找对应的逻辑下标；
// 超出两端（右侧留白、还没翻到的历史）按估计的 K 线间隔外推。单测见 syncMath.test.ts。
// Multi-chart sync maths (pure): map one chart's logical index / time onto another. The two may differ
// in interval and history length, so they align by time: the source's logical range becomes times, then
// the target's bar times give the matching logical indices; beyond either end (right-side whitespace,
// history not paged in yet) it extrapolates with the estimated bar step. Tests in syncMath.test.ts.

// 估计 K 线间隔（秒）：最近 20 个间隔的中位数（周末 / 休市的大缺口不影响）。少于两根时退回 60。
// Estimated bar step (s): the median of the last 20 gaps (weekend / session gaps don't skew it). 60 with < 2 bars.
export function estimateStep(times: readonly number[]): number {
  const n = times.length
  if (n < 2) return 60
  const gaps: number[] = []
  for (let i = Math.max(1, n - 20); i < n; i++) {
    const g = times[i] - times[i - 1]
    if (g > 0) gaps.push(g)
  }
  if (gaps.length === 0) return 60
  gaps.sort((a, b) => a - b)
  return gaps[Math.floor(gaps.length / 2)]
}

// 不大于 t 的最后一根的下标；t 早于第一根时返回 -1。/ index of the last bar at or before t; -1 when t precedes the first.
export function barAtOrBefore(times: readonly number[], t: number): number {
  let lo = 0
  let hi = times.length - 1
  if (hi < 0 || t < times[0]) return -1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (times[mid] <= t) lo = mid
    else hi = mid - 1
  }
  return lo
}

// 逻辑下标 → 时间（小数下标在相邻两根之间线性插值；超出两端按间隔外推）。
// Logical index → time (fractions interpolate between neighbours; beyond the ends extrapolate by step).
export function logicalToTime(times: readonly number[], l: number, step = estimateStep(times)): number | null {
  const n = times.length
  if (n === 0 || !Number.isFinite(l)) return null
  if (l <= 0) return times[0] + l * step
  if (l >= n - 1) return times[n - 1] + (l - (n - 1)) * step
  const i = Math.floor(l)
  const f = l - i
  return times[i] + f * (times[i + 1] - times[i])
}

// 时间 → 逻辑下标（logicalToTime 的反函数）/ time → logical index (inverse of logicalToTime)
export function timeToLogical(times: readonly number[], t: number, step = estimateStep(times)): number | null {
  const n = times.length
  if (n === 0 || !Number.isFinite(t)) return null
  if (t <= times[0]) return (t - times[0]) / step
  if (t >= times[n - 1]) return n - 1 + (t - times[n - 1]) / step
  const i = barAtOrBefore(times, t)
  const span = times[i + 1] - times[i]
  return i + (span > 0 ? (t - times[i]) / span : 0)
}

// 把源图的可见逻辑范围换成目标图的可见逻辑范围（时间对齐）。任一边没数据时返回 null。
// Map the source's visible logical range onto the target's (time-aligned). null when either has no data.
export function mapLogicalRange(
  src: readonly number[],
  dst: readonly number[],
  range: { from: number; to: number },
): { from: number; to: number } | null {
  if (src.length === 0 || dst.length === 0) return null
  const sStep = estimateStep(src)
  const dStep = estimateStep(dst)
  const a = logicalToTime(src, range.from, sStep)
  const b = logicalToTime(src, range.to, sStep)
  if (a == null || b == null) return null
  const from = timeToLogical(dst, a, dStep)
  const to = timeToLogical(dst, b, dStep)
  if (from == null || to == null || !(to > from)) return null
  return { from, to }
}

// 十字线落在目标图的哪一根：不大于该时间的最后一根；时间早于目标图第一根、或晚于最后一根一个
// 间隔以上（目标图没有那段数据）时返回 -1，目标图就清掉十字线。
// Which target bar the crosshair lands on: the last one at or before the time; -1 when the time precedes
// the target's first bar or lies more than a step past its last (no data there), so the target clears it.
export function crosshairBar(dst: readonly number[], t: number): number {
  const i = barAtOrBefore(dst, t)
  if (i < 0) return -1
  if (i === dst.length - 1 && t - dst[i] > estimateStep(dst) * 1.5) return -1
  return i
}
