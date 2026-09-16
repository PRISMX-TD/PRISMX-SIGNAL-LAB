// 策略使用：每个预设模板有多少人建过、多少人当前启用中。看的是"现在谁在用"，不跟范围走。
// Strategy usage per preset template: users who created one, users with one enabled. Not range-bound.
import { useTranslation } from 'react-i18next'
import type { AdminStrategyUsage, StrategyTemplateKey } from '../../../api/types'
import { TEMPLATE_LABEL_KEYS } from '../../../utils/strategyTemplates'

export default function StrategyUsageCard({ rows }: { rows: AdminStrategyUsage[] }) {
  const { t } = useTranslation()
  const name = (template: string) =>
    template in TEMPLATE_LABEL_KEYS ? t(TEMPLATE_LABEL_KEYS[template as StrategyTemplateKey]) : t('strategy.nameplaceholderCustom')
  return (
    <div className="glass p-5">
      <h2 className="mb-1 text-sm font-semibold text-white">{t('admin.overview.strategies.title')}</h2>
      <p className="mb-3 text-xs text-neutral-500">{t('admin.overview.strategies.hint')}</p>
      {rows.length === 0 ? (
        <p className="py-3 text-sm text-neutral-500">{t('admin.overview.strategies.empty')}</p>
      ) : (
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-neutral-500">
              <th className="pb-2 font-medium">{t('admin.overview.strategies.colTemplate')}</th>
              <th className="pb-2 text-right font-medium">{t('admin.overview.strategies.colUsers')}</th>
              <th className="pb-2 text-right font-medium">{t('admin.overview.strategies.colEnabled')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.template} className="border-t border-white/5">
                <td className="py-1.5 text-neutral-200">{name(r.template)}<code className="ml-2 text-[10px] text-neutral-500">{r.template}</code></td>
                <td className="py-1.5 text-right tabular-nums text-neutral-200">{r.users}</td>
                <td className="py-1.5 text-right tabular-nums text-neutral-200">{r.enabledUsers}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
