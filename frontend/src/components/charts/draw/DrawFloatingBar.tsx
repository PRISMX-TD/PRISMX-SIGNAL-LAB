// 选中画线时浮在图表上方的快捷栏：颜色、线宽、线型、设置、锁定、克隆、更多（叠放 / 隐藏 / 对象树）、删除。
// 多选时改的是全部选中项。
// Quick bar floating over the chart while drawings are selected: colour, width, style, settings,
// lock, clone, more (z-order / hide / object tree), delete. With a multi-selection it edits them all.
import { useRef, useState } from 'react'
import ChartPopover from '../ChartPopover'
import { type Drawing, type LineStyle, PALETTE, LINE_WIDTHS } from './model'

interface Props {
  drawings: Drawing[]
  onPatch: (patch: Partial<Drawing>) => void
  onSettings: () => void
  onToggleLock: () => void
  onClone: () => void
  onDelete: () => void
  onReorder: (how: 'front' | 'back' | 'up' | 'down') => void
  onHide: () => void
  onTree: () => void
  // 多空仓位工具：转成图上投影单 / long / short tool: turn into a projected order
  onToOrder?: () => void
  // 给这条画线添加警报（阶段 5；只有线类画线有）/ add an alert on this drawing (phase 5; line-type drawings only)
  onAlert?: () => void
  t: (k: string, o?: Record<string, unknown>) => unknown
}

const I = {
  gear: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z" /></svg>,
  lock: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 018 0v4" /></svg>,
  unlock: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 017.8-1.2" /></svg>,
  clone: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><rect x="8" y="8" width="13" height="13" rx="2" /><path d="M16 8V5a2 2 0 00-2-2H5a2 2 0 00-2 2v9a2 2 0 002 2h3" /></svg>,
  more: <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden><circle cx="5" cy="12" r="1.7" /><circle cx="12" cy="12" r="1.7" /><circle cx="19" cy="12" r="1.7" /></svg>,
  trash: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" /></svg>,
}

export function StyleGlyph({ s, w = 18 }: { s: LineStyle; w?: number }) {
  return (
    <svg width={w} height="8" viewBox={`0 0 ${w} 8`} aria-hidden>
      <line x1="1" y1="4" x2={w - 1} y2="4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeDasharray={s === 'dashed' ? '5 3' : s === 'dotted' ? '1 3' : undefined} />
    </svg>
  )
}

