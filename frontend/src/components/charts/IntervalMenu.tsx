// 周期下拉：按分钟 / 小时 / 天 / 周 / 月分组的全部预设，每行一颗星（收藏 = 显示在工具条上），
// 顶部一个输入框可敲任意周期（2h、45、3D、6M…，规则见 intervals.normalizeIntervalInput）。
// Interval dropdown: every preset grouped by minutes / hours / days / weeks / months, each
// with a star (favourite = shown on the toolbar), plus a box at the top that takes any
// interval (2h, 45, 3D, 6M…; rules in intervals.normalizeIntervalInput).
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import ChartPopover from './ChartPopover'
import { INTERVAL_PRESETS, intervalLabel, normalizeIntervalInput } from './intervals'
import { intervalSortKey } from './IntervalSeg'

interface Props {
  value: string
  onChange: (code: string) => void
  favorites: string[]
  onFavorites: (codes: string[]) => void
  // 手机底栏：按钮直接写当前周期（「1H ▾」），不只是小箭头 / phone bottom bar: the button shows the current interval
  asLabel?: boolean
}

export function Star({ on }: { on: boolean }) {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill={on ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden>
      <path d="M12 3.5l2.6 5.3 5.9.9-4.25 4.1 1 5.85L12 16.9l-5.25 2.75 1-5.85L3.5 9.7l5.9-.9z" />
    </svg>
  )
}

export default function IntervalMenu({ value, onChange, favorites, onFavorites, asLabel = false }: Props) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [bad, setBad] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const close = () => { setOpen(false); setText(''); setBad(false) }

  const toggleFav = (code: string) => {
    const on = favorites.includes(code)
    // 至少留一个，工具条不能空 / keep at least one so the toolbar never empties
    if (on && favorites.length <= 1) return
    const next = on ? favorites.filter((c) => c !== code) : [...favorites, code]
    onFavorites(next.sort((a, b) => intervalSortKey(a) - intervalSortKey(b)))
  }
  const pick = (code: string) => { onChange(code); close() }
  const submit = () => {
    const code = normalizeIntervalInput(text.trim())
    if (!code) { setBad(true); return }
    pick(code)
  }
  const custom = favorites.filter((c) => !INTERVAL_PRESETS.some((g) => g.codes.includes(c)))
  const label = String(t('charts.iv.more'))

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={asLabel ? `term-mbar-btn term-mbar-txt ${open ? 'on' : ''}` : `term-tool-btn term-iv-more ${open ? 'on' : ''}`}
        title={label}
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => (open ? close() : setOpen(true))}
      >
        {asLabel && <span>{intervalLabel(value)}</span>}
        <svg width={asLabel ? 10 : 12} height={asLabel ? 10 : 12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M6 9l6 6 6-6" /></svg>
      </button>
      <ChartPopover open={open} onClose={close} anchorRef={btnRef} width={240} label={label} className="chart-iv">
        <form className="chart-iv-in" onSubmit={(e) => { e.preventDefault(); submit() }}>
          <input
            value={text}
            onChange={(e) => { setText(e.target.value); setBad(false) }}
            placeholder={String(t('charts.iv.placeholder'))}
            aria-label={String(t('charts.iv.custom'))}
            aria-invalid={bad}
            maxLength={12}
            autoFocus
          />
          <button type="submit" disabled={!text.trim()}>{t('charts.iv.go')}</button>
        </form>
        {bad && <p className="chart-iv-bad" role="alert">{t('charts.iv.invalid')}</p>}
        <div className="chart-pop-body no-sb">
          {[...INTERVAL_PRESETS, ...(custom.length ? [{ group: 'custom' as const, codes: custom }] : [])].map((g) => (
            <div key={g.group} className="chart-iv-grp">
              <b>{t(`charts.iv.group.${g.group}`)}</b>
              {g.codes.map((code) => {
                const fav = favorites.includes(code)
                return (
                  <div key={code} className={`chart-pop-row ${value === code ? 'on' : ''}`}>
                    <button type="button" className="chart-pop-item" onClick={() => pick(code)}>
                      {intervalLabel(code)}
                      <small>{t(`charts.iv.long.${longKey(code)}`, { n: longN(code) })}</small>
                    </button>
                    <button
                      type="button"
                      className={`chart-pop-star ${fav ? 'on' : ''}`}
                      aria-pressed={fav}
                      aria-label={String(t(fav ? 'charts.iv.unfav' : 'charts.iv.fav', { iv: intervalLabel(code) }))}
                      onClick={() => toggleFav(code)}
                    >
                      <Star on={fav} />
                    </button>
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      </ChartPopover>
    </>
  )
}

// 「5 分钟」「2 小时」这类长名字 / long names like "5 minutes", "2 hours"
function longKey(code: string): 'min' | 'hour' | 'day' | 'week' | 'month' {
  if (/^\d+$/.test(code)) return Number(code) % 60 === 0 ? 'hour' : 'min'
  const u = code.slice(-1)
  return u === 'D' ? 'day' : u === 'W' ? 'week' : 'month'
}
function longN(code: string): number {
  if (/^\d+$/.test(code)) { const n = Number(code); return n % 60 === 0 ? n / 60 : n }
  const n = code.slice(0, -1)
  return n ? Number(n) : 1
}
