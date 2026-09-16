// 管理后台的页面访问统计卡：按天折线图 + 各页面明细表。
// 时间范围由父级 OverviewPanel 统一管理，这里不再有自己的天数开关。
// Admin page-stats card: per-day line chart plus a per-page table. The range
// is owned by OverviewPanel; this card no longer has its own window picker.
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AdminPageStats } from '../../api/types'
import LineChart, { SERIES_COLORS } from './overview/LineChart'

// 三个指标量纲差太多，一次只画一个 / three metrics, wildly different scales: one at a time
type Metric = 'visitors' | 'views' | 'avgSeconds'
const METRICS: Metric[] = ['visitors', 'views', 'avgSeconds']

// 折线只画访问量前 6 的页面，明细表列全部 / chart the top 6, table lists all
const MAX_LINES = 6

export function fmtDwell(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`
  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds % 60)
  return s > 0 ? `${m}m ${s}s` : `${m}m`
}

// 页面名走 i18n；nsSeparator: false 是必须的——带参路由的 key 里有冒号。
// Page names via i18n; nsSeparator:false is required (parameterised keys contain ':').
function usePageName() {
  const { t } = useTranslation()
  return (path: string) => t(`admin.pageStats.page.${path}`, { defaultValue: path, nsSeparator: false })
}

export default function PageStatsCard({ stats }: { stats: AdminPageStats | null }) {
  const { t } = useTranslation()
  const pageName = usePageName()
  const [metric, setMetric] = useState<Metric>('visitors')

  const series = useMemo(() => {
    if (!stats) return []
    return stats.pages.slice(0, MAX_LINES).map((page, i) => ({
      key: page.path,
      label: pageName(page.path),
      color: SERIES_COLORS[i % SERIES_COLORS.length],
      values: page.daily.map((d) => d[metric]),
    }))
  }, [stats, metric, pageName])

  const hasData = stats != null && stats.pages.length > 0
  const format = (v: number) => (metric === 'avgSeconds' ? fmtDwell(v) : String(v))

  return (
    <div className="glass mb-5 p-5">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-white">{t('admin.pageStats.title')}</h2>
        {hasData && (
          <span className="text-xs text-neutral-400">
            {t('admin.pageStats.summary', { visitors: stats.totalVisitors, views: stats.totalViews, avg: fmtDwell(stats.avgSecondsOverall) })}
          </span>
        )}
      </div>
      <p className="mb-3 text-xs text-neutral-500">{t('admin.pageStats.privacyHint')}</p>

      {!hasData ? (
        <p className="py-3 text-sm text-neutral-500">{t('admin.pageStats.empty')}</p>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap gap-1.5" role="tablist" aria-label={t('admin.pageStats.metricLabel')}>
            {METRICS.map((key) => (
              <button key={key} type="button" role="tab" aria-selected={metric === key} onClick={() => setMetric(key)}
                className={`rounded-full px-3 py-1 text-xs transition ${metric === key ? 'bg-prism-500/25 text-prism-100 ring-1 ring-prism-400/40' : 'text-neutral-400 hover:text-neutral-200'}`}>
                {t(`admin.pageStats.metric.${key}`)}
              </button>
            ))}
          </div>

          <LineChart
            dates={stats.dates}
            series={series}
            format={format}
            ariaLabel={t(`admin.pageStats.metric.${metric}`)}
            peakLabel={(v) => t('admin.pageStats.peak', { value: v })}
          />

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
