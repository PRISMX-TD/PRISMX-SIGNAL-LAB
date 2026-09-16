import { useTranslation } from 'react-i18next'
import type { AdminFunnelSteps, AdminFunnelWeek } from '../../../api/types'

const STEPS: (keyof AdminFunnelSteps)[] = ['registered', 'bound', 'traded', 'trialed', 'paid']

function pct(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 100)}%` : '—'
}

export default function FunnelCard({ funnel }: { funnel: { overall: AdminFunnelSteps; byWeek: AdminFunnelWeek[] } }) {
  const { t } = useTranslation()
  const { overall, byWeek } = funnel
  const base = overall.registered

  return (
    <div className="glass mb-5 p-5">
      <h2 className="mb-1 text-sm font-semibold text-white">{t('admin.overview.funnel.title')}</h2>
      <p className="mb-4 text-xs text-neutral-500">{t('admin.overview.funnel.hint')}</p>

      <ol className="space-y-2">
        {STEPS.map((step, i) => {
          const n = overall[step]
          const prev = i > 0 ? overall[STEPS[i - 1]] : null
          const width = base > 0 ? Math.max(2, (n / base) * 100) : 0
          return (
            <li key={step} className="grid grid-cols-[7rem_1fr_5rem] items-center gap-3 text-xs">
              <span className="text-neutral-300">{t(`admin.overview.funnel.step.${step}`)}</span>
              <div className="h-5 rounded bg-white/5">
                <div className="h-5 rounded bg-prism-500/50" style={{ width: `${width}%` }} />
              </div>
              <span className="text-right tabular-nums text-neutral-100">
                {n}
                {prev !== null && <span className="ml-1 text-[10px] text-neutral-500">{pct(n, prev)}</span>}
              </span>
            </li>
          )
        })}
      </ol>

      <h3 className="mb-2 mt-5 text-xs font-medium text-neutral-400">{t('admin.overview.funnel.byWeek')}</h3>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[520px] text-xs">
          <thead>
            <tr className="text-left text-neutral-500">
              <th className="pb-2 font-medium">{t('admin.overview.funnel.weekOf')}</th>
              {STEPS.map((s) => <th key={s} className="pb-2 text-right font-medium">{t(`admin.overview.funnel.step.${s}`)}</th>)}
            </tr>
          </thead>
          <tbody>
            {byWeek.map((w) => (
              <tr key={w.weekStart} className="border-t border-white/5">
                <td className="py-1.5 tabular-nums text-neutral-300">{w.weekStart}</td>
                {STEPS.map((s) => (
                  <td key={s} className="py-1.5 text-right tabular-nums text-neutral-200">
                    {w[s]}
                    {s !== 'registered' && <span className="ml-1 text-[10px] text-neutral-500">{pct(w[s], w.registered)}</span>}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
