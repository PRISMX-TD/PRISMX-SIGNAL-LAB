// 通用自定义下拉：替代原生 <select>，深色主题下拉菜单可控样式。
// 原生 select 弹出的选项列表由浏览器/系统渲染，深色主题下几乎无法覆盖样式
// （已在下单弹窗的账户切换器踩过这个坑，见 SlideOrderModal 的 slide-acct-* 类）。
// Generic custom dropdown replacing native <select> — a native select's popup
// list is rendered by the browser/OS and its styling can't be controlled in a
// dark theme (already hit this in the order modal's account switcher; see
// SlideOrderModal's slide-acct-* classes).
import { useEffect, useRef, useState } from 'react'

export interface SelectOption {
  value: string
  label: string
}

export default function Select({
  value,
  options,
  onChange,
  className = '',
}: {
  value: string
  options: SelectOption[]
  onChange: (value: string) => void
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const current = options.find((o) => o.value === value)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  return (
    <div ref={rootRef} className={`select-picker ${className}`}>
      <button type="button" className="select-trigger" onClick={() => setOpen((v) => !v)}>
        <span>{current?.label ?? value}</span>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" style={{ transform: open ? 'rotate(180deg)' : undefined }}>
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && (
        <>
          <div className="select-backdrop" onClick={() => setOpen(false)} />
          <div className="select-menu">
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
        </>
      )}
    </div>
  )
}
