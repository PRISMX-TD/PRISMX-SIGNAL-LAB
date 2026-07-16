// 指标设置弹窗：开关 + 周期/颜色客制化，六个指标各一行。字段改动即时生效
// （由父组件 ChartsPage 重新计算并画到图上），弹窗本身不缓存草稿、没有单独
// 的"保存"步骤——与站内其它偏好设置（画线颜色、下单默认手数等）的即时生效
// 习惯保持一致。
// Indicator settings modal: on/off + period/color customization, one row per
// indicator. Field edits take effect immediately (the parent ChartsPage
// recomputes and redraws) — the modal holds no draft state and has no
// separate "Save" step, consistent with how other in-app preferences (draw
// colors, default order volume, etc.) already apply instantly.
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { IndicatorFlags } from '../../pages/ChartsPage'
import type { IndicatorSettings } from './indicatorSettings'

interface Props {
  indicators: IndicatorFlags
  onToggle: (key: keyof IndicatorFlags) => void
  settings: IndicatorSettings
  onChange: (next: IndicatorSettings) => void
  onReset: () => void
  onClose: () => void
}

function NumberField({
  value,
  onChange,
  min = 1,
  max = 500,
  width = 52,
}: {
  value: number
  onChange: (v: number) => void
  min?: number
  max?: number
  width?: number
}) {
  return (
    <input
      type="number"
      className="input px-1.5 py-1 text-center text-xs"
      style={{ width }}
      min={min}
      max={max}
      value={value}
      onChange={(e) => {
        const n = parseInt(e.target.value, 10)
        if (!Number.isNaN(n)) onChange(Math.min(max, Math.max(min, n)))
      }}
    />
  )
}

function ColorSwatch({ value, onChange, title }: { value: string; onChange: (v: string) => void; title?: string }) {
  return (
    <label
      title={title}
      className="relative inline-block h-5 w-5 shrink-0 cursor-pointer overflow-hidden rounded-full border border-white/25"
      style={{ background: value }}
    >
      <input
        type="color"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
      />
    </label>
  )
}

// 一行的外壳：开关 + 标题 + 参数区 / row shell: toggle + title + params area
function Row({
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
    <div className="border-b border-white/10 py-3 last:border-b-0">
      <label className="flex cursor-pointer items-center gap-2">
        <input type="checkbox" checked={checked} onChange={onToggle} className="h-4 w-4 accent-prism-500" />
        <span className="text-sm font-semibold text-slate-100">{title}</span>
      </label>
      <div className={`mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 pl-6 transition-opacity ${checked ? '' : 'opacity-40'}`}>
        {children}
      </div>
    </div>
  )
}

