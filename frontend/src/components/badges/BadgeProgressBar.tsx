// 勋章进度条：一条细条 + 「5 / 7 天」。只画后端算好的 progress，不自己算。
// 目标为 0 或没有 progress 时不渲染；超过目标封顶 100%（判定和进度是两回事，
// 进度到了不代表已发——胜手还有手数、盈亏门槛）。
// Badge progress bar: thin track + "5 / 7 days". Renders backend-computed
// progress only; capped at 100% (reaching the bar is not the same as earning
// the tier — winning hand has extra gates).
import { useTranslation } from 'react-i18next'
import type { BadgeProgress } from '../../api/types'

export function BadgeProgressBar({ p, compact = false }: { p: BadgeProgress | undefined; compact?: boolean }) {
  const { t } = useTranslation()
  if (!p || p.target <= 0) return null
  const pct = Math.min(1, Math.max(0, p.value / p.target))
  const unit = t(`gamification.progressUnit.${p.unit}`, { defaultValue: '' })
  return (
    <span className={`ach-prog${compact ? ' compact' : ''}`}>
      <span
        className="ach-prog-track"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={p.target}
        aria-valuenow={Math.min(p.value, p.target)}
      >
        <i className="ach-prog-fill" style={{ ['--pct' as string]: pct }} />
      </span>
      <small className="ach-prog-label num">
        {p.value} / {p.target} {unit}
      </small>
    </span>
  )
}
