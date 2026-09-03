// frontend/src/components/badges/MedalTilt.tsx
// 指针驱动的 3D 倾斜 + 径向高光——V5 视觉方案里勋章"离手可摸"的那部分。
// 逻辑照抄设计稿（badge-atlas.html）里挂在 document 上的 pointermove/
// pointerout，只是从"整页委托一份监听器"改成"每个实例自己的 React 指针
// 事件"，行为等价（±22° 旋转、rAF 节流、离开时靠 CSS transition 回正）。
// prefers-reduced-motion 用户完全跳过——不只是去掉过渡（设计稿原文如此），
// 这里直接不旋转、不显示高光，成就页翻墙、比赛/榜单不挂它，只有勋章墙点开
// 与头部佩戴展示两处用得到。
//
// Pointer-driven 3D tilt + radial highlight — the "you can touch it" half
// of the V5 visual. Logic mirrors the design reference's document-level
// pointermove/pointerout (badge-atlas.html), just switched from one
// page-wide delegated listener to per-instance React pointer events; same
// behavior (±22° rotation, rAF-throttled, CSS transition eases back on
// leave). prefers-reduced-motion users skip it entirely — not merely
// dropping the transition (as the reference does) but no rotation and no
// highlight at all; only the badge-wall detail open and the header
// "equipped" display use this wrapper.
import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'

interface Props {
  children: ReactNode
  onClick?: () => void
  ariaLabel?: string
  className?: string
}

interface Pending { x: number; y: number; w: number; h: number }

export default function MedalTilt({ children, onClick, ariaLabel, className }: Props) {
  const elRef = useRef<HTMLDivElement | HTMLButtonElement | null>(null)
  const rafRef = useRef<number | null>(null)
  const pendingRef = useRef<Pending | null>(null)
  const reducedRef = useRef(false)

  useEffect(() => {
    reducedRef.current =
      typeof window !== 'undefined' && typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
  }, [])

  useEffect(() => () => { if (rafRef.current != null) cancelAnimationFrame(rafRef.current) }, [])

  function apply() {
    rafRef.current = null
    const el = elRef.current
    const pending = pendingRef.current
    if (!el || !pending) return
    pendingRef.current = null
    const dx = pending.x / pending.w - .5
    const dy = pending.y / pending.h - .5
    el.style.transform = `perspective(700px) rotateX(${(-dy * 22).toFixed(2)}deg) rotateY(${(dx * 22).toFixed(2)}deg) translateZ(6px)`
    el.style.setProperty('--lx', `${(pending.x / pending.w * 100).toFixed(1)}%`)
    el.style.setProperty('--ly', `${(pending.y / pending.h * 100).toFixed(1)}%`)
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement | HTMLButtonElement>) {
    if (reducedRef.current) return
    const el = elRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    pendingRef.current = { x: e.clientX - r.left, y: e.clientY - r.top, w: r.width, h: r.height }
    el.classList.add('no-transition')
    if (rafRef.current == null) rafRef.current = requestAnimationFrame(apply)
  }

  function onPointerLeave() {
    const el = elRef.current
    if (!el) return
    el.classList.remove('no-transition')
    el.style.transform = ''
  }

  const setRef = (node: HTMLDivElement | HTMLButtonElement | null) => { elRef.current = node }
  const classes = ['medal-tilt', className].filter(Boolean).join(' ')
  const content = (
    <>
      {children}
      <div className="medal-light" />
    </>
  )

  if (onClick) {
    return (
      <button
        type="button"
        ref={setRef}
        className={classes}
        aria-label={ariaLabel}
        onClick={onClick}
        onPointerMove={onPointerMove}
        onPointerLeave={onPointerLeave}
      >
        {content}
      </button>
    )
  }

  return (
    <div ref={setRef} className={classes} aria-label={ariaLabel} onPointerMove={onPointerMove} onPointerLeave={onPointerLeave}>
      {content}
    </div>
  )
}
