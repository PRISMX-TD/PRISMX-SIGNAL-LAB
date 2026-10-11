// 多选下拉：外观与 Select 同一套（.select-trigger / .select-menu / .select-opt），
// 点选项是勾 / 取消勾，菜单不收起；顶上一项「全部」清空选择。空数组 = 全部。
// 菜单同样 portal 到 body、fixed 定位，免得被祖先 overflow 裁掉（理由见 Select.tsx）。
// Multi-select dropdown sharing Select's look. Tapping an option toggles it and
// keeps the menu open; the top "All" row clears the selection. An empty array
// means "all". Portalled to body with fixed positioning, like Select.
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { SelectOption } from './Select'

export default function MultiSelect({
  values,
  options,
  onChange,
  allLabel,
  className = '',
  ariaLabel,
}: {
  values: string[]
  options: SelectOption[]
  onChange: (values: string[]) => void
  allLabel: string
  className?: string
  ariaLabel?: string
}) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number; width: number } | null>(null)

  const place = () => {
    const el = triggerRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setPos({ left: r.left, top: r.bottom, width: r.width })
  }

  useLayoutEffect(() => {
    if (open) { place(); return }
    setPos(null)
  }, [open])

  // 撑开后超出视口右侧就左移一次（同 Select）/ shift left once if it overflows (as Select)
  useLayoutEffect(() => {
    if (!open || !pos) return
    const el = menuRef.current
    if (!el) return
    const maxRight = window.innerWidth - 8
    if (pos.left + el.offsetWidth > maxRight) {
      const left = Math.max(8, maxRight - el.offsetWidth)
      if (left !== pos.left) setPos((p) => (p ? { ...p, left } : p))
    }
  }, [open, pos])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
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

  const picked = options.filter((o) => values.includes(o.value))
  // 触发器：没选 = 「全部」；选一个 = 它的名字；选多个 = 第一个 +N。
  // Trigger: none = "All"; one = its name; several = first +N.
  const triggerText = picked.length === 0
    ? allLabel
    : picked.length === 1 ? (picked[0].short ?? picked[0].label) : `${picked[0].short ?? picked[0].label} +${picked.length - 1}`
  const toggle = (v: string) => onChange(values.includes(v) ? values.filter((x) => x !== v) : [...values, v])

  return (
    <div className={`select-picker ${className}`}>
      <button ref={triggerRef} type="button" className="select-trigger" onClick={() => setOpen((v) => !v)}
              title={picked.map((o) => o.label).join(', ') || allLabel} aria-label={ariaLabel} aria-haspopup="listbox" aria-expanded={open}>
        <span>{triggerText}</span>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" style={{ transform: open ? 'rotate(180deg)' : undefined }}>
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && pos && createPortal(
        <>
          <div className="select-backdrop" onClick={() => setOpen(false)} />
          <div
            className="select-menu multi"
            ref={menuRef}
            role="listbox"
            aria-multiselectable="true"
            style={{ left: pos.left, top: pos.top + 4, minWidth: pos.width, width: 'max-content', maxWidth: Math.max(pos.width, window.innerWidth - 16) }}
          >
            <button type="button" role="option" aria-selected={values.length === 0} className={`select-opt ${values.length === 0 ? 'active' : ''}`} onClick={() => onChange([])}>
              <Check on={values.length === 0} />{allLabel}
            </button>
            {options.map((o) => {
              const on = values.includes(o.value)
              return (
                <button type="button" role="option" aria-selected={on} key={o.value} className={`select-opt ${on ? 'active' : ''}`} onClick={() => toggle(o.value)}>
                  <Check on={on} />{o.label}
                </button>
              )
            })}
          </div>
        </>,
        document.body,
      )}
    </div>
  )
}

function Check({ on }: { on: boolean }) {
  return (
    <span className={`select-check ${on ? 'on' : ''}`} aria-hidden="true">
      {on && <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12l5 5L20 7" /></svg>}
    </span>
  )
}
