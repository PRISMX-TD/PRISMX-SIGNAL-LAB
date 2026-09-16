// 留存：次日 / 7 日 / 30 日三个数字，每个写清楚"算的是哪批人"。
// cohort 只含"第 N 天已经过去"的注册者，所以三个数字的分母不同，这是正确的。
// Retention: d2 / d7 / d30, each with its cohort spelled out. Cohorts differ
// per N by design (only users whose day N has elapsed).
import { useTranslation } from 'react-i18next'
import type { AdminRetentionPoint } from '../../../api/types'

const KEYS = ['d2', 'd7', 'd30'] as const

export default function RetentionCard({
  retention,
  dataSince,
}: {
  retention: Record<(typeof KEYS)[number], AdminRetentionPoint>
  dataSince?: string | null
}) {
  const { t } = useTranslation()
  return (
    <div className="glass mb-5 p-5">
      <h2 className="mb-1 text-sm font-semibold text-white">{t('admin.overview.retention.title')}</h2>
      <p className="mb-4 text-xs text-neutral-500">
        {t('admin.overview.retention.hint')}
        {dataSince ? ` ${t('admin.overview.dataSince', { since: dataSince })}` : null}
      </p>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {KEYS.map((k) => {
          const p = retention[k]
          return (
            <div key={k} className="rounded-lg bg-white/5 px-4 py-3">
              <div className="text-xs text-neutral-400">{t(`admin.overview.retention.${k}`)}</div>
              <div className="num mt-1 font-display text-2xl font-bold text-neutral-50">
                {p.rate === null ? '—' : `${Math.round(p.rate * 100)}%`}
              </div>
              <div className="mt-1 text-[11px] text-neutral-500">
                {p.cohortSize === 0
                  ? t('admin.overview.retention.emptyCohort')
                  : t('admin.overview.retention.cohort', { from: p.cohortFrom, to: p.cohortTo, n: p.cohortSize })}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
