// 管理看板的通用多线折线：纯 SVG polyline + 悬停竖线 + 数值面板。
// 从 PageStatsCard 抽出来，供页面统计 / 活跃趋势 / 成交趋势三处复用。
// 为什么不用 lightweight-charts：那是金融时间序列库，几十个点的日线用它要处理
// 它的 resize 怪癖；这里没有交互需求，纯 SVG 更小更稳。
// Generic multi-series line chart for the admin dashboard, extracted from
// PageStatsCard. Plain SVG rather than lightweight-charts: no interaction
// needed, and the library's resize quirks aren't worth it for a few daily points.
import { useMemo, useState } from 'react'

export interface LineSeries {
  key: string
  label: string
  color: string
  values: number[] // 与 dates 同长同序 / same length and order as dates
}

export const SERIES_COLORS = ['var(--purple-hi)', '#38bdf8', '#34d399', '#fbbf24', '#fb7185', '#c084fc']

const SVG_W = 720
const SVG_H = 200
const PAD_L = 8
const PAD_R = 8
const PAD_T = 10
const PAD_B = 10

export default function LineChart({
  dates,
  series,
  format,
  ariaLabel,
  peakLabel,
}: {
  dates: string[]
  series: LineSeries[]
  format: (v: number) => string
  ariaLabel: string
  peakLabel?: (formatted: string) => string
}) {
  const [hover, setHover] = useState<number | null>(null)

  // Y 轴上界取所有序列的最大值，下界固定 0：贴着最小值会把 3 和 4 的差距放大成
  // 半张图高。/ Y max across all series, baseline pinned at 0.
  const yMax = useMemo(() => Math.max(0, ...series.flatMap((s) => s.values)), [series])

  const lines = useMemo(() => {
    const n = dates.length
    const innerW = SVG_W - PAD_L - PAD_R
    const innerH = SVG_H - PAD_T - PAD_B
    const stepX = n > 1 ? innerW / (n - 1) : 0
    return series.map((s) => {
      const coords = s.values.map((v, idx) => {
        const ratio = yMax > 0 ? v / yMax : 0
        return { x: PAD_L + idx * stepX, y: PAD_T + innerH - ratio * innerH }
      })
      return { ...s, coords, points: coords.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ') }
    })
  }, [dates.length, series, yMax])

  if (dates.length === 0 || series.length === 0) return null

  const hoverRatio = hover === null ? 0 : hover / Math.max(dates.length - 1, 1)

  return (
    <div className="relative" onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${SVG_W} ${SVG_H}`} className="w-full" preserveAspectRatio="none" role="img" aria-label={ariaLabel}>
        <line x1={PAD_L} y1={SVG_H - PAD_B} x2={SVG_W - PAD_R} y2={SVG_H - PAD_B}
              stroke="rgba(255,255,255,0.08)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        {lines.map((line) => (
          <polyline key={line.key} fill="none" stroke={line.color} strokeWidth="2" strokeLinecap="round"
                    strokeLinejoin="round" points={line.points} vectorEffect="non-scaling-stroke" />
        ))}
        {hover !== null && (
          <>
            <line x1={lines[0].coords[hover].x} y1={PAD_T} x2={lines[0].coords[hover].x} y2={SVG_H - PAD_B}
                  stroke="rgba(255,255,255,0.25)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
            {lines.map((line) => (
              // preserveAspectRatio="none" 会把圆压成椭圆，所以画小方块 / rects, not circles
              <rect key={line.key} x={line.coords[hover].x - 3} y={line.coords[hover].y - 3} width="6" height="6" rx="1" fill={line.color} />
            ))}
          </>
        )}
        {dates.map((d, idx) => {
          const w = (SVG_W - PAD_L - PAD_R) / dates.length
          return <rect key={d} x={PAD_L + idx * w} y={0} width={w} height={SVG_H} fill="transparent" onMouseEnter={() => setHover(idx)} />
        })}
      </svg>

      {hover !== null && (
        <div
          className="pointer-events-none absolute top-0 z-10 min-w-[9rem] rounded-lg border border-white/10 bg-ink-900/95 p-2.5 shadow-xl"
          style={hoverRatio > 0.5 ? { right: `${100 - hoverRatio * 100}%`, marginRight: 8 } : { left: `${hoverRatio * 100}%`, marginLeft: 8 }}
        >
          <p className="mb-1.5 text-[10px] text-neutral-400">{dates[hover]}</p>
          {lines.map((line) => (
            <p key={line.key} className="flex items-center gap-2 text-[11px] leading-5">
              <i className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: line.color }} />
              <span className="flex-1 truncate text-neutral-300">{line.label}</span>
              <span className="tabular-nums text-neutral-100">{format(line.values[hover])}</span>
            </p>
          ))}
        </div>
      )}

      <div className="mt-1 flex justify-between text-[10px] text-neutral-500">
        <span>{dates[0]}</span>
        {peakLabel && <span className="tabular-nums">{peakLabel(format(yMax))}</span>}
        <span>{dates[dates.length - 1]}</span>
      </div>

      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
        {lines.map((line) => (
          <span key={line.key} className="flex items-center gap-1.5 text-[11px] text-neutral-400">
            <i className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: line.color }} />
            {line.label}
          </span>
        ))}
      </div>
    </div>
  )
}
