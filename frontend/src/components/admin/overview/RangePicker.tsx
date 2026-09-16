// 看板顶部的时间范围：五个预设胶囊 + 自定义（两个日期框 + 应用）。
// 自定义的校验只挡明显错误（起晚于止、未来、超 400 天），日期语义由后端定。
// Range picker: five preset pills plus a custom from/to with apply.
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { PRESETS, customRangeError, todayIso, type RangeState } from './rangeUtils'

export default function RangePicker({ value, onChange }: { value: RangeState; onChange: (next: RangeState) => void }) {
  const { t } = useTranslation()
  const [customOpen, setCustomOpen] = useState(value.kind === 'custom')
  const [from, setFrom] = useState(value.kind === 'custom' ? value.from : '')
  const [to, setTo] = useState(value.kind === 'custom' ? value.to : todayIso())
  const error = customOpen && (from || to) ? customRangeError(from, to) : null
  const canApply = customOpen && !!from && !!to && error === null

  const pill = (active: boolean) =>
    `rounded-full px-3 py-1 text-xs transition ${active ? 'bg-white/10 text-neutral-100 ring-1 ring-white/20' : 'text-neutral-500 hover:text-neutral-300'}`

  return (
    <div className="mb-5 flex flex-wrap items-center gap-2" role="group" aria-label={t('admin.overview.range.label')}>
      {PRESETS.map((p) => (
        <button key={p} type="button" aria-pressed={value.kind === 'preset' && value.preset === p} className={pill(value.kind === 'preset' && value.preset === p)}
          onClick={() => { setCustomOpen(false); onChange({ kind: 'preset', preset: p }) }}>
          {t(`admin.overview.range.preset.${p}`)}
        </button>
      ))}
      <button type="button" aria-pressed={customOpen} className={pill(value.kind === 'custom' || customOpen)} onClick={() => setCustomOpen(true)}>
        {t('admin.overview.range.custom')}
      </button>

      {customOpen && (
        <div className="flex flex-wrap items-center gap-2">
          <input type="date" value={from} max={todayIso()} onChange={(e) => setFrom(e.target.value)} aria-label={t('admin.overview.range.from')}
                 className="rounded-md border border-white/10 bg-white/5 px-2 py-1 text-xs text-neutral-100" />
          <span className="text-xs text-neutral-500">–</span>
          <input type="date" value={to} max={todayIso()} onChange={(e) => setTo(e.target.value)} aria-label={t('admin.overview.range.to')}
                 className="rounded-md border border-white/10 bg-white/5 px-2 py-1 text-xs text-neutral-100" />
          <button type="button" disabled={!canApply} onClick={() => onChange({ kind: 'custom', from, to })}
                  className="rounded-full bg-prism-500/25 px-3 py-1 text-xs text-prism-100 ring-1 ring-prism-400/40 disabled:cursor-not-allowed disabled:opacity-40">
            {t('admin.overview.range.apply')}
          </button>
          {error && error !== 'incomplete' && <span className="text-xs text-down">{t(`admin.overview.range.error.${error}`)}</span>}
        </div>
      )}
    </div>
  )
}
