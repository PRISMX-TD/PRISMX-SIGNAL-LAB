// 画线工具整排 + 工具图标 + 桌面端自定义超细拖拽条。2026-09-06 从
// pages/ChartsPage.tsx 搬出，内容逐行原样。
// Draw-tool row, tool icons and the desktop thin drag bar, moved out of
// pages/ChartsPage.tsx verbatim on 2026-09-06.
import { useCallback, useEffect, useRef, useState, type PointerEvent as RPointerEvent, type ReactNode, type RefObject } from 'react'
import type { DrawLayerHandle, Tool } from './DrawLayer'
import { ToolList } from './chartConfig'

// 画线工具图标（提取到 ChartsPage 里复用，避免在 DrawLayer 内写死竖排布局）
export function DrawToolIcon({ tool }: { tool: Tool }) {
  switch (tool) {
    case 'cursor':
      return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 3l7 17 2.5-6.5L20 11 4 3z" /></svg>
    case 'cross':
      return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><line x1="12" y1="3" x2="12" y2="21" /><line x1="3" y1="12" x2="21" y2="12" /></svg>
    case 'trend':
      return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 20L20 4" /><circle cx="4" cy="20" r="2" /><circle cx="20" cy="4" r="2" /></svg>
    case 'hline':
      return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12h18" /><circle cx="12" cy="12" r="2" /></svg>
    case 'vline':
      return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v18" /><circle cx="12" cy="12" r="2" /></svg>
    case 'ray':
      return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="6" y1="18" x2="18" y2="6" /><line x1="18" y1="6" x2="22" y2="2" /><circle cx="6" cy="18" r="2" /></svg>
    case 'crossline':
      return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12h18" /><path d="M12 3v18" /><circle cx="12" cy="12" r="2" /></svg>
    case 'rect':
      return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="6" width="16" height="12" rx="1" /></svg>
    case 'fib':
      return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 5h18M3 10h18M3 14h18M3 19h18" /><path d="M4 19L20 5" opacity="0.5" /></svg>
  }
}

// 画线工具整排（图标 + 颜色点 + 删除/清空/连续绘制/显隐）：桌面工具栏与手机端
// 可展开行共用同一份，避免同样ー套按钮抄两遍。wrap=true 时允许换行（手机展开行，
// 铺满宽度更好点），false 时横向滚动（桌面工具栏，节省垂直空间）。
// The full draw-tool row (icons + color dots + delete/clear/stay/hide): shared
// by the desktop toolbar and the mobile expandable row so the same button set
// isn't duplicated. wrap=true allows wrapping (mobile: full-width is available
// and wrapping beats a hidden horizontal scroll); false scrolls horizontally
// (desktop: saves vertical space).
// 自定义超细拖拽条：原生滚动条（WebKit ::-webkit-scrollbar / Firefox
// scrollbar-width）都有各自的最小渲染厚度下限，height:0.2px/2px 会被浏览器夹回
// 到 ~1px 甚至画成一整条粗胶囊，无法真正做细。这里隐藏原生滚动条（no-sb），改用
// 一个真实的 <div> 当拖拽条：厚度就是 CSS 里写死的像素、不受浏览器下限约束，
// thumb 宽度/位置按 scrollLeft 实时算，支持点击拖动。仅桌面横滑用（wrap=false）。
// Custom ultra-thin drag bar: native scrollbars (WebKit's ::-webkit-scrollbar,
// Firefox's scrollbar-width) each enforce a minimum rendered thickness, so
// height:0.2px/2px gets clamped back to ~1px or drawn as one thick pill and
// can't truly be made thin. So we hide the native scrollbar (no-sb) and draw a
// real <div> as the bar: its thickness is exactly the pixel value in CSS, free
// of any browser minimum; the thumb's width/position track scrollLeft live and
// it's draggable. Desktop horizontal-scroll only (wrap=false).
function ScrollRow({ children }: { children: ReactNode }) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [thumb, setThumb] = useState<{ width: number; left: number; visible: boolean }>({
    width: 0,
    left: 0,
    visible: false,
  })
  const dragRef = useRef<{ startX: number; startScrollLeft: number } | null>(null)

  const update = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const { scrollWidth, clientWidth, scrollLeft } = el
    // 没有溢出就不显示拖拽条 / hide the bar when there's nothing to scroll
    if (scrollWidth <= clientWidth + 1) {
      setThumb((s) => (s.visible ? { ...s, visible: false } : s))
      return
    }
    const width = Math.max((clientWidth / scrollWidth) * clientWidth, 24)
    const maxLeft = clientWidth - width
    const left = maxLeft > 0 ? (scrollLeft / (scrollWidth - clientWidth)) * maxLeft : 0
    setThumb({ width, left, visible: true })
  }, [])

  useEffect(() => {
    update()
    const el = scrollRef.current
    if (!el) return
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [update, children])

  // thumb 拖动：按下记录起点，移动时把位移换算回 scrollLeft。
  // Thumb drag: record the start, then map the delta back to scrollLeft.
  const onThumbDown = useCallback((e: RPointerEvent<HTMLDivElement>) => {
    const el = scrollRef.current
    if (!el) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    dragRef.current = { startX: e.clientX, startScrollLeft: el.scrollLeft }
  }, [])

  const onThumbMove = useCallback((e: RPointerEvent<HTMLDivElement>) => {
    const el = scrollRef.current
    if (!el || !dragRef.current) return
    const { scrollWidth, clientWidth } = el
    const trackTravel = clientWidth - thumb.width
    if (trackTravel <= 0) return
    const dx = e.clientX - dragRef.current.startX
    const scrollable = scrollWidth - clientWidth
    el.scrollLeft = dragRef.current.startScrollLeft + (dx / trackTravel) * scrollable
  }, [thumb.width])

  const onThumbUp = useCallback((e: RPointerEvent<HTMLDivElement>) => {
    dragRef.current = null
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
  }, [])

  return (
    <div className="term-toolbar-scroll">
      <div ref={scrollRef} className="term-toolbar-tools no-sb" onScroll={update}>
        {children}
      </div>
      {thumb.visible && (
        <div className="term-toolbar-track">
          <div
            className="term-toolbar-thumb"
            style={{ width: thumb.width, transform: `translateX(${thumb.left}px)` }}
            onPointerDown={onThumbDown}
            onPointerMove={onThumbMove}
            onPointerUp={onThumbUp}
            onPointerCancel={onThumbUp}
          />
        </div>
      )}
    </div>
  )
}

