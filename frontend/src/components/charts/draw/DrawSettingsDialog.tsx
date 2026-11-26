// 单条画线的设置弹窗（对标 TradingView 的画线设置）：样式 / 文字 / 参数（多空仓位）/ 坐标 / 可见性，
// 底部是模板（存当前样式、套用、删除）与「存为默认」。改动实时预览，按「确定」才提交（进撤销栈）。
// Settings for one drawing (benchmarked on TradingView's): Style / Text / Inputs (positions) /
// Coordinates / Visibility, with templates and "save as default" in the footer. Edits preview live
// and only commit (into undo) on OK.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import ChartDialog from '../ChartDialog'
import Switch from '../../Switch'
import { AlphaColorPicker } from '../ind/ColorPicker'
import {
  type Drawing, type DrawTemplate, type DrawType, type FibLevel, type VisGroup, PALETTE, LINE_WIDTHS, TOOL_META,
  levelsOf, fillOf, showLabelOf, fontSizeOf, takesText, hasLevels, isScreenAnchored, EMOJIS, DEFAULT_ACCOUNT, DEFAULT_RISK,
} from './model'

// 没有线宽 / 线型可调的工具（图标、气泡、文字块）/ tools without width / style (icons, bubbles, text blocks)
const NO_LINE = new Set<DrawType>(['text', 'priceLabel', 'long', 'short', 'emoji', 'note', 'pin', 'flag', 'arrowUp', 'arrowDown', 'arrowMarker', 'comment', 'callout', 'signpost', 'anchoredText',
  'table', 'image', 'barsPattern', 'ghostFeed', 'fixedRangeVP', 'anchoredVP'])
// 用 tick 量算的工具（设置里注明）/ tools computed from tick volume (noted in settings)
const TICK_VOL = new Set<DrawType>(['anchoredVwap', 'fixedRangeVP', 'anchoredVP'])
// 能左右延长的工具 / tools that extend left / right
const EXTENDS = new Set<DrawType>(['channel', 'fib', 'fibExt', 'fibChannel', 'flatChannel', 'disjointChannel'])
// 有读数 / 档位标签开关的工具 / tools with a labels switch
const LABELED = new Set<DrawType>(['info', 'priceRange', 'dateRange', 'datePriceRange', 'long', 'short', 'forecast', 'gannFan', 'anchoredVwap', 'fixedRangeVP', 'anchoredVP'])
// 坐标只给提示、不逐点列出的工具（点太多）/ tools whose coordinates aren't listed point by point
const FREEHAND = new Set<DrawType>(['brush', 'highlighter'])
import { StyleGlyph } from './DrawFloatingBar'
import { VpInputs, VpStyle } from './VpSettings'

export type SettingsTab = 'style' | 'text' | 'inputs' | 'coords' | 'vis'

interface Props {
  drawing: Drawing
  initialTab: SettingsTab
  digits: number
  fmtTime: (t: number) => string
  templates: DrawTemplate[]
  onPreview: (d: Drawing) => void
  onApply: (d: Drawing) => void
  onCancel: () => void
  onSaveTemplate: (name: string, d: Drawing) => void
  onDeleteTemplate: (name: string) => void
  // 图片画线：选图并压缩，返回 data URL / image drawing: pick and squeeze, resolving to a data URL
  onPickImage?: () => Promise<{ url: string; w: number; h: number } | null>
  t: (k: string, o?: Record<string, unknown>) => unknown
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="chart-set-row">
      <span className="chart-set-lbl"><b>{label}</b>{hint && <small>{hint}</small>}</span>
      {children}
    </div>
  )
}

function Seg<T extends string | number>({ value, options, onChange, label }: { value: T; options: { v: T; label: ReactNode }[]; onChange: (v: T) => void; label: string }) {
  return (
    <span className="ind-seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={String(o.v)} type="button" role="radio" aria-checked={value === o.v} className={value === o.v ? 'on' : ''} onClick={() => onChange(o.v)}>
          {o.label}
        </button>
      ))}
    </span>
  )
}

// 数字输入：边打边校验，非法时不回写（保留文本让用户继续改）/ validated as typed; invalid text isn't written back
function Num({ value, onChange, label, min = -Infinity, max = Infinity, width }: { value: number; onChange: (v: number) => void; label: string; min?: number; max?: number; width?: number }) {
  const [text, setText] = useState(String(value))
  const last = useRef(value)
  useEffect(() => { if (value !== last.current) { last.current = value; setText(String(value)) } }, [value])
  return (
    <input
      className="ind-in"
      inputMode="decimal"
      aria-label={label}
      value={text}
      style={width ? { width } : undefined}
      onChange={(e) => {
        setText(e.target.value)
        const v = Number(e.target.value)
        if (e.target.value.trim() !== '' && Number.isFinite(v) && v >= min && v <= max) { last.current = v; onChange(v) }
      }}
    />
  )
}

