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

// 页面名走 i18n（admin.pageStats.page.<路径>），后端只回原始路径。
// defaultValue 回退到路径本身：新页面上线时若忘了补翻译，显示 /foo 也比显示
// 一串 key 或空白好，而且一眼就能看出漏了哪个。
// Page names come from i18n (admin.pageStats.page.<path>); the API only returns
// raw paths. defaultValue falls back to the path itself so a newly shipped page
// with no translation shows /foo rather than a raw key or a blank cell — and it
// is immediately obvious which one is missing.
function usePageName() {
  const { t } = useTranslation()
  return (path: string) => t(`admin.pageStats.page.${path}`, { defaultValue: path })
}

// 可选窗口。上界 90 天与后端 Query 约束一致，别在这里放更大的值——后端会
// 直接 422，而前端拿不到数据只会显示成"这段时间没人来"。
// Selectable windows. The 90-day cap matches the backend Query constraint; a
// larger value here would 422 and surface as a misleading empty chart.
const DAY_OPTIONS = [7, 14, 30, 90]

export default function PageStatsCard({
  stats,
  days,
  onDaysChange,
}: {
  stats: AdminPageStats | null
  days: number
  onDaysChange: (days: number) => void
}) {
  const { t } = useTranslation()
  const pageName = usePageName()
  const [metric, setMetric] = useState<Metric>('visitors')
  // 鼠标悬停的日期下标；null 表示没悬停。存下标而不是日期字符串，因为要用它
  // 直接索引每条线的 daily 数组。
  // Index of the hovered date, null when not hovering. An index rather than a
  // date string, since it directly indexes each line's daily array.
  const [hover, setHover] = useState<number | null>(null)

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
    return charted.map((page, i) => {
      // 坐标算一次、两处用：polyline 的 points 字符串和悬停时的圆点位置。
      // 分开各算一遍迟早会漂移。
      // Computed once, used twice: the polyline points string and the hover dot
      // position. Two separate calculations would drift apart eventually.
      const coords = page.daily.map((point, idx) => {
        const x = PAD_L + idx * stepX
        // yMax 为 0（该指标全窗口都没数据）时全部贴底，不能除以 0
        // When yMax is 0 (no data for this metric) everything sits on the
        // baseline; never divide by zero
        const ratio = yMax > 0 ? point[metric] / yMax : 0
        return { x, y: PAD_T + innerH - ratio * innerH }
      })
      return {
        path: page.path,
        color: LINE_COLORS[i % LINE_COLORS.length],
        coords,
        points: coords.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' '),
      }
    })
  }, [charted, stats, metric, yMax])

  const hasData = stats != null && stats.pages.length > 0

  // 悬停列在窗口里的横向比例，用于摆放数值面板。分母兜底为 1：只有一个日期时
  // 分母会是 0，算出 NaN 后面板的 left 会变成非法值、整块跑到左上角。
  // Horizontal ratio of the hovered column, used to place the value panel. The
  // divisor floors at 1: with a single date it would be 0, and the resulting NaN
  // would produce an invalid left offset that throws the panel to the corner.
  const hoverRatio = hover === null || !stats ? 0 : hover / Math.max(stats.dates.length - 1, 1)

  return (
    <div className="glass mb-5 p-5">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-white">{t('admin.pageStats.title', { days })}</h2>
        {hasData && (
          <span className="text-xs text-neutral-400">
            {t('admin.pageStats.summary', {
              visitors: stats.totalVisitors,
              views: stats.totalViews,
              avg: fmtDwell(stats.avgSecondsOverall),
            })}
          </span>
        )}
      </div>
      <p className="mb-3 text-xs text-neutral-500">{t('admin.pageStats.privacyHint')}</p>

      {/* 天数选择放在空数据判断之外：窗口没数据时更需要能换个范围试试，
          按钮跟着一起藏起来就没法操作了。
          The window picker sits outside the empty check: an empty window is
          exactly when you want to try a different range, so hiding the buttons
          along with the chart would leave nothing to click. */}
      <div className="mb-4 flex flex-wrap gap-1.5" role="group" aria-label={t('admin.pageStats.daysLabel')}>
        {DAY_OPTIONS.map((opt) => (
          <button
            key={opt}
            type="button"
            aria-pressed={days === opt}
            onClick={() => onDaysChange(opt)}
            className={`rounded-full px-3 py-1 text-xs transition ${
              days === opt
                ? 'bg-white/10 text-neutral-100 ring-1 ring-white/20'
                : 'text-neutral-500 hover:text-neutral-300'
            }`}
          >
            {t('admin.pageStats.daysOption', { days: opt })}
          </button>
        ))}
      </div>

      {!hasData ? (
        <p className="py-3 text-sm text-neutral-500">{t('admin.pageStats.empty')}</p>
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
                    : 'text-neutral-400 hover:text-neutral-200'
                }`}
              >
                {t(`admin.pageStats.metric.${key}`)}
              </button>
            ))}
          </div>

          <div className="relative" onMouseLeave={() => setHover(null)}>
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

              {/* 悬停：竖线 + 每条线上的圆点。
                  圆点半径要抵掉横向拉伸——preserveAspectRatio="none" 会把 <circle>
                  压成椭圆，所以用 <rect> 画小方块而不是圆。
                  Hover: a vertical rule plus a dot per line. Radii would be squashed
                  by preserveAspectRatio="none" (circles become ellipses), so these are
                  small rects rather than circles. */}
              {hover !== null && lines.length > 0 && (
                <>
                  <line
                    x1={lines[0].coords[hover].x}
                    y1={PAD_T}
                    x2={lines[0].coords[hover].x}
                    y2={SVG_H - PAD_B}
                    stroke="rgba(255,255,255,0.25)"
                    strokeWidth="1"
                    vectorEffect="non-scaling-stroke"
                  />
                  {lines.map((line) => (
                    <rect
                      key={line.path}
                      x={line.coords[hover].x - 3}
                      y={line.coords[hover].y - 3}
                      width="6"
                      height="6"
                      rx="1"
                      fill={line.color}
                    />
                  ))}
                </>
              )}

              {/* 每天一列透明矩形接住鼠标。用列而不是"找最近的点"，是因为列的
                  命中区从上到下贯通，鼠标在图里任何高度都能触发；只在点附近响应
                  的话，线贴着底部时几乎点不到。
                  One transparent column per day catches the pointer. Columns rather
                  than nearest-point hit-testing: a column spans the full height, so
                  any vertical position works — with per-point targets, lines hugging
                  the baseline would be nearly impossible to hit. */}
              {stats.dates.map((date, idx) => {
                const w = (SVG_W - PAD_L - PAD_R) / stats.dates.length
                return (
                  <rect
                    key={date}
                    x={PAD_L + idx * w}
                    y={0}
                    width={w}
                    height={SVG_H}
                    fill="transparent"
                    onMouseEnter={() => setHover(idx)}
                  />
                )
              })}
            </svg>

            {/* 数值面板。左右位置按悬停列在窗口里的比例走，靠右半边时向左翻转，
                否则最后几天的面板会被卡片右边缘截掉。
                pointer-events-none 是必须的：面板盖在命中列上方，能接收鼠标事件的
                话，鼠标一移到面板上就等于离开了图表，面板闪一下自己消失。
                Value panel. Positioned by the hovered column's ratio, flipping to the
                left past the midpoint so the last few days aren't clipped by the card
                edge. pointer-events-none is required: the panel sits above the hit
                columns, and if it captured events, moving onto it would count as
                leaving the chart and it would flicker away. */}
            {hover !== null && (
              <div
                className="pointer-events-none absolute top-0 z-10 min-w-[9rem] rounded-lg border border-white/10 bg-ink-900/95 p-2.5 shadow-xl"
                style={
                  hoverRatio > 0.5
                    ? { right: `${100 - hoverRatio * 100}%`, marginRight: 8 }
                    : { left: `${hoverRatio * 100}%`, marginLeft: 8 }
                }
              >
                <p className="mb-1.5 text-[10px] text-neutral-400">{stats.dates[hover]}</p>
                {charted.map((page, i) => (
                  <p key={page.path} className="flex items-center gap-2 text-[11px] leading-5">
                    <i
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ backgroundColor: LINE_COLORS[i % LINE_COLORS.length] }}
                    />
                    <span className="flex-1 truncate text-neutral-300">{pageName(page.path)}</span>
                    <span className="tabular-nums text-neutral-100">
                      {fmtMetric(metric, page.daily[hover][metric])}
                    </span>
                  </p>
                ))}
              </div>
            )}

            <div className="mt-1 flex justify-between text-[10px] text-neutral-500">
              <span>{stats.dates[0]}</span>
              <span className="tabular-nums">
                {t('admin.pageStats.peak', { value: fmtMetric(metric, yMax) })}
              </span>
              <span>{stats.dates[stats.dates.length - 1]}</span>
            </div>
          </div>

          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
            {lines.map((line) => (
              <span key={line.path} className="flex items-center gap-1.5 text-[11px] text-neutral-400">
                <i className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: line.color }} />
                {pageName(line.path)}
              </span>
            ))}
          </div>

          <div className="mt-5 overflow-x-auto">
            <table className="w-full min-w-[420px] text-xs">
              <thead>
                <tr className="text-left text-neutral-500">
                  <th className="pb-2 font-medium">{t('admin.pageStats.colPage')}</th>
                  <th className="pb-2 text-right font-medium">{t('admin.pageStats.metric.visitors')}</th>
                  <th className="pb-2 text-right font-medium">{t('admin.pageStats.metric.views')}</th>
                  <th className="pb-2 text-right font-medium">{t('admin.pageStats.metric.avgSeconds')}</th>
                </tr>
              </thead>
              <tbody>
                {stats.pages.map((p) => (
                  <tr key={p.path} className="border-t border-white/5">
                    {/* 中文名为主、路径为辅：只显示中文名的话，排查"这条对应哪个路由"
                        又得回头翻代码；路径用小字灰色跟在后面，不抢视线。
                        Name first, path as a hint: showing only the name would send you
                        back to the code to work out which route a row is. */}
                    <td className="py-1.5">
                      <span className="text-neutral-200">{pageName(p.path)}</span>
                      <code className="ml-2 text-[10px] text-neutral-500">{p.path}</code>
                    </td>
                    <td className="py-1.5 text-right tabular-nums text-neutral-200">{p.visitors}</td>
                    <td className="py-1.5 text-right tabular-nums text-neutral-200">{p.views}</td>
                    <td className="py-1.5 text-right tabular-nums text-neutral-400">{fmtDwell(p.avgSeconds)}</td>
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
