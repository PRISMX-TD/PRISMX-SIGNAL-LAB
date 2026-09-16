// 活跃趋势：日活 + 新注册两条线，按天。
// Activity trend: daily active + daily signups.
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { AdminActivityDay } from '../../../api/types'
import LineChart, { SERIES_COLORS } from './LineChart'

export default function ActivityChart({ daily }: { daily: AdminActivityDay[] }) {
  const { t } = useTranslation()
  const dates = useMemo(() => daily.map((d) => d.date), [daily])
  const series = useMemo(() => [
    { key: 'active', label: t('admin.overview.activity.active'), color: SERIES_COLORS[0], values: daily.map((d) => d.active) },
    { key: 'signups', label: t('admin.overview.activity.signups'), color: SERIES_COLORS[2], values: daily.map((d) => d.signups) },
  ], [daily, t])
  return (
    <div className="glass mb-5 p-5">
      <h2 className="mb-1 text-sm font-semibold text-white">{t('admin.overview.activity.title')}</h2>
      <p className="mb-3 text-xs text-neutral-500">{t('admin.overview.activity.hint')}</p>
      <LineChart dates={dates} series={series} format={String} ariaLabel={t('admin.overview.activity.title')}
                 peakLabel={(v) => t('admin.pageStats.peak', { value: v })} />
    </div>
  )
}
