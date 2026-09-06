// 手机端全屏模式：CSS 全屏 + 原生 Fullscreen API + 横屏锁定，以及全屏态悬浮
// 画线工具栏的拖动。2026-09-06 从 pages/ChartsPage.tsx 搬出，内容逐行原样。
// Mobile fullscreen (CSS + native Fullscreen API + landscape lock) and the
// draggable floating toolbar, moved out of ChartsPage verbatim on 2026-09-06.
import { useCallback, useEffect, useRef, useState, type PointerEvent as RPointerEvent, type RefObject } from 'react'
import { useBackToClose } from '../../utils/useBackToClose'

export function useChartFullscreen(containerRef: RefObject<HTMLDivElement>) {
  // 手机端全屏模式：图表撑满屏幕，画线工具栏悬浮可拖移
  // Mobile fullscreen: chart fills the entire viewport, drawing toolbar floats & is draggable
  const [isFullscreen, setIsFullscreen] = useState(false)
  const fsToolbarRef = useRef<HTMLDivElement>(null)
  const fsDragRef = useRef<{ startX: number; startY: number; left: number; top: number } | null>(null)
  const [fsToolbarPos, setFsToolbarPos] = useState<{ left: number; top: number } | null>(null)

  // CSS 全屏 + 原生 Fullscreen API（横屏锁定需要后者才能生效）。
  // CSS fullscreen (fixed inset-0 z-60) + native Fullscreen API —
  // screen.orientation.lock('landscape') only works inside a native fullscreen
  // context on mobile browsers (iOS Safari & Android Chrome both require it).
  const enterFullscreen = useCallback(() => {
    setIsFullscreen(true)
    document.body.classList.add('chart-fullscreen')
    // 先请求浏览器原生全屏，再锁定横屏（lock 在原生全屏上下文里才生效）。
    // 目标元素取 containerRef 的直接父节点（即 .term-chart，见 JSX：
    // <div className="term-chart ..."><div ref={containerRef} />...</div>）。
    // 之前用 closest('.glass') 找——无缝框重排时那层的 .glass 类被去掉了，
    // closest 从此永远找不到，导致原生全屏与横屏锁定悄悄失效（只剩纯 CSS
    // 视觉铺满，不是真全屏、不会转横屏），这正是用户反馈"点全屏不转横屏"的
    // 根因。改用直接父节点引用，不再依赖某个可能被样式重构改掉的类名。
    // Request native fullscreen first, then lock landscape (lock only works
    // inside a native fullscreen context). Target element is containerRef's
    // direct parent (.term-chart; see the JSX structure above). This used to
    // look it up via closest('.glass') — the seamless-frame layout rework
    // dropped that class from this element, so the lookup started silently
    // returning null forever, meaning native fullscreen + orientation lock
    // quietly stopped working (only the CSS full-viewport look remained — no
    // real fullscreen, no rotation) — this is the root cause of "tapping
    // fullscreen doesn't rotate to landscape". Using the direct parent ref
    // instead removes the dependency on a class name that styling reworks can
    // change out from under it.
    const el = containerRef.current?.parentElement ?? null
    if (el && document.fullscreenEnabled) {
      el.requestFullscreen().then(() => {
        const orient = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> } | null
        orient?.lock?.('landscape').catch(() => {})
      }).catch(() => {
        // 降级：原生全屏失败仍尝试锁横屏（部分 Android 浏览器不要求先全屏）
        const orient = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> } | null
        orient?.lock?.('landscape').catch(() => {})
      })
    } else {
      const orient = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> } | null
      orient?.lock?.('landscape').catch(() => {})
    }
  }, [])

  const exitFullscreen = useCallback(() => {
    setIsFullscreen(false)
    document.body.classList.remove('chart-fullscreen')
    setFsToolbarPos(null)
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {})
    }
    if (screen.orientation && 'unlock' in screen.orientation) {
      ;(screen.orientation as ScreenOrientation & { unlock: () => void }).unlock()
    }
  }, [])

  useBackToClose(isFullscreen, exitFullscreen)

  // 用户通过系统手势/返回键退出原生全屏时，同步 CSS 全屏状态
  useEffect(() => {
    const onFsChange = () => {
      if (!document.fullscreenElement && isFullscreen) {
        exitFullscreen()
      }
    }
    document.addEventListener('fullscreenchange', onFsChange)
    return () => document.removeEventListener('fullscreenchange', onFsChange)
  }, [isFullscreen, exitFullscreen])

  // 全屏画线工具栏拖动：setPointerCapture 必须挂在真正监听事件的元素上
  // （即拖动把手本身，e.currentTarget），否则 pointermove 不会被捕获路由回来，
  // 表现为"很难拖动"。初始位置用 getBoundingClientRect 相对父容器换算，避免从
  // bottom 定位切到 top 定位时的跳变。
  // Drag: setPointerCapture must live on the element that actually listens
  // (the handle, e.currentTarget), otherwise pointermove isn't routed back —
  // which felt like "hard to drag". The start offset is derived from
  // getBoundingClientRect relative to the parent so switching from bottom- to
  // top-anchoring doesn't jump.
  const onFsToolbarPointerDown = useCallback((e: RPointerEvent<HTMLDivElement>) => {
    const el = fsToolbarRef.current
    if (!el) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    const parent = el.offsetParent as HTMLElement | null
    const pr = parent?.getBoundingClientRect()
    const r = el.getBoundingClientRect()
    fsDragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      left: r.left - (pr?.left ?? 0),
      top: r.top - (pr?.top ?? 0),
    }
  }, [])

  const onFsToolbarPointerMove = useCallback((e: RPointerEvent<HTMLDivElement>) => {
    if (!fsDragRef.current) return
    const dx = e.clientX - fsDragRef.current.startX
    const dy = e.clientY - fsDragRef.current.startY
    const el = fsToolbarRef.current
    if (!el) return
    const parent = el.offsetParent as HTMLElement | null
    if (!parent) return
    const maxX = parent.clientWidth - el.offsetWidth
    const maxY = parent.clientHeight - el.offsetHeight
    setFsToolbarPos({
      left: Math.max(0, Math.min(fsDragRef.current.left + dx, maxX)),
      top: Math.max(0, Math.min(fsDragRef.current.top + dy, maxY)),
    })
  }, [])

  const onFsToolbarPointerUp = useCallback((e: RPointerEvent<HTMLDivElement>) => {
    fsDragRef.current = null
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
  }, [])

  return {
    isFullscreen, enterFullscreen, exitFullscreen,
    fsToolbarRef, fsToolbarPos,
    onFsToolbarPointerDown, onFsToolbarPointerMove, onFsToolbarPointerUp,
  }
}
