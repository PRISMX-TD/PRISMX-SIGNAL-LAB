// 快速输入框（图表获得焦点时直接敲数字 / 字母弹出，同 TradingView）：敲周期（5、2h、D、W…）
// 回车切周期；敲品种名前几个字母，下面列出匹配的品种，回车选第一个。Esc 关闭并把焦点还给图表。
// Quick input (type a digit / letter while the chart has focus, as in TradingView): an
// interval (5, 2h, D, W…) + Enter switches the interval; the first letters of a symbol list
// matches below and Enter picks the first. Escape closes and returns focus to the chart.
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { intervalLabel, normalizeIntervalInput } from './intervals'

export function matchSymbols(symbols: readonly string[], text: string, limit = 8): string[] {
  const q = text.trim().toUpperCase()
  if (!q) return []
  const starts = symbols.filter((s) => s.toUpperCase().startsWith(q))
  const contains = symbols.filter((s) => !s.toUpperCase().startsWith(q) && s.toUpperCase().includes(q))
  return [...starts, ...contains].slice(0, limit)
}

export default function QuickInput({ initial, symbols, onInterval, onSymbol, onClose }: {
  initial: string
  symbols: readonly string[]
  onInterval: (code: string) => void
  onSymbol: (s: string) => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const [text, setText] = useState(initial)
  const [idx, setIdx] = useState(0)
  const inRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const el = inRef.current
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [])
  const iv = normalizeIntervalInput(text.trim())
  const syms = useMemo(() => (/^\d/.test(text.trim()) ? [] : matchSymbols(symbols, text)), [symbols, text])
  const options: { kind: 'iv' | 'sym'; v: string }[] = [
    ...(iv ? [{ kind: 'iv' as const, v: iv }] : []),
    ...syms.map((v) => ({ kind: 'sym' as const, v })),
  ]
  const choose = (o: { kind: 'iv' | 'sym'; v: string } | undefined) => {
    if (!o) return
    if (o.kind === 'iv') onInterval(o.v)
    else onSymbol(o.v)
    onClose()
  }
  return (
    <div className="chart-quick" role="dialog" aria-label={String(t('charts.quick.title'))}>
      <input
        ref={inRef}
        value={text}
        maxLength={20}
        spellCheck={false}
        autoCapitalize="characters"
        aria-label={String(t('charts.quick.title'))}
        aria-autocomplete="list"
        aria-controls="chart-quick-list"
        onChange={(e) => { setText(e.target.value); setIdx(0) }}
        onBlur={onClose}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { e.preventDefault(); onClose() }
          else if (e.key === 'Enter') { e.preventDefault(); choose(options[idx] ?? options[0]) }
          else if (e.key === 'ArrowDown') { e.preventDefault(); setIdx((i) => Math.min(options.length - 1, i + 1)) }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setIdx((i) => Math.max(0, i - 1)) }
        }}
      />
      <ul id="chart-quick-list" role="listbox">
        {options.map((o, i) => (
          <li key={`${o.kind}:${o.v}`} role="option" aria-selected={i === idx} className={i === idx ? 'on' : ''}
            onPointerDown={(e) => { e.preventDefault(); choose(o) }}>
            {o.kind === 'iv' ? <><b>{intervalLabel(o.v)}</b><small>{t('charts.quick.interval')}</small></> : <><b>{o.v}</b><small>{t('charts.quick.symbol')}</small></>}
          </li>
        ))}
        {options.length === 0 && <li className="none">{t('charts.quick.none')}</li>}
      </ul>
    </div>
  )
}
