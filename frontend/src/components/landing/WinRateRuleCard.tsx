// 判定规则可视化卡：把 4 条胜率判定规则做成时间线，不含任何编造数字
// win-rate rule visualization: a timeline of the 4 scoring rules, no invented numbers
import { useTranslation } from 'react-i18next'

type RuleRow = {
  key: 'wrRule1' | 'wrRule2' | 'wrRule3' | 'wrRule4'
  mark: string
  markColor: string
  badge: string
  badgeBg: string
  badgeColor: string
}

const rows: RuleRow[] = [
  { key: 'wrRule1', mark: '✓', markColor: 'var(--up)', badge: 'WIN', badgeBg: 'var(--up-bg)', badgeColor: 'var(--up)' },
  { key: 'wrRule2', mark: '✗', markColor: 'var(--down)', badge: 'LOSS', badgeBg: 'var(--down-bg)', badgeColor: 'var(--down)' },
  { key: 'wrRule3', mark: '⚠', markColor: 'var(--gold)', badge: 'LOSS', badgeBg: 'var(--down-bg)', badgeColor: 'var(--down)' },
  { key: 'wrRule4', mark: '—', markColor: '#64748b', badge: 'N/A', badgeBg: 'rgba(148, 163, 184, 0.12)', badgeColor: '#94a3b8' },
]

export default function WinRateRuleCard() {
  const { t } = useTranslation()

  return (
    <div className="glass p-6">
      {/* 顶部节点：信号发出 / top node: signal fired */}
      <div className="flex items-center gap-3">
        <span
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold"
          style={{ background: 'var(--purple)', color: '#fff' }}
        >
          ●
        </span>
        <span className="text-sm font-semibold text-slate-200">{t('landing.wrSignalFired')}</span>
      </div>

      <div className="relative mt-1 pl-3">
        <div className="absolute bottom-2 left-[11px] top-0 w-px bg-white/10" />
        {rows.map((row) => (
          <div key={row.key} className="relative flex items-start gap-3 py-3 pl-4">
            <span
              className="absolute left-0 top-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-white/10 bg-ink-950 text-sm font-bold"
              style={{ color: row.markColor }}
            >
              {row.mark}
            </span>
            <div className="ml-6 flex-1">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm text-slate-200">{t(`landing.${row.key}`)}</p>
                <span
                  className="shrink-0 rounded-md px-2 py-0.5 text-[10px] font-bold tracking-wide"
                  style={{ background: row.badgeBg, color: row.badgeColor }}
                >
                  {row.badge}
                </span>
              </div>
              <p className="mt-1 text-xs text-slate-500">{t(`landing.${row.key}Note`)}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
