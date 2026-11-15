// 多选下拉：外观与 Select 同一套（.select-trigger / .select-menu / .select-opt），
// 点选项是勾 / 取消勾，菜单不收起；顶上一项「全部」清空选择。空数组 = 全部。
// 菜单同样 portal 到 body、fixed 定位，免得被祖先 overflow 裁掉（理由见 Select.tsx）。
// Multi-select dropdown sharing Select's look. Tapping an option toggles it and
// keeps the menu open; the top "All" row clears the selection. An empty array
// means "all". Portalled to body with fixed positioning, like Select.
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import type { SelectOption } from './Select'
import { initialIndex, nextIndex } from './selectKeys'

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
  // roving tabindex，同 Select。下标 0 是「全部」，选项从 1 开始。
  // Roving tabindex as in Select. Index 0 is "All"; options start at 1.
  const [active, setActive] = useState(0)
  const optRefs = useRef<(HTMLButtonElement | null)[]>([])
  const listId = useId()
  const menuShown = open && pos != null
  const rowCount = options.length + 1

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
    // 合帧：一帧里可能来好几个滚动事件（捕获阶段连菜单自己列表的滚动也收），每帧最多
    // 重算一次位置，免得每个事件都 setState 重渲染一次。
    // Coalesced: a frame can deliver several scroll events (the capture phase also catches
    // the menu's own list scrolling); reposition at most once per frame instead of a
    // setState re-render per event.
    let raf = 0
    const onReflow = () => {
      if (!raf) raf = window.requestAnimationFrame(() => { raf = 0; place() })
    }
    window.addEventListener('resize', onReflow)
    window.addEventListener('scroll', onReflow, true)
    return () => {
      window.removeEventListener('resize', onReflow)
      window.removeEventListener('scroll', onReflow, true)
      if (raf) window.cancelAnimationFrame(raf)
    }
  }, [open])

  useEffect(() => {
    if (!menuShown) return
    const el = optRefs.current[active]
    if (!el) return
    el.focus({ preventScroll: true })
    el.scrollIntoView({ block: 'nearest' })
  }, [menuShown, active])

  const picked = options.filter((o) => values.includes(o.value))
  // 触发器：没选 = 「全部」；选一个 = 它的名字；选多个 = 第一个 +N。
  // Trigger: none = "All"; one = its name; several = first +N.
  const triggerText = picked.length === 0
    ? allLabel
    : picked.length === 1 ? (picked[0].short ?? picked[0].label) : `${picked[0].short ?? picked[0].label} +${picked.length - 1}`
  const toggle = (v: string) => onChange(values.includes(v) ? values.filter((x) => x !== v) : [...values, v])
  const openMenu = () => {
    // 打开时停在第一个已勾选项上；都没勾就停在「全部」（下标 0）。
    // Start on the first checked option; on "All" (index 0) when nothing is checked.
    const firstOn = options.findIndex((o) => values.includes(o.value))
    setActive(initialIndex(firstOn >= 0 ? firstOn + 1 : 0, rowCount))
    setOpen(true)
  }
  const close = () => {
    setOpen(false)
    triggerRef.current?.focus({ preventScroll: true })
  }
  const onTriggerKey = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault()
      openMenu()
    }
  }
  // 多选：Space 走按钮原生 click（勾 / 取消，菜单不关）；Enter 只负责收起——preventDefault
  // 拦掉 Enter 在按钮上触发的 click，免得「按回车确认」顺手把当前项勾反了。
  // Multi-select: Space keeps the native click (toggle, menu stays open); Enter only
  // closes — preventDefault stops Enter's synthetic click so "press Enter to finish"
  // does not also flip the focused option.
  const onMenuKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape' || e.key === 'Tab' || e.key === 'Enter') {
      e.preventDefault()
      e.stopPropagation()
      close()
      return
    }
    const next = nextIndex(e.key, active, rowCount)
    if (next == null) return
    e.preventDefault()
    setActive(next)
  }
  const pickedNames = picked.map((o) => o.label).join(', ') || allLabel

  return (
    <div className={`select-picker ${className}`}>
      <button ref={triggerRef} type="button" className="select-trigger"
              onClick={() => (open ? close() : openMenu())}
              onKeyDown={onTriggerKey}
              title={pickedNames}
              aria-label={ariaLabel ? `${ariaLabel}: ${pickedNames}` : undefined}
              aria-haspopup="listbox" aria-expanded={open} aria-controls={menuShown ? listId : undefined}>
        <span>{triggerText}</span>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ transform: open ? 'rotate(180deg)' : undefined }}>
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && pos && createPortal(
        <>
          <div className="select-backdrop" onClick={close} />
          <div
            className="select-menu multi"
            ref={menuRef}
            id={listId}
            role="listbox"
            aria-multiselectable="true"
            aria-label={ariaLabel ?? allLabel}
            onKeyDown={onMenuKey}
            style={{ left: pos.left, top: pos.top + 4, minWidth: pos.width, width: 'max-content', maxWidth: Math.max(pos.width, window.innerWidth - 16) }}
          >
            <button
              type="button"
              id={`${listId}-opt-0`}
              ref={(el) => { optRefs.current[0] = el }}
              role="option"
              aria-selected={values.length === 0}
              tabIndex={active === 0 ? 0 : -1}
              className={`select-opt ${values.length === 0 ? 'active' : ''}`}
              onFocus={() => setActive(0)}
              onClick={() => onChange([])}
            >
              <Check on={values.length === 0} />{allLabel}
            </button>
            {options.map((o, i) => {
              const on = values.includes(o.value)
              const row = i + 1
              return (
                <button
                  type="button"
                  key={o.value}
                  id={`${listId}-opt-${row}`}
                  ref={(el) => { optRefs.current[row] = el }}
                  role="option"
                  aria-selected={on}
                  tabIndex={active === row ? 0 : -1}
                  className={`select-opt ${on ? 'active' : ''}`}
                  onFocus={() => setActive(row)}
                  onClick={() => toggle(o.value)}
                >
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
