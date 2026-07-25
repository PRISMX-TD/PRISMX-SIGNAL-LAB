// 管理后台的页面访问统计卡：按天折线图 + 各页面明细表。
// Admin page-stats card: per-day line chart plus a per-page detail table.
//
// 为什么手写 SVG 而不用 lightweight-charts：那个库是为金融时间序列做的（十字线、
// 缩放、多品种叠加），这里要画的是 7~30 个点的多条日线，用它反而要处理它的尺寸
// 重算怪癖（见 ChartsPage 与策略回测图注释里记过的 resize 坑）。这张图没有交互
// 需求，纯 SVG polyline 更小更稳。
// Why hand-rolled SVG instead of lightweight-charts: that library targets
// financial series (crosshairs, zoom, multi-symbol overlays). Here we plot a
// handful of daily points across a few lines, and using it would drag in its
// resize quirks (see the notes in ChartsPage and the strategy backtest chart).
// This chart needs no interaction, so a plain SVG polyline is smaller and safer.
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AdminPageStats } from '../../api/types'

// 指标切换：三个指标量纲完全不同（人数几十、次数几百、秒数可能上千），
// 画在同一个 Y 轴上小的那条会被压成一条直线，所以一次只画一个指标。
// Metric switch: the three metrics have wildly different scales (tens of
// visitors, hundreds of views, possibly thousands of seconds), so sharing one Y
// axis would flatten the smaller series into a straight line. One at a time.
type Metric = 'visitors' | 'views' | 'avgSeconds'
const METRICS: Metric[] = ['visitors', 'views', 'avgSeconds']

// 折线颜色：最多给前 6 个页面上色，其余不画线（图例会挤爆，且尾部页面通常
// 访问量极低、线贴着底部看不出区别）。明细表仍然列出全部页面。
// Line colours for the top 6 pages; the rest are omitted from the chart (the
// legend would overflow, and low-traffic pages hug the baseline anyway). The
// detail table still lists every page.
const LINE_COLORS = ['#a78bfa', '#38bdf8', '#34d399', '#fbbf24', '#fb7185', '#c084fc']
const MAX_LINES = 6

const SVG_W = 720
const SVG_H = 200
const PAD_L = 8
const PAD_R = 8
const PAD_T = 10
const PAD_B = 10

