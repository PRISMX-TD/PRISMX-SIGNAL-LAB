// 全屏态悬浮画线工具栏（可拖移）。2026-09-06 从 pages/ChartsPage.tsx 搬出，
// 内容逐行原样；拖动逻辑在 useChartFullscreen。
// Floating draggable draw toolbar for fullscreen mode, moved out of ChartsPage
// verbatim on 2026-09-06; drag logic lives in useChartFullscreen.
import { useTranslation } from 'react-i18next'
import type { PointerEvent as RPointerEvent, RefObject } from 'react'
import type { DrawLayerHandle, Tool } from './DrawLayer'
import { ToolList } from './chartConfig'
import { DrawToolIcon } from './DrawToolsRow'
import PositionMarkerToggle from './PositionMarkerToggle'

export default function FullscreenToolbar({ toolbarRef, pos, onPointerDown, onPointerMove, onPointerUp, drawLayerRef, bumpDraw, showPositions, onTogglePositions }: {
  toolbarRef: RefObject<HTMLDivElement>
  pos: { left: number; top: number } | null
  onPointerDown: (e: RPointerEvent<HTMLDivElement>) => void
  onPointerMove: (e: RPointerEvent<HTMLDivElement>) => void
  onPointerUp: (e: RPointerEvent<HTMLDivElement>) => void
  drawLayerRef: RefObject<DrawLayerHandle>
  bumpDraw: () => void
  showPositions: boolean
  onTogglePositions: () => void
}) {
  const { t } = useTranslation()
  return (
    <div
      ref={toolbarRef}
      className="chart-fs-toolbar"
      style={
        pos
          ? { left: pos.left, top: pos.top }
          : { left: 8, bottom: 32 }
      }
    >
      {/* 拖动把手：整条都是热区，配一个明显的抓手图标，方便拖动 */}
      <div
        className="chart-fs-toolbar-handle"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <svg width="26" height="12" viewBox="0 0 26 12" fill="currentColor" opacity="0.5">
          <circle cx="7" cy="4" r="1.4" /><circle cx="13" cy="4" r="1.4" /><circle cx="19" cy="4" r="1.4" />
          <circle cx="7" cy="8" r="1.4" /><circle cx="13" cy="8" r="1.4" /><circle cx="19" cy="8" r="1.4" />
        </svg>
      </div>
      {/* 工具按钮 */}
      <div className="flex items-center gap-1">
        {(ToolList as Tool[]).map((toolName) => (
          <button
            key={toolName}
            type="button"
            title={String(t(`charts.draw.${toolName}`))}
            aria-label={String(t(`charts.draw.${toolName}`))}
            onClick={() => { drawLayerRef.current?.setTool(toolName); bumpDraw() }}
            className={`flex h-6 w-6 items-center justify-center rounded-md border transition ${
              drawLayerRef.current?.tool === toolName
                ? 'border-prism-500/60 bg-prism-600/25 text-prism-200'
                : 'border-white/10 bg-ink-800/60 text-neutral-400 hover:text-neutral-100'
            }`}
          >
            <DrawToolIcon tool={toolName} />
          </button>
        ))}
        <span className="mx-0.5 h-5 w-px bg-white/10" />
        {['#22d3ee', '#a78bfa', '#2ee07e', '#ff4d67', '#f5c451'].map((c) => (
          <button
            key={c}
            type="button"
            title={t('charts.draw.color')}
            aria-label={t('charts.draw.color')}
            onClick={() => { drawLayerRef.current?.applyColor(c); bumpDraw() }}
            className={`h-3.5 w-3.5 rounded-full border transition ${
              drawLayerRef.current?.color === c ? 'border-white scale-110' : 'border-white/20'
            }`}
            style={{ background: c }}
          />
        ))}
        <span className="mx-0.5 h-5 w-px bg-white/10" />
        <button type="button" title={t('charts.draw.lock')} aria-label={t('charts.draw.lock')} onClick={() => { drawLayerRef.current?.toggleLock(); bumpDraw() }} disabled={!drawLayerRef.current?.selectedId}
          className="flex h-6 w-6 items-center justify-center rounded-md border border-white/10 bg-ink-800/60 text-neutral-400 transition hover:text-neutral-100 disabled:opacity-30"
        ><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0110 0v4" /></svg></button>
        <button type="button" title={t('charts.draw.undo')} aria-label={t('charts.draw.undo')} onClick={() => { drawLayerRef.current?.undo(); bumpDraw() }}
          className="flex h-6 w-6 items-center justify-center rounded-md border border-white/10 bg-ink-800/60 text-neutral-400 transition hover:text-neutral-100"
        ><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="1 4 1 10 7 10" /><path d="M3.51 15a9 9 0 102.13-9.36L1 10" /></svg></button>
        <button type="button" title={t('charts.draw.redo')} aria-label={t('charts.draw.redo')} onClick={() => { drawLayerRef.current?.redo(); bumpDraw() }}
          className="flex h-6 w-6 items-center justify-center rounded-md border border-white/10 bg-ink-800/60 text-neutral-400 transition hover:text-neutral-100"
        ><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10" /></svg></button>
        <span className="mx-0.5 h-5 w-px bg-white/10" />
        <button type="button" title={t('charts.draw.delete')} aria-label={t('charts.draw.delete')}
          onClick={() => { drawLayerRef.current?.deleteSelected(); bumpDraw() }} disabled={!drawLayerRef.current?.selectedId}
          className="flex h-6 w-6 items-center justify-center rounded-md border border-white/10 bg-ink-800/60 text-neutral-400 transition hover:text-down disabled:opacity-30 disabled:hover:text-neutral-400"
        ><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" /></svg></button>
        <button type="button" title={t('charts.draw.clear')} aria-label={t('charts.draw.clear')}
          onClick={() => { drawLayerRef.current?.clearAll(); bumpDraw() }} disabled={(drawLayerRef.current?.drawCount ?? 0) === 0}
          className="flex h-6 w-6 items-center justify-center rounded-md border border-white/10 bg-ink-800/60 text-neutral-400 transition hover:text-down disabled:opacity-30 disabled:hover:text-neutral-400"
        ><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M19 5L5 19M5 5l14 14" /></svg></button>
        <span className="mx-0.5 h-5 w-px bg-white/10" />
        <button type="button" title={t('charts.draw.stayInDraw')} aria-label={t('charts.draw.stayInDraw')} onClick={() => { drawLayerRef.current?.setStayInDraw(!drawLayerRef.current?.stayInDraw); bumpDraw() }}
          className={`flex h-6 w-6 items-center justify-center rounded-md border transition ${drawLayerRef.current?.stayInDraw ? 'border-prism-500/60 bg-prism-600/25 text-prism-200' : 'border-white/10 bg-ink-800/60 text-neutral-400 hover:text-neutral-100'}`}
        ><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 3l4 4-4 4" /><path d="M3 17l4 4-4 4" /><line x1="21" y1="7" x2="7" y2="21" /><line x1="7" y1="3" x2="21" y2="17" /></svg></button>
        <PositionMarkerToggle on={showPositions} onToggle={() => onTogglePositions()} t={t} compact />
      </div>
    </div>
  )
}
