// iOS 式分段控件：选中块是一块滑动的「拇指」，在选项之间平移过去，而不是各自亮灭——
// 动画只为说明「选择从这里换到了那里」。位置按选中按钮的实际 offsetLeft / 宽度量出来，
// 只改 transform 与 width（width 只在换选项时变一次）。减少动态时直接跳到位。
// iOS-style segmented control: the selection is one sliding thumb that travels between
// options instead of each one lighting up, so the change reads as "moved from here to there".
// Its box is measured from the selected button (offsetLeft / width); only transform and
// width change (width once per switch). Reduced motion jumps straight there.
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'

export interface SegOption<T extends string> {
  value: T
  label: ReactNode
  title?: string
}

interface Props<T extends string> {
  value: T | null
  options: readonly SegOption<T>[]
  onChange: (v: T) => void
  ariaLabel: string
  size?: 'sm' | 'md'
  className?: string
}

export default function ProSegmented<T extends string>({ value, options, onChange, ariaLabel, size = 'md', className = '' }: Props<T>) {
  const wrap = useRef<HTMLDivElement>(null)
  const [thumb, setThumb] = useState<{ x: number; w: number } | null>(null)
  // 第一次定位不播动画（不然拇指会从最左边滑进来）/ the first placement doesn't animate
  const placed = useRef(false)

  useLayoutEffect(() => {
    const el = wrap.current
    if (!el) return
    const measure = () => {
      const btn = el.querySelector<HTMLButtonElement>('button[aria-checked="true"]')
      if (!btn) { setThumb(null); return }
      setThumb({ x: btn.offsetLeft, w: btn.offsetWidth })
    }
    measure()
    // 字体载入、语言切换都会改按钮宽度 / font loads and language switches change button widths
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [value, options])
  useLayoutEffect(() => {
    if (!thumb || placed.current) return
    const id = requestAnimationFrame(() => { placed.current = true })
    return () => cancelAnimationFrame(id)
  }, [thumb])

  return (
    <div ref={wrap} className={`pt-seg pt-seg--${size} ${className}`} role="radiogroup" aria-label={ariaLabel}>
      {thumb && (
        <span
          className={`pt-seg-thumb ${placed.current ? '' : 'instant'}`}
          style={{ width: thumb.w, transform: `translateX(${thumb.x}px)` }}
          aria-hidden
        />
      )}
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          title={o.title}
          className={o.value === value ? 'on' : ''}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
