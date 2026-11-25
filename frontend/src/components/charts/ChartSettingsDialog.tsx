// 图表设置（对标 TradingView 的 Chart settings）：主图 / 状态行 / 坐标与线 / 画布 / 交易 五个页签，
// 底部是模板（存当前外观、套用、删除）与「恢复默认」。改动即时生效、云端同步（chartv2）。
// 取代 2026-11-25 之前齿轮上的小菜单（倒计时 + K 线颜色 + 显示持仓），那几项都在这里。
// Chart settings (benchmarked on TradingView's): Symbol / Status line / Scales & lines /
// Canvas / Trading tabs, with templates (save the current look, apply, delete) and "reset"
// in the footer. Applies instantly and syncs to the cloud (chartv2). Replaces the small gear
// menu used before 2026-11-25 (countdown, candle colours, show positions) — those live here.
import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import ChartDialog from './ChartDialog'
import Switch from '../Switch'
import { ColorDot } from './IndicatorSettingsModal'
import { CANDLE_COLOR_PRESETS, CANDLE_SCHEMES, candleSchemeOf, type CandleColors, type CandleScheme } from './chartConfig'
import { COLOR_PRESETS } from './indicatorSettings'
import { PRICE_BASED_TYPES, templateOf, type ChartPrefs, type GridMode, type ScaleMode } from './chartPrefs'
import type { ChartPrefsUpdate } from './useChartPrefs'

type Tab = 'symbol' | 'status' | 'scales' | 'canvas' | 'trading'
const TABS: Tab[] = ['symbol', 'status', 'scales', 'canvas', 'trading']

interface Props {
  prefs: ChartPrefs
  update: (u: ChartPrefsUpdate) => void
  reset: () => void
  candleColors: CandleColors
  onCandleColors: (c: CandleColors) => void
  showCountdown: boolean
  onShowCountdown: (v: boolean) => void
  showPositions: boolean
  onShowPositions: (v: boolean) => void
  afterPlaceOpen: boolean
  onAfterPlaceOpen: (v: boolean) => void
  onClose: () => void
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="chart-set-row">
      <span className="chart-set-lbl"><b>{label}</b>{hint && <small>{hint}</small>}</span>
      {children}
    </div>
  )
}

