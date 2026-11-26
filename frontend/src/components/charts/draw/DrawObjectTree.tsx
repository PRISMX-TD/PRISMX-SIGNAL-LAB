// 对象树：当前品种的全部画线（最上层的排在最前），点一下选中（Ctrl 多选）、双击改设置，
// 每行可显示 / 隐藏、锁定、上移 / 下移、删除。浮在图表右侧，不遮挡操作。
// Object tree: every drawing on this symbol (topmost first). Click selects (Ctrl adds), double-click
// opens settings; each row shows / hides, locks, moves up / down and deletes. Floats on the chart's right.
import { DrawToolIcon } from '../DrawToolsRow'
import type { Drawing } from './model'

interface Props {
  drawings: Drawing[]
  selected: string[]
  onSelect: (id: string, add: boolean) => void
  onPatch: (id: string, patch: Partial<Drawing>) => void
  onDelete: (id: string) => void
  onReorder: (id: string, how: 'up' | 'down') => void
  onSettings: (id: string) => void
  onClose: () => void
  // 停靠在专业版右栏（不浮在图上、没有关闭钮）/ docked in the pro right panel (not floating, no close button)
  docked?: boolean
  t: (k: string, o?: Record<string, unknown>) => unknown
}

const ico = (d: string) => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d={d} /></svg>
const EYE = 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8zM12 9a3 3 0 100 6 3 3 0 000-6z'
const EYE_OFF = 'M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19M1 1l22 22'
const LOCK = 'M5 11h14v10H5zM8 11V7a4 4 0 018 0v4'
const UNLOCK = 'M5 11h14v10H5zM8 11V7a4 4 0 017.8-1.2'

export default function DrawObjectTree({ drawings, selected, onSelect, onPatch, onDelete, onReorder, onSettings, onClose, docked = false, t }: Props) {
  const tt = (k: string, o?: Record<string, unknown>) => String(t(k, o))
  const rows = [...drawings].reverse()
  return (
    <div className={`draw-tree${docked ? ' docked' : ''}`} role={docked ? 'region' : 'dialog'} aria-label={tt('charts.draw.objectTree')} onPointerDown={(e) => e.stopPropagation()}>
      <div className="draw-tree-hd">
        <b>{tt('charts.draw.objectTree')}</b>
        <small>{drawings.length}</small>
        {!docked && <button type="button" className="draw-tree-x" onClick={onClose} aria-label={tt('common.close')}>{ico('M6 6l12 12M18 6L6 18')}</button>}
      </div>
      <div className="draw-tree-list no-sb">
        {rows.length === 0 && <p className="draw-tree-empty">{tt('charts.draw.treeEmpty')}</p>}
        {rows.map((d, i) => {
          const name = d.name || (d.text && d.type !== 'priceLabel' ? `${tt(`charts.draw.${d.type}`)} · ${d.text.slice(0, 18)}` : tt(`charts.draw.${d.type}`))
          return (
            <div key={d.id} className={`draw-tree-row ${selected.includes(d.id) ? 'on' : ''} ${d.hidden ? 'off' : ''}`}>
              <button type="button" className="draw-tree-name" onClick={(e) => onSelect(d.id, e.ctrlKey || e.metaKey || e.shiftKey)} onDoubleClick={() => onSettings(d.id)}>
                <span className="draw-tree-dot" style={{ color: d.color }}><DrawToolIcon tool={d.type} /></span>
                <span className="draw-tree-label">{name}</span>
              </button>
              <button type="button" className="draw-tree-act" disabled={i === 0} onClick={() => onReorder(d.id, 'up')} aria-label={tt('charts.draw.zUp')} title={tt('charts.draw.zUp')}>{ico('M12 19V5M5 12l7-7 7 7')}</button>
              <button type="button" className="draw-tree-act" disabled={i === rows.length - 1} onClick={() => onReorder(d.id, 'down')} aria-label={tt('charts.draw.zDown')} title={tt('charts.draw.zDown')}>{ico('M12 5v14M5 12l7 7 7-7')}</button>
              <button type="button" className={`draw-tree-act ${d.hidden ? 'warn' : ''}`} onClick={() => onPatch(d.id, { hidden: !d.hidden })} aria-label={tt(d.hidden ? 'charts.draw.show' : 'charts.draw.hide')} title={tt(d.hidden ? 'charts.draw.show' : 'charts.draw.hide')}>{ico(d.hidden ? EYE_OFF : EYE)}</button>
              <button type="button" className={`draw-tree-act ${d.locked ? 'warn' : ''}`} onClick={() => onPatch(d.id, { locked: !d.locked })} aria-label={tt(d.locked ? 'charts.draw.unlock' : 'charts.draw.lock')} title={tt(d.locked ? 'charts.draw.unlock' : 'charts.draw.lock')}>{ico(d.locked ? LOCK : UNLOCK)}</button>
              <button type="button" className="draw-tree-act danger" onClick={() => onDelete(d.id)} aria-label={tt('charts.draw.delete')} title={tt('charts.draw.delete')}>{ico('M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14')}</button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
