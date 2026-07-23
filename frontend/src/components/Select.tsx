// 通用自定义下拉：替代原生 <select>，深色主题下拉菜单可控样式。
// 原生 select 弹出的选项列表由浏览器/系统渲染，深色主题下几乎无法覆盖样式
// （已在下单弹窗的账户切换器踩过这个坑，见 SlideOrderModal 的 slide-acct-* 类）。
// Generic custom dropdown replacing native <select> — a native select's popup
// list is rendered by the browser/OS and its styling can't be controlled in a
// dark theme (already hit this in the order modal's account switcher; see
// SlideOrderModal's slide-acct-* classes).
//
// 菜单通过 portal 渲染到 <body> 并用 position: fixed 按触发器的屏幕坐标定位，
// 这样即使触发器身处 overflow: hidden/auto 的祖先容器里（如下单面板 .term-ticket
// 内、无缝网格 .term-panel 里），弹出的选项列表也不会被裁掉。
// The menu is portaled to <body> and positioned with fixed coordinates from the
// trigger's bounding rect, so it isn't clipped by any overflow:hidden/auto
// ancestor (e.g. inside the order ticket / seamless grid panel).
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export interface SelectOption {
  value: string
  label: string
}

export default function Select({
  value,
  options,
  onChange,
  className = '',
  openUpward = false,
}: {
  value: string
  options: SelectOption[]
  onChange: (value: string) => void
  className?: string
  // 菜单是否向上弹出（用于紧贴在其他内容上方的触发器，避免向下弹出时盖住下方内容）
  // Open the menu upward (for triggers sitting right above other content, so
  // it doesn't cover what's below when it opens downward instead)
  openUpward?: boolean
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number; width: number } | null>(null)
  const current = options.find((o) => o.value === value)

  // 依据触发器的屏幕坐标计算菜单位置（fixed 定位，跟随视口）。
  // Compute the menu position from the trigger's screen rect (fixed to viewport).
  const place = () => {
    const el = triggerRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setPos({
      left: r.left,
      top: openUpward ? r.top : r.bottom,
      width: r.width,
    })
  }

  useLayoutEffect(() => {
    if (open) place()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    // 视口滚动/尺寸变化时重新定位（capture 捕获所有祖先滚动容器的滚动）。
    // Reposition on scroll/resize (capture catches scrolling in any ancestor).
    const onReflow = () => place()
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', onReflow)
    window.addEventListener('scroll', onReflow, true)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onReflow)
      window.removeEventListener('scroll', onReflow, true)
    }
  }, [open])

  return (
    <div ref={rootRef} className={`select-picker ${className}`}>
      <button ref={triggerRef} type="button" className="select-trigger" onClick={() => setOpen((v) => !v)} title={current?.label ?? value}>
        <span>{current?.label ?? value}</span>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" style={{ transform: open ? 'rotate(180deg)' : undefined }}>
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && pos && createPortal(
        <>
          <div className="select-backdrop" onClick={() => setOpen(false)} />
          <div
            className={`select-menu ${openUpward ? 'up' : ''}`}
            style={{
              left: pos.left,
              width: pos.width,
              ...(openUpward
                ? { bottom: window.innerHeight - pos.top + 4 }
                : { top: pos.top + 4 }),
            }}
          >
            {options.map((o) => (
              <button
                type="button"
                key={o.value}
                className={`select-opt ${o.value === value ? 'active' : ''}`}
                onClick={() => { onChange(o.value); setOpen(false) }}
              >
                {o.label}
              </button>
            ))}
          </div>
        </>,
        document.body,
      )}
    </div>
  )
}