function fmtDwell(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`
  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds % 60)
  return s === 0 ? `${m}m` : `${m}m ${s}s`
}

function fmtMetric(metric: Metric, value: number): string {
  return metric === 'avgSeconds' ? fmtDwell(value) : String(value)
}

export default function PageStatsCard({ stats }: { stats: AdminPageStats | null }) {
  const { t } = useTranslation()
  const [metric, setMetric] = useState<Metric>('visitors')

  const charted = useMemo(() => (stats ? stats.pages.slice(0, MAX_LINES) : []), [stats])

  // Y 轴上界取当前指标在所有画出的线里的最大值。以 0 为下界而不是贴着最小值，
  // 否则 3 和 4 的差距会被放大成半张图高，看着像流量翻倍。
  // Y max is the largest value of the current metric across plotted lines. The
  // baseline is 0, not the minimum: anchoring at the minimum would blow the gap
  // between 3 and 4 up to half the chart height and read like traffic doubled.
  const yMax = useMemo(() => {
    let max = 0
    for (const page of charted) {
      for (const point of page.daily) {
        const v = point[metric]
        if (v > max) max = v
      }
    }
    return max
  }, [charted, metric])

  const lines = useMemo(() => {
    if (!stats || charted.length === 0) return []
    const n = stats.dates.length
    const innerW = SVG_W - PAD_L - PAD_R
    const innerH = SVG_H - PAD_T - PAD_B
    // 只有一个日期时除数会是 0，直接把点放在左边界
    // With a single date the divisor would be 0; pin the point to the left edge
    const stepX = n > 1 ? innerW / (n - 1) : 0
    return charted.map((page, i) => ({
      path: page.path,
      color: LINE_COLORS[i % LINE_COLORS.length],
      points: page.daily
        .map((point, idx) => {
          const x = PAD_L + idx * stepX
          // yMax 为 0（该指标全窗口都没数据）时全部贴底，不能除以 0
          // When yMax is 0 (no data for this metric) everything sits on the
          // baseline; never divide by zero
          const ratio = yMax > 0 ? point[metric] / yMax : 0
          const y = PAD_T + innerH - ratio * innerH
          return `${x.toFixed(1)},${y.toFixed(1)}`
        })
        .join(' '),
    }))
  }, [charted, stats, metric, yMax])

  const hasData = stats != null && stats.pages.length > 0

  return (
    <div className="glass mb-5 p-5">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-white">{t('admin.pageStats.title')}</h2>
        {hasData && (
          <span className="text-xs text-slate-400">
            {t('admin.pageStats.summary', {
              visitors: stats.totalVisitors,
              views: stats.totalViews,
              avg: fmtDwell(stats.avgSecondsOverall),
            })}
          </span>
        )}
      </div>
      <p className="mb-4 text-xs text-slate-500">{t('admin.pageStats.privacyHint')}</p>

      {!hasData ? (
        <p className="py-3 text-sm text-slate-500">{t('admin.pageStats.empty')}</p>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap gap-1.5" role="tablist" aria-label={t('admin.pageStats.metricLabel')}>
            {METRICS.map((key) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={metric === key}
                onClick={() => setMetric(key)}
                className={`rounded-full px-3 py-1 text-xs transition ${
                  metric === key
                    ? 'bg-prism-500/25 text-prism-100 ring-1 ring-prism-400/40'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {t(`admin.pageStats.metric.${key}`)}
              </button>
            ))}
          </div>

          <div className="relative">
            {/* preserveAspectRatio="none" 让线横向铺满容器；配 vectorEffect 保持线宽
                不被拉伸变形（与 DisciplineScoreCard 的趋势线同一套做法）。
                preserveAspectRatio="none" stretches the plot to the container width;
                vectorEffect keeps the stroke from being scaled with it. */}
            <svg viewBox={`0 0 ${SVG_W} ${SVG_H}`} className="w-full" preserveAspectRatio="none" role="img"
                 aria-label={t(`admin.pageStats.metric.${metric}`)}>
              <line x1={PAD_L} y1={SVG_H - PAD_B} x2={SVG_W - PAD_R} y2={SVG_H - PAD_B}
                    stroke="rgba(255,255,255,0.08)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
              {lines.map((line) => (
                <polyline
                  key={line.path}
                  fill="none"
                  stroke={line.color}
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  points={line.points}
                  vectorEffect="non-scaling-stroke"
                />
              ))}
            </svg>
            <div className="mt-1 flex justify-between text-[10px] text-slate-500">
              <span>{stats.dates[0]}</span>
              <span className="tabular-nums">
                {t('admin.pageStats.peak', { value: fmtMetric(metric, yMax) })}
              </span>
              <span>{stats.dates[stats.dates.length - 1]}</span>
            </div>
          </div>

          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
            {lines.map((line) => (
              <span key={line.path} className="flex items-center gap-1.5 text-[11px] text-slate-400">
                <i className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: line.color }} />
                <code>{line.path}</code>
              </span>
            ))}
          </div>

          <div className="mt-5 overflow-x-auto">
            <table className="w-full min-w-[420px] text-xs">
              <thead>
                <tr className="text-left text-slate-500">
                  <th className="pb-2 font-medium">{t('admin.pageStats.colPage')}</th>
                  <th className="pb-2 text-right font-medium">{t('admin.pageStats.metric.visitors')}</th>
                  <th className="pb-2 text-right font-medium">{t('admin.pageStats.metric.views')}</th>
                  <th className="pb-2 text-right font-medium">{t('admin.pageStats.metric.avgSeconds')}</th>
                </tr>
              </thead>
              <tbody>
                {stats.pages.map((p) => (
                  <tr key={p.path} className="border-t border-white/5">
                    <td className="py-1.5"><code className="text-slate-300">{p.path}</code></td>
                    <td className="py-1.5 text-right tabular-nums text-slate-200">{p.visitors}</td>
                    <td className="py-1.5 text-right tabular-nums text-slate-200">{p.views}</td>
                    <td className="py-1.5 text-right tabular-nums text-slate-400">{fmtDwell(p.avgSeconds)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}