export default function IndicatorSettingsModal({ indicators, onToggle, settings, onChange, onReset, onClose }: Props) {
  const { t } = useTranslation()

  return (
    <div className="slide-overlay" onClick={onClose}>
      <div className="slide-sheet" style={{ width: 440 }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-bold text-white">{t('charts.indicators.settingsTitle')}</h3>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-white" aria-label={t('common.close')}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
          </button>
        </div>

        <div className="mt-3">
          {/* MA */}
          <Row checked={indicators.ma} onToggle={() => onToggle('ma')} title={t('charts.indicators.ma')}>
            <span className="text-xs text-slate-500">{t('charts.indicators.periods')}</span>
            {settings.ma.periods.map((p, i) => (
              <NumberField
                key={i}
                value={p}
                onChange={(v) => {
                  const periods = [...settings.ma.periods] as [number, number, number]
                  periods[i] = v
                  onChange({ ...settings, ma: { ...settings.ma, periods } })
                }}
              />
            ))}
            <span className="text-xs text-slate-500">{t('charts.indicators.colors')}</span>
            {settings.ma.colors.map((c, i) => (
              <ColorSwatch
                key={i}
                value={c}
                onChange={(v) => {
                  const colors = [...settings.ma.colors] as [string, string, string]
                  colors[i] = v
                  onChange({ ...settings, ma: { ...settings.ma, colors } })
                }}
              />
            ))}
          </Row>

          {/* EMA */}
          <Row checked={indicators.ema} onToggle={() => onToggle('ema')} title={t('charts.indicators.ema')}>
            <span className="text-xs text-slate-500">{t('charts.indicators.periods')}</span>
            {settings.ema.periods.map((p, i) => (
              <NumberField
                key={i}
                value={p}
                onChange={(v) => {
                  const periods = [...settings.ema.periods] as [number, number]
                  periods[i] = v
                  onChange({ ...settings, ema: { ...settings.ema, periods } })
                }}
              />
            ))}
            <span className="text-xs text-slate-500">{t('charts.indicators.colors')}</span>
            {settings.ema.colors.map((c, i) => (
              <ColorSwatch
                key={i}
                value={c}
                onChange={(v) => {
                  const colors = [...settings.ema.colors] as [string, string]
                  colors[i] = v
                  onChange({ ...settings, ema: { ...settings.ema, colors } })
                }}
              />
            ))}
          </Row>

          {/* Bollinger Bands */}
          <Row checked={indicators.boll} onToggle={() => onToggle('boll')} title={t('charts.indicators.boll')}>
            <span className="text-xs text-slate-500">{t('charts.indicators.period')}</span>
            <NumberField value={settings.boll.period} onChange={(v) => onChange({ ...settings, boll: { ...settings.boll, period: v } })} />
            <span className="text-xs text-slate-500">{t('charts.indicators.multiplier')}</span>
            <NumberField
              value={settings.boll.mult}
              min={1}
              max={5}
              width={44}
              onChange={(v) => onChange({ ...settings, boll: { ...settings.boll, mult: v } })}
            />
            <span className="text-xs text-slate-500">{t('charts.indicators.color')}</span>
            <ColorSwatch value={settings.boll.color} onChange={(v) => onChange({ ...settings, boll: { ...settings.boll, color: v } })} />
          </Row>

          {/* Volume */}
          <Row checked={indicators.volume} onToggle={() => onToggle('volume')} title={t('charts.indicators.volume')}>
            <span className="text-xs text-slate-500">{t('charts.indicators.upColor')}</span>
            <ColorSwatch value={settings.volume.upColor} onChange={(v) => onChange({ ...settings, volume: { ...settings.volume, upColor: v } })} />
            <span className="text-xs text-slate-500">{t('charts.indicators.downColor')}</span>
            <ColorSwatch value={settings.volume.downColor} onChange={(v) => onChange({ ...settings, volume: { ...settings.volume, downColor: v } })} />
          </Row>

          {/* RSI */}
          <Row checked={indicators.rsi} onToggle={() => onToggle('rsi')} title={t('charts.indicators.rsi')}>
            <span className="text-xs text-slate-500">{t('charts.indicators.period')}</span>
            <NumberField value={settings.rsi.period} onChange={(v) => onChange({ ...settings, rsi: { ...settings.rsi, period: v } })} />
            <span className="text-xs text-slate-500">{t('charts.indicators.overbought')}</span>
            <NumberField
              value={settings.rsi.overbought}
              min={50}
              max={99}
              onChange={(v) => onChange({ ...settings, rsi: { ...settings.rsi, overbought: v } })}
            />
            <span className="text-xs text-slate-500">{t('charts.indicators.oversold')}</span>
            <NumberField
              value={settings.rsi.oversold}
              min={1}
              max={50}
              onChange={(v) => onChange({ ...settings, rsi: { ...settings.rsi, oversold: v } })}
            />
            <span className="text-xs text-slate-500">{t('charts.indicators.color')}</span>
            <ColorSwatch value={settings.rsi.color} onChange={(v) => onChange({ ...settings, rsi: { ...settings.rsi, color: v } })} />
          </Row>

          {/* MACD */}
          <Row checked={indicators.macd} onToggle={() => onToggle('macd')} title={t('charts.indicators.macd')}>
            <span className="text-xs text-slate-500">{t('charts.indicators.fast')}</span>
            <NumberField value={settings.macd.fast} onChange={(v) => onChange({ ...settings, macd: { ...settings.macd, fast: v } })} />
            <span className="text-xs text-slate-500">{t('charts.indicators.slow')}</span>
            <NumberField value={settings.macd.slow} onChange={(v) => onChange({ ...settings, macd: { ...settings.macd, slow: v } })} />
            <span className="text-xs text-slate-500">{t('charts.indicators.signal')}</span>
            <NumberField value={settings.macd.signal} onChange={(v) => onChange({ ...settings, macd: { ...settings.macd, signal: v } })} />
            <span className="text-xs text-slate-500">{t('charts.indicators.colors')}</span>
            <ColorSwatch
              title="MACD"
              value={settings.macd.macdColor}
              onChange={(v) => onChange({ ...settings, macd: { ...settings.macd, macdColor: v } })}
            />
            <ColorSwatch
              title={t('charts.indicators.signal')}
              value={settings.macd.signalColor}
              onChange={(v) => onChange({ ...settings, macd: { ...settings.macd, signalColor: v } })}
            />
          </Row>
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
