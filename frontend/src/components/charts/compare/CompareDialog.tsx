// 对比品种弹窗：搜品种（与快速输入同一套匹配），选显示方式（百分比 / 新价格轴 / 新窗格）与颜色后点一下加入；
// 下面列出已加的条目，可改颜色、换显示方式、显隐、删除。每张图最多 5 个。条目由页面持有，这里只回调 onChange。
// Compare dialog: search symbols (the quick-input matcher), pick a mode (percent / new scale / new pane)
// and a colour, click to add; below, the current entries with colour, mode, visibility and remove.
// At most 5 per chart. The page owns the entries; this only calls onChange.
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import ChartDialog from '../ChartDialog'
import ColorPicker from '../ind/ColorPicker'
import { matchSymbols } from '../QuickInput'
import type { CompareEntry, CompareMode } from '../layout/paneState'
import { COMPARE_COLORS, MAX_COMPARE, addableSymbols, nextCompareColor } from './compareModel'
import { Ico, RI } from '../replay/icons'
import './compare.css'

const MODES: CompareMode[] = ['percent', 'scale', 'pane']

export default function CompareDialog({ symbols, mainSymbol, entries, onChange, onClose }: {
  // 可选品种（activeSymbols）/ selectable symbols (activeSymbols)
  symbols: readonly string[]
  mainSymbol: string
  entries: readonly CompareEntry[]
  onChange: (next: CompareEntry[]) => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const [q, setQ] = useState('')
  const [mode, setMode] = useState<CompareMode>('percent')
  const [color, setColor] = useState(() => nextCompareColor(entries))
  const full = entries.length >= MAX_COMPARE
  const addable = useMemo(() => addableSymbols(symbols, mainSymbol, entries), [symbols, mainSymbol, entries])
  const list = useMemo(() => (q.trim() ? matchSymbols(addable, q, 40) : addable.slice(0, 80)), [addable, q])

  const add = (symbol: string) => {
    if (full) return
    const next = [...entries, { symbol, mode, color }]
    onChange(next)
    setColor(nextCompareColor(next))
    setQ('')
  }
  const patch = (symbol: string, p: Partial<CompareEntry>) => onChange(entries.map((e) => (e.symbol === symbol ? { ...e, ...p } : e)))
  const remove = (symbol: string) => {
    const next = entries.filter((e) => e.symbol !== symbol)
    onChange(next)
    setColor(nextCompareColor(next))
  }

  const modeSeg = (cur: CompareMode, set: (m: CompareMode) => void, small = false) => (
    <span className={`cmp-seg ${small ? 'sm' : ''}`} role="radiogroup" aria-label={String(t('charts.compare.mode'))}>
      {MODES.map((m) => (
        <button key={m} type="button" role="radio" aria-checked={cur === m} className={cur === m ? 'on' : ''} onClick={() => set(m)}
          title={String(t(`charts.compare.mode_${m}`))} aria-label={String(t(`charts.compare.mode_${m}`))}>
          <Ico size={small ? 14 : 15}>{RI[m]}</Ico>
          {!small && <span>{t(`charts.compare.mode_${m}`)}</span>}
        </button>
      ))}
    </span>
  )

  return (
    <ChartDialog title={String(t('charts.compare.title'))} onClose={onClose} className="cmp-dlg">
      <div className="cmp-add">
        <div className="cmp-opts">
          {modeSeg(mode, setMode)}
          <span className="cmp-color">
            <span>{t('charts.compare.color')}</span>
            <ColorPicker color={color} label={String(t('charts.compare.color'))} presets={COMPARE_COLORS} onChange={(c) => setColor(c)} />
          </span>
        </div>
        <input className="ind-in wide cmp-q" value={q} onChange={(e) => setQ(e.target.value)} placeholder={String(t('charts.compare.search'))}
          aria-label={String(t('charts.compare.search'))} spellCheck={false} autoCapitalize="characters" disabled={full}
          onKeyDown={(e) => { if (e.key === 'Enter' && list[0]) { e.preventDefault(); add(list[0]) } }} />
        {full ? (
          <p className="chart-dlg-note">{t('charts.compare.max', { max: MAX_COMPARE })}</p>
        ) : (
          <ul className="cmpd-list no-sb" role="listbox" aria-label={String(t('charts.compare.search'))}>
            {list.map((s) => (
              <li key={s} role="option" aria-selected={false}>
                <button type="button" onClick={() => add(s)}>
                  <i className="cmpl-dot" style={{ background: color }} aria-hidden />
                  <b>{s}</b>
                  <span className="cmp-plus">{t('charts.compare.add')}</span>
                </button>
              </li>
            ))}
            {list.length === 0 && <li className="none">{t('charts.compare.none')}</li>}
          </ul>
        )}
      </div>
      <div className="cmp-cur">
        <h4>{t('charts.compare.added', { n: entries.length, max: MAX_COMPARE })}</h4>
        {entries.length === 0 && <p className="chart-dlg-note">{t('charts.compare.empty')}</p>}
        {entries.map((e) => (
          <div key={e.symbol} className={`cmpd-row ${e.hidden ? 'off' : ''}`}>
            <ColorPicker color={e.color} label={`${t('charts.compare.color')} ${e.symbol}`} presets={COMPARE_COLORS} onChange={(c) => patch(e.symbol, { color: c })} />
            <b className="cmp-sym">{e.symbol}</b>
            {modeSeg(e.mode, (m) => patch(e.symbol, { mode: m }), true)}
            <button type="button" className="cmp-ico" aria-label={`${t(e.hidden ? 'charts.compare.show' : 'charts.compare.hide')} ${e.symbol}`}
              onClick={() => patch(e.symbol, { hidden: e.hidden ? undefined : true })}>
              <Ico size={15}>{e.hidden ? RI.eyeOff : RI.eye}</Ico>
            </button>
            <button type="button" className="cmp-ico" aria-label={`${t('charts.compare.remove')} ${e.symbol}`} onClick={() => remove(e.symbol)}>
              <Ico size={15}>{RI.x}</Ico>
            </button>
          </div>
        ))}
      </div>
    </ChartDialog>
  )
}

// 顶栏上的「对比」按钮（页面自己管弹窗开关）/ the top-bar Compare button (the page owns the dialog state)
export function CompareButton({ count, onClick, className = '', showLabel = false }: { count: number; onClick: () => void; className?: string; showLabel?: boolean }) {
  const { t } = useTranslation()
  const label = String(t('charts.compare.button'))
  return (
    <button type="button" className={`${className} ${count > 0 ? 'on' : ''}`} title={label} aria-label={count > 0 ? `${label} (${count})` : label} onClick={onClick}>
      <Ico>{RI.compare}</Ico>
      {showLabel && <span>{label}</span>}
      {count > 0 && <em className="cmp-count">{count}</em>}
    </button>
  )
}
