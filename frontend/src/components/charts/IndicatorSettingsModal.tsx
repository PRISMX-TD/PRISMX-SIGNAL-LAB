// 指标面板：开关 + 周期/颜色客制化，六个指标各一行。字段改动即时生效（由父组件
// ChartsPage 重新计算并画到图上），面板本身不缓存草稿、没有单独的"保存"步骤
// ——与站内其它偏好设置（画线颜色、下单默认手数等）的即时生效习惯一致。
// MA/EMA 是变长的均线列表，可逐条增删；颜色一律从预设色板点选，不用原生取色器。
// 2026-09-08 重做：桌面是居中的一张面（560 宽），手机是贴底抽屉；发丝线一行一个
// 指标，行头是开关 + 名称 + 当前颜色点 + 参数摘要，参数区在行下（关掉时减淡但仍
// 可改）。整个面板 portal 到 body——页面切换动画给 <main> 造了层叠上下文，留在里
// 面的话再高的 z-index 也压不过全站底栏（z-40），之前手机上就是这样被底栏挡住。
// Indicator panel: on/off + period/color customization, one hairline row per
// indicator. Edits apply immediately (ChartsPage recomputes and redraws); no
// draft state, no separate Save. MA/EMA are variable-length line lists; colors
// come from a preset palette, never a native picker.
// Redone 2026-09-08: a centered 560px plane on desktop, a bottom sheet on
// mobile. Row head = switch + name + current color dots + a parameter summary;
// params sit under the row (dimmed when off, still editable). The whole panel
// is portalled to body: the page-enter animation gives <main> a stacking
// context inside which no z-index beats the app tab bar (z-40), which is how
// the tab bar used to cover this panel on phones.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import Switch from '../Switch'
import type { IndicatorFlags } from './chartConfig'
import {
  COLOR_PRESETS,
  MAX_LINES,
  MIN_LINES,
  addLine,
  removeLine,
  type IndicatorSettings,
  type LinesConfig,
} from './indicatorSettings'
import { useBackToClose } from '../../utils/useBackToClose'

interface Props {
  indicators: IndicatorFlags
  onToggle: (key: keyof IndicatorFlags) => void
  settings: IndicatorSettings
  onChange: (next: IndicatorSettings) => void
  onReset: () => void
  onClose: () => void
}

// 数字框：失焦才解析、夹紧、上报——逐键夹紧会把正在输入的 "1" 弹成下限。
// Number field: parse / clamp / propagate on blur only — clamping per keystroke
// bounces a half-typed "1" to the minimum.
function Num({ value, min = 1, max = 500, isFloat = false, onChange, ariaLabel }: {
  value: number
  min?: number
  max?: number
  isFloat?: boolean
  onChange: (v: number) => void
  ariaLabel: string
}) {
  const [text, setText] = useState(String(value))
  useEffect(() => { setText(String(value)) }, [value])
  const commit = () => {
    const n = isFloat ? parseFloat(text) : parseInt(text, 10)
    const clamped = !Number.isFinite(n) ? value : Math.min(max, Math.max(min, n))
    setText(String(clamped))
    if (clamped !== value) onChange(clamped)
  }
  return (
    <input
      className="ind-in"
      value={text}
      inputMode={isFloat ? 'decimal' : 'numeric'}
      aria-label={ariaLabel}
      onChange={(e) => setText(e.target.value.replace(isFloat ? /[^0-9.]/g : /[^0-9]/g, ''))}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
    />
  )
}

// 颜色选择：一个圆点，点开一小块预设色板，点色即选中并关闭——不出现系统取色器。
// 它是"弹窗里的弹窗"：划返回先收色板，再收整个面板。
// Color picker: a dot that opens a small preset palette; picking closes it — no
// native picker. Nested modal: swipe-back closes the palette first, then the panel.
function ColorDot({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
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
          {COLOR_PRESETS.map((c) => (
            <button
              key={c}
              type="button"
              role="option"
              aria-selected={c === value}
              className={`ind-dot sm ${c === value ? 'on' : ''}`}
              style={{ background: c }}
              onClick={() => { onChange(c); setOpen(false) }}
            />
          ))}
        </span>
      )}
    </span>
  )
}

function Field({ k, children }: { k: string; children: ReactNode }) {
  return (
    <label className="ind-f">
      <span className="k">{k}</span>
      {children}
    </label>
  )
}

