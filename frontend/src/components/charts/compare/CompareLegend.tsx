// 对比品种的图例行：主图状态行下面一行一个（色点 · 品种 · 显示方式 · 十字线所在那根的值 · 显隐 / 删除），
// pane 模式的放在自己窗格的左上角。页面把它放进 .term-chart（与 ChartLegend 同级）；它把自己的高度写到
// 父元素的 --cmp-h，主图的指标图例跟着往下排（见 compare.css）。值订阅 useCompare 的行仓库，十字线拖动只重渲染这里。
// Compare legend rows: one per entry under the main status line (dot · symbol · mode · value at the
// crosshair bar · show / remove); pane-mode rows sit at the top-left of their own pane. The page puts
// it inside .term-chart (next to ChartLegend); it writes its height to the parent's --cmp-h so the
// main indicator legend moves down (see compare.css). Values come from useCompare's row store, so
// crosshair drags re-render only this.
import { memo, useEffect, useRef, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import type { PaneBoxes } from '../useChartEngine'
import type { CompareHandle, CompareRow } from './useCompare'
import { comparePaneId } from './compareModel'
import { Ico, RI } from '../replay/icons'
import './compare.css'

function CompareLegend({ compare, boxes, onToggle, onRemove, onSettings }: {
  compare: CompareHandle
  // engine.paneBoxes：pane 模式的行按它放到窗格顶上 / engine.paneBoxes: pane-mode rows go to their pane's top
  boxes?: PaneBoxes
  onToggle: (symbol: string) => void
  onRemove: (symbol: string) => void
  // 打开对比设置（CompareDialog）/ open the compare settings (CompareDialog)
  onSettings?: () => void
}) {
  const { t } = useTranslation()
  const { rows, leftInset } = useSyncExternalStore(compare.rows.subscribe, compare.rows.get)
  const listRef = useRef<HTMLDivElement>(null)
  const boxOf = (r: CompareRow) => (r.mode === 'pane' && !r.hidden ? boxes?.[comparePaneId(r.symbol)] : undefined)
  const mainRows = rows.filter((r) => !boxOf(r))
  const paneRows = rows.filter((r) => boxOf(r))

  // 把列表高度写到父元素，主图指标图例让出位置 / publish the list height so the indicator legend moves down
  const hasMain = mainRows.length > 0
  useEffect(() => {
    const el = listRef.current
    const host = el?.parentElement
    if (!el || !host || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => host.style.setProperty('--cmp-h', `${el.offsetHeight + 2}px`))
    ro.observe(el)
    return () => { ro.disconnect(); host.style.removeProperty('--cmp-h') }
  }, [hasMain])

  const row = (r: CompareRow) => {
    const val = r.status === 'loading' ? '…'
      : r.status === 'error' ? String(t('charts.compare.error'))
        : r.status === 'empty' ? String(t('charts.compare.noData'))
          : r.value != null ? r.value.toFixed(r.digits) : '—'
    return (
      <div key={r.symbol} className={`cmpl-row ${r.hidden ? 'off' : ''}`} onDoubleClick={onSettings}
        onMouseDown={(e) => { if (e.button === 1) e.preventDefault() }}
        onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); onRemove(r.symbol) } }}>
        <i className="cmpl-dot" style={{ background: r.color }} aria-hidden />
        <b className="cmpl-sym">{r.symbol}</b>
        <span className="cmpl-mode" title={String(t(`charts.compare.mode_${r.mode}`))}><Ico size={12}>{RI[r.mode]}</Ico></span>
        {!r.hidden && <span className="cmpl-v" style={{ color: r.status === 'ok' ? r.color : undefined }}>{val}</span>}
        <span className="cmpl-btns">
          <button type="button" aria-label={`${t(r.hidden ? 'charts.compare.show' : 'charts.compare.hide')} ${r.symbol}`} onClick={() => onToggle(r.symbol)}>
            <Ico size={14}>{r.hidden ? RI.eyeOff : RI.eye}</Ico>
          </button>
          {onSettings && (
            <button type="button" aria-label={String(t('charts.compare.settings'))} onClick={onSettings}><Ico size={14}>{RI.gear}</Ico></button>
          )}
          <button type="button" aria-label={`${t('charts.compare.remove')} ${r.symbol}`} onClick={() => onRemove(r.symbol)}><Ico size={14}>{RI.x}</Ico></button>
        </span>
      </div>
    )
  }

  if (rows.length === 0) return null
  return (
    <>
      {hasMain && <div ref={listRef} className="cmpl-list" style={leftInset ? { left: 12 + leftInset } : undefined}>{mainRows.map(row)}</div>}
      {paneRows.map((r) => {
        const b = boxOf(r)!
        return <div key={r.symbol} className="cmpl-list pane" style={{ top: b.top + 5, ...(leftInset ? { left: 12 + leftInset } : {}) }}>{row(r)}</div>
      })}
    </>
  )
}

export default memo(CompareLegend)
