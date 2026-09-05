import type { UTCTimestamp } from 'lightweight-charts'

// 图表时间轴与十字准线的时间文案：全站固定 UTC+8（见 api/utils.ts 的 fmtTime）。
// 刻度标签和悬停读数是 lightweight-charts 的两个独立格式化钩子，任一漏设就会退回
// 浏览器本地时区，与轴上的时间对不上——那正是当年「图表时间还是不对」的 bug。
// 图表页与回测面板共用这一份，两边永远一致。
// Axis tick / crosshair time label, pinned to UTC+8 like the rest of the site.
// Both formatting hooks must be set or one falls back to the browser zone and
// disagrees with the other. Shared by the chart page and the backtest panel.
export function fmtChartTime(time: UTCTimestamp): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(time * 1000))
}

// 把含 null（预热期）的指标序列转成折线点，丢掉 null 而不是补 0——补 0 会在图上
// 画一条假的归零线。
// Indicator series with nulls (warm-up) → line points, dropping the nulls rather
// than substituting 0, which would draw a false line down to zero.
export function toLinePoints(
  times: UTCTimestamp[],
  values: (number | null)[],
): { time: UTCTimestamp; value: number }[] {
  const out: { time: UTCTimestamp; value: number }[] = []
  for (let i = 0; i < values.length; i++) {
    const v = values[i]
    if (v != null) out.push({ time: times[i], value: v })
  }
  return out
}
