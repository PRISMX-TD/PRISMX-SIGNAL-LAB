// 底部弹层的下拉关闭：按住把手 / 抽屉头往下拖，弹层 1:1 跟手、遮罩随之变淡；松手时按速度
// 与距离决定关掉还是弹回。只挂在把手 / 抽屉头上，正文（可滚动）永远不起拖：指针事件没法和
// 原生竖向滚动共用一次手势，浏览器一接管滚动就发 pointercancel，要抢过来就得给正文
// touch-action: none，正文也就滚不动了。
//
// Drag-to-dismiss for bottom sheets: hold the grab handle / sheet header and pull down;
// the sheet tracks the finger 1:1 and the scrim fades with it; on release, velocity and
// distance decide between dismissing and settling back. Only the handle / header starts
// a drag; the scrollable body never does: pointer events cannot share one gesture with
// native vertical scrolling. The browser sends pointercancel the moment it takes the pan,
// and claiming it would need touch-action: none on the body, which stops it scrolling.
import { useEffect, useRef, type PointerEvent as RPointerEvent, type RefObject } from 'react'

// 起拖阈值：先走出 10px 才算拖，点一下把手、✕、开关都不会让弹层抖。
// Drag threshold: 10px before anything moves, so a tap on the handle, ✕ or a switch never jiggles the sheet.
export const SHEET_DRAG_SLOP = 10
// 松手时拖过弹层高度的 30% 就关。/ Past 30% of the sheet's height on release dismisses.
export const SHEET_DISMISS_RATIO = 0.3
// 或者向下松手速度超过 0.11 px/ms 且至少拖了 10px：短而快的一甩也能关。
// Or a downward release faster than 0.11 px/ms after at least 10px: a short quick flick dismisses.
export const SHEET_FLICK_VELOCITY = 0.11
export const SHEET_FLICK_MIN_DY = 10
// 往上拖过头的橡皮筋：起始斜率 0.55，渐近 24px，越拉越沉。
// Upward overdrag rubber-band: slope 0.55 at first, approaching 24px, heavier the further it goes.
const RUBBER_C = 0.55
const RUBBER_MAX = 24
// 归位 / 甩走：时长等于 tokens.css 的 --dur-base（0.24s）。
// Settle / fling: the duration equals --dur-base (0.24s) in tokens.css.
const SETTLE_MS = 240
const SETTLE_TRANSFORM = 'transform var(--dur-base) var(--ease-sheet)'
const SETTLE_OPACITY = 'opacity var(--dur-base) var(--ease-sheet)'

export function rubberBand(dy: number): number {
  if (dy >= 0) return dy
  const o = -dy
  return -(o * RUBBER_MAX * RUBBER_C) / (RUBBER_MAX + RUBBER_C * o)
}

// 松手时关不关。速度的符号优先：拖过一半但往回甩，弹回去。
// Dismiss or not on release. The velocity's sign wins: dragged halfway but flung back up, it settles.
export function shouldDismissSheet(dy: number, velocity: number, height: number): boolean {
  if (dy <= 0) return false
  if (velocity < -SHEET_FLICK_VELOCITY) return false
  if (velocity > SHEET_FLICK_VELOCITY && dy > SHEET_FLICK_MIN_DY) return true
  return height > 0 && dy > SHEET_DISMISS_RATIO * height
}

export interface DragSample { y: number; t: number }

// 最近 100ms 内的平均速度（px/ms，向下为正）。单帧的差值太抖；手指停住再抬起，窗口里只剩
// 抬起那一个点，速度为 0。
// Average velocity over the last 100ms (px/ms, positive is down). One frame's delta is too
// noisy; a finger that stops and then lifts leaves only the lift sample in the window, so 0.
export function releaseVelocity(samples: DragSample[]): number {
  if (samples.length < 2) return 0
  const last = samples[samples.length - 1]
  let first = samples[0]
  for (const s of samples) {
    if (last.t - s.t <= 100) { first = s; break }
  }
  const dt = last.t - first.t
  return dt > 0 ? (last.y - first.y) / dt : 0
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
}

// 弹层此刻的竖向位移（归位过渡中途是插值后的矩阵）。
// The sheet's current vertical offset (mid-settle this is the interpolated matrix).
function currentTy(el: HTMLElement): number {
  const m = /matrix\(([^)]+)\)/.exec(getComputedStyle(el).transform)
  return m ? parseFloat(m[1].split(',')[5]) || 0 : 0
}

interface Options {
  sheetRef: RefObject<HTMLElement>
  scrimRef?: RefObject<HTMLElement>
  onDismiss: () => void
  // 从这些元素里按下不起拖（例如可滚动的正文）/ presses inside these never start a drag
  ignore?: string
}

interface DragState { id: number; startY: number; dy: number; height: number; active: boolean; samples: DragSample[] }

