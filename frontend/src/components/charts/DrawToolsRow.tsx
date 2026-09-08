// 画线工具：图标 + 两种排布。rail = 桌面图表左侧的竖轨（2026-09-08 起，工具从
// 顶部横条搬到这里，周期与指标入口独占上方一条）；wrap = 手机端点画笔后展开的
// 换行行。两处共用同一份按钮，避免抄两遍。
// Draw tools: icons plus two layouts. rail = the vertical rail on the chart's
// left (since 2026-09-08; tools moved out of the top bar so intervals and the
// indicator entry own that row); wrap = the mobile row that expands on tap.
import { Fragment, type RefObject } from 'react'
import type { DrawLayerHandle, Tool } from './DrawLayer'
import { ToolList } from './chartConfig'

export function DrawToolIcon({ tool }: { tool: Tool }) {
  switch (tool) {
    case 'cursor':
      return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 3l7 17 2.5-6.5L20 11 4 3z" /></svg>
    case 'cross':
      return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><line x1="12" y1="3" x2="12" y2="21" /><line x1="3" y1="12" x2="21" y2="12" /></svg>
    case 'trend':
      return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 20L20 4" /><circle cx="4" cy="20" r="1.8" /><circle cx="20" cy="4" r="1.8" /></svg>
    case 'hline':
      return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12h18" /><circle cx="12" cy="12" r="1.8" /></svg>
    case 'vline':
      return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v18" /><circle cx="12" cy="12" r="1.8" /></svg>
    case 'ray':
      return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><line x1="6" y1="18" x2="18" y2="6" /><line x1="18" y1="6" x2="22" y2="2" /><circle cx="6" cy="18" r="1.8" /></svg>
    case 'crossline':
      return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12h18" /><path d="M12 3v18" /><circle cx="12" cy="12" r="1.8" /></svg>
    case 'rect':
      return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="6" width="16" height="12" rx="1" /></svg>
    case 'fib':
      return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M3 5h18M3 10h18M3 14h18M3 19h18" /><path d="M4 19L20 5" opacity="0.5" /></svg>
  }
}

const COLORS = ['#22d3ee', '#a78bfa', '#2ee07e', '#ff4d67', '#f5c451']

export default function DrawToolsRow({
  drawLayerRef,
  bumpDraw,
  t,
  variant = 'rail',
}: {
  drawLayerRef: RefObject<DrawLayerHandle>
  bumpDraw: () => void
  t: (key: string) => unknown
  variant?: 'rail' | 'wrap'
}) {
  const rail = variant === 'rail'
  const Divider = () => (rail ? <hr /> : <span className="term-toolbar-divider" />)
  const dl = drawLayerRef.current
  // 画线层挂上之前 ref 还是空的，此时按「可见」画，免得眼睛按钮闪一下高亮。
  // Before the draw layer mounts the ref is null; treat drawings as visible so the eye doesn't flash on.
  const visible = dl?.visible ?? true

  return (
    <div className={rail ? 'term-rail no-sb' : 'term-tools-wrap'} aria-label={String(t('charts.draw.tools'))}>
      {(ToolList as Tool[]).map((toolName) => (
        <Fragment key={toolName}>
          <button
            type="button"
            title={String(t(`charts.draw.${toolName}`))}
            aria-label={String(t(`charts.draw.${toolName}`))}
            aria-pressed={dl?.tool === toolName}
            onClick={() => { drawLayerRef.current?.setTool(toolName); bumpDraw() }}
            className={`term-tool-btn ${dl?.tool === toolName ? 'on' : ''}`}
          >
            <DrawToolIcon tool={toolName} />
          </button>
          {/* 光标两件与画线工具之间划一道 / a divider after the two cursor tools */}
          {toolName === 'cross' && <Divider />}
        </Fragment>
      ))}
      <Divider />
      {COLORS.map((c) => (
        <button
          key={c}
          type="button"
          title={String(t('charts.draw.color'))}
          aria-label={String(t('charts.draw.color'))}
          onClick={() => { drawLayerRef.current?.applyColor(c); bumpDraw() }}
          className={`term-color-dot ${dl?.color === c ? 'on' : ''}`}
          style={{ background: c }}
        />
      ))}
      <Divider />
      <button
        type="button"
        title={String(t('charts.draw.delete'))}
        aria-label={String(t('charts.draw.delete'))}
        onClick={() => { drawLayerRef.current?.deleteSelected(); bumpDraw() }}
        disabled={!dl?.selectedId}
        className="term-tool-btn"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" /></svg>
      </button>
      <button
        type="button"
        title={String(t('charts.draw.clear'))}
        aria-label={String(t('charts.draw.clear'))}
        onClick={() => { drawLayerRef.current?.clearAll(); bumpDraw() }}
        disabled={(dl?.drawCount ?? 0) === 0}
        className="term-tool-btn"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M19 5L5 19M5 5l14 14" /></svg>
      </button>
      <button
        type="button"
        title={String(t('charts.draw.stayInDraw'))}
        aria-label={String(t('charts.draw.stayInDraw'))}
        aria-pressed={!!dl?.stayInDraw}
        onClick={() => { drawLayerRef.current?.setStayInDraw(!drawLayerRef.current?.stayInDraw); bumpDraw() }}
        className={`term-tool-btn ${dl?.stayInDraw ? 'on' : ''}`}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3l4 4-4 4" /><path d="M3 17l4 4-4 4" /><line x1="21" y1="7" x2="7" y2="21" /><line x1="7" y1="3" x2="21" y2="17" /></svg>
      </button>
      <button
        type="button"
        title={String(visible ? t('charts.draw.hideAll') : t('charts.draw.showAll'))}
        aria-label={String(visible ? t('charts.draw.hideAll') : t('charts.draw.showAll'))}
        onClick={() => { drawLayerRef.current?.setVisible(!drawLayerRef.current?.visible); bumpDraw() }}
        className={`term-tool-btn warn ${!visible ? 'on' : ''}`}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{visible ? <><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" /></> : <><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24" /><line x1="1" y1="1" x2="23" y2="23" /></>}</svg>
      </button>
    </div>
  )
}