export function ColorGrid({ value, onPick, t }: { value: string; onPick: (c: string) => void; t: Props['t'] }) {
  return (
    <div className="draw-palette">
      <div className="draw-palette-grid">
        {PALETTE.map((c) => (
          <button key={c} type="button" className={`draw-swatch ${value.toLowerCase() === c ? 'on' : ''}`} style={{ background: c }} onClick={() => onPick(c)} aria-label={c} aria-pressed={value.toLowerCase() === c} />
        ))}
      </div>
      <label className="draw-palette-custom">
        <input type="color" value={/^#[0-9a-f]{6}$/i.test(value) ? value : '#22d3ee'} onChange={(e) => onPick(e.target.value)} />
        <span>{String(t('charts.draw.customColor'))}</span>
      </label>
    </div>
  )
}

export default function DrawFloatingBar({ drawings, onPatch, onSettings, onToggleLock, onClone, onDelete, onReorder, onHide, onTree, onToOrder, onAlert, t }: Props) {
  const [menu, setMenu] = useState<'color' | 'width' | 'style' | 'more' | null>(null)
  const colorRef = useRef<HTMLButtonElement>(null)
  const widthRef = useRef<HTMLButtonElement>(null)
  const styleRef = useRef<HTMLButtonElement>(null)
  const moreRef = useRef<HTMLButtonElement>(null)
  const first = drawings[0]
  const allLocked = drawings.every((d) => d.locked)
  const linear = drawings.some((d) => d.type !== 'text' && d.type !== 'priceLabel' && d.type !== 'long' && d.type !== 'short')
  const width = first.lineWidth ?? 1
  const style = first.lineStyle ?? 'solid'
  const close = () => setMenu(null)
  const tt = (k: string) => String(t(k))

  return (
    <div className="draw-fbar" role="toolbar" aria-label={tt('charts.draw.quickBar')} onPointerDown={(e) => e.stopPropagation()}>
      {drawings.length > 1 && <span className="draw-fbar-count">{drawings.length}</span>}
      <button ref={colorRef} type="button" className="draw-fbar-btn" title={tt('charts.draw.color')} aria-label={tt('charts.draw.color')} onClick={() => setMenu(menu === 'color' ? null : 'color')}>
        <span className="draw-fbar-swatch" style={{ background: first.color }} />
      </button>
      {linear && (
        <>
          <button ref={widthRef} type="button" className="draw-fbar-btn" title={tt('charts.draw.width')} aria-label={tt('charts.draw.width')} onClick={() => setMenu(menu === 'width' ? null : 'width')}>
            <span className="draw-fbar-w" style={{ height: width }} /><small>{width}px</small>
          </button>
          <button ref={styleRef} type="button" className="draw-fbar-btn" title={tt('charts.draw.style')} aria-label={tt('charts.draw.style')} onClick={() => setMenu(menu === 'style' ? null : 'style')}>
            <StyleGlyph s={style} />
          </button>
        </>
      )}
      {onToOrder && (
        <button type="button" className="draw-fbar-btn draw-fbar-order" title={tt('charts.trade.toOrder')} aria-label={tt('charts.trade.toOrder')} onClick={onToOrder}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M4 12h12M12 6l6 6-6 6" /><path d="M20 5v14" /></svg>
          <small>{tt('charts.trade.toOrderShort')}</small>
        </button>
      )}
      {onAlert && (
        <button type="button" className="draw-fbar-btn" title={tt('charts.alert.addOnDrawing')} aria-label={tt('charts.alert.addOnDrawing')} onClick={onAlert}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M6 16V11a6 6 0 0112 0v5l2 2H4z" /><path d="M10 21h4" /></svg>
        </button>
      )}
      <span className="draw-fbar-sep" />
      {drawings.length === 1 && (
        <button type="button" className="draw-fbar-btn" title={tt('charts.draw.settings')} aria-label={tt('charts.draw.settings')} onClick={onSettings}>{I.gear}</button>
      )}
      <button type="button" className={`draw-fbar-btn ${allLocked ? 'on' : ''}`} title={tt(allLocked ? 'charts.draw.unlock' : 'charts.draw.lock')} aria-label={tt(allLocked ? 'charts.draw.unlock' : 'charts.draw.lock')} aria-pressed={allLocked} onClick={onToggleLock}>{allLocked ? I.lock : I.unlock}</button>
      <button type="button" className="draw-fbar-btn" title={tt('charts.draw.clone')} aria-label={tt('charts.draw.clone')} onClick={onClone}>{I.clone}</button>
      <button ref={moreRef} type="button" className="draw-fbar-btn" title={tt('charts.draw.more')} aria-label={tt('charts.draw.more')} onClick={() => setMenu(menu === 'more' ? null : 'more')}>{I.more}</button>
      <button type="button" className="draw-fbar-btn danger" title={tt('charts.draw.delete')} aria-label={tt('charts.draw.delete')} onClick={onDelete}>{I.trash}</button>

      <ChartPopover open={menu === 'color'} onClose={close} anchorRef={colorRef} width={196} label={tt('charts.draw.color')}>
        <ColorGrid value={first.color} onPick={(c) => onPatch({ color: c })} t={t} />
      </ChartPopover>
      <ChartPopover open={menu === 'width'} onClose={close} anchorRef={widthRef} width={120} label={tt('charts.draw.width')}>
        {LINE_WIDTHS.map((w) => (
          <button key={w} type="button" className={`chart-pop-item ${width === w ? 'on' : ''}`} onClick={() => { onPatch({ lineWidth: w }); close() }}>
            <span className="draw-fbar-w" style={{ height: w, width: 36 }} /><span>{w}px</span>
          </button>
        ))}
      </ChartPopover>
      <ChartPopover open={menu === 'style'} onClose={close} anchorRef={styleRef} width={140} label={tt('charts.draw.style')}>
        {(['solid', 'dashed', 'dotted'] as const).map((s) => (
          <button key={s} type="button" className={`chart-pop-item ${style === s ? 'on' : ''}`} onClick={() => { onPatch({ lineStyle: s }); close() }}>
            <StyleGlyph s={s} w={36} /><span>{tt(`charts.draw.${s}`)}</span>
          </button>
        ))}
      </ChartPopover>
      <ChartPopover open={menu === 'more'} onClose={close} anchorRef={moreRef} width={168} align="end" label={tt('charts.draw.more')}>
        <button type="button" className="chart-pop-item" onClick={() => { onReorder('front'); close() }}>{tt('charts.draw.zFront')}</button>
        <button type="button" className="chart-pop-item" onClick={() => { onReorder('up'); close() }}>{tt('charts.draw.zUp')}</button>
        <button type="button" className="chart-pop-item" onClick={() => { onReorder('down'); close() }}>{tt('charts.draw.zDown')}</button>
        <button type="button" className="chart-pop-item" onClick={() => { onReorder('back'); close() }}>{tt('charts.draw.zBack')}</button>
        <div className="chart-pop-sep" />
        <button type="button" className="chart-pop-item" onClick={() => { onHide(); close() }}>{tt('charts.draw.hide')}</button>
        <button type="button" className="chart-pop-item" onClick={() => { onTree(); close() }}>{tt('charts.draw.objectTree')}</button>
      </ChartPopover>
    </div>
  )
}
