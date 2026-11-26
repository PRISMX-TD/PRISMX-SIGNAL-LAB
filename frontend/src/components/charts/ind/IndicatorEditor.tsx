// 单个指标实例的设置：输入 / 样式 / 可见性三页（同 TradingView）。改动即时画到图上，「取消」退回
// 打开时的样子，「确定」保留；底部「默认值」可恢复默认或把当前设置存为这种指标的默认。
// 输入页：参数、数据源（价格或另一个指标的某条线 = 指标套指标）、时间周期（更大周期，按图上 K 线
// 合成）。样式页：每条线的显隐 / 颜色与透明度 / 粗细 / 线型（线、阶梯、柱、面积、圆点、十字）/
// 虚实，水平参考线、填充，精度、价格轴标签、价格轴。可见性页：按分钟 / 小时 / 日 / 周 / 月设范围。
// Settings for one indicator instance: Inputs / Style / Visibility (as on TradingView). Edits draw
// live; Cancel restores the state at opening, OK keeps it; "Defaults" resets or saves the current
// settings as this kind's default. Inputs: parameters, source (a price or another indicator's
// plot = indicator on indicator), timeframe (higher, aggregated from the chart's bars). Style:
// per-plot visibility / colour & opacity / width / type / dash, hlines, fills, precision, price
// label and scale. Visibility: ranges per minutes / hours / days / weeks / months.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import Switch from '../../Switch'
import { useScrollLock } from '../../../utils/scrollLock'
import { useDialogA11y } from '../../../utils/useDialogA11y'
import { intervalLabel } from '../intervals'
import type { CandleColors } from '../chartConfig'
import ColorPicker from './ColorPicker'
import { approxSeconds } from './compute'
import { defOf, defaultInputs } from './registry'
import { fillStyle, hlineStyle, instArgs, plotStyle, resolveColor } from './style'
import {
  SOURCE_KINDS, VIS_KINDS, VIS_RANGE,
  type IndInstance, type IndLayout, type LineDash, type PlotKind, type PlotStyle, type VisKind,
} from './types'

const MA_LABEL: Record<string, string> = { sma: 'SMA', ema: 'EMA', wma: 'WMA', rma: 'RMA (SMMA)', hma: 'HMA', dema: 'DEMA', tema: 'TEMA', vwma: 'VWMA', alma: 'ALMA', lsma: 'LSMA' }
const KINDS: PlotKind[] = ['line', 'step', 'hist', 'columns', 'area', 'points', 'cross']
const DASHES: LineDash[] = ['solid', 'dashed', 'dotted']
const TFS = ['1', '5', '15', '30', '60', '120', '240', 'D', 'W', 'M']

// 数字框：失焦或回车才解析、夹紧、上报 / parse, clamp and report on blur or Enter only
function NumIn({ value, min, max, float, onChange, label, wide }: { value: number; min: number; max: number; float?: boolean; onChange: (v: number) => void; label: string; wide?: boolean }) {
  const [text, setText] = useState(String(value))
  useEffect(() => { setText(String(value)) }, [value])
  const commit = () => {
    const n = float ? parseFloat(text) : parseInt(text, 10)
    const c = !Number.isFinite(n) ? value : Math.min(max, Math.max(min, n))
    setText(String(c))
    if (c !== value) onChange(c)
  }
  return (
    <input className={`ind-in ${wide ? 'wide' : ''}`} value={text} inputMode={float || min < 0 ? 'decimal' : 'numeric'} aria-label={label}
      onChange={(e) => setText(e.target.value.replace(float ? /[^0-9.-]/g : /[^0-9-]/g, ''))}
      onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} />
  )
}

function Row({ label, children, sub }: { label: ReactNode; children: ReactNode; sub?: boolean }) {
  return (
    <div className={`inde-row ${sub ? 'sub' : ''}`}>
      <span className="inde-l">{label}</span>
      <span className="inde-c">{children}</span>
    </div>
  )
}

