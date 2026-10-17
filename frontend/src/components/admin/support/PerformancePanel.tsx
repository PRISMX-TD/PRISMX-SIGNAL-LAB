// 业绩看板（设计 §7.4）：按客服 × 时间段的分配 / 已联系 / 有意向 / 转化（分 kind，只算已确认）、
// 转化率与平均首次联系时长。只有数量，没有任何金额。日期按 UTC+8 自然日。
// Performance (design §7.4): per agent over a date range — assigned / contacted / interested /
// conversions by kind (confirmed only), conversion rate and mean time to first contact. Counts
// only, never amounts. Days are UTC+8 calendar days.
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { adminSupportApi } from '../../../api/client'
import { CONVERSION_KINDS, type SupportStatsRow } from '../../../api/supportTypes'
import { SkeletonLine } from '../../Skeleton'
import { errText } from '../../support/supportUi'

function bjToday(offsetDays = 0): string {
  return new Date(Date.now() + 8 * 3600_000 + offsetDays * 86400_000).toISOString().slice(0, 10)
}

export default function PerformancePanel({ onToast }: { onToast: (kind: 'ok' | 'err', text: string) => void }) {
  const { t } = useTranslation()
  const [start, setStart] = useState(() => bjToday(-29))
  const [end, setEnd] = useState(() => bjToday())
  const [rows, setRows] = useState<SupportStatsRow[] | null>(null)

  const load = useCallback(async () => {
    setRows(null)
    try {
      const r = await adminSupportApi.stats(start || undefined, end || undefined)
      setRows(r.items)
    } catch (err) {
      onToast('err', errText(err, t('admin.loadError')))
      setRows([])
    }
  }, [start, end, onToast, t])
  useEffect(() => { void load() }, [load])

  return (
    <div className="space-y-3">
      <div className="glass flex flex-wrap items-center gap-3 p-4 text-xs text-neutral-400">
        <label className="flex items-center gap-2">
          {t('admin.support.perf.start')}
          <input type="date" className="input w-auto py-1 text-xs" value={start} max={end} onChange={(e) => setStart(e.target.value)} />
        </label>
        <label className="flex items-center gap-2">
          {t('admin.support.perf.end')}
          <input type="date" className="input w-auto py-1 text-xs" value={end} min={start} onChange={(e) => setEnd(e.target.value)} />
        </label>
        <span className="text-neutral-500">{t('admin.support.perf.hint')}</span>
      </div>
      {!rows ? (
        <div className="glass space-y-3 p-5"><SkeletonLine /><SkeletonLine width="70%" /></div>
      ) : rows.length === 0 ? (
        <div className="glass p-8 text-center text-sm text-neutral-500">{t('admin.support.perf.empty')}</div>
      ) : (
        <div className="glass overflow-x-auto p-0">
          <table className="w-full min-w-[860px] text-left text-sm">
            <thead>
              <tr className="border-b border-white/10 text-xs uppercase tracking-wide text-neutral-500">
                <th className="px-3 py-3 font-medium">{t('admin.support.perf.staff')}</th>
                <th className="px-3 py-3 text-right font-medium">{t('admin.support.perf.assigned')}</th>
                <th className="px-3 py-3 text-right font-medium">{t('admin.support.perf.contacted')}</th>
                <th className="px-3 py-3 text-right font-medium">{t('admin.support.perf.interested')}</th>
                <th className="px-3 py-3 text-right font-medium">{t('admin.support.perf.converted')}</th>
                {CONVERSION_KINDS.map((k) => (
                  <th key={k} className="px-3 py-3 text-right font-medium">{t(`supportDesk.conversions.kind.${k}`)}</th>
                ))}
                <th className="px-3 py-3 text-right font-medium">{t('admin.support.perf.rate')}</th>
                <th className="px-3 py-3 text-right font-medium">{t('admin.support.perf.firstContact')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.staffId} className="border-b border-white/5 last:border-0">
                  <td className="px-3 py-2.5">
                    <div className="text-xs font-medium text-neutral-200">{r.nickname || r.email}</div>
                    <div className="text-[11px] text-neutral-500">{r.role === 'admin' ? t('supportDesk.role.admin') : t(`admin.support.tier.${r.tier}`)}</div>
                  </td>
                  {[r.assigned, r.contacted, r.interested, r.convertedFollowUps, ...CONVERSION_KINDS.map((k) => r.conversions[k] ?? 0)].map((n, i) => (
                    <td key={i} className="num px-3 py-2.5 text-right text-xs text-neutral-200">{n}</td>
                  ))}
                  <td className="num px-3 py-2.5 text-right text-xs text-neutral-200">{r.conversionRate == null ? '—' : `${(r.conversionRate * 100).toFixed(1)}%`}</td>
                  <td className="num px-3 py-2.5 text-right text-xs text-neutral-200">
                    {r.avgFirstContactHours == null ? '—' : t('admin.support.perf.hours', { n: r.avgFirstContactHours.toFixed(1) })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
