// 添加指标对话框：左栏分类（收藏、最近使用、七个内置分组、模板），右栏列表；搜索跨全部分类。
// 点一行就往图上加一个实例（同一种可以加很多次），行尾显示已加了几个；星标收藏。
// 模板页：内置模板、自己存的模板（应用 / 删除），以及「把当前这套存为模板」。
// 手机是贴底抽屉，分类变成顶部一排横向滑动的标签。portal 到 body（理由同其它全屏弹层）。
// Add-indicator dialog: categories on the left (favourites, recent, seven built-in groups,
// templates), the list on the right; search spans everything. A click adds an instance (any kind
// can be added many times) and the row shows how many are on the chart; stars mark favourites.
// The templates page lists built-ins and saved ones (apply / delete) and saves the current set.
// Phones get a bottom sheet with the categories as a horizontal strip. Portalled to body.
import { useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { useScrollLock } from '../../../utils/scrollLock'
import { useDialogA11y } from '../../../utils/useDialogA11y'
import { IND_GROUPS, IND_IDS, defOf, defaultInputs } from './registry'
import { BUILTIN_TEMPLATES, applyBuiltin, applyTemplate, templateOfLayout } from './store'
import { instArgs } from './style'
import { MAX_INSTANCES, type IndLayout } from './types'
import type { IndLayoutUpdate } from './useIndLayout'

type Cat = 'fav' | 'recent' | (typeof IND_GROUPS)[number] | 'tpl'

export default function IndicatorDialog({ layout, update, isPro, onAdd, onClose, closing = false }: {
  layout: IndLayout
  update: (u: IndLayoutUpdate) => void
  isPro: boolean
  onAdd: (type: string) => void
  onClose: () => void
  closing?: boolean
}) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [q, setQ] = useState('')
  const [cat, setCat] = useState<Cat>(() => (layout.favs.length ? 'fav' : 'ma'))
  const [tplName, setTplName] = useState('')
  const [flash, setFlash] = useState<string | null>(null)
  const flashTimer = useRef<number>()
  useScrollLock(!closing)
  const dlgRef = useRef<HTMLDivElement>(null)
  useDialogA11y(dlgRef, onClose, { initialFocus: 'container', open: !closing })

  const name = (id: string) => String(t(`charts.ind.name.${id}`))
  const desc = (id: string) => String(t(`charts.ind.desc.${id}`))
  const counts = useMemo(() => {
    const m = new Map<string, number>()
    for (const i of layout.list) m.set(i.type, (m.get(i.type) ?? 0) + 1)
    return m
  }, [layout.list])
  const query = q.trim().toLowerCase()
  const ids = useMemo(() => {
    if (query) return IND_IDS.filter((id) => {
      const d = defOf(id)!
      return d.abbr.toLowerCase().includes(query) || name(id).toLowerCase().includes(query) || id.includes(query) || desc(id).toLowerCase().includes(query)
    })
    if (cat === 'fav') return layout.favs
    if (cat === 'recent') return layout.recent
    if (cat === 'tpl') return []
    return IND_IDS.filter((id) => defOf(id)!.group === cat)
  // eslint-disable-next-line react-hooks/exhaustive-deps -- name/desc follow t
  }, [query, cat, layout.favs, layout.recent, t])

  const full = layout.list.length >= MAX_INSTANCES
  // 要加的和图上某一条参数完全一样（同种、同输入）：先在那一行下面问一句，确认了才加
  // Adding one identical to an existing instance (same kind, same inputs): ask under that row first
  const [dup, setDup] = useState<{ id: string; label: string } | null>(null)
  const add = (id: string, force = false) => {
    const d = defOf(id)
    if (!d) return
    if (d.pro && !isPro) { onClose(); navigate('/upgrade'); return }
    if (full) return
    if (!force) {
      const want: Record<string, unknown> = { ...defaultInputs(d), ...(layout.defaults[id]?.inputs ?? {}) }
      const twin = layout.list.find((i) => i.type === id && Object.keys(want).every((k) => i.inputs[k] === want[k]))
      if (twin) {
        const args = instArgs(d, twin, (v) => (v.startsWith('ind:') ? '' : String(t(`charts.ind.src.${v}`))), true)
        setDup({ id, label: args ? `${d.abbr} ${args}` : d.abbr })
        return
      }
    }
    setDup(null)
    onAdd(id)
    setFlash(id)
    window.clearTimeout(flashTimer.current)
    flashTimer.current = window.setTimeout(() => setFlash(null), 900)
  }
  const toggleFav = (id: string) => update((l) => ({ ...l, favs: l.favs.includes(id) ? l.favs.filter((x) => x !== id) : [...l.favs, id] }))

  const cats: Cat[] = ['fav', 'recent', ...IND_GROUPS, 'tpl']
  const catLabel = (c: Cat) => String(t(`charts.ind.grp.${c}`))

  const star = (on: boolean) => (
    <svg width="15" height="15" viewBox="0 0 24 24" fill={on ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
      <path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8L3.5 9.7l5.9-.9z" />
    </svg>
  )

  return createPortal(
    <div className={`ind-overlay${closing ? ' closing' : ''}`} onClick={onClose}>
      <div ref={dlgRef} className="ind-dlg indx" role="dialog" aria-modal="true" aria-label={String(t('charts.ind.ui.title'))} tabIndex={-1} onClick={(e) => e.stopPropagation()}>
        <div className="ind-hd">
          <h3>{t('charts.ind.ui.title')}</h3>
          <span className="ind-n">{t('charts.ind.ui.onChart', { n: layout.list.length })}</span>
          <div className="ind-srch">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4-4" /></svg>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={String(t('charts.ind.ui.search'))} aria-label={String(t('charts.ind.ui.search'))} />
          </div>
          <button type="button" className="ind-close" onClick={onClose} aria-label={String(t('common.close'))}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
          </button>
        </div>

        <nav className="indx-cats no-sb" aria-label={String(t('charts.ind.ui.categories'))}>
          {cats.map((c) => (
            <button key={c} type="button" className={!query && cat === c ? 'on' : ''} aria-current={!query && cat === c} onClick={() => { setCat(c); setQ('') }}>
              {catLabel(c)}
              {c === 'fav' && layout.favs.length > 0 && <span>{layout.favs.length}</span>}
            </button>
          ))}
        </nav>

        <div className="indx-main">
          {!query && cat === 'tpl' ? (
            <div className="indx-tpl no-sb">
              <div className="indx-k">{t('charts.ind.ui.tplMine')}</div>
              <form className="indx-tplsave" onSubmit={(e) => {
                e.preventDefault()
                const nm = tplName.trim()
                if (!nm || layout.list.length === 0) return
                update((l) => ({ ...l, tpls: [...l.tpls.filter((x) => x.name !== nm), templateOfLayout(l, nm)].slice(-20) }))
                setTplName('')
              }}>
                <input className="ind-in" value={tplName} maxLength={40} onChange={(e) => setTplName(e.target.value)} placeholder={String(t('charts.ind.ui.tplName'))} aria-label={String(t('charts.ind.ui.tplName'))} />
                <button type="submit" className="ind-btn" disabled={!tplName.trim() || layout.list.length === 0}>{t('charts.ind.ui.tplSave')}</button>
              </form>
              {layout.tpls.length === 0 && <p className="indx-empty">{t('charts.ind.ui.tplNone')}</p>}
              {layout.tpls.map((tp) => (
                <div key={tp.name} className="indx-trow">
                  <button type="button" className="indx-tapply" onClick={() => { update((l) => applyTemplate(l, tp)); onClose() }}>
                    <b>{tp.name}</b>
                    <span>{tp.list.map((i) => defOf(i.type)?.abbr).filter(Boolean).join(' · ')}</span>
                  </button>
                  <button type="button" className="ind-x" aria-label={String(t('charts.ind.ui.tplDelete'))} onClick={() => update((l) => ({ ...l, tpls: l.tpls.filter((x) => x.name !== tp.name) }))}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
                  </button>
                </div>
              ))}
              <div className="indx-k">{t('charts.ind.ui.tplBuiltin')}</div>
              {BUILTIN_TEMPLATES.map((tp) => (
                <div key={tp.id} className="indx-trow">
                  <button type="button" className="indx-tapply" onClick={() => { update((l) => applyBuiltin(l, tp.types)); onClose() }}>
                    <b>{t(`charts.ind.tpl.${tp.id}`)}</b>
                    <span>{tp.types.map((x) => defOf(x)?.abbr).join(' · ')}</span>
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div className="ind-list no-sb" role="list">
              {!query && cat === 'custom' && <p className="ind-disc">{t('charts.indicators.customDisclaimer')}</p>}
              {ids.length === 0 && (
                <p className="indx-empty">{t(query ? 'charts.ind.ui.noMatch' : cat === 'fav' ? 'charts.ind.ui.noFav' : 'charts.ind.ui.noRecent')}</p>
              )}
              {ids.map((id) => {
                const d = defOf(id)
                if (!d) return null
                const n = counts.get(id) ?? 0
                const locked = d.pro && !isPro
                return (
                  <div key={id} role="listitem" className={`ind-it indx-it ${n ? 'on' : ''} ${flash === id ? 'flash' : ''}`}>
                    <button type="button" className="indx-add" onClick={() => add(id)} disabled={full && !locked} title={full ? String(t('charts.ind.ui.limit', { n: MAX_INSTANCES })) : undefined}>
                      <span className="ind-ab">{d.abbr.length > 5 ? d.abbr.slice(0, 4) : d.abbr}</span>
                      <span className="ind-txt">
                        <span className="nm">{name(id)}{d.pro && <span className="ind-tag">PRO</span>}{query && <span className="indx-g">{catLabel(d.group)}</span>}</span>
                        <span className="ds">{desc(id)}</span>
                      </span>
                      {n > 0 && <span className="indx-n" aria-label={String(t('charts.ind.ui.addedN', { n }))}>{n}</span>}
                    </button>
                    <button type="button" className={`indx-star ${layout.favs.includes(id) ? 'on' : ''}`} aria-pressed={layout.favs.includes(id)}
                      aria-label={String(t(layout.favs.includes(id) ? 'charts.ind.ui.unfav' : 'charts.ind.ui.fav'))} onClick={() => toggleFav(id)}>
                      {star(layout.favs.includes(id))}
                    </button>
                    {dup?.id === id && (
                      <div className="indx-dup" role="alert">
                        <span>{t('charts.ind.ui.dupAsk', { name: dup.label })}</span>
                        <button type="button" className="ind-btn" onClick={() => setDup(null)}>{t('charts.ind.ui.dupCancel')}</button>
                        <button type="button" className="ind-btn primary" onClick={() => add(id, true)}>{t('charts.ind.ui.dupAdd')}</button>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
