// 奖品模式的两张选项卡（按份量 / 按概率，各带一句说明）。新建一期的弹框与「奖品设置」共用。
// locked 时只有当前模式可点（已有人抽过 / 已结束），另一张置灰。
// The two prize-mode option cards (qty / prob, each with its hint), shared by the new-round sheet and the
// prize settings. When locked (someone has drawn, or the round ended) only the current mode stays enabled.
import { useTranslation } from 'react-i18next'
import type { LuckyMode } from '../../../api/luckyTypes'

const MODES: LuckyMode[] = ['qty', 'prob']

export default function LuckyModeOptions({ value, onChange, locked = false }: {
  value: LuckyMode
  onChange: (m: LuckyMode) => void
  locked?: boolean
}) {
  const { t } = useTranslation()
  return (
    <div className="lka-modes" role="radiogroup" aria-label={t('admin.lucky.mode.label')}>
      {MODES.map((m) => {
        const on = value === m
        return (
          <button key={m} type="button" role="radio" aria-checked={on} className={`lka-mode ${on ? 'is-on' : ''}`}
            disabled={locked && !on} onClick={() => { if (!on) onChange(m) }}>
            <span className="lka-mode-title"><span className="lka-mode-dot" aria-hidden />{t(`admin.lucky.mode.${m}`)}</span>
            <span className="lka-mode-hint block">{t(`admin.lucky.mode.${m}Hint`)}</span>
          </button>
        )
      })}
    </div>
  )
}
