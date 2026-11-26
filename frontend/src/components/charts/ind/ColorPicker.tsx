// 取色器：10 × 8 的色板（一行灰阶 + 十种色相各七档明度）、任意十六进制色值、R / G / B 三格、透明度滑块。
// 指标样式、画线设置、图表设置共用（2026-11-26 画线 / 图表设置从只有几个预设点的 ColorDot 换过来，
// 那个色板挂在对话框滚动区里会被裁掉）。可选 presets：在大色板上面多一行该处常用的颜色。
// 弹层 portal 到 body、按色块位置用 fixed 定位，放不下就翻到上方，免得被对话框的滚动区裁掉。
// Colour picker: a 10 × 8 palette (a grey row plus ten hues at seven lightness steps), any hex
// value, R / G / B fields and an opacity slider. Shared by indicator, drawing and chart settings;
// optional presets add a row of the colours that spot uses most above the big palette. The popover is portalled to body and positioned
// fixed from the swatch (flipping above when there's no room) so the dialog's scroller can't clip it.
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { useBackToClose } from '../../../utils/useBackToClose'

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

/** #rrggbbaa → { #rrggbb, 不透明度 % }；六位色不透明度 100 / split an 8-digit hex into colour + opacity % */
export function splitAlpha(c: string): { color: string; opacity: number } {
  if (/^#[0-9a-f]{8}$/i.test(c)) return { color: c.slice(0, 7).toLowerCase(), opacity: Math.round((parseInt(c.slice(7), 16) / 255) * 100) }
  return { color: c, opacity: 100 }
}
/** 不透明度不足 100 才写成八位色，满不透明仍是六位（旧数据、旧版 App 照常读）/ 8-digit only below 100% */
export function joinAlpha(color: string, opacity: number): string {
  if (!HEX.test(color) || opacity >= 100) return color
  return color.toLowerCase() + Math.round((Math.max(0, opacity) / 100) * 255).toString(16).padStart(2, '0')
}

const rgbOf = (hex: string): [number, number, number] | null =>
  HEX.test(hex) ? [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)] : null
const hexOf = (rgb: readonly number[]) => '#' + rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')

export function Swatch({ color, opacity = 100 }: { color: string; opacity?: number }) {
  return (
    <span className="cp-sw" aria-hidden>
      <i style={{ background: color, opacity: opacity / 100 }} />
    </span>
  )
}

/** 取色面板本体（色板 + 色值 + R/G/B + 不透明度），弹层里和别的菜单里（画线浮动工具条）都用它。
 *  The picker body (palettes + hex + R/G/B + opacity), used in the popover and embedded in other
 *  menus such as the drawing floating bar. */
export function ColorPanel({ color, opacity, onChange, resolved, presets }: {
  color: string
  opacity?: number
  onChange: (color: string, opacity?: number) => void
  resolved?: string
  presets?: readonly string[]
}) {
  const { t } = useTranslation()
  const shown = resolved ?? color
  const [hex, setHex] = useState(shown)
  useEffect(() => { setHex(shown) }, [shown])
  return (
    <>
      {presets && presets.length > 0 && (
        <div className="cp-grid cp-pre">
          {presets.map((c) => (
            <button key={c} type="button" className={`cp-c ${c.toLowerCase() === shown.toLowerCase() ? 'on' : ''}`} style={{ background: c }} aria-label={c} onClick={() => onChange(c, opacity)} />
          ))}
        </div>
      )}
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
      {/* R / G / B 三格：改任一格立刻生效 / editing any channel applies at once */}
      <div className="cp-row cp-rgb">
        {(['R', 'G', 'B'] as const).map((ch, i) => {
          const rgb = rgbOf(HEX.test(hex) ? hex : shown) ?? [0, 0, 0]
          return (
            <label key={ch} className="cp-ch">
              <span>{ch}</span>
              <input
                type="number"
                min={0}
                max={255}
                inputMode="numeric"
                value={rgb[i]}
                aria-label={ch}
                onChange={(e) => {
                  const n = Number(e.target.value)
                  if (!Number.isFinite(n)) return
                  const next = [...rgb]
                  next[i] = n
                  const v = hexOf(next)
                  setHex(v)
                  onChange(v, opacity)
                }}
              />
            </label>
          )
        })}
      </div>
      {opacity != null && (
        <div className="cp-row">
          <span className="cp-k">{t('charts.ind.ui.opacity')}</span>
          <input className="cp-range" type="range" min={0} max={100} step={1} value={opacity} aria-label={String(t('charts.ind.ui.opacity'))}
            style={{ ['--cp-c' as string]: HEX.test(shown) ? shown : '#888888' }}
            onChange={(e) => onChange(color, Number(e.target.value))} />
          <OpacityInput value={opacity} label={String(t('charts.ind.ui.opacity'))} onChange={(o) => onChange(color, o)} />
        </div>
      )}
    </>
  )
}

