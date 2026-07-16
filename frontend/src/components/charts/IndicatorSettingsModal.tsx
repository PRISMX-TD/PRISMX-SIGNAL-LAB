// 指标设置弹窗：开关 + 周期/颜色客制化，六个指标各一张卡片。字段改动即时
// 生效（由父组件 ChartsPage 重新计算并画到图上），弹窗本身不缓存草稿、没有
// 单独的"保存"步骤——与站内其它偏好设置（画线颜色、下单默认手数等）的即时
// 生效习惯保持一致。MA/EMA 是变长的均线列表，可逐条增删；颜色一律从预设
// 色板点选，不用原生 RGB 取色器（那对大多数用户是不必要的复杂度）。
// Indicator settings modal: on/off + period/color customization, one card per
// indicator. Field edits take effect immediately (the parent ChartsPage
// recomputes and redraws) — the modal holds no draft state and has no
// separate "Save" step, consistent with how other in-app preferences (draw
// colors, default order volume, etc.) already apply instantly. MA/EMA are
// variable-length line lists that can be added to / removed from one at a
// time; colors are always picked from a preset palette rather than a native
// RGB picker (unnecessary complexity for most users).
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { IndicatorFlags } from '../../pages/ChartsPage'
import {
  COLOR_PRESETS,
  MAX_LINES,
  MIN_LINES,
  addLine,
  removeLine,
  type IndicatorSettings,
  type LinesConfig,
} from './indicatorSettings'

interface Props {
  indicators: IndicatorFlags
  onToggle: (key: keyof IndicatorFlags) => void
  settings: IndicatorSettings
  onChange: (next: IndicatorSettings) => void
  onReset: () => void
  onClose: () => void
}

function NumberField({
  label,
  value,
  onChange,
  min = 1,
  max = 500,
}: {
  label: string
  value: number
  onChange: (v: number) => void
  min?: number
  max?: number
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-wide text-slate-500">{label}</span>
      <input
        type="number"
        className="input w-16 px-1.5 py-1 text-center text-xs"
        min={min}
        max={max}
        value={value}
        onChange={(e) => {
          const n = parseInt(e.target.value, 10)
          if (!Number.isNaN(n)) onChange(Math.min(max, Math.max(min, n)))
        }}
      />
    </label>
  )
}