// MA/EMA 的均线列表：一条一枚药丸（周期 · 颜色 · 删），末尾一枚虚线「添加」。
// MA/EMA line list: one pill per line (period · color · remove) and a dashed "add" pill.
function LineList({ cfg, onChange }: { cfg: LinesConfig; onChange: (next: LinesConfig) => void }) {
  const { t } = useTranslation()
  return (
    <div className="ind-lines">
      {cfg.periods.map((period, i) => (
        <span key={i} className="ind-line">
          <Num
            value={period}
            ariaLabel={`${t('charts.indicators.period')} ${i + 1}`}
            onChange={(v) => { const periods = [...cfg.periods]; periods[i] = v; onChange({ ...cfg, periods }) }}
          />
          <ColorDot
            value={cfg.colors[i]}
            label={String(t('charts.indicators.color'))}
            onChange={(v) => { const colors = [...cfg.colors]; colors[i] = v; onChange({ ...cfg, colors }) }}
          />
          <button
            type="button"
            className="ind-x"
            onClick={() => onChange(removeLine(cfg, i))}
            disabled={cfg.periods.length <= MIN_LINES}
            aria-label={String(t('charts.indicators.removeLine'))}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
          </button>
        </span>
      ))}
      <button type="button" className="ind-add" onClick={() => onChange(addLine(cfg))} disabled={cfg.periods.length >= MAX_LINES}>
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
        {t('charts.indicators.addLine')}
      </button>
    </div>
  )
}

// 一行指标：开关 + 名称 + 当前颜色点 + 参数摘要；参数区在下，关掉时减淡但仍可改。
// One indicator row: switch + name + color dots + summary; params below, dimmed when off.
function Row({ on, onToggle, name, colors, summary, children }: {
  on: boolean
  onToggle: () => void
  name: string
  colors: string[]
  summary: string
  children: ReactNode
}) {
  return (
    <div className="ind-row" data-off={!on || undefined}>
      <div className="ind-head">
        <Switch checked={on} onChange={onToggle} aria-label={name} />
        <span className="ind-name">{name}</span>
        <span className="ind-sw" aria-hidden>{colors.map((c, i) => <i key={i} style={{ background: c }} />)}</span>
        <span className="ind-sum">{summary}</span>
      </div>
      <div className="ind-body">{children}</div>
    </div>
  )
}

