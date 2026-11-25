// 命令面板（Ctrl / ⌘ + K）：一个输入框搜全部——品种、周期（也认「3h」「2d」这种手敲写法）、
// 指标、动作。↑↓ 选、回车执行、Esc 关；鼠标悬停也会移动选中。点顶栏品种名时以「只搜品种」打开。
// Command palette (Ctrl / ⌘ + K): one field searches everything — symbols, intervals (typed
// forms like "3h" / "2d" too), indicators and actions. ↑↓ moves, Enter runs, Esc closes; the
// pointer moves the selection too. The top bar's symbol button opens it on symbols only.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { displaySymbol } from '../../../api/utils'
import { INTERVAL_PRESETS, intervalLabel, normalizeIntervalInput } from '../intervals'
import { IND_IDS, defOf } from '../ind/registry'
import { SymAvatar } from './ProTopBar'
import { IcFx, IcReturn, IcSearch } from './icons'

export interface ProAction {
  id: string
  label: string
  icon: ReactNode
  hint?: string
  run: () => void
}

export type ProCommandMode = 'all' | 'symbols'

interface Props {
  open: boolean
  mode: ProCommandMode
  onClose: () => void
  symbols: string[]
  activeSymbol: string
  interval: string
  onSymbol: (s: string) => void
  onInterval: (code: string) => void
  onIndicator: (id: string) => void
  isPro: boolean
  actions: ProAction[]
}

type Group = 'symbols' | 'intervals' | 'indicators' | 'actions'
interface Item { key: string; group: Group; label: string; sub?: string; icon: ReactNode; tag?: string; hint?: string; run: () => void }

const norm = (s: string) => s.toLowerCase().replace(/[\s._/-]+/g, '')

export default function ProCommand(p: Props) {
  if (!p.open) return null
  return createPortal(<Palette {...p} />, document.body)
}

