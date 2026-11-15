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
  // 拖动中的状态全在 ref 里：哪根手指、起点、按下时的位置、可拖范围、当前位置。
  // Drag state lives in a ref: which pointer, the start point, the position at
  // pointerdown, the clamp range and the current position.
  const fsDragRef = useRef<{
    pointerId: number
    startX: number
    startY: number
    left: number
    top: number
    maxX: number
    maxY: number
    x: number
    y: number
  } | null>(null)
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

  // 卸载兜底：`chart-fullscreen` 是挂在 <body> 上的全局类，只在 exitFullscreen 里
  // 摘。全屏状态下若组件被直接卸载（路由跳转、不经返回手势），这个类会留在 body
  // 上继续影响全站布局，而用户已经不在图表页了，没有任何入口能把它摘掉。
  // Unmount safety net: `chart-fullscreen` is a global <body> class removed only
  // by exitFullscreen. Unmounting while fullscreen (e.g. a route change that
  // doesn't go through the back gesture) would leave it stuck on the body,
  // affecting the whole app with no way left to clear it.
  useEffect(() => () => { document.body.classList.remove('chart-fullscreen') }, [])

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
  // 拖动过程中不走 React：每个 pointermove 只改工具栏自己的 transform（只合成、不重排），
  // 松手时才把最终位置写进 state，整页只重渲染这一次。以前每个 move 都 setState
  // （整个图表页重渲染）再写 left / top（每帧重排），工具栏还带毛玻璃，主线程一忙就跟不上手指。
  // 只认按下的那根手指：第二根手指碰到把手不会抢走拖动。
  // Drag: setPointerCapture must live on the element that actually listens
  // (the handle, e.currentTarget), otherwise pointermove isn't routed back —
  // which felt like "hard to drag". The start offset is derived from
  // getBoundingClientRect relative to the parent so switching from bottom- to
  // top-anchoring doesn't jump.
  // Moves bypass React: each pointermove writes only the toolbar's own transform
  // (composite, no layout) and the final position is committed to state once, on release.
  // Every move used to setState (re-rendering the whole charts page) and write left/top
  // (a layout per frame) on a backdrop-blurred toolbar, which fell behind the finger
  // whenever the main thread was busy. Only the pointer that started the drag counts.
  const onFsToolbarPointerDown = useCallback((e: RPointerEvent<HTMLDivElement>) => {
    const el = fsToolbarRef.current
    const parent = el?.offsetParent as HTMLElement | null | undefined
    if (!el || !parent || !e.isPrimary) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    const pr = parent.getBoundingClientRect()
    const r = el.getBoundingClientRect()
    const left = r.left - pr.left
    const top = r.top - pr.top
    fsDragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      left,
      top,
      // 可拖范围按下时量一次：拖动中父容器和工具栏的尺寸都不会变，move 里不必再读布局。
      // Clamp range measured once at pointerdown: neither size changes mid-drag, so moves read no layout.
      maxX: parent.clientWidth - el.offsetWidth,
      maxY: parent.clientHeight - el.offsetHeight,
      x: left,
      y: top,
    }
    // 马上要开始 transform 动画：此刻提层，松手撤掉（just-in-time，不常驻）。
    // A transform animation is about to start: promote now, release on pointerup (never left on).
    el.style.willChange = 'transform'
  }, [])

  const onFsToolbarPointerMove = useCallback((e: RPointerEvent<HTMLDivElement>) => {
    const d = fsDragRef.current
    const el = fsToolbarRef.current
    if (!d || !el || e.pointerId !== d.pointerId) return
    d.x = Math.max(0, Math.min(d.left + e.clientX - d.startX, d.maxX))
    d.y = Math.max(0, Math.min(d.top + e.clientY - d.startY, d.maxY))
    el.style.transform = `translate3d(${d.x - d.left}px, ${d.y - d.top}px, 0)`
  }, [])

  const onFsToolbarPointerUp = useCallback((e: RPointerEvent<HTMLDivElement>) => {
    const d = fsDragRef.current
    if (d && e.pointerId !== d.pointerId) return
    fsDragRef.current = null
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
    const el = fsToolbarRef.current
    if (!d || !el) return
    // pointerup 是离散事件，下面这次 setState 在本帧绘制之前就提交：清掉 transform
    // 与写入 left / top 落在同一帧里，工具栏不会闪回原位。
    // pointerup is a discrete event, so the setState below commits before this frame
    // paints: clearing the transform and applying left/top land in the same frame, no flash back.
    el.style.transform = ''
    el.style.willChange = ''
    // 没挪动（只是点了一下把手）：不写 state，工具栏保持原来的锚定方式。
    // No movement (a tap on the handle): no state write, the toolbar keeps its anchoring.
    if (d.x === d.left && d.y === d.top) return
    setFsToolbarPos({ left: d.x, top: d.y })
  }, [])

  return {
    isFullscreen, enterFullscreen, exitFullscreen,
    fsToolbarRef, fsToolbarPos,
    onFsToolbarPointerDown, onFsToolbarPointerMove, onFsToolbarPointerUp,
  }
}
