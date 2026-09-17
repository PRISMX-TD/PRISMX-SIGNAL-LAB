// 转化漏斗：五根横柱（注册 → 绑 MT5 → 下过单 → 开过试用 → 付费）+ 最近 8 周分批表。
// 五步互相独立、允许跳步，所以后一根不一定比前一根短；柱宽按"占注册人数比例"画。
// Conversion funnel: five independent steps (skipping allowed), bar width is the
// share of registered users; plus the last 8 signup weeks.
import { useTranslation } from 'react-i18next'
import type { AdminFunnelSteps, AdminFunnelWeek } from '../../../api/types'

// 主步骤五个；"绑定 MT5" 下面挂两个子行：真仓 / 模拟仓，百分比相对"绑定 MT5"而不是上一行。
// Five main steps; two sub-rows under "Linked MT5" (real / demo) whose
// percentages are relative to the bound total, not the row above.
type Step = keyof AdminFunnelSteps
const STEPS: Step[] = ['registered', 'bound', 'boundReal', 'boundDemo', 'traded', 'trialed', 'paid']
const SUB_STEPS = new Set<Step>(['boundReal', 'boundDemo'])
// 每一步的百分比分母：子行分母是 bound，主步骤分母是上一主步骤，注册无分母。
// Denominator per step: sub-rows use bound, main steps use the previous main step.
const PCT_BASE: Partial<Record<Step, Step>> = {
  bound: 'registered',
  boundReal: 'bound',
  boundDemo: 'bound',
  traded: 'bound',
  trialed: 'traded',
  paid: 'trialed',
}

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
        {STEPS.map((step) => {
          const n = overall[step]
          const baseKey = PCT_BASE[step]
          const prev = baseKey ? overall[baseKey] : null
          const sub = SUB_STEPS.has(step)
          const width = base > 0 && n > 0 ? Math.max(2, (n / base) * 100) : 0
          return (
            <li key={step} className="grid grid-cols-[7rem_1fr_5rem] items-center gap-3 text-xs">
              <span className={sub ? 'pl-4 text-neutral-500' : 'text-neutral-300'}>{t(`admin.overview.funnel.step.${step}`)}</span>
              <div className={sub ? 'h-3 rounded bg-white/5' : 'h-5 rounded bg-white/5'}>
                <div className={sub ? 'h-3 rounded bg-prism-500/30' : 'h-5 rounded bg-prism-500/50'} style={{ width: `${width}%` }} />
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
        <table className="w-full min-w-[680px] text-xs">
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
                    {s !== 'registered' && (
                      <span className="ml-1 text-[10px] text-neutral-500">{pct(w[s], SUB_STEPS.has(s) ? w.bound : w.registered)}</span>
                    )}
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