export function useSheetDrag({ sheetRef, scrimRef, onDismiss, ignore }: Options) {
  const drag = useRef<DragState | null>(null)
  const timer = useRef(0)
  const onDismissRef = useRef(onDismiss)
  onDismissRef.current = onDismiss
  useEffect(() => () => window.clearTimeout(timer.current), [])

  const paint = (s: DragState) => {
    const sheet = sheetRef.current
    if (sheet) sheet.style.transform = `translateY(${s.dy}px)`
    const scrim = scrimRef?.current
    if (scrim && s.height > 0) scrim.style.opacity = String(Math.max(0, Math.min(1, 1 - Math.max(0, s.dy) / s.height)))
  }
  // 入场是 fill-mode: both 的 CSS 动画，会压过行内 transform / opacity，起拖前必须关掉；
  // 之后不再还原，还原会让入场动画从头重播。
  // The entrance is a fill-mode: both CSS animation that overrides inline transform /
  // opacity, so it must be switched off before dragging; it is never restored, because
  // restoring it would replay the entrance.
  const freeze = () => {
    for (const el of [sheetRef.current, scrimRef?.current]) {
      if (!el) continue
      el.style.animation = 'none'
      el.style.transition = 'none'
    }
  }
  const settle = () => {
    const sheet = sheetRef.current
    const scrim = scrimRef?.current
    const reduce = prefersReducedMotion()
    if (sheet) { sheet.style.transition = reduce ? 'none' : SETTLE_TRANSFORM; sheet.style.transform = 'translateY(0px)' }
    if (scrim) { scrim.style.transition = reduce ? 'none' : SETTLE_OPACITY; scrim.style.opacity = '1' }
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      if (sheet) { sheet.style.transition = ''; sheet.style.transform = '' }
      if (scrim) { scrim.style.transition = ''; scrim.style.opacity = '' }
    }, reduce ? 0 : SETTLE_MS)
  }
  const dismiss = () => {
    const sheet = sheetRef.current
    const scrim = scrimRef?.current
    window.clearTimeout(timer.current)
    if (prefersReducedMotion()) {
      // 减弱动效：不再滑走。清掉行内的 transition 与遮罩透明度，交给 .closing 的淡出。
      // Reduced motion: no slide. Clear the inline transition and scrim opacity so the
      // .closing fade takes over.
      if (sheet) sheet.style.transition = ''
      if (scrim) { scrim.style.transition = ''; scrim.style.opacity = '' }
    } else {
      // 行内样式优先于 .closing：从松手的位置接着滑走，不会跳回原位再重来。
      // Inline styles beat .closing: the sheet carries on from the release point.
      if (sheet) { sheet.style.transition = SETTLE_TRANSFORM; sheet.style.transform = 'translateY(100%)' }
      if (scrim) { scrim.style.transition = SETTLE_OPACITY; scrim.style.opacity = '0' }
    }
    // 退场结束时清掉行内样式。正常情况下这一刻弹层正好卸载，清不清看不出差别；但如果退场
    // 途中又被打开（usePresence 会保留同一个 DOM 节点），留着的 translateY(100%) / 透明度 0
    // 会让重新打开的弹层一直停在屏幕外、看不见。
    // Clear the inline styles when the exit ends. Normally the sheet unmounts right then and
    // it makes no visible difference, but if it is reopened mid-exit (usePresence keeps the
    // same DOM node), a leftover translateY(100%) / opacity 0 would keep the reopened sheet
    // off screen.
    timer.current = window.setTimeout(() => {
      if (sheet) { sheet.style.transition = ''; sheet.style.transform = '' }
      if (scrim) { scrim.style.transition = ''; scrim.style.opacity = '' }
    }, SETTLE_MS)
    onDismissRef.current()
  }

  const onPointerDown = (e: RPointerEvent<HTMLElement>) => {
    if (drag.current || !e.isPrimary) return
    if (e.pointerType === 'mouse' && e.button !== 0) return
    if (ignore && (e.target as Element).closest?.(ignore)) return
    const sheet = sheetRef.current
    if (!sheet) return
    window.clearTimeout(timer.current)
    // 归位途中按住：从它此刻的位置接着拖，不跳。
    // Caught mid-settle: continue from where it is now, no jump.
    const cur = currentTy(sheet)
    const s: DragState = { id: e.pointerId, startY: e.clientY - cur, dy: cur, height: sheet.getBoundingClientRect().height, active: false, samples: [{ y: e.clientY, t: e.timeStamp }] }
    drag.current = s
    if (cur !== 0) {
      s.active = true
      e.currentTarget.setPointerCapture(e.pointerId)
      freeze()
      paint(s)
    }
  }
  const onPointerMove = (e: RPointerEvent<HTMLElement>) => {
    const s = drag.current
    if (!s || e.pointerId !== s.id) return
    const raw = e.clientY - s.startY
    if (!s.active) {
      if (Math.abs(raw) < SHEET_DRAG_SLOP) return
      // 过了阈值才捕获：在 ✕ / 开关上点一下，click 仍落在它们身上。
      // Capture only past the threshold, so a tap on ✕ / a switch still clicks it.
      s.active = true
      e.currentTarget.setPointerCapture(e.pointerId)
      freeze()
    }
    s.dy = rubberBand(raw)
    s.samples.push({ y: e.clientY, t: e.timeStamp })
    if (s.samples.length > 6) s.samples.shift()
    paint(s)
  }
  const onPointerUp = (e: RPointerEvent<HTMLElement>) => {
    const s = drag.current
    if (!s || e.pointerId !== s.id) return
    drag.current = null
    if (!s.active) return   // 没过阈值：普通点击 / below the threshold: a plain click
    s.samples.push({ y: e.clientY, t: e.timeStamp })
    if (shouldDismissSheet(s.dy, releaseVelocity(s.samples), s.height)) dismiss()
    else settle()
  }
  // 系统取消（返回手势、来电）：归位，不关。/ System cancel (back gesture, call): settle, never dismiss.
  const onPointerCancel = (e: RPointerEvent<HTMLElement>) => {
    const s = drag.current
    if (!s || e.pointerId !== s.id) return
    drag.current = null
    if (s.active) settle()
  }
  return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel }
}
