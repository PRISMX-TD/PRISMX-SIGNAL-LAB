// 指标图例（每个窗格一块，每个实例一行）与窗格按钮。
// 行：名字 + 参数 + 各条线的当前值（同线色）；悬停（手机点一下）出现 隐藏 / 设置 / 删除 / 更多。
// 「更多」：复制、移到主图 / 上下窗格 / 新窗格、价格轴、存为默认、删除。按住名字拖到别的窗格 = 移过去。
// 窗格按钮（副图右上角）：上移、下移、最大化 / 还原、折叠 / 展开、删除窗格；主图有副图时只给最大化。
// Indicator legends (one block per pane, one row per instance) and pane buttons.
// A row: name + arguments + each plot's value in its colour; hover (tap on phones) reveals hide /
// settings / remove / more. "More": duplicate, move to main / adjacent / new pane, price scale,
// save as default, remove. Dragging the name onto another pane moves it there.
// Pane buttons (top-right of a sub-pane): up, down, maximise / restore, collapse / expand,
// delete; the main pane only gets maximise when sub-panes exist.
import { memo, useEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useLegend, type LegendStore } from '../legendStore'
import type { CandleColors } from '../chartConfig'
import type { PaneBoxes } from '../useChartEngine'
import { EMPTY } from '../../../utils/format'
import { defOf } from './registry'
import { instArgs, plotStyle, resolveColor } from './style'
import type { IndDef, IndInstance, IndLayout, ScalePin } from './types'

export interface LegendActions {
  toggleHidden: (uid: string) => void
  settings: (uid: string) => void
  remove: (uid: string) => void
  duplicate: (uid: string) => void
  moveTo: (uid: string, target: { pane: string } | { newPaneAt: number }) => void
  scale: (uid: string, pin: ScalePin) => void
  saveDefault: (uid: string) => void
  paneMove: (id: string, dir: -1 | 1) => void
  paneMax: (id: string | null) => void
  paneCollapse: (id: string, collapsed: boolean) => void
  paneRemove: (id: string) => void
}

function fmtVal(v: number | null | undefined, def: IndDef, inst: IndInstance, digits: number): string {
  if (v == null || !Number.isFinite(v)) return EMPTY
  if (inst.precision != null) return v.toFixed(inst.precision)
  if (def.digits === 'volume' || def.digits === 0) {
    const a = Math.abs(v)
    if (a >= 1e9) return `${(v / 1e9).toFixed(2)}B`
    if (a >= 1e6) return `${(v / 1e6).toFixed(2)}M`
    if (a >= 1e4) return `${(v / 1e3).toFixed(1)}K`
    return Math.round(v).toLocaleString()
  }
  return v.toFixed(typeof def.digits === 'number' ? def.digits : digits)
}

const I = {
  eye: <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12zm10 3a3 3 0 100-6 3 3 0 000 6z" />,
  eyeOff: <path d="M3 3l18 18M10.6 5.1A10 10 0 0112 5c6.4 0 10 7 10 7a17 17 0 01-3.1 3.9M6.6 6.6C3.8 8.5 2 12 2 12s3.6 7 10 7a9.6 9.6 0 004.2-1M9.9 9.9a3 3 0 004.2 4.2" />,
  gear: <path d="M12 15a3 3 0 100-6 3 3 0 000 6zm7.4-3a7.4 7.4 0 00-.1-1.2l2-1.6-2-3.4-2.4 1a7.6 7.6 0 00-2-1.2L14.5 3h-5l-.4 2.6a7.6 7.6 0 00-2 1.2l-2.4-1-2 3.4 2 1.6a7.4 7.4 0 000 2.4l-2 1.6 2 3.4 2.4-1a7.6 7.6 0 002 1.2l.4 2.6h5l.4-2.6a7.6 7.6 0 002-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2z" />,
  x: <path d="M18 6L6 18M6 6l12 12" />,
  more: <path d="M5 12h.01M12 12h.01M19 12h.01" strokeWidth="3" />,
  up: <path d="M6 15l6-6 6 6" />,
  down: <path d="M6 9l6 6 6-6" />,
  max: <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />,
  restore: <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" />,
  collapse: <path d="M5 12h14" />,
  expand: <path d="M5 8h14v8H5z" />,
}
// 主图指标图例收起与否：每个看图的人自己的习惯，存本机（读写失败就当展开）
// Whether the main legend is folded: a per-viewer habit kept in this browser (read/write failures mean unfolded)
const FOLD_KEY = 'prismx_indl_fold'
const readFold = () => { try { return localStorage.getItem(FOLD_KEY) === '1' } catch { return false } }
const writeFold = (v: boolean) => { try { localStorage.setItem(FOLD_KEY, v ? '1' : '0') } catch { /* 无痕模式等 / private mode etc. */ } }

