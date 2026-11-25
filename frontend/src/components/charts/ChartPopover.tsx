// 图表页通用弹出层：portal 到 body、按锚点 fixed 定位（放不下就往上翻）、点外面 / Esc /
// 安卓返回键关闭。抽自原齿轮小菜单（ChartSettingsMenu，已删）的同一套逻辑，周期菜单、图表类型菜单、时区菜单共用。
// Shared chart popover: portalled to body, fixed-positioned from its anchor (flips above when
// it doesn't fit), closed by an outside click / Escape / Android back. The same logic as the old gear menu
// (ChartSettingsMenu, now deleted), factored out for the interval, chart-type and timezone menus.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { useBackToClose } from '../../utils/useBackToClose'
import { usePopoverEscape } from '../../utils/usePopoverEscape'

interface Props {
  open: boolean
  onClose: () => void
  anchorRef: RefObject<HTMLElement>
  width: number
  align?: 'start' | 'end'
  label: string
  className?: string
  children: ReactNode
}

export default function ChartPopover({ open, onClose, anchorRef, width, align = 'start', label, className = '', children }: Props) {
  const menuRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number; maxHeight?: number }>({ top: -9999, left: -9999 })
  useBackToClose(open, onClose)

  useLayoutEffect(() => {
    if (!open || !anchorRef.current) return
    const r = anchorRef.current.getBoundingClientRect()
    const w = Math.min(width, window.innerWidth - 16)
    const x = align === 'end' ? r.right - w : r.left
    const left = Math.max(8, Math.min(window.innerWidth - w - 8, x))
    const tabbar = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--app-tabbar')) || 0
    const h = menuRef.current?.offsetHeight ?? 0
    const below = window.innerHeight - tabbar - 8 - (r.bottom + 6)
    const above = r.top - 6 - 8
    if (h <= below || below >= above) setPos({ top: r.bottom + 6, left, maxHeight: below })
    else setPos({ top: Math.max(8, r.top - 6 - Math.min(h, above)), left, maxHeight: above })
  }, [open, width, align, anchorRef])

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      const n = e.target as Node
      if (menuRef.current?.contains(n) || anchorRef.current?.contains(n)) return
      onClose()
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [open, onClose, anchorRef])
  usePopoverEscape(open, onClose, anchorRef as RefObject<HTMLButtonElement>, menuRef)

  if (!open) return null
  return createPortal(
    <div
      ref={menuRef}
      className={`chart-pop ${className}`}
      role="dialog"
      aria-label={label}
      style={{ top: pos.top, left: pos.left, width: Math.min(width, window.innerWidth - 16), maxHeight: pos.maxHeight }}
    >
      {children}
    </div>,
    document.body,
  )
}
