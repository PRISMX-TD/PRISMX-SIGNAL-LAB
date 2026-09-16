// 等级分布：FREE / PRO 付费 / PRO 试用。后端已拆好，这里只按固定顺序显示。
// Plan breakdown; the split is done server-side.
import { useTranslation } from 'react-i18next'

const ORDER = ['FREE', 'PRO_PAID', 'PRO_TRIAL'] as const
const CHIP: Record<string, string> = {
  FREE: 'bg-white/5 text-neutral-400',
  PRO_PAID: 'bg-prism-600/20 text-prism-300',
  PRO_TRIAL: 'bg-prism-600/10 text-prism-200',
}

export default function PlanBreakdown({ plans }: { plans: Record<string, number> }) {
  const { t } = useTranslation()
  // 后端可能出现表外的等级键（历史数据），排在固定三项之后原样显示
  // Any unexpected plan key from legacy data is shown after the fixed three
  const extra = Object.keys(plans).filter((k) => !(ORDER as readonly string[]).includes(k))
  return (
    <div className="glass mb-5 flex flex-wrap items-center gap-2 p-4">
      <span className="text-xs text-neutral-400">{t('admin.planBreakdown')}</span>
      {[...ORDER, ...extra].map((k) => (
        <span key={k} className={`tag ${CHIP[k] ?? 'bg-white/5 text-neutral-400'}`}>
          {t(`admin.overview.plans.${k}`, { defaultValue: k })} · {plans[k] ?? 0}
        </span>
      ))}
    </div>
  )
}