const Ico = ({ d }: { d: JSX.Element }) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{d}</svg>
)

function PaneLegends({ layout, list, boxes, legendStore, digits, candle, axisW, maxPane, actions, showRows }: {
  layout: IndLayout
  // 实际画在图上的实例（会员过滤后）/ instances actually drawn (after the membership filter)
  list: IndInstance[]
  boxes: PaneBoxes
  legendStore: LegendStore
  digits: number
  candle: CandleColors
  // 右侧价格轴宽度，窗格按钮贴在它左边 / right price-axis width; pane buttons sit left of it
  axisW: number
  maxPane: string | null
  actions: LegendActions
  // 设置里关掉「指标图例」时只留窗格按钮 / with the legend switched off only pane buttons remain
  showRows: boolean
}) {
  const { t } = useTranslation()
  const legend = useLegend(legendStore)
  const [active, setActive] = useState<string | null>(null)
  const [menu, setMenu] = useState<string | null>(null)
  const [drag, setDrag] = useState<{ uid: string; y: number; target: string | null } | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const [fold, setFoldState] = useState(readFold)
  const setFold = (v: boolean) => { setFoldState(v); writeFold(v) }

  useEffect(() => {
    if (!menu && !active) return
    const onDown = (e: PointerEvent) => {
      const el = e.target as HTMLElement
      if (el.closest('.indl-menu') || el.closest('.indl-row')) return
      setMenu(null)
      setActive(null)
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [menu, active])

  const paneIds = ['main', ...layout.panes.filter((p) => boxes[p.id]).map((p) => p.id)]
  const paneAt = (y: number): string | null => {
    for (const id of paneIds) { const b = boxes[id]; if (b && y >= b.top && y < b.top + b.height) return id }
    return null
  }
  const srcName = (v: string) => {
    if (!v.startsWith('ind:')) return String(t(`charts.ind.src.${v}`))
    const ref = list.find((i) => i.uid === v.split(':')[1])
    return ref ? defOf(ref.type)?.abbr ?? '' : ''
  }

  // 按住名字拖到别的窗格 / drag a name onto another pane
  const startDrag = (e: RPointerEvent, uid: string) => {
    if (e.button !== 0) return
    const host = rootRef.current?.parentElement
    if (!host) return
    const top = host.getBoundingClientRect().top
    const y0 = e.clientY
    let moving = false
    const move = (ev: PointerEvent) => {
      if (!moving && Math.abs(ev.clientY - y0) < 6) return
      moving = true
      const y = ev.clientY - top
      setDrag({ uid, y, target: paneAt(y) })
    }
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      if (!moving) return
      setDrag(null)
      const y = ev.clientY - top
      const target = paneAt(y)
      const inst = list.find((i) => i.uid === uid)
      if (!inst) return
      const last = paneIds[paneIds.length - 1]
      const lb = boxes[last]
      // 拖到最下面窗格的底边以下 → 新窗格 / below the last pane's bottom edge → a new pane
      if (!target && lb && y >= lb.top + lb.height - 2) actions.moveTo(uid, { newPaneAt: layout.panes.length })
      else if (target && target !== inst.pane) actions.moveTo(uid, { pane: target })
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const row = (inst: IndInstance) => {
    const def = defOf(inst.type)
    if (!def) return null
    const vals = legend[inst.uid] ?? {}
    const args = instArgs(def, inst, srcName)
    const tf = inst.tf ? ` · ${inst.tf}` : ''
    const on = active === inst.uid || menu === inst.uid
    const idx = paneIds.indexOf(inst.pane)
    return (
      <div key={inst.uid} className={`indl-row ${inst.hidden ? 'off' : ''} ${on ? 'on' : ''} ${drag?.uid === inst.uid ? 'dragging' : ''}`}
        onClick={() => setActive((a) => (a === inst.uid ? null : inst.uid))}
        onDoubleClick={() => actions.settings(inst.uid)}>
        <span className="indl-nm" onPointerDown={(e) => startDrag(e, inst.uid)} title={String(t('charts.ind.ui.dragHint'))}>
          {def.abbr}{args && <span className="indl-args"> {args}</span>}{tf}
        </span>
        {!inst.hidden && def.plots.filter((p) => !p.noLegend).map((p) => {
          const st = plotStyle(inst, p)
          if (!st.visible) return null
          const v = vals[p.key]
          // 多色线 / 柱：值的颜色跟正负走 / multi-colour plots tint by sign
          const color = p.colors ? resolveColor(v != null && v < 0 ? st.colors[st.colors.length - 1] : st.colors[0], candle) : resolveColor(st.color, candle)
          if (p.gaps && v == null) return null
          return <span key={p.key} className="indl-v" style={{ color }}>{fmtVal(v, def, inst, digits)}</span>
        })}
        <span className="indl-btns" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
          <button type="button" aria-label={String(t(inst.hidden ? 'charts.ind.ui.show' : 'charts.ind.ui.hide'))} onClick={() => actions.toggleHidden(inst.uid)}><Ico d={inst.hidden ? I.eyeOff : I.eye} /></button>
          <button type="button" aria-label={String(t('charts.ind.ui.settings'))} onClick={() => actions.settings(inst.uid)}><Ico d={I.gear} /></button>
          <button type="button" aria-label={String(t('charts.ind.ui.remove'))} onClick={() => actions.remove(inst.uid)}><Ico d={I.x} /></button>
          <button type="button" aria-label={String(t('charts.ind.ui.more'))} aria-expanded={menu === inst.uid} onClick={() => setMenu((m) => (m === inst.uid ? null : inst.uid))}><Ico d={I.more} /></button>
        </span>
        {menu === inst.uid && (
          <span className="indl-menu" role="menu" onClick={(e) => e.stopPropagation()}>
            {(() => {
              const go = (fn: () => void) => () => { fn(); setMenu(null); setActive(null) }
              const pin = inst.scale ?? (inst.pane === 'main' && !def.overlay ? 'none' : 'right')
              const items: JSX.Element[] = [
                <button key="set" type="button" role="menuitem" onClick={go(() => actions.settings(inst.uid))}>{t('charts.ind.ui.settings')}…</button>,
                <button key="dup" type="button" role="menuitem" onClick={go(() => actions.duplicate(inst.uid))}>{t('charts.ind.ui.duplicate')}</button>,
              ]
              if (def.plots.length > 0) {
                items.push(<span key="s1" className="indl-sep" />)
                if (inst.pane !== 'main') items.push(<button key="mm" type="button" role="menuitem" onClick={go(() => actions.moveTo(inst.uid, { pane: 'main' }))}>{t('charts.ind.ui.moveMain')}</button>)
                if (idx > 1) items.push(<button key="mu" type="button" role="menuitem" onClick={go(() => actions.moveTo(inst.uid, { pane: paneIds[idx - 1] }))}>{t('charts.ind.ui.movePaneUp')}</button>)
                if (idx >= 0 && idx < paneIds.length - 1) items.push(<button key="md" type="button" role="menuitem" onClick={go(() => actions.moveTo(inst.uid, { pane: paneIds[idx + 1] }))}>{t('charts.ind.ui.movePaneDown')}</button>)
                const at = inst.pane === 'main' ? 0 : layout.panes.findIndex((p) => p.id === inst.pane)
                if (inst.pane !== 'main') items.push(<button key="na" type="button" role="menuitem" onClick={go(() => actions.moveTo(inst.uid, { newPaneAt: at }))}>{t('charts.ind.ui.moveNewAbove')}</button>)
                items.push(<button key="nb" type="button" role="menuitem" onClick={go(() => actions.moveTo(inst.uid, { newPaneAt: inst.pane === 'main' ? 0 : at + 1 }))}>{t('charts.ind.ui.moveNewBelow')}</button>)
                items.push(<span key="s2" className="indl-sep" />)
                for (const s of ['right', 'left', 'none'] as const) {
                  items.push(<button key={`p${s}`} type="button" role="menuitemradio" aria-checked={pin === s} className={pin === s ? 'chk' : ''} onClick={go(() => actions.scale(inst.uid, s))}>{t(`charts.ind.ui.scale_${s}`)}</button>)
                }
              }
              items.push(<span key="s3" className="indl-sep" />)
              items.push(<button key="def" type="button" role="menuitem" onClick={go(() => actions.saveDefault(inst.uid))}>{t('charts.ind.ui.saveDefault')}</button>)
              items.push(<button key="rm" type="button" role="menuitem" className="danger" onClick={go(() => actions.remove(inst.uid))}>{t('charts.ind.ui.remove')}</button>)
              return items
            })()}
          </span>
        )}
      </div>
    )
  }

  const subs = layout.panes.filter((p) => boxes[p.id])
  // 某行按钮展开时让出该窗格的窗格按钮（手机上两者会叠在同一行）
  // While a row shows its buttons, hide that pane's buttons (they overlap on phones)
  const busyPane = list.find((i) => i.uid === active || i.uid === menu)?.pane ?? null
  return (
    <div ref={rootRef} className="indl-root">
      {showRows && (() => {
        const mains = list.filter((i) => i.pane === 'main' || !boxes[i.pane])
        if (mains.length === 0) return null
        const label = String(t(fold ? 'charts.ind.ui.legendExpand' : 'charts.ind.ui.legendCollapse'))
        return (
          <div className="term-legend main indl">
            {!fold && mains.map(row)}
            {/* 收起 / 展开主图的指标行（收起时显示个数）/ fold or unfold the main pane's rows (the count shows while folded) */}
            <button type="button" className={`indl-fold ${fold ? 'folded' : ''}`} aria-expanded={!fold} aria-label={label} title={label} onClick={() => setFold(!fold)}>
              <Ico d={fold ? I.down : I.up} />
              {fold && <span>{mains.length}</span>}
            </button>
          </div>
        )
      })()}
      {subs.map((p, k) => {
        const b = boxes[p.id]
        const collapsed = !!p.collapsed && maxPane !== p.id
        return (
          <div key={p.id}>
            {showRows && (
              <div className="term-legend indl" style={{ left: 12, top: b.top + 5 }}>
                {list.filter((i) => i.pane === p.id).map(row)}
              </div>
            )}
            {busyPane !== p.id && <div className="indl-pane" style={{ top: b.top + 4, right: axisW + 6 }}>
              <button type="button" disabled={k === 0} aria-label={String(t('charts.ind.ui.paneUp'))} onClick={() => actions.paneMove(p.id, -1)}><Ico d={I.up} /></button>
              <button type="button" disabled={k === subs.length - 1} aria-label={String(t('charts.ind.ui.paneDown'))} onClick={() => actions.paneMove(p.id, 1)}><Ico d={I.down} /></button>
              <button type="button" aria-label={String(t(maxPane === p.id ? 'charts.ind.ui.restore' : 'charts.ind.ui.maximize'))} onClick={() => actions.paneMax(maxPane === p.id ? null : p.id)}><Ico d={maxPane === p.id ? I.restore : I.max} /></button>
              {!maxPane && <button type="button" aria-label={String(t(collapsed ? 'charts.ind.ui.expand' : 'charts.ind.ui.collapse'))} onClick={() => actions.paneCollapse(p.id, !collapsed)}><Ico d={collapsed ? I.expand : I.collapse} /></button>}
              <button type="button" aria-label={String(t('charts.ind.ui.paneRemove'))} onClick={() => actions.paneRemove(p.id)}><Ico d={I.x} /></button>
            </div>}
          </div>
        )
      })}
      {subs.length > 0 && boxes.main && (
        <div className="indl-pane main" style={{ top: boxes.main.top + boxes.main.height - 30, right: axisW + 6 }}>
          <button type="button" aria-label={String(t(maxPane === 'main' ? 'charts.ind.ui.restore' : 'charts.ind.ui.maximize'))} onClick={() => actions.paneMax(maxPane === 'main' ? null : 'main')}><Ico d={maxPane === 'main' ? I.restore : I.max} /></button>
        </div>
      )}
      {drag && (() => {
        const b = drag.target ? boxes[drag.target] : null
        const last = boxes[paneIds[paneIds.length - 1]]
        const box = b ?? (last ? { top: last.top + last.height - 24, height: 24 } : null)
        return box ? <div className={`indl-drop ${b ? '' : 'new'}`} style={{ top: box.top, height: box.height }}>{!b && t('charts.ind.ui.newPane')}</div> : null
      })()}
    </div>
  )
}

export default memo(PaneLegends)