function Palette({ mode, onClose, symbols, activeSymbol, interval, onSymbol, onInterval, onIndicator, isPro, actions }: Props) {
  const { t } = useTranslation()
  const tt = (k: string, o?: Record<string, unknown>) => String(t(k, o))
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  // 键盘移动时才把选中项滚进视野；鼠标悬停换选中不滚（否则列表会追着鼠标跑）
  // Scroll the selection into view only for keyboard moves; hover changes never scroll
  const kbd = useRef(false)

  useEffect(() => { inputRef.current?.focus() }, [])

  const items = useMemo<Item[]>(() => {
    const nq = norm(q)
    const hit = (...xs: (string | undefined)[]) => !nq || xs.some((x) => x && norm(x).includes(nq))
    const run = (fn: () => void) => () => { onClose(); fn() }
    const out: Item[] = []

    const syms = symbols.filter((s) => hit(s, displaySymbol(s)))
    // 精确命中的品种排第一 / an exact symbol match goes first
    syms.sort((a, b) => Number(norm(b) === nq) - Number(norm(a) === nq))
    for (const s of syms.slice(0, mode === 'symbols' ? 60 : nq ? 8 : 6)) {
      out.push({ key: `s:${s}`, group: 'symbols', label: s, sub: displaySymbol(s) !== s ? displaySymbol(s) : undefined, icon: <SymAvatar symbol={s} />, tag: s === activeSymbol ? tt('charts.pro.cmd.current') : undefined, run: run(() => onSymbol(s)) })
    }
    if (mode === 'symbols') return out

    // 周期：手敲的写法排在最前，然后是预设里匹配的 / typed form first, then matching presets
    const typed = nq ? normalizeIntervalInput(q.trim()) : null
    const ivs = new Set<string>()
    if (typed) ivs.add(typed)
    if (nq) {
      for (const g of INTERVAL_PRESETS) for (const c of g.codes) {
        if (hit(intervalLabel(c), tt(`charts.pro.cmd.ivGroup.${g.group}`))) ivs.add(c)
      }
    }
    for (const c of [...ivs].slice(0, 6)) {
      out.push({ key: `i:${c}`, group: 'intervals', label: intervalLabel(c), icon: <span className="pt-cmd-iv">{intervalLabel(c)}</span>, tag: c === interval ? tt('charts.pro.cmd.current') : undefined, run: run(() => onInterval(c)) })
    }

    if (nq) {
      let n = 0
      for (const id of IND_IDS) {
        const d = defOf(id)
        if (!d) continue
        const name = tt(`charts.ind.name.${id}`)
        if (!hit(name, d.abbr, id)) continue
        const locked = !!d.pro && !isPro
        out.push({ key: `n:${id}`, group: 'indicators', label: name, sub: d.abbr !== name ? d.abbr : undefined, icon: <IcFx size={15} />, tag: locked ? 'PRO' : undefined, run: run(() => onIndicator(id)) })
        if (++n >= 8) break
      }
    }

    for (const a of actions) {
      if (!hit(a.label)) continue
      out.push({ key: `a:${a.id}`, group: 'actions', label: a.label, icon: a.icon, hint: a.hint, run: run(a.run) })
    }
    return out
  // eslint-disable-next-line react-hooks/exhaustive-deps -- tt follows the language
  }, [q, mode, symbols, activeSymbol, interval, isPro, actions, onClose, onSymbol, onInterval, onIndicator, t])

  useEffect(() => { setSel(0) }, [q])
  const cur = Math.min(sel, Math.max(0, items.length - 1))

  useLayoutEffect(() => {
    if (!kbd.current) return
    kbd.current = false
    listRef.current?.querySelector<HTMLElement>(`[data-i="${cur}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [cur])

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (!items.length) return
      kbd.current = true
      setSel((i) => (Math.min(i, items.length - 1) + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      items[cur]?.run()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
  }

  let last: Group | null = null
  return (
    <div className="pt-cmd-ov" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="pt-cmd" role="dialog" aria-modal="true" aria-label={tt('charts.pro.cmd.open')} onKeyDown={onKey}>
        <div className="pt-cmd-in">
          <IcSearch size={17} />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={tt(mode === 'symbols' ? 'charts.pro.cmd.phSymbols' : 'charts.pro.cmd.ph')}
            role="combobox"
            aria-expanded="true"
            aria-controls="pt-cmd-list"
            aria-activedescendant={items[cur] ? `pt-cmd-${cur}` : undefined}
            autoComplete="off"
            spellCheck={false}
            enterKeyHint="go"
          />
          <kbd className="pt-cmd-esc">Esc</kbd>
        </div>
        <div ref={listRef} id="pt-cmd-list" className="pt-cmd-list no-sb" role="listbox">
          {items.length === 0 && (
            <p className="pt-cmd-none">{tt('charts.pro.cmd.none', { q: q.trim() })}</p>
          )}
          {items.map((it, i) => {
            const head = it.group !== last
            last = it.group
            return (
              <div key={it.key} role="presentation">
                {head && <p className="pt-cmd-cap" role="presentation">{tt(`charts.pro.cmd.g.${it.group}`)}</p>}
                <button
                  type="button"
                  id={`pt-cmd-${i}`}
                  data-i={i}
                  role="option"
                  aria-selected={i === cur}
                  className={`pt-cmd-item ${i === cur ? 'on' : ''}`}
                  onPointerMove={() => { if (i !== cur) setSel(i) }}
                  onClick={it.run}
                  tabIndex={-1}
                >
                  <span className="pt-cmd-ic">{it.icon}</span>
                  <span className="pt-cmd-tx">
                    <b>{it.label}</b>
                    {it.sub && <small>{it.sub}</small>}
                  </span>
                  {it.tag && <span className="pt-cmd-tag">{it.tag}</span>}
                  {it.hint && <kbd>{it.hint}</kbd>}
                  {i === cur && <IcReturn size={14} className="pt-cmd-ret" />}
                </button>
              </div>
            )
          })}
        </div>
        <div className="pt-cmd-ft" aria-hidden>
          <span><kbd>↑</kbd><kbd>↓</kbd>{tt('charts.pro.cmd.move')}</span>
          <span><kbd>↵</kbd>{tt('charts.pro.cmd.run')}</span>
          <span><kbd>Esc</kbd>{tt('charts.pro.cmd.close')}</span>
        </div>
      </div>
    </div>
  )
}
