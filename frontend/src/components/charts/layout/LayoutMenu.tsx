// 「图表布局」菜单（经典版桌面工具条、专业版顶栏共用）：网格选择、同步开关、已保存的布局（载入 /
// 重命名 / 复制 / 删除）、保存 / 另存为、自动保存开关。按钮图标画的是当前网格的样子。
// The "chart layout" menu (classic desktop toolbar and pro top bar): grid picker, sync switches, saved
// layouts (load / rename / copy / delete), save / save as, the autosave switch. The button's icon draws
// the current grid.
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import ChartPopover from '../ChartPopover'
import Switch from '../../Switch'
import { GRIDS, SYNC_KEYS, type GridId, type SyncFlags } from './layoutModel'
import type { ChartLayoutsApi } from './useChartLayouts'

// 网格小图标：24 格、圆头、描边 1.8，与图表页其它内联图标同一家族
// Grid glyph: 24 grid, round caps, 1.8 stroke — the same family as the page's other inline icons
export function GridIcon({ grid, size = 16 }: { grid: GridId; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      {(grid === '2h' || grid === '4') && <path d="M12 4.5v15" />}
      {(grid === '2v' || grid === '4') && <path d="M3.5 12h17" />}
      {grid === '3' && <path d="M13.5 4.5v15M13.5 12h7" />}
    </svg>
  )
}

const IcPen = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M4 20l4-1 10.5-10.5a2.1 2.1 0 00-3-3L5 16z" /></svg>
const IcCopy = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><rect x="8.5" y="8.5" width="11" height="11" rx="2" /><path d="M15.5 8.5V6a1.5 1.5 0 00-1.5-1.5H6A1.5 1.5 0 004.5 6v8A1.5 1.5 0 006 15.5h2.5" /></svg>
const IcTrash = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M4.5 7h15M10 11v6M14 11v6M6.5 7l1 12a1.5 1.5 0 001.5 1.4h6a1.5 1.5 0 001.5-1.4l1-12M9.5 7V5a1 1 0 011-1h3a1 1 0 011 1v2" /></svg>

interface Props {
  variant: 'classic' | 'pro'
  grid: GridId
  onGrid: (g: GridId) => void
  sync: SyncFlags
  onSync: (patch: Partial<SyncFlags>) => void
  api: ChartLayoutsApi
  onToast: (msg: string, kind: 'success' | 'error' | 'info') => void
}

