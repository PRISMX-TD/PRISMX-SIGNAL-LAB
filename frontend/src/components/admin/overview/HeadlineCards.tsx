// 看板顶部五张指标卡。今日/周/月活跃永远"截至今天"，不跟范围走；新注册跟范围走并带对比。
// Five headline tiles. Active counts are always "as of today"; signups follow the range.
import { useTranslation } from 'react-i18next'
import type { AdminOverviewHeadline, Compare } from '../../../api/types'

// 对比小字："比上一期 +12%"。上一期为 0 时显示 —，因为百分比没有意义。
// Delta caption vs the previous period; "—" when the previous value is 0.
export function DeltaBadge({ current, previous }: Compare) {
  const { t } = useTranslation()
  if (previous === 0) return <span className="text-[11px] text-neutral-500">{t('admin.overview.delta.none')}</span>
  const pct = Math.round(((current - previous) / previous) * 100)
  const cls = pct > 0 ? 'text-up' : pct < 0 ? 'text-down' : 'text-neutral-400'
  const sign = pct > 0 ? '+' : ''
  return <span className={`text-[11px] tabular-nums ${cls}`}>{t('admin.overview.delta.vsPrev', { pct: `${sign}${pct}%` })}</span>
}

function Tile({ label, value, accent, footer }: { label: string; value: number; accent?: string; footer?: React.ReactNode }) {
  return (
    <div className="glass px-4 py-4">
      <div className="text-xs text-neutral-400">{label}</div>
      <div className={`num mt-1 font-display text-2xl font-bold ${accent ?? 'text-neutral-50'}`}>{value}</div>
      {footer && <div className="mt-1">{footer}</div>}
    </div>
  )
}

export default function HeadlineCards({ headline }: { headline: AdminOverviewHeadline }) {
  const { t } = useTranslation()
  return (
    <div className="mb-5 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
      <Tile label={t('admin.totalUsers')} value={headline.totalUsers} />
      <Tile label={t('admin.overview.headline.activeToday')} value={headline.activeToday} accent="text-up" />
      <Tile label={t('admin.overview.headline.activeWeek')} value={headline.activeWeek} accent="text-prism-300" />
      <Tile label={t('admin.overview.headline.activeMonth')} value={headline.activeMonth} accent="text-prism-300" />
      <Tile label={t('admin.overview.headline.signups')} value={headline.signups.current} footer={<DeltaBadge {...headline.signups} />} />
    </div>
  )
}
