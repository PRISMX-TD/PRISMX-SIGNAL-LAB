// 看板顶部的五个核心指标，排成一条指标带（样式在 admin.css）。今日/周/月活跃永远"截至今天"，
// 不跟范围走；新注册跟范围走并带对比。
// The five headline figures as one KPI strip (styles in admin.css). Active counts are always
// "as of today"; signups follow the range.
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

// live：今日活跃前面亮一个小绿点，表示这个数是实时的，不跟上面选的范围。
// live: a small green dot on "active today", the one figure that is real-time.
function Kpi({ label, value, live, footer }: { label: string; value: number; live?: boolean; footer?: React.ReactNode }) {
  return (
    <div className="adm-kpi">
      <div className="adm-kpi-label">
        {live && <span className="adm-live-dot" aria-hidden />}
        {label}
      </div>
      <div className="adm-kpi-value num">{value.toLocaleString()}</div>
      {footer && <div className="adm-kpi-foot">{footer}</div>}
    </div>
  )
}

export default function HeadlineCards({ headline }: { headline: AdminOverviewHeadline }) {
  const { t } = useTranslation()
  return (
    <div className="adm-kpis mb-5">
      <Kpi label={t('admin.totalUsers')} value={headline.totalUsers} />
      <Kpi label={t('admin.overview.headline.activeToday')} value={headline.activeToday} live />
      <Kpi label={t('admin.overview.headline.activeWeek')} value={headline.activeWeek} />
      <Kpi label={t('admin.overview.headline.activeMonth')} value={headline.activeMonth} />
      <Kpi label={t('admin.overview.headline.signups')} value={headline.signups.current} footer={<DeltaBadge {...headline.signups} />} />
    </div>
  )
}