function Seg<T extends string | number>({ value, options, onChange, label }: { value: T; options: { v: T; label: string }[]; onChange: (v: T) => void; label: string }) {
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

function Num({ value, onChange, min, max, step = 1, label, autoLabel }: { value: number; onChange: (v: number) => void; min: number; max: number; step?: number; label: string; autoLabel?: string }) {
  const [text, setText] = useState(value === 0 && autoLabel ? '' : String(value))
  return (
    <input
      className="ind-in"
      inputMode="decimal"
      aria-label={label}
      placeholder={autoLabel}
      value={text}
      onChange={(e) => {
        setText(e.target.value)
        const v = e.target.value.trim() === '' && autoLabel ? 0 : Number(e.target.value)
        if (Number.isFinite(v) && (v === 0 && autoLabel ? true : v >= min && v <= max)) onChange(step >= 1 ? Math.round(v) : v)
      }}
    />
  )
}

export default function ChartSettingsDialog(p: Props) {
  const { t } = useTranslation()
  const tt = (k: string, o?: Record<string, unknown>) => String(t(k, o))
  const [tab, setTab] = useState<Tab>('symbol')
  const [tplName, setTplName] = useState('')
  const { prefs, update } = p
  const set = <K extends keyof ChartPrefs>(k: K, v: ChartPrefs[K]) => update({ [k]: v } as Partial<ChartPrefs>)
  const scheme = candleSchemeOf(p.candleColors)
  const ct = prefs.chartType

  const saveTemplate = () => {
    const name = tplName.trim()
    if (!name) return
    const rest = prefs.templates.filter((x) => x.name !== name)
    set('templates', [...rest, { name, prefs: templateOf(prefs) }].slice(-20))
    setTplName('')
  }

  const body = (() => {
    switch (tab) {
      case 'symbol':
        return (
          <>
            <div className="chart-set-sec">
              <b>{tt('charts.settings.candleColors')}</b>
              <Seg<CandleScheme | 'custom'>
                value={scheme}
                label={tt('charts.settings.candleColors')}
                options={[{ v: 'greenUp', label: tt('charts.settings.greenUp') }, { v: 'redUp', label: tt('charts.settings.redUp') }]}
                onChange={(v) => { if (v !== 'custom') p.onCandleColors({ ...CANDLE_SCHEMES[v] }) }}
              />
              <div className="chart-set-custom">
                <span className="chart-set-pick">
                  <ColorDot value={p.candleColors.up} palette={CANDLE_COLOR_PRESETS} label={tt('charts.settings.upColor')} onChange={(v) => p.onCandleColors({ ...p.candleColors, up: v })} />
                  {tt('charts.settings.upColor')}
                </span>
                <span className="chart-set-pick">
                  <ColorDot value={p.candleColors.down} palette={CANDLE_COLOR_PRESETS} label={tt('charts.settings.downColor')} onChange={(v) => p.onCandleColors({ ...p.candleColors, down: v })} />
                  {tt('charts.settings.downColor')}
                </span>
                {scheme === 'custom' && <em>{tt('charts.settings.custom')}</em>}
              </div>
            </div>
            <Row label={tt('charts.cs.body')}><Switch checked={prefs.candle.body} onChange={(v) => set('candle', { ...prefs.candle, body: v })} aria-label={tt('charts.cs.body')} /></Row>
            <Row label={tt('charts.cs.borders')}><Switch checked={prefs.candle.borders} onChange={(v) => set('candle', { ...prefs.candle, borders: v })} aria-label={tt('charts.cs.borders')} /></Row>
            <Row label={tt('charts.cs.wick')}><Switch checked={prefs.candle.wick} onChange={(v) => set('candle', { ...prefs.candle, wick: v })} aria-label={tt('charts.cs.wick')} /></Row>
            <Row label={tt('charts.cs.lineColor')} hint={tt('charts.cs.lineColorHint')}>
              <ColorDot value={prefs.lineColor} palette={COLOR_PRESETS} label={tt('charts.cs.lineColor')} onChange={(v) => set('lineColor', v)} />
            </Row>
            <Row label={tt('charts.cs.lineWidth')}>
              <Seg value={prefs.lineWidth} label={tt('charts.cs.lineWidth')} options={[1, 2, 3, 4].map((n) => ({ v: n, label: `${n}px` }))} onChange={(v) => set('lineWidth', v)} />
            </Row>
            {(PRICE_BASED_TYPES.has(ct)) && (
              <div className="chart-set-sec">
                <b>{tt(`charts.type.${ct}`)}</b>
                {ct === 'renko' && <>
                  <Row label={tt('charts.cs.box')} hint={tt('charts.cs.autoHint')}><Num value={prefs.transform.renkoBox} min={0} max={1e9} step={0.00001} label={tt('charts.cs.box')} autoLabel={tt('charts.cs.auto')} onChange={(v) => set('transform', { ...prefs.transform, renkoBox: v })} /></Row>
                  <Row label={tt('charts.cs.wicks')}><Switch checked={prefs.transform.renkoWicks} onChange={(v) => set('transform', { ...prefs.transform, renkoWicks: v })} aria-label={tt('charts.cs.wicks')} /></Row>
                </>}
                {ct === 'lineBreak' && (
                  <Row label={tt('charts.cs.lineCount')}><Num value={prefs.transform.lineBreak} min={1} max={10} label={tt('charts.cs.lineCount')} onChange={(v) => set('transform', { ...prefs.transform, lineBreak: v })} /></Row>
                )}
                {ct === 'kagi' && (
                  <Row label={tt('charts.cs.reversal')} hint={tt('charts.cs.autoHint')}><Num value={prefs.transform.kagiReversal} min={0} max={1e9} step={0.00001} label={tt('charts.cs.reversal')} autoLabel={tt('charts.cs.auto')} onChange={(v) => set('transform', { ...prefs.transform, kagiReversal: v })} /></Row>
                )}
                {ct === 'pnf' && <>
                  <Row label={tt('charts.cs.box')} hint={tt('charts.cs.autoHint')}><Num value={prefs.transform.pnfBox} min={0} max={1e9} step={0.00001} label={tt('charts.cs.box')} autoLabel={tt('charts.cs.auto')} onChange={(v) => set('transform', { ...prefs.transform, pnfBox: v })} /></Row>
                  <Row label={tt('charts.cs.pnfReversal')}><Num value={prefs.transform.pnfReversal} min={1} max={10} label={tt('charts.cs.pnfReversal')} onChange={(v) => set('transform', { ...prefs.transform, pnfReversal: v })} /></Row>
                  <Row label={tt('charts.cs.source')}>
                    <Seg value={prefs.transform.pnfSource} label={tt('charts.cs.source')} options={[{ v: 'close', label: tt('charts.cs.srcClose') }, { v: 'hl', label: tt('charts.cs.srcHL') }]} onChange={(v) => set('transform', { ...prefs.transform, pnfSource: v })} />
                  </Row>
                </>}
              </div>
            )}
          </>
        )
      case 'status':
        return (
          <>
            {(['title', 'ohlc', 'change', 'volume', 'indicators'] as const).map((k) => (
              <Row key={k} label={tt(`charts.cs.legend.${k}`)}>
                <Switch checked={prefs.legend[k]} onChange={(v) => set('legend', { ...prefs.legend, [k]: v })} aria-label={tt(`charts.cs.legend.${k}`)} />
              </Row>
            ))}
          </>
        )
      case 'scales':
        return (
          <>
            <Row label={tt('charts.cs.scaleMode')}>
              <Seg<ScaleMode> value={prefs.scaleMode} label={tt('charts.cs.scaleMode')} options={[
                { v: 0, label: tt('charts.scale.normal') }, { v: 1, label: tt('charts.scale.log') }, { v: 2, label: '%' }, { v: 3, label: tt('charts.scale.indexed') },
              ]} onChange={(v) => set('scaleMode', v)} />
            </Row>
            <Row label={tt('charts.cs.invert')}><Switch checked={prefs.invertScale} onChange={(v) => set('invertScale', v)} aria-label={tt('charts.cs.invert')} /></Row>
            {(['lastPrice', 'bidAsk', 'highLow', 'prevClose', 'indicatorLabels', 'sessionBreaks'] as const).map((k) => (
              <Row key={k} label={tt(`charts.cs.lines.${k}`)} hint={tt(`charts.cs.lines.${k}Hint`)}>
                <Switch checked={prefs.lines[k]} onChange={(v) => set('lines', { ...prefs.lines, [k]: v })} aria-label={tt(`charts.cs.lines.${k}`)} />
              </Row>
            ))}
            <Row label={tt('charts.settings.countdown')} hint={tt('charts.settings.countdownHint')}>
              <Switch checked={p.showCountdown} onChange={p.onShowCountdown} aria-label={tt('charts.settings.countdown')} />
            </Row>
          </>
        )
      case 'canvas':
        return (
          <>
            <Row label={tt('charts.cs.theme')}>
              <Seg value={prefs.theme} label={tt('charts.cs.theme')} options={[
                { v: 'dark', label: tt('charts.cs.dark') }, { v: 'light', label: tt('charts.cs.light') }, { v: 'system', label: tt('charts.cs.system') },
              ]} onChange={(v) => set('theme', v)} />
            </Row>
            <Row label={tt('charts.cs.bg')} hint={tt('charts.cs.bgHint')}>
              <span className="chart-set-pick">
                <ColorDot value={prefs.canvas.bg ?? '#09090b'} palette={['#09090b', '#0b0e14', '#131722', '#1e222d', '#ffffff', '#f8f9fd', '#fdf6e3', '#0c1a2a']} label={tt('charts.cs.bg')} onChange={(v) => set('canvas', { ...prefs.canvas, bg: v })} />
                {prefs.canvas.bg && <button type="button" className="chart-link" onClick={() => set('canvas', { ...prefs.canvas, bg: null })}>{tt('charts.cs.bgReset')}</button>}
              </span>
            </Row>
            <Row label={tt('charts.cs.grid')}>
              <Seg<GridMode> value={prefs.canvas.grid} label={tt('charts.cs.grid')} options={(['both', 'vert', 'horz', 'none'] as const).map((v) => ({ v, label: tt(`charts.cs.grid_${v}`) }))} onChange={(v) => set('canvas', { ...prefs.canvas, grid: v })} />
            </Row>
            <Row label={tt('charts.cs.crosshair')}>
              <Seg value={prefs.canvas.crosshair} label={tt('charts.cs.crosshair')} options={(['normal', 'magnet', 'hidden'] as const).map((v) => ({ v, label: tt(`charts.cs.cross_${v}`) }))} onChange={(v) => set('canvas', { ...prefs.canvas, crosshair: v })} />
            </Row>
            <Row label={tt('charts.cs.crossStyle')}>
              <Seg value={prefs.canvas.crossStyle} label={tt('charts.cs.crossStyle')} options={(['solid', 'dashed', 'dotted'] as const).map((v) => ({ v, label: tt(`charts.cs.dash_${v}`) }))} onChange={(v) => set('canvas', { ...prefs.canvas, crossStyle: v })} />
            </Row>
            <Row label={tt('charts.cs.watermark')} hint={tt('charts.cs.watermarkHint')}>
              <Switch checked={prefs.canvas.watermark} onChange={(v) => set('canvas', { ...prefs.canvas, watermark: v })} aria-label={tt('charts.cs.watermark')} />
            </Row>
            <Row label={tt('charts.cs.rightOffset')} hint={tt('charts.cs.rightOffsetHint')}>
              <Num value={prefs.canvas.rightOffset} min={0} max={80} label={tt('charts.cs.rightOffset')} onChange={(v) => set('canvas', { ...prefs.canvas, rightOffset: v })} />
            </Row>
          </>
        )
      case 'trading': {
        const tr = prefs.trading
        const setTr = (patch: Partial<typeof tr>) => set('trading', { ...tr, ...patch })
        return (
          <>
            <Row label={tt('charts.settings.positions')} hint={tt('charts.settings.positionsHint')}>
              <Switch checked={p.showPositions} onChange={p.onShowPositions} aria-label={tt('charts.settings.positions')} />
            </Row>
            <Row label={tt('charts.cs.tr.pending')}>
              <Switch checked={tr.pending} onChange={(v) => setTr({ pending: v })} aria-label={tt('charts.cs.tr.pending')} />
            </Row>
            <Row label={tt('charts.cs.tr.pnl')} hint={tt('charts.cs.tr.pnlHint')}>
              <Switch checked={tr.pnl} onChange={(v) => setTr({ pnl: v })} aria-label={tt('charts.cs.tr.pnl')} />
            </Row>
            <Row label={tt('charts.cs.tr.pnlUnit')}>
              <Seg value={tr.pnlUnit} label={tt('charts.cs.tr.pnlUnit')} options={(['money', 'points', 'pct'] as const).map((v) => ({ v, label: tt(`charts.cs.tr.unit_${v}`) }))} onChange={(v) => setTr({ pnlUnit: v })} />
            </Row>
            <Row label={tt('charts.cs.tr.lineButtons')} hint={tt('charts.cs.tr.lineButtonsHint')}>
              <Switch checked={tr.lineButtons} onChange={(v) => setTr({ lineButtons: v })} aria-label={tt('charts.cs.tr.lineButtons')} />
            </Row>
            <Row label={tt('charts.cs.tr.align')}>
              <Seg value={tr.align} label={tt('charts.cs.tr.align')} options={(['left', 'right'] as const).map((v) => ({ v, label: tt(`charts.cs.tr.align_${v}`) }))} onChange={(v) => setTr({ align: v })} />
            </Row>
            <Row label={tt('charts.cs.tr.executions')} hint={tt('charts.cs.tr.executionsHint')}>
              <Switch checked={tr.executions} onChange={(v) => setTr({ executions: v })} aria-label={tt('charts.cs.tr.executions')} />
            </Row>
            <Row label={tt('charts.cs.tr.buttons')} hint={tt('charts.cs.tr.buttonsHint')}>
              <Switch checked={tr.buttons} onChange={(v) => setTr({ buttons: v })} aria-label={tt('charts.cs.tr.buttons')} />
            </Row>
            <Row label={tt('charts.cs.tr.oneClick')} hint={tt('charts.cs.tr.oneClickHint')}>
              <Switch checked={tr.oneClick} onChange={(v) => setTr({ oneClick: v })} aria-label={tt('charts.cs.tr.oneClick')} />
            </Row>
            <Row label={tt('charts.cs.tr.sound')}>
              <Switch checked={tr.sound} onChange={(v) => setTr({ sound: v })} aria-label={tt('charts.cs.tr.sound')} />
            </Row>
            <Row label={tt('charts.cs.afterPlace')} hint={tt('charts.cs.afterPlaceHint')}>
              <Switch checked={p.afterPlaceOpen} onChange={p.onAfterPlaceOpen} aria-label={tt('charts.cs.afterPlace')} />
            </Row>
          </>
        )
      }
    }
  })()

  return (
    <ChartDialog
      title={tt('charts.settings.title')}
      onClose={p.onClose}
      wide
      className="chart-cs"
      footer={<>
        <button type="button" className="ind-btn" onClick={p.reset}>{tt('charts.cs.reset')}</button>
        <button type="button" className="ind-btn primary" onClick={p.onClose}>{tt('charts.indicators.done')}</button>
      </>}
    >
      <div className="chart-cs-tabs" role="tablist" aria-label={tt('charts.settings.title')}>
        {TABS.map((k) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
            {tt(`charts.cs.tab.${k}`)}
          </button>
        ))}
      </div>
      <div className="chart-cs-body" role="tabpanel">
        {body}
        {tab !== 'trading' && (
          <div className="chart-set-sec chart-tpl">
            <b>{tt('charts.cs.templates')}</b>
            <form className="chart-iv-in" onSubmit={(e) => { e.preventDefault(); saveTemplate() }}>
              <input value={tplName} onChange={(e) => setTplName(e.target.value)} maxLength={40} placeholder={tt('charts.cs.tplName')} aria-label={tt('charts.cs.tplName')} />
              <button type="submit" disabled={!tplName.trim()}>{tt('charts.cs.tplSave')}</button>
            </form>
            {prefs.templates.length === 0 && <small>{tt('charts.cs.tplEmpty')}</small>}
            {prefs.templates.map((x) => (
              <div key={x.name} className="chart-pop-row">
                <button type="button" className="chart-pop-item" onClick={() => update((cur) => ({ ...cur, ...x.prefs, templates: cur.templates, interval: cur.interval, favIntervals: cur.favIntervals, timezone: cur.timezone }))}>
                  {x.name}<small>{tt('charts.cs.tplApply')}</small>
                </button>
                <button type="button" className="chart-pop-star" aria-label={tt('charts.cs.tplDelete', { name: x.name })} onClick={() => set('templates', prefs.templates.filter((y) => y !== x))}>
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
