// 看板顶部的时间范围：五个预设胶囊 + 自定义（两个日期框 + 应用）。
// 自定义的校验只挡明显错误（起晚于止、未来、超 400 天），日期语义由后端定。
// Range picker: five preset pills plus a custom from/to with apply.
import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { PRESETS, customRangeError, rangeKey, todayIso, type RangeState } from './rangeUtils'
import type { OverviewRangePreset } from '../../../api/types'

export default function RangePicker({ value, onChange }: { value: RangeState; onChange: (next: RangeState) => void }) {
  const { t } = useTranslation()
  const [customOpen, setCustomOpen] = useState(value.kind === 'custom')
  const [from, setFrom] = useState(value.kind === 'custom' ? value.from : '')
  const [to, setTo] = useState(value.kind === 'custom' ? value.to : todayIso())

  // 范围状态的真源是 URL（父级传进来的 value）。浏览器前进/后退或外部改了 value 时，
  // 本地的"自定义面板开着 / 两个日期框"要跟着对齐，否则会出现预设胶囊亮着、
  // 自定义面板却还开着显示旧日期的错位。
  // The URL (the incoming value) is the source of truth; re-sync local panel state
  // whenever it changes externally (back/forward, deep link).
  useEffect(() => {
    if (value.kind === 'custom') {
      setCustomOpen(true)
      setFrom(value.from)
      setTo(value.to)
    } else {
      setCustomOpen(false)
    }
    // key 字符串才是 range 的稳定身份；value 对象每次渲染都可能是新引用，
    // 用它当依赖会在无关重渲染时也重跑这个效果。
    // The key string is the range's stable identity; value is a fresh object on
    // some re-renders, and depending on it would re-run this effect needlessly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rangeKey(value)])

  const error = customOpen && (from || to) ? customRangeError(from, to) : null
  const canApply = customOpen && !!from && !!to && error === null

  const pill = (active: boolean) =>
    `rounded-full px-3 py-1 text-xs transition ${active ? 'bg-white/10 text-neutral-100 ring-1 ring-white/20' : 'text-neutral-500 hover:text-neutral-300'}`

  const presetActive = (p: OverviewRangePreset) => !customOpen && value.kind === 'preset' && value.preset === p

  return (
    <div className="mb-5 flex flex-wrap items-center gap-2" role="group" aria-label={t('admin.overview.range.label')}>
      {PRESETS.map((p) => (
        <button key={p} type="button" aria-pressed={presetActive(p)} className={pill(presetActive(p))}
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