// 不透明度也能直接输入 %：边打边生效，清空或超出 0–100 时不回写，失焦恢复成当前值
// Opacity can be typed as a %: applies as you type; empty / out-of-range text isn't written back
// and blurring restores the current value
function OpacityInput({ value, label, onChange }: { value: number; label: string; onChange: (v: number) => void }) {
  const [text, setText] = useState(String(value))
  const [focused, setFocused] = useState(false)
  const shown = focused ? text : String(value)
  return (
    <label className="cp-ch cp-op">
      <input
        type="number"
        min={0}
        max={100}
        inputMode="numeric"
        value={shown}
        aria-label={label}
        onFocus={(e) => { setText(String(value)); setFocused(true); e.target.select() }}
        onBlur={() => setFocused(false)}
        onChange={(e) => {
          setText(e.target.value)
          const n = Number(e.target.value)
          if (e.target.value.trim() !== '' && Number.isFinite(n) && n >= 0 && n <= 100) onChange(Math.round(n))
        }}
      />
      <span>%</span>
    </label>
  )
}

export default function ColorPicker({ color, opacity, onChange, label, resolved, presets }: {
  color: string
  opacity?: number
  // 第二个参数为 undefined 表示没有透明度 / undefined opacity = no slider
  onChange: (color: string, opacity?: number) => void
  label: string
  // 'up' / 'down' 这种跟随色的实际显示值 / display value for follow colours like 'up' / 'down'
  resolved?: string
  /** 大色板上面多一行常用色 / an extra row of common colours above the palette */
  presets?: readonly string[]
}) {
  const [open, setOpen] = useState(false)
  useBackToClose(open, () => setOpen(false))
  const btn = useRef<HTMLButtonElement>(null)
  const pop = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const shown = resolved ?? color

  useLayoutEffect(() => {
    if (!open || !btn.current) return
    const r = btn.current.getBoundingClientRect()
    const w = 268
    const h = pop.current?.offsetHeight ?? 360
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
          <ColorPanel color={color} opacity={opacity} onChange={onChange} resolved={resolved} presets={presets} />
        </div>,
        document.body,
      )}
    </>
  )
}

/** 颜色带透明度存成一个字符串（#rrggbb 或 #rrggbbaa）的场合：画线颜色等。
 *  For places that store colour and opacity as one string (#rrggbb or #rrggbbaa), e.g. drawings. */
export function AlphaColorPicker({ value, onChange, label, presets }: { value: string; onChange: (v: string) => void; label: string; presets?: readonly string[] }) {
  const { color, opacity } = splitAlpha(value)
  return <ColorPicker color={color} opacity={opacity} label={label} presets={presets} onChange={(c, o) => onChange(joinAlpha(c, o ?? 100))} />
}

/** 同上，嵌在别的菜单里的面板版 / the same, as an embeddable panel */
export function AlphaColorPanel({ value, onChange, presets }: { value: string; onChange: (v: string) => void; presets?: readonly string[] }) {
  const { color, opacity } = splitAlpha(value)
  return <ColorPanel color={color} opacity={opacity} presets={presets} onChange={(c, o) => onChange(joinAlpha(c, o ?? 100))} />
}