export default function LayoutMenu({ variant, grid, onGrid, sync, onSync, api, onToast }: Props) {
  const { t } = useTranslation()
  const tt = (k: string, o?: Record<string, unknown>) => String(t(`charts.layout.${k}`, o))
  const btnRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [delId, setDelId] = useState<string | null>(null)
  const [newName, setNewName] = useState('')
  const { refresh } = api
  useEffect(() => {
    if (!open) { setEditId(null); setDelId(null); return }
    void refresh()
  }, [open, refresh])
  const label = tt('button')
  const single = grid === '1'

  const onRename = (e: FormEvent<HTMLFormElement>, id: string) => {
    e.preventDefault()
    const v = String(new FormData(e.currentTarget).get('name') ?? '')
    void api.rename(id, v).then((ok) => { if (ok) setEditId(null) })
  }
  const onSaveAs = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    void api.saveAs(newName).then((ok) => { if (ok) { setNewName(''); onToast(tt('savedToast'), 'success') } })
  }
  const status = api.saving ? tt('savingNow') : api.activeId && api.dirty ? tt('unsaved') : ''

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={variant === 'pro' ? `pt-icon ${open ? 'on' : ''}` : `term-tool-btn ${open ? 'on' : ''}`}
        title={label}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <GridIcon grid={grid} size={variant === 'pro' ? 17 : 15} />
      </button>
      <ChartPopover open={open} onClose={() => setOpen(false)} anchorRef={btnRef} width={292} label={label} className="cg-menu">
        <div className="chart-pop-body no-sb">
          <p className="chart-pop-sec">{tt('grid')}</p>
          <div className="cg-grids" role="radiogroup" aria-label={tt('grid')}>
            {GRIDS.map((g) => (
              <button key={g} type="button" role="radio" aria-checked={g === grid} className={g === grid ? 'on' : undefined} title={tt(`g${g}`)} aria-label={tt(`g${g}`)} onClick={() => onGrid(g)}>
                <GridIcon grid={g} size={20} />
              </button>
            ))}
          </div>

          <p className="chart-pop-sec">{tt('sync')}{single && <small className="cg-hint">{tt('syncHint')}</small>}</p>
          {SYNC_KEYS.map((k) => (
            <label key={k} className={`cg-row ${single ? 'dim' : ''}`}>
              <span>{tt(`s.${k}`)}</span>
              <Switch checked={sync[k]} onChange={(v) => onSync({ [k]: v })} aria-label={tt(`s.${k}`)} />
            </label>
          ))}

          <div className="chart-pop-sep" />
          <p className="chart-pop-sec cg-sec">
            <span>{tt('saved')}</span>
            {status && <small className="cg-hint">{status}</small>}
          </p>
          {api.list == null && api.loading && <p className="cg-empty">{tt('loading')}</p>}
          {api.list != null && api.list.length === 0 && <p className="cg-empty">{tt('none')}</p>}
          {(api.list ?? []).map((l) => {
            const on = l.id === api.activeId
            if (editId === l.id) {
              return (
                <form key={l.id} className="chart-iv-in cg-edit" onSubmit={(e) => onRename(e, l.id)}>
                  <input name="name" defaultValue={l.name} maxLength={60} autoFocus aria-label={tt('rename')} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setEditId(null) } }} />
                  <button type="submit">{tt('ok')}</button>
                </form>
              )
            }
            if (delId === l.id) {
              return (
                <div key={l.id} className="chart-pop-row cg-lrow cg-del">
                  <span className="cg-lname">{tt('confirmDelete', { name: l.name })}</span>
                  <button type="button" className="cg-mini danger" onClick={() => { void api.remove(l.id).then((ok) => { setDelId(null); if (ok) onToast(tt('deletedToast'), 'info') }) }}>{tt('delete')}</button>
                  <button type="button" className="cg-mini" onClick={() => setDelId(null)}>{tt('cancel')}</button>
                </div>
              )
            }
            return (
              <div key={l.id} className={`chart-pop-row cg-lrow ${on ? 'on' : ''}`}>
                <button type="button" className="chart-pop-item wide" onClick={() => { api.load(l.id); setOpen(false); onToast(tt('loadedToast', { name: l.name }), 'success') }}>
                  <span>{l.name}</span>
                  {on && <small>{tt('current')}</small>}
                </button>
                <button type="button" className="cg-ic" title={tt('rename')} aria-label={tt('rename')} onClick={() => setEditId(l.id)}><IcPen /></button>
                <button type="button" className="cg-ic" title={tt('copy')} aria-label={tt('copy')} onClick={() => { void api.copy(l.id) }}><IcCopy /></button>
                <button type="button" className="cg-ic" title={tt('delete')} aria-label={tt('delete')} onClick={() => setDelId(l.id)}><IcTrash /></button>
              </div>
            )
          })}

          <div className="cg-actions">
            <button type="button" className="cg-primary" disabled={api.saving} onClick={() => { void api.save().then((ok) => { if (ok) onToast(tt('savedToast'), 'success') }) }}>
              {api.activeId ? tt('save') : tt('saveNew')}
            </button>
          </div>
          <form className="chart-iv-in cg-saveas" onSubmit={onSaveAs}>
            <input value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={60} placeholder={tt('namePh')} aria-label={tt('namePh')} />
            <button type="submit" disabled={api.saving}>{tt('saveAs')}</button>
          </form>
          <label className="cg-row">
            <span>{tt('autosave')}<small>{tt('autosaveHint')}</small></span>
            <Switch checked={api.autosave} onChange={api.setAutosave} aria-label={tt('autosave')} />
          </label>
        </div>
      </ChartPopover>
    </>
  )
}
