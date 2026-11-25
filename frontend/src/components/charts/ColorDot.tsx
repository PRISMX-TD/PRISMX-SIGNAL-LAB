// 颜色点：点开一小块预设色板，点色即选中并关闭——不出现系统取色器。
// 它是"弹窗里的弹窗"：划返回先收色板，再收整个面板。图表设置、画线设置都用它，各传自己的色板。
// （2026-11-25 从旧的指标面板 IndicatorSettingsModal 搬出；指标设置改用 ind/ColorPicker 的自由取色。）
// Color dot opening a preset palette; a nested modal for swipe-back. Used by the chart and drawing
// settings with their own palettes. (Moved out of the old IndicatorSettingsModal on 2026-11-25;
// indicator settings now use the free picker in ind/ColorPicker.)
import { useEffect, useRef, useState } from 'react'
import { COLOR_PRESETS } from './indicatorSettings'
import { useBackToClose } from '../../utils/useBackToClose'

export function ColorDot({ value, onChange, label, palette = COLOR_PRESETS }: { value: string; onChange: (v: string) => void; label: string; palette?: readonly string[] }) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLSpanElement>(null)
  useBackToClose(open, () => setOpen(false))
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [open])
  return (
    <span className="ind-cp" ref={rootRef}>
      <button type="button" className="ind-dot" style={{ background: value }} aria-label={label} aria-expanded={open} onClick={() => setOpen((v) => !v)} />
      {open && (
        <span className="ind-pal" role="listbox">
          {palette.map((c) => (
            <button key={c} type="button" role="option" aria-selected={c === value} className={`ind-dot sm ${c === value ? 'on' : ''}`} style={{ background: c }} onClick={() => { onChange(c); setOpen(false) }} />
          ))}
        </span>
      )}
    </span>
  )
}