function Sel<T extends string>({ value, options, onChange, label }: { value: T; options: { v: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <select className="inde-sel" value={value} aria-label={label} onChange={(e) => onChange(e.target.value as T)}>
      {options.map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}
    </select>
  )
}

export default function IndicatorEditor({ uid, layout, onChange, onSaveDefault, interval, candle, symbols = [], closing = false, onClose }: {
  uid: string
  layout: IndLayout
  onChange: (next: IndInstance) => void
  onSaveDefault: (inst: IndInstance) => void
  interval: string
  candle: CandleColors
  // 「品种」输入的候选（当前在推的品种）/ choices for symbol inputs (symbols currently streaming)
  symbols?: string[]
  closing?: boolean
  onClose: () => void
}) {
  const { t } = useTranslation()
  const inst = layout.list.find((i) => i.uid === uid)
  const snapshot = useRef(inst)
  const [tab, setTab] = useState<'inputs' | 'style' | 'vis'>('inputs')
  const [menu, setMenu] = useState(false)
  useScrollLock(!closing)
  const dlgRef = useRef<HTMLDivElement>(null)
  const cancel = () => { if (snapshot.current) onChange(snapshot.current); onClose() }
  useDialogA11y(dlgRef, cancel, { initialFocus: 'container', open: !closing })

  const srcOptions = useMemo(() => {
    const own = SOURCE_KINDS.map((k) => ({ v: k as string, label: String(t(`charts.ind.src.${k}`)) }))
    const others = layout.list.filter((i) => i.uid !== uid).flatMap((i) => {
      const d = defOf(i.type)
      if (!d) return []
      // 引用了自己的不列（避免循环）/ skip those that reference this one (no cycles)
      if (Object.values(i.inputs).some((v) => typeof v === 'string' && v.startsWith(`ind:${uid}:`))) return []
      const nm = `${d.abbr}${instArgs(d, i, (v) => v) ? ` ${instArgs(d, i, (v) => v)}` : ''}`
      return d.plots.filter((p) => !p.noLegend).map((p) => ({ v: `ind:${i.uid}:${p.key}`, label: `${nm} · ${t(`charts.ind.plot.${p.label}`, { defaultValue: p.label })}` }))
    })
    return { own, others }
  }, [layout.list, uid, t])

  if (!inst) return null
  const def = defOf(inst.type)
  if (!def) return null
  const tt = (k: string, o?: Record<string, unknown>) => String(t(k, o))
  const set = (patch: Partial<IndInstance>) => onChange({ ...inst, ...patch })
  const setInput = (k: string, v: number | string | boolean) => set({ inputs: { ...inst.inputs, [k]: v } })
  const setStyle = (k: string, patch: PlotStyle) => set({ styles: { ...inst.styles, [k]: { ...inst.styles[k], ...patch } } })
  const plotLabel = (l: string) => tt(`charts.ind.plot.${l}`, { defaultValue: l })
  const tfs = TFS.filter((c) => approxSeconds(c) > approxSeconds(interval))
  const args = instArgs(def, inst, (v) => (v.startsWith('ind:') ? '…' : tt(`charts.ind.src.${v}`)))

  const inputs = (
    <div className="inde-body no-sb">
      {def.inputs.length === 0 && def.noTf && <p className="indx-empty">{tt('charts.ind.ui.noInputs')}</p>}
      {def.inputs.map((d) => {
        const v = inst.inputs[d.key]
        const label = tt(`charts.ind.in.${d.key}`, { defaultValue: d.key })
        switch (d.kind) {
          case 'int': case 'float':
            return <Row key={d.key} label={label}><NumIn value={Number(v)} min={d.min} max={d.max} float={d.kind === 'float'} label={label} onChange={(x) => setInput(d.key, x)} /></Row>
          case 'bool':
            return <Row key={d.key} label={label}><Switch checked={v === true} onChange={(x) => setInput(d.key, x)} aria-label={label} /></Row>
          case 'select':
            return <Row key={d.key} label={label}><Sel value={String(v)} label={label} onChange={(x) => setInput(d.key, x)} options={d.options.map((o) => ({ v: o, label: tt(`charts.ind.opt.${o}`, { defaultValue: o }) }))} /></Row>
          case 'symbol': {
            const opts = symbols.includes(String(v)) ? symbols : [String(v), ...symbols]
            return <Row key={d.key} label={label}><Sel value={String(v)} label={label} onChange={(x) => setInput(d.key, x)} options={opts.map((o) => ({ v: o, label: o }))} /></Row>
          }
          case 'ma':
            return <Row key={d.key} label={label}><Sel value={String(v)} label={label} onChange={(x) => setInput(d.key, x)} options={(d.options ?? ['sma', 'ema', 'wma', 'rma', 'hma', 'dema', 'tema', 'vwma', 'alma', 'lsma']).map((o) => ({ v: o, label: MA_LABEL[o] ?? o }))} /></Row>
          case 'source':
            return (
              <Row key={d.key} label={label}>
                <select className="inde-sel" value={String(v)} aria-label={label} onChange={(e) => setInput(d.key, e.target.value)}>
                  {srcOptions.own.map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}
                  {srcOptions.others.length > 0 && (
                    <optgroup label={tt('charts.ind.ui.srcIndicators')}>
                      {srcOptions.others.map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}
                    </optgroup>
                  )}
                </select>
              </Row>
            )
        }
        return null
      })}
      {!def.noTf && (
        <>
          <div className="inde-sep" />
          <Row label={tt('charts.ind.ui.timeframe')}>
            <select className="inde-sel" value={inst.tf ?? ''} aria-label={tt('charts.ind.ui.timeframe')} onChange={(e) => set({ tf: e.target.value || null })}>
              <option value="">{tt('charts.ind.ui.tfChart')}</option>
              {tfs.map((c) => <option key={c} value={c}>{intervalLabel(c)}</option>)}
              {inst.tf && !tfs.includes(inst.tf) && <option value={inst.tf}>{intervalLabel(inst.tf)}</option>}
            </select>
          </Row>
          {inst.tf && (
            <Row label={tt('charts.ind.ui.tfWait')} sub><Switch checked={inst.tfWait === true} onChange={(x) => set({ tfWait: x || undefined })} aria-label={tt('charts.ind.ui.tfWait')} /></Row>
          )}
          {inst.tf && approxSeconds(inst.tf) <= approxSeconds(interval) && <p className="inde-hint">{tt('charts.ind.ui.tfLower')}</p>}
          {inst.tf && <p className="inde-hint">{tt('charts.ind.ui.tfHint')}</p>}
        </>
      )}
    </div>
  )

  const style = (
    <div className="inde-body no-sb">
      {def.plots.map((p) => {
        const st = plotStyle(inst, p)
        const lineish = st.kind === 'line' || st.kind === 'step' || st.kind === 'area'
        return (
          <div key={p.key} className="inde-plot">
            <label className="inde-chk">
              <input type="checkbox" checked={st.visible} onChange={(e) => setStyle(p.key, { visible: e.target.checked })} />
              <span>{plotLabel(p.label)}</span>
            </label>
            <span className="inde-ctl">
              {p.colors ? st.colors.map((c, i) => (
                <ColorPicker key={i} color={c} resolved={resolveColor(c, candle)} opacity={st.opacity} label={`${plotLabel(p.label)} ${i + 1}`}
                  onChange={(nc, op) => { const colors = [...st.colors]; colors[i] = nc; setStyle(p.key, { colors, ...(op != null ? { opacity: op } : {}) }) }} />
              )) : (
                <ColorPicker color={st.color} resolved={resolveColor(st.color, candle)} opacity={st.opacity} label={plotLabel(p.label)} onChange={(nc, op) => setStyle(p.key, { color: nc, ...(op != null ? { opacity: op } : {}) })} />
              )}
              <Sel value={String(st.width)} label={tt('charts.ind.ui.width')} onChange={(x) => setStyle(p.key, { width: Number(x) })} options={['1', '2', '3', '4'].map((w) => ({ v: w, label: `${w}px` }))} />
              {!p.shape && <Sel value={st.kind} label={tt('charts.ind.ui.plotKind')} onChange={(x) => setStyle(p.key, { kind: x })} options={KINDS.map((k) => ({ v: k, label: tt(`charts.ind.kind.${k}`) }))} />}
              {(lineish || p.shape) && <Sel value={st.dash} label={tt('charts.ind.ui.dash')} onChange={(x) => setStyle(p.key, { dash: x })} options={DASHES.map((k) => ({ v: k, label: tt(`charts.ind.dash.${k}`) }))} />}
            </span>
          </div>
        )
      })}
      {(def.hlines ?? []).map((h) => {
        const st = hlineStyle(inst, h)
        const k = `h:${h.key}`
        return (
          <div key={k} className="inde-plot">
            <label className="inde-chk">
              <input type="checkbox" checked={st.visible} onChange={(e) => setStyle(k, { visible: e.target.checked })} />
              <span>{tt('charts.ind.ui.hline')}</span>
            </label>
            <span className="inde-ctl">
              <ColorPicker color={st.color} opacity={st.opacity} label={tt('charts.ind.ui.hline')} onChange={(nc, op) => setStyle(k, { color: nc, ...(op != null ? { opacity: op } : {}) })} />
              <Sel value={st.dash} label={tt('charts.ind.ui.dash')} onChange={(x) => setStyle(k, { dash: x })} options={DASHES.map((d) => ({ v: d, label: tt(`charts.ind.dash.${d}`) }))} />
              <NumIn value={st.value} min={-1e9} max={1e9} float label={tt('charts.ind.ui.value')} onChange={(x) => setStyle(k, { value: x })} wide />
            </span>
          </div>
        )
      })}
      {(def.fills ?? []).map((f) => {
        const st = fillStyle(inst, f)
        const k = `f:${f.key}`
        return (
          <div key={k} className="inde-plot">
            <label className="inde-chk">
              <input type="checkbox" checked={st.visible} onChange={(e) => setStyle(k, { visible: e.target.checked })} />
              <span>{plotLabel(f.label)}</span>
            </label>
            <span className="inde-ctl">
              <ColorPicker color={st.color} opacity={st.opacity} label={plotLabel(f.label)} onChange={(nc, op) => setStyle(k, { color: nc, ...(op != null ? { opacity: op } : {}) })} />
              {f.colorB && <ColorPicker color={st.colorB} opacity={st.opacity} label={`${plotLabel(f.label)} 2`} onChange={(nc, op) => setStyle(k, { colors: [nc], ...(op != null ? { opacity: op } : {}) })} />}
            </span>
          </div>
        )
      })}
      <div className="inde-sep" />
      <Row label={tt('charts.ind.ui.precision')}>
        <Sel value={inst.precision == null ? 'auto' : String(inst.precision)} label={tt('charts.ind.ui.precision')}
          onChange={(x) => set({ precision: x === 'auto' ? null : Number(x) })}
          options={[{ v: 'auto', label: tt('charts.ind.ui.auto') }, ...[0, 1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ v: String(n), label: String(n) }))]} />
      </Row>
      <Row label={tt('charts.ind.ui.axisLabel')}>
        <Sel value={inst.labels == null ? 'auto' : inst.labels ? 'on' : 'off'} label={tt('charts.ind.ui.axisLabel')}
          onChange={(x) => set({ labels: x === 'auto' ? null : x === 'on' })}
          options={[{ v: 'auto', label: tt('charts.ind.ui.followGlobal') }, { v: 'on', label: tt('charts.ind.ui.show') }, { v: 'off', label: tt('charts.ind.ui.hide') }]} />
      </Row>
      {def.plots.some((p) => !p.shape) && (
        <Row label={tt('charts.ind.ui.scale')}>
          <Sel value={inst.scale ?? (inst.pane === 'main' && !def.overlay ? 'none' : 'right')} label={tt('charts.ind.ui.scale')} onChange={(x) => set({ scale: x })}
            options={(['right', 'left', 'none'] as const).map((s) => ({ v: s, label: tt(`charts.ind.ui.scale_${s}`) }))} />
        </Row>
      )}
    </div>
  )

  const visRow = (k: VisKind) => {
    const [lo, hi] = VIS_RANGE[k]
    const r = inst.vis?.[k] ?? { on: true, from: lo, to: hi }
    const put = (next: { on: boolean; from: number; to: number }) => {
      const vis = { ...(inst.vis ?? {}), [k]: next }
      // 全开且全范围 = 没有规则 / fully on and full range = no rule
      if (next.on && next.from === lo && next.to === hi) delete vis[k]
      set({ vis: Object.keys(vis).length ? vis : undefined })
    }
    return (
      <div key={k} className="inde-plot">
        <label className="inde-chk">
          <input type="checkbox" checked={r.on} onChange={(e) => put({ ...r, on: e.target.checked })} />
          <span>{tt(`charts.ind.vis.${k}`)}</span>
        </label>
        <span className="inde-ctl">
          <NumIn value={r.from} min={lo} max={hi} label={tt('charts.ind.ui.from')} onChange={(x) => put({ ...r, on: true, from: Math.min(x, r.to) })} />
          <span className="inde-dash">–</span>
          <NumIn value={r.to} min={lo} max={hi} label={tt('charts.ind.ui.to')} onChange={(x) => put({ ...r, on: true, to: Math.max(x, r.from) })} />
        </span>
      </div>
    )
  }

  return createPortal(
    <div className={`ind-overlay${closing ? ' closing' : ''}`} onClick={cancel}>
      <div ref={dlgRef} className="ind-dlg inde" role="dialog" aria-modal="true" aria-label={`${def.abbr} ${tt('charts.ind.ui.settings')}`} tabIndex={-1} onClick={(e) => e.stopPropagation()}>
        <div className="ind-hd">
          <span className="ind-ab lg">{def.abbr.length > 5 ? def.abbr.slice(0, 4) : def.abbr}</span>
          <h3>{tt(`charts.ind.name.${def.id}`)}{args && <span className="inde-args">{args}</span>}</h3>
          <button type="button" className="ind-close" onClick={cancel} aria-label={tt('common.close')}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
          </button>
        </div>
        <div className="inde-tabs" role="tablist">
          {(['inputs', 'style', 'vis'] as const).map((k) => (
            <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{tt(`charts.ind.ui.tab_${k}`)}</button>
          ))}
        </div>
        {tab === 'inputs' ? inputs : tab === 'style' ? style : <div className="inde-body no-sb">{VIS_KINDS.map(visRow)}</div>}
        <div className="ind-ft">
          <span className="inde-def">
            <button type="button" className="ind-btn" aria-expanded={menu} onClick={() => setMenu((v) => !v)}>{tt('charts.ind.ui.defaults')}</button>
            {menu && (
              <span className="inde-menu" role="menu">
                <button type="button" role="menuitem" onClick={() => {
                  const d = layout.defaults[inst.type]
                  onChange({ ...inst, inputs: { ...defaultInputs(def), ...(d?.inputs ?? {}) }, styles: { ...(d?.styles ?? {}) } })
                  setMenu(false)
                }}>{tt('charts.ind.ui.resetDefault')}</button>
                {layout.defaults[inst.type] && (
                  <button type="button" role="menuitem" onClick={() => { onChange({ ...inst, inputs: defaultInputs(def), styles: {} }); setMenu(false) }}>{tt('charts.ind.ui.factoryDefault')}</button>
                )}
                <button type="button" role="menuitem" onClick={() => { onSaveDefault(inst); setMenu(false) }}>{tt('charts.ind.ui.saveDefault')}</button>
              </span>
            )}
          </span>
          <button type="button" className="ind-btn" onClick={cancel}>{tt('charts.ind.ui.cancel')}</button>
          <button type="button" className="ind-btn primary" onClick={onClose}>{tt('charts.ind.ui.ok')}</button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