export default function IndicatorSettingsModal({ indicators, onToggle, settings, onChange, onReset, onClose }: Props) {
  const { t } = useTranslation()
  const onCount = Object.values(indicators).filter(Boolean).length

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const period = String(t('charts.indicators.period'))
  const color = String(t('charts.indicators.color'))

  return createPortal(
    <div className="ind-overlay" onClick={onClose}>
      <div className="ind-dlg" role="dialog" aria-modal="true" aria-label={String(t('charts.indicators.settingsTitle'))} onClick={(e) => e.stopPropagation()}>
        <div className="ind-hd">
          <div>
            <h3>{t('charts.indicators.settingsTitle')}</h3>
            <span>{t('charts.indicators.enabledCount', { n: onCount })}</span>
          </div>
          <button type="button" className="ind-close" onClick={onClose} aria-label={String(t('common.close'))}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
          </button>
        </div>

        <div className="ind-list no-sb">
          <Row on={indicators.ma} onToggle={() => onToggle('ma')} name={String(t('charts.indicators.ma'))} colors={settings.ma.colors} summary={settings.ma.periods.join(' · ')}>
            <LineList cfg={settings.ma} onChange={(ma) => onChange({ ...settings, ma })} />
          </Row>

          <Row on={indicators.ema} onToggle={() => onToggle('ema')} name={String(t('charts.indicators.ema'))} colors={settings.ema.colors} summary={settings.ema.periods.join(' · ')}>
            <LineList cfg={settings.ema} onChange={(ema) => onChange({ ...settings, ema })} />
          </Row>

          <Row on={indicators.boll} onToggle={() => onToggle('boll')} name={String(t('charts.indicators.boll'))} colors={[settings.boll.color]} summary={`${settings.boll.period} × ${settings.boll.mult}σ`}>
            <div className="ind-params">
              <Field k={period}><Num value={settings.boll.period} ariaLabel={period} onChange={(v) => onChange({ ...settings, boll: { ...settings.boll, period: v } })} /></Field>
              <Field k={String(t('charts.indicators.multiplier'))}><Num value={settings.boll.mult} min={1} max={5} isFloat ariaLabel={String(t('charts.indicators.multiplier'))} onChange={(v) => onChange({ ...settings, boll: { ...settings.boll, mult: v } })} /></Field>
              <Field k={color}><ColorDot value={settings.boll.color} label={color} onChange={(v) => onChange({ ...settings, boll: { ...settings.boll, color: v } })} /></Field>
            </div>
          </Row>

          <Row on={indicators.volume} onToggle={() => onToggle('volume')} name={String(t('charts.indicators.volume'))} colors={[settings.volume.upColor, settings.volume.downColor]} summary="">
            <div className="ind-params">
              <Field k={String(t('charts.indicators.upColor'))}><ColorDot value={settings.volume.upColor} label={String(t('charts.indicators.upColor'))} onChange={(v) => onChange({ ...settings, volume: { ...settings.volume, upColor: v } })} /></Field>
              <Field k={String(t('charts.indicators.downColor'))}><ColorDot value={settings.volume.downColor} label={String(t('charts.indicators.downColor'))} onChange={(v) => onChange({ ...settings, volume: { ...settings.volume, downColor: v } })} /></Field>
            </div>
          </Row>

          <Row on={indicators.rsi} onToggle={() => onToggle('rsi')} name={String(t('charts.indicators.rsi'))} colors={[settings.rsi.color]} summary={`${settings.rsi.period} · ${settings.rsi.overbought} / ${settings.rsi.oversold}`}>
            <div className="ind-params">
              <Field k={period}><Num value={settings.rsi.period} ariaLabel={period} onChange={(v) => onChange({ ...settings, rsi: { ...settings.rsi, period: v } })} /></Field>
              <Field k={String(t('charts.indicators.overbought'))}><Num value={settings.rsi.overbought} min={50} max={99} ariaLabel={String(t('charts.indicators.overbought'))} onChange={(v) => onChange({ ...settings, rsi: { ...settings.rsi, overbought: v } })} /></Field>
              <Field k={String(t('charts.indicators.oversold'))}><Num value={settings.rsi.oversold} min={1} max={50} ariaLabel={String(t('charts.indicators.oversold'))} onChange={(v) => onChange({ ...settings, rsi: { ...settings.rsi, oversold: v } })} /></Field>
              <Field k={color}><ColorDot value={settings.rsi.color} label={color} onChange={(v) => onChange({ ...settings, rsi: { ...settings.rsi, color: v } })} /></Field>
            </div>
          </Row>

          <Row on={indicators.macd} onToggle={() => onToggle('macd')} name={String(t('charts.indicators.macd'))} colors={[settings.macd.macdColor, settings.macd.signalColor]} summary={`${settings.macd.fast} · ${settings.macd.slow} · ${settings.macd.signal}`}>
            <div className="ind-params">
              <Field k={String(t('charts.indicators.fast'))}><Num value={settings.macd.fast} ariaLabel={String(t('charts.indicators.fast'))} onChange={(v) => onChange({ ...settings, macd: { ...settings.macd, fast: v } })} /></Field>
              <Field k={String(t('charts.indicators.slow'))}><Num value={settings.macd.slow} ariaLabel={String(t('charts.indicators.slow'))} onChange={(v) => onChange({ ...settings, macd: { ...settings.macd, slow: v } })} /></Field>
              <Field k={String(t('charts.indicators.signal'))}><Num value={settings.macd.signal} ariaLabel={String(t('charts.indicators.signal'))} onChange={(v) => onChange({ ...settings, macd: { ...settings.macd, signal: v } })} /></Field>
              <Field k="MACD"><ColorDot value={settings.macd.macdColor} label="MACD" onChange={(v) => onChange({ ...settings, macd: { ...settings.macd, macdColor: v } })} /></Field>
              <Field k={String(t('charts.indicators.signal'))}><ColorDot value={settings.macd.signalColor} label={String(t('charts.indicators.signal'))} onChange={(v) => onChange({ ...settings, macd: { ...settings.macd, signalColor: v } })} /></Field>
            </div>
          </Row>
        </div>

        <div className="ind-ft">
          <button type="button" className="ind-btn" onClick={onReset}>{t('charts.indicators.reset')}</button>
          <button type="button" className="ind-btn primary" onClick={onClose}>{t('charts.indicators.done')}</button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