export default function DrawToolsRow({
  drawLayerRef,
  bumpDraw,
  t,
  wrap = false,
}: {
  drawLayerRef: RefObject<DrawLayerHandle>
  bumpDraw: () => void
  t: (key: string) => unknown
  wrap?: boolean
}) {
  const content = (
    <>
      {(ToolList as Tool[]).map((toolName) => (
        <button
          key={toolName}
          type="button"
          title={String(t(`charts.draw.${toolName}`))}
          aria-label={String(t(`charts.draw.${toolName}`))}
          onClick={() => { drawLayerRef.current?.setTool(toolName); bumpDraw() }}
          className={`term-tool-btn ${drawLayerRef.current?.tool === toolName ? 'on' : ''}`}
        >
          <DrawToolIcon tool={toolName} />
        </button>
      ))}
      <span className="term-toolbar-divider" />
      {['#22d3ee', '#a78bfa', '#2ee07e', '#ff4d67', '#f5c451'].map((c) => (
        <button
          key={c}
          type="button"
          title={String(t('charts.draw.color'))}
          aria-label={String(t('charts.draw.color'))}
          onClick={() => { drawLayerRef.current?.applyColor(c); bumpDraw() }}
          className={`term-color-dot ${drawLayerRef.current?.color === c ? 'on' : ''}`}
          style={{ background: c }}
        />
      ))}
      <span className="term-toolbar-divider" />
      <button
        type="button"
        title={String(t('charts.draw.delete'))}
        aria-label={String(t('charts.draw.delete'))}
        onClick={() => { drawLayerRef.current?.deleteSelected(); bumpDraw() }}
        disabled={!drawLayerRef.current?.selectedId}
        className="term-tool-btn"
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" /></svg>
      </button>
      <button
        type="button"
        title={String(t('charts.draw.clear'))}
        aria-label={String(t('charts.draw.clear'))}
        onClick={() => { drawLayerRef.current?.clearAll(); bumpDraw() }}
        disabled={(drawLayerRef.current?.drawCount ?? 0) === 0}
        className="term-tool-btn"
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 5L5 19M5 5l14 14" /></svg>
      </button>
      <button
        type="button"
        title={String(t('charts.draw.stayInDraw'))}
        aria-label={String(t('charts.draw.stayInDraw'))}
        onClick={() => { drawLayerRef.current?.setStayInDraw(!drawLayerRef.current?.stayInDraw); bumpDraw() }}
        className={`term-tool-btn ${drawLayerRef.current?.stayInDraw ? 'on' : ''}`}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3l4 4-4 4" /><path d="M3 17l4 4-4 4" /><line x1="21" y1="7" x2="7" y2="21" /><line x1="7" y1="3" x2="21" y2="17" /></svg>
      </button>
      <button
        type="button"
        title={String(drawLayerRef.current?.visible ? t('charts.draw.hideAll') : t('charts.draw.showAll'))}
        aria-label={String(drawLayerRef.current?.visible ? t('charts.draw.hideAll') : t('charts.draw.showAll'))}
        onClick={() => { drawLayerRef.current?.setVisible(!drawLayerRef.current?.visible); bumpDraw() }}
        className={`term-tool-btn warn ${!drawLayerRef.current?.visible ? 'on' : ''}`}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{drawLayerRef.current?.visible ? <><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" /></> : <><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24" /><line x1="1" y1="1" x2="23" y2="23" /></>}</svg>
      </button>
    </>
  )

  // 手机端换行铺满（不需要横滑/拖拽条）；桌面端用自定义超细拖拽条包裹。
  // Mobile wraps to fill (no horizontal scroll/bar); desktop wraps in the
  // custom ultra-thin drag bar.
  if (wrap) {
    return <div className="term-toolbar-tools wrap no-sb">{content}</div>
  }
  return <ScrollRow>{content}</ScrollRow>
}
