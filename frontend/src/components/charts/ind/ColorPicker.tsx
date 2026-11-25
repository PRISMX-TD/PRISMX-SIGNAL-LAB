// 指标样式的取色器：10 × 8 的色板（一行灰阶 + 十种色相各七档明度）、任意十六进制色值、透明度滑块。
// 弹层 portal 到 body、按色块位置用 fixed 定位，放不下就翻到上方，免得被对话框的滚动区裁掉。
// Indicator style colour picker: a 10 × 8 palette (a grey row plus ten hues at seven lightness
// steps), any hex value and an opacity slider. The popover is portalled to body and positioned
// fixed from the swatch (flipping above when there's no room) so the dialog's scroller can't clip it.
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'

function hsl(h: number, s: number, l: number): string {
  const a = (s / 100) * Math.min(l / 100, 1 - l / 100)
  const f = (n: number) => {
    const k = (n + h / 30) % 12
    const c = l / 100 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))
    return Math.round(c * 255).toString(16).padStart(2, '0')
  }
  return `#${f(0)}${f(8)}${f(4)}`
}

const HUES = [0, 25, 45, 120, 165, 190, 215, 240, 270, 320]
const LIGHT = [88, 78, 66, 55, 45, 35, 25]
export const PALETTE: string[] = [
  ...Array.from({ length: 10 }, (_, i) => { const v = Math.round(255 - (i * 255) / 9).toString(16).padStart(2, '0'); return `#${v}${v}${v}` }),
  ...LIGHT.flatMap((l) => HUES.map((h) => hsl(h, h === 45 ? 95 : 80, l))),
]

const HEX = /^#[0-9a-fA-F]{6}$/

export function Swatch({ color, opacity = 100 }: { color: string; opacity?: number }) {
  return (
    <span className="cp-sw" aria-hidden>
      <i style={{ background: color, opacity: opacity / 100 }} />
    </span>
  )
}

export default function ColorPicker({ color, opacity, onChange, label, resolved }: {
  color: string
  opacity?: number
  // 第二个参数为 undefined 表示没有透明度 / undefined opacity = no slider
  onChange: (color: string, opacity?: number) => void
  label: string
  // 'up' / 'down' 这种跟随色的实际显示值 / display value for follow colours like 'up' / 'down'
  resolved?: string
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const btn = useRef<HTMLButtonElement>(null)
  const pop = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const shown = resolved ?? color
  const [hex, setHex] = useState(shown)
  useEffect(() => { setHex(shown) }, [shown])

  useLayoutEffect(() => {
    if (!open || !btn.current) return
    const r = btn.current.getBoundingClientRect()
    const w = 268
    const h = pop.current?.offsetHeight ?? 300
    const left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left))
    const below = r.bottom + 6
    const top = below + h > window.innerHeight - 8 ? Math.max(8, r.top - h - 6) : below
    setPos({ left, top })
  }, [open])

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      const tg = e.target as Node
      if (pop.current?.contains(tg) || btn.current?.contains(tg)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false) } }
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey, true)
    return () => { document.removeEventListener('pointerdown', onDown, true); document.removeEventListener('keydown', onKey, true) }
  }, [open])

  return (
    <>
      <button ref={btn} type="button" className="cp-btn" aria-label={label} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <Swatch color={shown} opacity={opacity} />
      </button>
      {open && createPortal(
        <div ref={pop} className="cp-pop" role="dialog" aria-label={label} style={pos ? { left: pos.left, top: pos.top } : { visibility: 'hidden' }}>
          <div className="cp-grid">
            {PALETTE.map((c) => (
              <button key={c} type="button" className={`cp-c ${c.toLowerCase() === shown.toLowerCase() ? 'on' : ''}`} style={{ background: c }} aria-label={c} onClick={() => onChange(c, opacity)} />
            ))}
          </div>
          <div className="cp-row">
            <span className="cp-cur"><i style={{ background: HEX.test(hex) ? hex : shown }} /></span>
            <input
              className="cp-hex"
              value={hex}
              maxLength={7}
              spellCheck={false}
              aria-label={String(t('charts.ind.ui.hex'))}
              onChange={(e) => {
                const v = e.target.value.startsWith('#') ? e.target.value : `#${e.target.value}`
                setHex(v)
                if (HEX.test(v)) onChange(v.toLowerCase(), opacity)
              }}
            />
          </div>
          {opacity != null && (
            <div className="cp-row">
              <span className="cp-k">{t('charts.ind.ui.opacity')}</span>
              <input className="cp-range" type="range" min={0} max={100} step={5} value={opacity} aria-label={String(t('charts.ind.ui.opacity'))}
                style={{ ['--cp-c' as string]: HEX.test(shown) ? shown : '#888888' }}
                onChange={(e) => onChange(color, Number(e.target.value))} />
              <span className="cp-v">{opacity}%</span>
            </div>
          )}
        </div>,
        document.body,
      )}
    </>
  )
}
