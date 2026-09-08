// 指标库面板：左栏目录（四组十四个指标 + 组合模板 + 搜索），右栏选中指标的编辑器
// （实时预览 + 参数 + 样式）。字段改动即时生效（ChartsPage 重算并画到图上），面板
// 不缓存草稿、没有单独的"保存"步骤。手机是两级抽屉：目录 → 点进某个指标滑到编辑器。
// 目录 / 参数表单 / 预览都按 indicatorCatalog 的描述渲染，加指标不用改这里。
// 整个面板 portal 到 body：页面切换动画给 <main> 造了层叠上下文，留在里面再高的
// z-index 也压不过全站底栏（z-40）。
// Indicator library: catalog on the left (four groups, 14 indicators, templates,
// search), editor for the selected indicator on the right (live preview, params,
// style). Edits apply immediately; no draft state. Mobile is a two-level sheet:
// catalog → editor. Rows, forms and preview are driven by indicatorCatalog, so
// adding an indicator needs no change here. Portalled to body so it clears the
// app tab bar despite <main>'s stacking context.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import Switch from '../Switch'
import type { Candle } from '../../api/types'
import type { IndicatorFlags } from './chartConfig'
import {
  COLOR_PRESETS, DEFAULT_INDICATOR_SETTINGS, MAX_LINES, MIN_LINES, addLine, removeLine,
  type IndicatorSettings, type LineDash, type LineWidth, type LinesConfig, type PaneSize,
} from './indicatorSettings'
import {
  GROUPS, INDICATOR_FORM, INDICATOR_IDS, INDICATOR_META, TEMPLATES, computeIndicator, refLines, seriesSpecs, summaryOf,
  type IndicatorId,
} from './indicatorCatalog'
import { useBackToClose } from '../../utils/useBackToClose'

interface Props {
  indicators: IndicatorFlags
  onToggle: (key: IndicatorId) => void
  onSetIndicators: (next: IndicatorFlags) => void
  getCandles: () => Candle[]
  settings: IndicatorSettings
  onChange: (next: IndicatorSettings) => void
  onClose: () => void
}

const PREVIEW_BARS = 120

// 数字框：失焦才解析、夹紧、上报——逐键夹紧会把正在输入的 "1" 弹成下限。
// Number field: parse / clamp / propagate on blur only.
function Num({ value, min, max, isFloat = false, onChange, ariaLabel }: {
  value: number
  min: number
  max: number
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

// 颜色点：点开一小块预设色板，点色即选中并关闭——不出现系统取色器。
// 它是"弹窗里的弹窗"：划返回先收色板，再收整个面板。
// Color dot opening a preset palette; nested modal for swipe-back.
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
            <button key={c} type="button" role="option" aria-selected={c === value} className={`ind-dot sm ${c === value ? 'on' : ''}`} style={{ background: c }} onClick={() => { onChange(c); setOpen(false) }} />
          ))}
        </span>
      )}
    </span>
  )
}

function Field({ k, children }: { k: string; children: ReactNode }) {
  return (
    <label className="ind-f">
      <span className="l">{k}</span>
      {children}
    </label>
  )
}

function Seg<T extends string | number>({ value, options, onChange, label }: { value: T; options: { v: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <span className="ind-seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={String(o.v)} type="button" role="radio" aria-checked={o.v === value} className={o.v === value ? 'on' : ''} onClick={() => onChange(o.v)}>{o.label}</button>
      ))}
    </span>
  )
}