const VIS_GROUPS: VisGroup[] = ['m', 'h', 'd', 'w', 'M']

export default function DrawSettingsDialog(p: Props) {
  const tt = (k: string, o?: Record<string, unknown>) => String(p.t(k, o))
  const [d, setD] = useState<Drawing>(() => ({ ...p.drawing, pts: p.drawing.pts.map((x) => ({ ...x })) }))
  const type = d.type
  const meta = TOOL_META[type]
  const isPos = type === 'long' || type === 'short'
  const isFib = hasLevels(type)
  // 成交量分布照 TradingView：「输入」在前、「样式」在后 / volume profiles follow TradingView: Inputs, then Style
  const isVp = type === 'fixedRangeVP' || type === 'anchoredVP'
  const tabs: SettingsTab[] = isVp ? ['inputs', 'style'] : ['style']
  if (takesText(type)) tabs.push('text')
  if (isPos) tabs.push('inputs')
  if (!isScreenAnchored(type)) tabs.push('coords')
  tabs.push('vis')
  const [tab, setTab] = useState<SettingsTab>(tabs.includes(p.initialTab) ? p.initialTab : 'style')
  const [tplName, setTplName] = useState('')

  // 每次改动都实时预览 / preview every edit live
  const onPreview = useRef(p.onPreview)
  onPreview.current = p.onPreview
  useEffect(() => { onPreview.current(d) }, [d])
  const set = (patch: Partial<Drawing>) => setD((cur) => ({ ...cur, ...patch }))
  const setLevels = (lv: FibLevel[]) => set({ levels: lv })
  const levels = levelsOf(d)

  const ptLabel = (i: number) => {
    if (isPos) return tt(['charts.draw.lbl.entry', 'charts.draw.lbl.target', 'charts.draw.lbl.stop'][i] ?? 'charts.draw.lbl.point', { n: i + 1 })
    if ((type === 'channel' || type === 'fibChannel') && i === 2) return tt('charts.draw.lbl.width')
    return tt('charts.draw.lbl.point', { n: i + 1 })
  }

  const body = (() => {
    switch (tab) {
      case 'style':
        if (isVp) return <VpStyle d={d} set={set} tt={tt} />
        return (
          <>
            {!isPos && (
              <Row label={tt('charts.draw.color')}>
                <AlphaColorPicker presets={PALETTE} value={d.color} label={tt('charts.draw.color')} onChange={(v) => set({ color: v })} />
              </Row>
            )}
            {!NO_LINE.has(type) && (
              <>
                <Row label={tt('charts.draw.width')}>
                  <Seg value={d.lineWidth ?? 1} label={tt('charts.draw.width')} options={LINE_WIDTHS.map((w) => ({ v: w, label: `${w}px` }))} onChange={(v) => set({ lineWidth: v })} />
                </Row>
                <Row label={tt('charts.draw.style')}>
                  <Seg value={d.lineStyle ?? 'solid'} label={tt('charts.draw.style')} options={(['solid', 'dashed', 'dotted'] as const).map((s) => ({ v: s, label: <StyleGlyph s={s} w={24} /> }))} onChange={(v) => set({ lineStyle: v })} />
                </Row>
              </>
            )}
            {meta.fillable && (
              <Row label={tt('charts.draw.fill')}>
                <Switch checked={fillOf(d)} onChange={(v) => set({ fill: v })} aria-label={tt('charts.draw.fill')} />
              </Row>
            )}
            {type === 'polyline' && (
              <Row label={tt('charts.draw.closed')}>
                <Switch checked={!!d.closed} onChange={(v) => set({ closed: v })} aria-label={tt('charts.draw.closed')} />
              </Row>
            )}
            {type === 'image' && (
              <>
                <Row label={tt('charts.draw.image')}>
                  <button type="button" className="ind-btn" onClick={() => { void p.onPickImage?.().then((r) => { if (r) set({ img: r.url }) }) }}>
                    {tt(d.img ? 'charts.draw.replaceImage' : 'charts.draw.pickImage')}
                  </button>
                </Row>
                <Row label={tt('charts.draw.opacity')}>
                  <Seg value={d.alpha ?? 1} label={tt('charts.draw.opacity')} options={[0.25, 0.5, 0.75, 1].map((v) => ({ v, label: `${Math.round(v * 100)}%` }))} onChange={(v) => set({ alpha: v })} />
                </Row>
              </>
            )}
            {type === 'anchoredVwap' && (
              <Row label={tt('charts.draw.bands')}>
                <Switch checked={!!d.bands} onChange={(v) => set({ bands: v })} aria-label={tt('charts.draw.bands')} />
              </Row>
            )}
            {type === 'barsPattern' && (
              <>
                <Row label={tt('charts.draw.flip')}>
                  <Switch checked={!!d.flip} onChange={(v) => set({ flip: v })} aria-label={tt('charts.draw.flip')} />
                </Row>
                <Row label={tt('charts.draw.mirror')}>
                  <Switch checked={!!d.mirror} onChange={(v) => set({ mirror: v })} aria-label={tt('charts.draw.mirror')} />
                </Row>
              </>
            )}
            {TICK_VOL.has(type) && <small>{tt('charts.draw.tickVolHint')}</small>}
            {type === 'regression' && (
              <Row label={tt('charts.draw.extendRight')}>
                <Switch checked={!!d.extendRight} onChange={(v) => set({ extendRight: v })} aria-label={tt('charts.draw.extendRight')} />
              </Row>
            )}
            {(meta.lineLike || EXTENDS.has(type)) && type !== 'extended' && (
              <>
                <Row label={tt('charts.draw.extendLeft')}>
                  <Switch checked={!!d.extendLeft} onChange={(v) => set({ extendLeft: v })} aria-label={tt('charts.draw.extendLeft')} />
                </Row>
                {type !== 'ray' && (
                  <Row label={tt('charts.draw.extendRight')}>
                    <Switch checked={!!d.extendRight} onChange={(v) => set({ extendRight: v })} aria-label={tt('charts.draw.extendRight')} />
                  </Row>
                )}
              </>
            )}
            {(LABELED.has(type) || isFib) && (
              <Row label={tt('charts.draw.showLabel')}>
                <Switch checked={showLabelOf(d)} onChange={(v) => set({ showLabel: v })} aria-label={tt('charts.draw.showLabel')} />
              </Row>
            )}
            {isFib && (
              <div className="chart-set-sec">
                <b>{tt('charts.draw.levels')}</b>
                <div className="draw-levels">
                  {levels.map((l, i) => (
                    <div key={i} className="draw-level">
                      <input type="checkbox" checked={l.on} aria-label={tt('charts.draw.levelOn', { v: l.v })} onChange={(e) => setLevels(levels.map((x, k) => (k === i ? { ...x, on: e.target.checked } : x)))} />
                      <Num value={l.v} width={72} label={tt('charts.draw.levelValue')} onChange={(v) => setLevels(levels.map((x, k) => (k === i ? { ...x, v } : x)))} />
                      <AlphaColorPicker presets={PALETTE} value={l.color || d.color} label={tt('charts.draw.color')} onChange={(v) => setLevels(levels.map((x, k) => (k === i ? { ...x, color: v } : x)))} />
                      <button type="button" className="chart-pop-star" aria-label={tt('charts.draw.levelRemove')} onClick={() => setLevels(levels.filter((_, k) => k !== i))}>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><path d="M6 6l12 12M18 6L6 18" /></svg>
                      </button>
                    </div>
                  ))}
                </div>
                <span className="draw-level-actions">
                  <button type="button" className="ind-btn" onClick={() => setLevels([...levels, { v: levels.length ? Math.round((Math.max(...levels.map((l) => l.v)) + 0.5) * 1000) / 1000 : 0, on: true }])}>{tt('charts.draw.levelAdd')}</button>
                  <button type="button" className="ind-btn" onClick={() => set({ levels: undefined })}>{tt('charts.draw.levelReset')}</button>
                </span>
              </div>
            )}
          </>
        )
      case 'text':
        if (type === 'emoji') {
          return (
            <div className="draw-emoji-grid" role="radiogroup" aria-label={tt('charts.draw.emoji')}>
              {EMOJIS.map((e) => (
                <button key={e} type="button" role="radio" aria-checked={d.text === e} className={d.text === e ? 'on' : ''} onClick={() => set({ text: e })}>{e}</button>
              ))}
              <Row label={tt('charts.draw.fontSize')}>
                <Seg value={fontSizeOf(d)} label={tt('charts.draw.fontSize')} options={[10, 14, 18, 24, 32].map((n) => ({ v: n, label: String(n) }))} onChange={(v) => set({ fontSize: v })} />
              </Row>
            </div>
          )
        }
        return (
          <>
            {type === 'table' && <small>{tt('charts.draw.tableHint')}</small>}
            <textarea className="ind-in wide draw-text-in" rows={type === 'table' ? 6 : 4} maxLength={type === 'table' ? 2000 : 500} value={d.text ?? ''} autoFocus
              aria-label={tt('charts.draw.text')} placeholder={tt('charts.draw.textPh')} onChange={(e) => set({ text: e.target.value })} />
            <Row label={tt('charts.draw.fontSize')}>
              <Seg value={fontSizeOf(d)} label={tt('charts.draw.fontSize')} options={[10, 12, 14, 18, 24, 32].map((n) => ({ v: n, label: String(n) }))} onChange={(v) => set({ fontSize: v })} />
            </Row>
            <Row label={tt('charts.draw.textColor')}>
              <AlphaColorPicker presets={PALETTE} value={d.textColor || d.color} label={tt('charts.draw.textColor')} onChange={(v) => set({ textColor: v })} />
            </Row>
          </>
        )
      case 'inputs':
        if (isVp) return <VpInputs d={d} set={set} tt={tt} />
        return (
          <>
            <Row label={tt('charts.draw.account')}><Num value={d.account ?? DEFAULT_ACCOUNT} min={1} max={1e12} label={tt('charts.draw.account')} width={120} onChange={(v) => set({ account: v })} /></Row>
            <Row label={tt('charts.draw.riskPct')}><Num value={d.risk ?? DEFAULT_RISK} min={0.01} max={100} label={tt('charts.draw.riskPct')} onChange={(v) => set({ risk: v })} /></Row>
            <small>{tt('charts.draw.qtyHint')}</small>
          </>
        )
      case 'coords':
        return (
          <>
            {d.pts.map((pt, i) => {
              if (type === 'hline' && i > 0) return null
              const showT = type !== 'hline' && !(isPos && i > 0) && !(type === 'channel' && i === 2)
              const showP = type !== 'vline'
              if (FREEHAND.has(type)) return null
              return (
                <Row key={i} label={ptLabel(i)} hint={showT ? p.fmtTime(pt.t) : undefined}>
                  {showP ? <Num value={Number(pt.p.toFixed(p.digits))} width={120} label={ptLabel(i)} onChange={(v) => set({ pts: d.pts.map((x, k) => (k === i ? { ...x, p: v } : x)) })} /> : <span />}
                </Row>
              )
            })}
            {FREEHAND.has(type) && <small>{tt('charts.draw.brushCoords')}</small>}
          </>
        )
      case 'vis':
        return (
          <>
            <small>{tt('charts.draw.visHint')}</small>
            {VIS_GROUPS.map((g) => (
              <Row key={g} label={tt(`charts.draw.vis_${g}`)}>
                <Switch checked={d.vis?.[g] !== false} onChange={(v) => set({ vis: { ...(d.vis ?? {}), [g]: v } })} aria-label={tt(`charts.draw.vis_${g}`)} />
              </Row>
            ))}
          </>
        )
    }
  })()

  const saveTpl = () => {
    const name = tplName.trim()
    if (!name) return
    p.onSaveTemplate(name, d)
    setTplName('')
  }

  return (
    <ChartDialog
      title={`${tt(`charts.draw.${type}`)}${d.name ? ` · ${d.name}` : ''}`}
      onClose={p.onCancel}
      wide
      className="chart-cs"
      footer={<>
        <span className="draw-remember-hint">{tt('charts.draw.autoRemember')}</span>
        <button type="button" className="ind-btn primary" onClick={() => p.onApply(d)}>{tt('charts.draw.ok')}</button>
        <button type="button" className="ind-btn" onClick={p.onCancel}>{tt('common.cancel')}</button>
      </>}
    >
      <div className="chart-cs-tabs" role="tablist" aria-label={tt('charts.draw.settings')}>
        {tabs.map((k) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
            {tt(`charts.draw.tab_${k}`)}
          </button>
        ))}
      </div>
      <div className="chart-cs-body" role="tabpanel">
        {body}
        {tab === 'style' && (
          <div className="chart-set-sec chart-tpl">
            <b>{tt('charts.cs.templates')}</b>
            <form className="chart-iv-in" onSubmit={(e) => { e.preventDefault(); saveTpl() }}>
              <input value={tplName} onChange={(e) => setTplName(e.target.value)} maxLength={40} placeholder={tt('charts.cs.tplName')} aria-label={tt('charts.cs.tplName')} />
              <button type="submit" disabled={!tplName.trim()}>{tt('charts.cs.tplSave')}</button>
            </form>
            {p.templates.length === 0 && <small>{tt('charts.cs.tplEmpty')}</small>}
            {p.templates.map((x) => (
              <div key={x.name} className="chart-pop-row">
                <button type="button" className="chart-pop-item" onClick={() => setD((cur) => ({ ...cur, ...x.style }))}>
                  {x.name}<small>{tt('charts.cs.tplApply')}</small>
                </button>
                <button type="button" className="chart-pop-star" aria-label={tt('charts.cs.tplDelete', { name: x.name })} onClick={() => p.onDeleteTemplate(x.name)}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><path d="M6 6l12 12M18 6L6 18" /></svg>
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </ChartDialog>
  )
}