// 颜色选择：一个圆形色块按钮，点开一个装着预设色板的小弹层，点色板里的颜色
// 即选中并关闭——不出现系统原生的 RGB 取色器。
// Color picker: a circular swatch button; clicking opens a small popover of
// preset colors, clicking one selects it and closes the popover — no native
// OS/RGB color picker ever appears.
function ColorPicker({ label, value, onChange }: { label?: string; value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [open])

  return (
    <div className="relative flex flex-col gap-1" ref={rootRef}>
      {label && <span className="text-[10px] uppercase tracking-wide text-slate-500">{label}</span>}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="h-6 w-6 shrink-0 rounded-full border-2 border-white/25 transition hover:border-white/50"
        style={{ background: value }}
        aria-label={label}
      />
      {open && (
        // 移动端（<640px）：不跟着按钮悬浮定位，改成贴底固定的小抽屉——
        // inset-x-4 保证不管按钮在弹窗里多靠右，色板永远整体落在屏幕可见
        // 范围内，不会被裁切/伸到屏幕外。桌面端（sm: 以上）维持贴着按钮下方
        // 的小悬浮面板，给一个明确宽度（w-40）而不是让内容撑开，避免网格在
        // 窄父级里挤压出圆点重叠的观感。
        // Mobile (<640px): don't float-anchor to the button — become a small
        // fixed bottom drawer instead. inset-x-4 guarantees the palette
        // always lands fully within the visible screen regardless of how far
        // right the triggering button sits, so it can never get clipped or
        // pushed off-screen. Desktop (sm: and up) keeps the small popover
        // anchored just below the button, given an explicit width (w-40)
        // instead of shrink-to-fit, so the grid never gets squeezed into
        // overlapping-looking circles by an ambiguous parent width.
        <div className="fixed inset-x-4 bottom-4 z-30 grid grid-cols-5 gap-2 rounded-xl border border-white/10 bg-ink-900/95 p-3 shadow-prism backdrop-blur sm:absolute sm:inset-x-auto sm:bottom-auto sm:left-0 sm:top-full sm:z-30 sm:mt-1 sm:w-40 sm:gap-1.5 sm:rounded-lg sm:p-2">
          {COLOR_PRESETS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => {
                onChange(c)
                setOpen(false)
              }}
              className={`h-6 w-6 shrink-0 rounded-full border-2 transition hover:border-white/70 sm:h-5 sm:w-5 ${c === value ? 'border-white' : 'border-white/20'}`}
              style={{ background: c }}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// MA/EMA 共用的"均线列表"编辑区：逐条显示周期 + 颜色 + 删除按钮，底部一个
// "添加"按钮；条数触达上下限时对应按钮置灰。
// The line-list editor shared by MA/EMA: each line shows period + color +
// a remove button, with an "add" button below; add/remove disable at the
// configured bounds.
function LineList({ cfg, onChange }: { cfg: LinesConfig; onChange: (next: LinesConfig) => void }) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col gap-2">
      {cfg.periods.map((period, i) => (
        <div key={i} className="flex items-end gap-2">
          <NumberField
            label={`${t('charts.indicators.period')} ${i + 1}`}
            value={period}
            onChange={(v) => {
              const periods = [...cfg.periods]
              periods[i] = v
              onChange({ ...cfg, periods })
            }}
          />
          <ColorPicker
            value={cfg.colors[i]}
            onChange={(v) => {
              const colors = [...cfg.colors]
              colors[i] = v
              onChange({ ...cfg, colors })
            }}
          />
          <button
            type="button"
            onClick={() => onChange(removeLine(cfg, i))}
            disabled={cfg.periods.length <= MIN_LINES}
            className="mb-0.5 flex h-6 w-6 items-center justify-center rounded-md text-slate-500 transition hover:text-down disabled:cursor-not-allowed disabled:opacity-30"
            aria-label={t('charts.indicators.removeLine')}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange(addLine(cfg))}
        disabled={cfg.periods.length >= MAX_LINES}
        className="flex w-fit items-center gap-1 rounded-md border border-dashed border-white/20 px-2 py-1 text-[11px] text-slate-400 transition hover:border-prism-500/50 hover:text-prism-200 disabled:cursor-not-allowed disabled:opacity-30"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
        {t('charts.indicators.addLine')}
      </button>
    </div>
  )
}

// 一张指标卡片：开关 + 标题 + 参数区（禁用时整体降低透明度但不隐藏，用户
// 仍能看到/预设参数，只是要先勾选开关才会画到图上）。
// One indicator card: toggle + title + params area (dims when off but stays
// visible/editable — the user can still see and pre-configure the settings
// before flipping the toggle to actually draw it).
function Card({
  checked,
  onToggle,
  title,
  children,
}: {
  checked: boolean
  onToggle: () => void
  title: string
  children: ReactNode
}) {
  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.02] p-3">
      <label className="flex cursor-pointer items-center gap-2">
        <input type="checkbox" checked={checked} onChange={onToggle} className="h-4 w-4 accent-prism-500" />
        <span className="text-sm font-semibold text-slate-100">{title}</span>
      </label>
      <div className={`mt-2.5 pl-6 transition-opacity ${checked ? '' : 'opacity-40'}`}>{children}</div>
    </div>
  )
}

export default function IndicatorSettingsModal({ indicators, onToggle, settings, onChange, onReset, onClose }: Props) {
  const { t } = useTranslation()

  return (
    <div className="slide-overlay" onClick={onClose}>
      {/* 宽度不用内联 style：.slide-sheet 自带的移动端媒体查询
          （<640px 时变成贴底全屏抽屉）靠的就是 CSS 类选择器，内联 style 的
          优先级会盖过媒体查询把它废掉——之前 style={{width:480}} 正是这样
          在手机上把全站统一的抽屉式弹窗行为顶掉，导致内容在窄屏上溢出。
          这里改用 Tailwind 的 sm: 前缀只在桌面宽度（≥640px，与站内媒体查询
          的断点严丝合缝互补）加宽到 480px，移动端完全交还给已验证过的
          抽屉样式。
          No inline style for width: .slide-sheet's own mobile media query
          (becomes a full-width bottom sheet below 640px) relies on a plain
          CSS class selector, and an inline style's specificity beats a media
          query outright — that's exactly how the previous
          style={{width:480}} clobbered the site-wide bottom-sheet modal
          behavior on phones, causing content to overflow on narrow screens.
          Using Tailwind's sm: prefix here only widens to 480px at desktop
          widths (>=640px, which dovetails exactly with the site's own
          breakpoint), leaving mobile entirely to the already-proven sheet
          style. */}
      <div className="slide-sheet sm:w-[480px]" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-bold text-white">{t('charts.indicators.settingsTitle')}</h3>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-white" aria-label={t('common.close')}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
          </button>
        </div>

        <div className="mt-3 flex flex-col gap-3">
          <Card checked={indicators.ma} onToggle={() => onToggle('ma')} title={t('charts.indicators.ma')}>
            <LineList cfg={settings.ma} onChange={(ma) => onChange({ ...settings, ma })} />
          </Card>

          <Card checked={indicators.ema} onToggle={() => onToggle('ema')} title={t('charts.indicators.ema')}>
            <LineList cfg={settings.ema} onChange={(ema) => onChange({ ...settings, ema })} />
          </Card>

          <Card checked={indicators.boll} onToggle={() => onToggle('boll')} title={t('charts.indicators.boll')}>
            <div className="flex flex-wrap items-end gap-3">
              <NumberField
                label={t('charts.indicators.period')}
                value={settings.boll.period}
                onChange={(v) => onChange({ ...settings, boll: { ...settings.boll, period: v } })}
              />
              <NumberField
                label={t('charts.indicators.multiplier')}
                value={settings.boll.mult}
                min={1}
                max={5}
                onChange={(v) => onChange({ ...settings, boll: { ...settings.boll, mult: v } })}
              />
              <ColorPicker
                label={t('charts.indicators.color')}
                value={settings.boll.color}
                onChange={(v) => onChange({ ...settings, boll: { ...settings.boll, color: v } })}
              />
            </div>
          </Card>

          <Card checked={indicators.volume} onToggle={() => onToggle('volume')} title={t('charts.indicators.volume')}>
            <div className="flex flex-wrap items-end gap-3">
              <ColorPicker
                label={t('charts.indicators.upColor')}
                value={settings.volume.upColor}
                onChange={(v) => onChange({ ...settings, volume: { ...settings.volume, upColor: v } })}
              />
              <ColorPicker
                label={t('charts.indicators.downColor')}
                value={settings.volume.downColor}
                onChange={(v) => onChange({ ...settings, volume: { ...settings.volume, downColor: v } })}
              />
            </div>
          </Card>

          <Card checked={indicators.rsi} onToggle={() => onToggle('rsi')} title={t('charts.indicators.rsi')}>
            <div className="flex flex-wrap items-end gap-3">
              <NumberField
                label={t('charts.indicators.period')}
                value={settings.rsi.period}
                onChange={(v) => onChange({ ...settings, rsi: { ...settings.rsi, period: v } })}
              />
              <NumberField
                label={t('charts.indicators.overbought')}
                value={settings.rsi.overbought}
                min={50}
                max={99}
                onChange={(v) => onChange({ ...settings, rsi: { ...settings.rsi, overbought: v } })}
              />
              <NumberField
                label={t('charts.indicators.oversold')}
                value={settings.rsi.oversold}
                min={1}
                max={50}
                onChange={(v) => onChange({ ...settings, rsi: { ...settings.rsi, oversold: v } })}
              />
              <ColorPicker
                label={t('charts.indicators.color')}
                value={settings.rsi.color}
                onChange={(v) => onChange({ ...settings, rsi: { ...settings.rsi, color: v } })}
              />
            </div>
          </Card>

          <Card checked={indicators.macd} onToggle={() => onToggle('macd')} title={t('charts.indicators.macd')}>
            <div className="flex flex-wrap items-end gap-3">
              <NumberField
                label={t('charts.indicators.fast')}
                value={settings.macd.fast}
                onChange={(v) => onChange({ ...settings, macd: { ...settings.macd, fast: v } })}
              />
              <NumberField
                label={t('charts.indicators.slow')}
                value={settings.macd.slow}
                onChange={(v) => onChange({ ...settings, macd: { ...settings.macd, slow: v } })}
              />
              <NumberField
                label={t('charts.indicators.signal')}
                value={settings.macd.signal}
                onChange={(v) => onChange({ ...settings, macd: { ...settings.macd, signal: v } })}
              />
              <ColorPicker
                label="MACD"
                value={settings.macd.macdColor}
                onChange={(v) => onChange({ ...settings, macd: { ...settings.macd, macdColor: v } })}
              />
              <ColorPicker
                label={t('charts.indicators.signal')}
                value={settings.macd.signalColor}
                onChange={(v) => onChange({ ...settings, macd: { ...settings.macd, signalColor: v } })}
              />
            </div>
          </Card>
        </div>

        <div className="mt-4 flex gap-3">
          <button onClick={onReset} className="btn-ghost flex-1 py-2 text-sm">
            {t('charts.indicators.reset')}
          </button>
          <button onClick={onClose} className="btn-primary flex-1 rounded-xl py-2 text-sm font-semibold">
            {t('charts.indicators.done')}
          </button>
        </div>
      </div>
    </div>
  )
}