// MA/EMA 的均线列表：一条一枚药丸（周期 · 颜色 · 删），末尾一枚虚线「添加」。
// MA/EMA line list: one pill per line and a dashed "add" pill.
function LineList<T extends LinesConfig>({ cfg, onChange }: { cfg: T; onChange: (next: T) => void }) {
  const { t } = useTranslation()
  return (
    <div className="ind-lines">
      {cfg.periods.map((period, i) => (
        <span key={i} className="ind-line">
          <Num value={period} min={1} max={500} ariaLabel={`${t('charts.indicators.period')} ${i + 1}`} onChange={(v) => { const periods = [...cfg.periods]; periods[i] = v; onChange({ ...cfg, periods }) }} />
          <ColorDot value={cfg.colors[i]} label={String(t('charts.indicators.color'))} onChange={(v) => { const colors = [...cfg.colors]; colors[i] = v; onChange({ ...cfg, colors }) }} />
          <button type="button" className="ind-x" onClick={() => onChange(removeLine(cfg, i))} disabled={cfg.periods.length <= MIN_LINES} aria-label={String(t('charts.indicators.removeLine'))}>
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

// 实时预览：最近 120 根真实 K 线 + 选中指标，改参数即重绘。主图指标叠在 K 线上，
// 副图指标画在下方一条摆动区里（含参考线）。
// Live preview: the last 120 real bars plus the selected indicator, redrawn on
// every edit. Main-pane overlays sit on the candles; sub-pane ones get an
// oscillator strip underneath (with reference lines).
function Preview({ id, settings, getCandles }: { id: IndicatorId; settings: IndicatorSettings; getCandles: () => Candle[] }) {
  const { t } = useTranslation()
  const ref = useRef<HTMLCanvasElement>(null)
  const bars = useMemo(() => getCandles().slice(-PREVIEW_BARS), [getCandles])
  const specs = seriesSpecs(id, settings)

  useEffect(() => {
    const cv = ref.current
    if (!cv) return
    const draw = () => {
      const W = cv.clientWidth, H = cv.clientHeight
      if (!W || !H) return
      const dpr = window.devicePixelRatio || 1
      cv.width = W * dpr
      cv.height = H * dpr
      const g = cv.getContext('2d')
      if (!g) return
      g.setTransform(dpr, 0, 0, dpr, 0, 0)
      g.clearRect(0, 0, W, H)
      if (bars.length < 2) return
      const sub = INDICATOR_META[id].pane === 'sub'
      const mainH = sub ? H * 0.58 : H
      const cw = W / (bars.length + 2)
      const x = (i: number) => i * cw + cw
      const out = computeIndicator(id, bars, settings)
      // 主图价格范围：K 线 + 叠加线都要装进去 / price range covers candles and overlays
      let lo = Math.min(...bars.map((b) => b.l))
      let hi = Math.max(...bars.map((b) => b.h))
      if (!sub) for (const sp of specs) for (const v of out[sp.key] ?? []) if (v != null) { lo = Math.min(lo, v); hi = Math.max(hi, v) }
      const pad = (hi - lo) * 0.08 || 1
      lo -= pad; hi += pad
      const y = (p: number) => 8 + ((hi - p) / (hi - lo)) * (mainH - 16)
      bars.forEach((b, i) => {
        const up = b.c >= b.o
        const col = up ? 'rgba(58,213,132,.6)' : 'rgba(255,100,120,.6)'
        g.strokeStyle = col; g.fillStyle = col
        g.beginPath(); g.moveTo(x(i) + 0.5, y(b.h)); g.lineTo(x(i) + 0.5, y(b.l)); g.stroke()
        g.fillRect(x(i) - Math.max(1, cw * 0.3), y(Math.max(b.o, b.c)), Math.max(2, cw * 0.6), Math.max(1, Math.abs(y(b.o) - y(b.c))))
      })
      const line = (vals: (number | null)[], yy: (v: number) => number, color: string, width: number, dashed: boolean) => {
        g.save()
        if (dashed) g.setLineDash([3, 3])
        g.strokeStyle = color; g.lineWidth = width; g.beginPath()
        let started = false
        vals.forEach((v, i) => { if (v == null) { started = false; return } started ? g.lineTo(x(i), yy(v)) : g.moveTo(x(i), yy(v)); started = true })
        g.stroke(); g.restore()
      }
      const st = (settings[id] as { width?: number; dash?: string })
      const width = st.width ?? 1
      const dashed = st.dash === 'dashed'
      if (!sub) {
        for (const sp of specs) {
          const vals = out[sp.key] ?? []
          if (sp.kind === 'points') {
            g.fillStyle = sp.color
            vals.forEach((v, i) => { if (v != null) { g.beginPath(); g.arc(x(i), y(v), 1.6, 0, Math.PI * 2); g.fill() } })
          } else line(vals, y, sp.color, width, dashed || !!sp.dashed)
        }
        return
      }
      // 副图区 / oscillator strip
      const top = mainH + 6, h = H - top - 8
      g.strokeStyle = 'rgba(255,255,255,.08)'; g.beginPath(); g.moveTo(0, mainH + 0.5); g.lineTo(W, mainH + 0.5); g.stroke()
      const refs = refLines(id, settings)
      let mn = Infinity, mx = -Infinity
      for (const sp of specs) for (const v of out[sp.key] ?? []) if (v != null) { mn = Math.min(mn, v); mx = Math.max(mx, v) }
      for (const r of refs) { mn = Math.min(mn, r.value); mx = Math.max(mx, r.value) }
      if (specs.some((sp) => sp.kind === 'hist')) { mn = Math.min(mn, 0); mx = Math.max(mx, 0) }
      if (!Number.isFinite(mn)) return
      const span = mx - mn || 1
      const ys = (v: number) => top + h - ((v - mn) / span) * h
      g.save(); g.setLineDash([3, 3]); g.strokeStyle = 'rgba(255,255,255,.14)'
      for (const r of refs) { g.beginPath(); g.moveTo(0, ys(r.value) + 0.5); g.lineTo(W, ys(r.value) + 0.5); g.stroke() }
      g.restore()
      for (const sp of specs) {
        const vals = out[sp.key] ?? []
        if (sp.kind === 'hist') {
          const upC = (settings[id] as { upColor?: string }).upColor ?? 'rgba(58,213,132,.7)'
          const dnC = (settings[id] as { downColor?: string }).downColor ?? 'rgba(255,100,120,.7)'
          vals.forEach((v, i) => {
            if (v == null) return
            const positive = sp.histColor === 'candle' ? bars[i].c >= bars[i].o : v >= 0
            g.fillStyle = positive ? upC : dnC
            g.globalAlpha = 0.75
            const y0 = ys(0), y1 = ys(v)
            g.fillRect(x(i) - Math.max(1, cw * 0.3), Math.min(y0, y1), Math.max(2, cw * 0.6), Math.max(1, Math.abs(y1 - y0)))
            g.globalAlpha = 1
          })
        } else line(vals, ys, sp.color, width, dashed)
      }
    }
    draw()
    const ro = new ResizeObserver(draw)
    ro.observe(cv)
    return () => ro.disconnect()
  }, [bars, id, settings, specs])

  return (
    <div className="ind-prev">
      <canvas ref={ref} />
      {bars.length < 2 ? (
        <span className="ind-prev-empty">{t('charts.empty')}</span>
      ) : (
        <span className="ind-prev-lg">
          {specs.map((sp) => <span key={sp.key}><i style={{ background: sp.color }} />{INDICATOR_META[id].abbr}{sp.label ? ` ${sp.label}` : ''}</span>)}
        </span>
      )}
      <span className="ind-prev-cap">{t('charts.indicators.previewCaption', { n: Math.min(PREVIEW_BARS, bars.length) })}</span>
    </div>
  )
}

export default function IndicatorSettingsModal({ indicators, onToggle, onSetIndicators, getCandles, settings, onChange, onClose }: Props) {
  const { t } = useTranslation()
  const firstOn = INDICATOR_IDS.find((id) => indicators[id]) ?? 'ma'
  const [sel, setSel] = useState<IndicatorId>(firstOn)
  const [query, setQuery] = useState('')
  const [mobileEdit, setMobileEdit] = useState(false)
  useBackToClose(mobileEdit, () => setMobileEdit(false))

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const name = (id: IndicatorId) => String(t(`charts.indicators.${id}`))
  const q = query.trim().toLowerCase()
  const matches = (id: IndicatorId) =>
    !q || INDICATOR_META[id].abbr.toLowerCase().includes(q) || name(id).toLowerCase().includes(q) || String(t(`charts.indicators.desc.${id}`)).toLowerCase().includes(q)
  const onCount = INDICATOR_IDS.filter((id) => indicators[id]).length
  const enabled = INDICATOR_IDS.filter((id) => indicators[id])
  const activeTpl = TEMPLATES.find((tp) => tp.ids.length === enabled.length && tp.ids.every((id) => indicators[id]))?.id
  const applyTemplate = (ids: IndicatorId[]) => {
    const next = Object.fromEntries(INDICATOR_IDS.map((id) => [id, ids.includes(id)])) as IndicatorFlags
    onSetIndicators(next)
    setSel(ids[0])
  }
  const pick = (id: IndicatorId) => { setSel(id); setMobileEdit(true) }

  const meta = INDICATOR_META[sel]
  const form = INDICATOR_FORM[sel]
  const cfg = settings[sel] as Record<string, unknown>
  const set = (patch: Record<string, unknown>) => onChange({ ...settings, [sel]: { ...cfg, ...patch } })
  const lbl = (key: string) => String(t(`charts.indicators.${key}`))

  return createPortal(
    <div className="ind-overlay" onClick={onClose}>
      <div className={`ind-dlg ${mobileEdit ? 'edit' : ''}`} role="dialog" aria-modal="true" aria-label={String(t('charts.indicators.settingsTitle'))} onClick={(e) => e.stopPropagation()}>
        <div className="ind-hd">
          <button type="button" className="ind-back" onClick={() => setMobileEdit(false)} aria-label={String(t('charts.indicators.back'))}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
          </button>
          <h3>{t('charts.indicators.settingsTitle')}</h3>
          <span className="ind-n">{t('charts.indicators.enabledCount', { n: onCount, total: INDICATOR_IDS.length })}</span>
          <div className="ind-srch">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4-4" /></svg>
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={String(t('charts.indicators.search'))} aria-label={String(t('charts.indicators.search'))} />
          </div>
          <button type="button" className="ind-close" onClick={onClose} aria-label={String(t('common.close'))}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
          </button>
        </div>

        {/* 左：目录 / catalog */}
        <div className="ind-cat">
          <div className="ind-tpl">
            <span className="k">{t('charts.indicators.templates')}</span>
            {TEMPLATES.map((tp) => (
              <button key={tp.id} type="button" className={activeTpl === tp.id ? 'on' : ''} onClick={() => applyTemplate(tp.ids)}>{t(`charts.indicators.tpl.${tp.id}`)}</button>
            ))}
          </div>
          <div className="ind-list no-sb" role="listbox">
            {GROUPS.map((g) => {
              const ids = INDICATOR_IDS.filter((id) => INDICATOR_META[id].group === g && matches(id))
              if (ids.length === 0) return null
              const on = ids.filter((id) => indicators[id]).length
              return (
                <div key={g}>
                  <div className="ind-grp"><b>{t(`charts.indicators.group.${g}`)}</b><span>{on ? `${on} / ` : ''}{ids.length}</span></div>
                  {ids.map((id) => (
                    <div
                      key={id}
                      role="option"
                      tabIndex={0}
                      aria-selected={id === sel}
                      className={`ind-it ${indicators[id] ? 'on' : ''} ${id === sel ? 'sel' : ''}`}
                      onClick={() => pick(id)}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(id) } }}
                    >
                      <span className="ind-ab">{INDICATOR_META[id].abbr}</span>
                      <span className="ind-txt">
                        <span className="nm">{name(id)}</span>
                        <span className="ds">{t(`charts.indicators.desc.${id}`)}</span>
                      </span>
                      <span onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                        <Switch checked={indicators[id]} onChange={() => onToggle(id)} aria-label={name(id)} />
                      </span>
                    </div>
                  ))}
                </div>
              )
            })}
          </div>
        </div>

        {/* 右：编辑器 / editor */}
        <div className="ind-ed">
          <div className="ind-ed-hd">
            <span className="ind-ab lg">{meta.abbr}</span>
            <div className="ind-ed-t">
              <h4>{name(sel)}<span className="ind-tag">{t(meta.pane === 'main' ? 'charts.indicators.mainPane' : 'charts.indicators.subPane')}</span></h4>
              <p>{t(`charts.indicators.desc.${sel}`)}</p>
            </div>
            <Switch checked={indicators[sel]} onChange={() => onToggle(sel)} aria-label={name(sel)} />
          </div>
          <Preview id={sel} settings={settings} getCandles={getCandles} />
          <div className="ind-body no-sb">
            <div className="ind-sec">
              <div className="k">{t(form.params[0]?.kind === 'lines' ? 'charts.indicators.linesLabel' : 'charts.indicators.params')}</div>
              {form.params[0]?.kind === 'lines' ? (
                <LineList cfg={settings[sel as 'ma' | 'ema']} onChange={(next) => onChange({ ...settings, [sel]: next })} />
              ) : (
                <div className="ind-params">
                  {form.params.map((p) => p.kind === 'num' ? (
                    <Field key={p.key} k={lbl(p.label)}>
                      <Num value={cfg[p.key] as number} min={p.min} max={p.max} isFloat={p.isFloat} ariaLabel={lbl(p.label)} onChange={(v) => set({ [p.key]: v })} />
                    </Field>
                  ) : p.kind === 'color' ? (
                    <Field key={p.key} k={lbl(p.label)}>
                      <ColorDot value={cfg[p.key] as string} label={lbl(p.label)} onChange={(v) => set({ [p.key]: v })} />
                    </Field>
                  ) : null)}
                </div>
              )}
            </div>
            {(form.lineStyle || meta.pane === 'sub') && (
              <div className="ind-sec">
                <div className="k">{t('charts.indicators.style')}</div>
                <div className="ind-params">
                  {form.lineStyle && (
                    <>
                      <Field k={lbl('lineWidth')}>
                        <Seg<LineWidth> value={cfg.width as LineWidth} options={[{ v: 1, label: '1' }, { v: 2, label: '2' }, { v: 3, label: '3' }]} onChange={(v) => set({ width: v })} label={lbl('lineWidth')} />
                      </Field>
                      <Field k={lbl('lineStyle')}>
                        <Seg<LineDash> value={cfg.dash as LineDash} options={[{ v: 'solid', label: lbl('solid') }, { v: 'dashed', label: lbl('dashed') }]} onChange={(v) => set({ dash: v })} label={lbl('lineStyle')} />
                      </Field>
                    </>
                  )}
                  {meta.pane === 'sub' && (
                    <Field k={lbl('paneHeight')}>
                      <Seg<PaneSize> value={cfg.size as PaneSize} options={[{ v: 'sm', label: lbl('sizeSm') }, { v: 'md', label: lbl('sizeMd') }, { v: 'lg', label: lbl('sizeLg') }]} onChange={(v) => set({ size: v })} label={lbl('paneHeight')} />
                    </Field>
                  )}
                </div>
              </div>
            )}
            <p className="ind-hint">{t(`charts.indicators.hint.${sel}`)}</p>
          </div>
          <div className="ind-ft">
            <button type="button" className="ind-btn" onClick={() => onChange({ ...settings, [sel]: DEFAULT_INDICATOR_SETTINGS[sel] })}>{t('charts.indicators.reset')}</button>
            <span className="ind-en" aria-hidden>
              {enabled.map((id) => <span key={id}><i style={{ background: seriesSpecs(id, settings)[0]?.color }} />{INDICATOR_META[id].abbr}</span>)}
            </span>
            <button type="button" className="ind-btn primary" onClick={onClose}>{t('charts.indicators.done')}</button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}

// 目录行摘要留给以后要用的地方（当前行内不显示，避免与说明挤在一起）。
// Kept for callers that want the one-line summary (not shown in rows to avoid crowding the description).
export { summaryOf }
