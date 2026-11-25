// 新建 / 编辑 / 克隆一条图表警报。来源可以是价格、图上的指标（支持警报的那几种）或一条画线的
// 某一部分；条件、触发方式、周期、到期、消息、推送 / 邮件都在这一页。站内通知总是会发。
// Create / edit / clone a chart alert. The source is the price, an indicator on the chart (the
// kinds that support alerts) or a piece of a drawing; condition, trigger, interval, expiry,
// message and push / email all live on this one page. In-app notifications always go out.
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ChartAlert, ChartAlertCond, ChartAlertIn, ChartAlertKind, ChartAlertTrigger } from '../../../api/types'
import { localizeApiError } from '../../../api/utils'
import ChartDialog from '../ChartDialog'
import type { Drawing } from '../draw/model'
import type { IndInstance } from '../ind/types'
import { intervalLabel } from '../intervals'
import { createAlert, updateAlert, alertsNow } from './alertStore'
import {
  ALERT_INDS, ALERTS_MAX, CONDS_BAND, CONDS_LINE, CONDS_MOVE, PRICE_SCALE_INDS, SERVER_INTERVALS,
  alertableInd, closeBased, defaultMessage, drawSpec, drawTargets, indName, isBand, isMove, serverInputs,
  serverIntervalOf, triggersFor, type DrawTarget,
} from './model'

export interface AlertInit {
  // 编辑这一条；clone = 拿它当模板新建 / edit this one; clone = use it as a template for a new one
  edit?: ChartAlert
  clone?: boolean
  price?: number
  drawing?: Drawing
  indUid?: string
}

interface Props {
  init: AlertInit
  symbol: string
  digits: number
  chartInterval: string
  indicators: IndInstance[]
  drawings: Drawing[]
  bid: () => number | null
  onClose: () => void
  onSaved?: (a: ChartAlert, created: boolean) => void
}

type IndSpec = { type: string; inputs: Record<string, unknown>; plot: string }
interface Source { key: string; kind: ChartAlertKind; label: string; ind?: IndSpec; target?: DrawTarget }

const p2 = (n: number) => String(n).padStart(2, '0')
function localInput(d: Date): string {
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}`
}
const num = (s: string) => (s.trim() === '' ? NaN : Number(s))

export default function AlertDialog({ init, symbol, digits, chartInterval, indicators, drawings, bid, onClose, onSaved }: Props) {
  const { t } = useTranslation()
  const tt = (k: string, o?: Record<string, unknown>) => String(t(k, o))
  const ed = init.edit
  const es = (ed?.spec ?? {}) as Record<string, unknown>
  const sym = ed?.symbol ?? symbol
  const editing = !!ed && !init.clone
  const fmt = (v: number) => (Number.isFinite(v) ? v.toFixed(digits) : '')

  // ── 来源 / sources ──
  const drawing = init.drawing ?? (ed?.kind === 'drawing' ? drawings.find((d) => d.id === ed.drawingId) : undefined)
  const sources = useMemo<Source[]>(() => {
    const out: Source[] = []
    if (drawing) {
      const name = drawing.name || tt(`charts.draw.${drawing.type}`)
      const tgs = drawTargets(drawing)
      for (const tg of tgs) {
        const part = tgs.length > 1 ? ` · ${tt(tg.label, tg.labelArgs)}` : ''
        out.push({ key: `draw:${tg.part}`, kind: 'drawing', label: `${name}${part}`, target: tg })
      }
      if (ed?.kind === 'drawing' && !tgs.some((x) => x.part === (es.part ?? 'line'))) {
        out.push({ key: 'draw:saved', kind: 'drawing', label: String(es.label || tt('charts.alert.drawing')) })
      }
      return out
    }
    if (ed?.kind === 'drawing') return [{ key: 'draw:saved', kind: 'drawing', label: String(es.label || tt('charts.alert.drawing')) }]
    out.push({ key: 'price', kind: 'price', label: tt('charts.alert.price') })
    if (ed?.kind === 'indicator' && es.ind && typeof es.ind === 'object') {
      const i = es.ind as IndSpec
      out.push({ key: 'ind:saved', kind: 'indicator', label: `${indName(i.type, i.inputs)}${ALERT_INDS[i.type]?.length > 1 ? ` · ${tt(`charts.alert.plot.${i.plot}`, { defaultValue: i.plot })}` : ''}`, ind: i })
    }
    for (const inst of indicators.filter(alertableInd)) {
      const plots = ALERT_INDS[inst.type]
      for (const plot of plots) {
        out.push({
          key: `ind:${inst.uid}:${plot}`, kind: 'indicator',
          label: `${indName(inst.type, inst.inputs)}${plots.length > 1 ? ` · ${tt(`charts.alert.plot.${plot}`, { defaultValue: plot })}` : ''}`,
          ind: { type: inst.type, inputs: serverInputs(inst.type, inst.inputs), plot },
        })
      }
    }
    return out
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawing, indicators])

  const initialSrc = (() => {
    if (ed?.kind === 'drawing') return sources.find((s) => s.key === `draw:${es.part ?? 'line'}`)?.key ?? 'draw:saved'
    if (ed?.kind === 'indicator') return 'ind:saved'
    if (init.drawing) return sources[0]?.key ?? 'price'
    if (init.indUid) return sources.find((s) => s.key.startsWith(`ind:${init.indUid}:`))?.key ?? 'price'
    return 'price'
  })()
  const [srcKey, setSrcKey] = useState(initialSrc)
  const src = sources.find((s) => s.key === srcKey) ?? sources[0]
  const kind = src?.kind ?? 'price'

  const condsOf = (s: Source | undefined): ChartAlertCond[] => {
    if (!s) return CONDS_LINE
    if (s.kind === 'drawing') {
      if (s.target) return s.target.band ? CONDS_BAND : CONDS_LINE
      return Array.isArray(es.lines) && es.lines.length === 2 ? CONDS_BAND : CONDS_LINE
    }
    return [...CONDS_LINE, ...CONDS_BAND, ...CONDS_MOVE]
  }
  const [cond, setCondState] = useState<ChartAlertCond>(() => {
    const list = condsOf(src)
    return ed && list.includes(ed.cond) ? ed.cond : list[0]
  })
  const conds = condsOf(src)
  const condNow: ChartAlertCond = conds.includes(cond) ? cond : conds[0]

  // ── 数值 / values ──
  const startPrice = init.price ?? bid() ?? NaN
  const [level, setLevel] = useState(() => fmt(typeof es.level === 'number' ? es.level : startPrice))
  const [lo, setLo] = useState(() => fmt(typeof es.lo === 'number' ? es.lo : startPrice * 0.995))
  const [hi, setHi] = useState(() => fmt(typeof es.hi === 'number' ? es.hi : startPrice * 1.005))
  const [moveV, setMoveV] = useState(() => (typeof es.value === 'number' ? String(es.value) : ''))
  const [moveN, setMoveN] = useState(() => (typeof es.bars === 'number' ? String(es.bars) : '1'))
  const et = (es.target ?? {}) as { kind?: string; v?: number; lo?: number; hi?: number; plot?: string }
  const [tgt, setTgt] = useState<string>(() => (et.kind === 'plot' ? `plot:${et.plot}` : et.kind === 'price' ? 'price' : 'value'))
  const [tv, setTv] = useState(() => (typeof et.v === 'number' ? String(et.v) : ''))
  const [tlo, setTlo] = useState(() => (typeof et.lo === 'number' ? String(et.lo) : ''))
  const [thi, setThi] = useState(() => (typeof et.hi === 'number' ? String(et.hi) : ''))

  // 换来源时把指标的比较值预填成常用的（RSI 70、价格类叠加默认跟价格比）
  // Changing the source pre-fills sensible targets (RSI 70; price overlays compare with price)
  const pickSource = (key: string) => {
    setSrcKey(key)
    const s = sources.find((x) => x.key === key)
    if (s?.kind !== 'indicator' || !s.ind) return
    const ty = s.ind.type
    if (PRICE_SCALE_INDS.has(ty)) { setTgt('price'); return }
    setTgt('value')
    const preset: Record<string, [string, string, string]> = { rsi: ['70', '30', '70'], stoch: ['80', '20', '80'], willr: ['-20', '-80', '-20'], cci: ['100', '-100', '100'] }
    const p = preset[ty] ?? ['0', '', '']
    setTv(p[0]); setTlo(p[1]); setThi(p[2])
  }

  // ── 触发、周期、到期、通知 / trigger, interval, expiry, notify ──
  const [trigger, setTrigger] = useState<ChartAlertTrigger>(ed?.trigger ?? 'once')
  const triggers = triggersFor(kind, condNow)
  const triggerNow: ChartAlertTrigger = triggers.includes(trigger) ? trigger : 'close'
  const [interval, setIv] = useState<string>(ed?.interval ?? serverIntervalOf(chartInterval))
  const showInterval = triggerNow !== 'once' || closeBased(kind, condNow)
  const [never, setNever] = useState(!ed?.expiresAt)
  const [expires, setExpires] = useState(() => localInput(ed?.expiresAt ? new Date(ed.expiresAt) : new Date(Date.now() + 30 * 86400_000)))
  const [message, setMessage] = useState(ed?.message ?? '')
  const [push, setPush] = useState(ed?.push ?? true)
  const [email, setEmail] = useState(ed?.email ?? false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  // ── 组装 / build ──
  const build = (): ChartAlertIn | string => {
    const spec: Record<string, unknown> = {}
    const b = bid()
    if (isMove(condNow)) {
      const v = num(moveV), n = Math.round(num(moveN))
      if (!(v > 0)) return tt('charts.alert.err.value')
      if (!(n >= 1 && n <= 500)) return tt('charts.alert.err.bars')
      spec.value = v; spec.bars = n
    }
    if (kind === 'price') {
      if (isBand(condNow)) {
        const a = num(lo), c = num(hi)
        if (!(a > 0) || !(c > 0) || a === c) return tt('charts.alert.err.band')
        spec.lo = Math.min(a, c); spec.hi = Math.max(a, c)
      } else if (!isMove(condNow)) {
        const v = num(level)
        if (!(v > 0)) return tt('charts.alert.err.price')
        spec.level = v
      }
      if (b != null && b > 0) spec.ref = b
    } else if (kind === 'drawing') {
      if (src?.target) Object.assign(spec, drawSpec(src.target))
      else { spec.lines = es.lines; if (es.part) spec.part = es.part; if (es.win) spec.win = es.win }
      spec.label = (src?.label ?? '').slice(0, 60)
      if (b != null && b > 0) spec.ref = b
    } else {
      if (!src?.ind) return tt('charts.alert.err.source')
      spec.ind = src.ind
      if (!isMove(condNow)) {
        if (isBand(condNow)) {
          const a = num(tlo), c = num(thi)
          if (!Number.isFinite(a) || !Number.isFinite(c) || a === c) return tt('charts.alert.err.band')
          spec.target = { kind: 'band', lo: Math.min(a, c), hi: Math.max(a, c) }
        } else if (tgt === 'price') spec.target = { kind: 'price' }
        else if (tgt.startsWith('plot:')) spec.target = { kind: 'plot', plot: tgt.slice(5) }
        else {
          const v = num(tv)
          if (!Number.isFinite(v)) return tt('charts.alert.err.value')
          spec.target = { kind: 'value', v }
        }
      }
    }
    let expiresAt: string | null = null
    if (!never) {
      const d = new Date(expires)
      if (!Number.isFinite(d.getTime()) || d.getTime() <= Date.now()) return tt('charts.alert.err.expiry')
      expiresAt = d.toISOString()
    }
    const body: ChartAlertIn = {
      symbol: sym, kind, cond: condNow, spec, trigger: triggerNow, interval: showInterval ? interval : (ed?.interval ?? serverIntervalOf(chartInterval)),
      message: '', push, email, expiresAt, drawingId: kind === 'drawing' ? (drawing?.id ?? ed?.drawingId ?? null) : null,
      active: editing ? ed!.status !== 'paused' : true,
    }
    body.message = message.trim() || defaultMessage(body, digits, t)
    return body
  }

  const save = async () => {
    const body = build()
    if (typeof body === 'string') { setErr(body); return }
    if (!editing && alertsNow().length >= ALERTS_MAX) { setErr(tt('charts.alert.err.max', { n: ALERTS_MAX })); return }
    setBusy(true); setErr('')
    try {
      const a = editing ? await updateAlert(ed!.id, body) : await createAlert(body)
      onSaved?.(a, !editing)
      onClose()
    } catch (e) {
      setErr(e instanceof Error ? localizeApiError(e.message) : tt('charts.alert.err.save'))
    } finally {
      setBusy(false)
    }
  }

  const preview = (() => { const b = build(); return typeof b === 'string' ? '' : b.message })()
  const indPlots = src?.ind ? ALERT_INDS[src.ind.type].filter((p) => p !== src.ind!.plot) : []
  const numIn = (v: string, set: (s: string) => void, label: string) => (
    <input className="ind-in wide" inputMode="decimal" value={v} onChange={(e) => setVal(set, e.target.value)} aria-label={label} />
  )
  function setVal(set: (s: string) => void, s: string) { set(s); setErr('') }

  return (
    <ChartDialog
      title={tt(editing ? 'charts.alert.editTitle' : 'charts.alert.newTitle', { symbol: sym })}
      onClose={onClose}
      className="alert-dlg"
      footer={<>
        {err && <span className="alert-err" role="alert">{err}</span>}
        <button type="button" className="ind-btn" onClick={onClose}>{tt('common.cancel')}</button>
        <button type="button" className="ind-btn primary" onClick={() => void save()} disabled={busy}>{tt(editing ? 'charts.alert.save' : 'charts.alert.create')}</button>
      </>}
    >
      <form className="alert-form" onSubmit={(e) => { e.preventDefault(); void save() }}>
        <label className="alert-row">
          <span>{tt('charts.alert.source')}</span>
          <select className="ind-in wide" value={src?.key} onChange={(e) => pickSource(e.target.value)} disabled={sources.length < 2}>
            {sources.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
        </label>
        <label className="alert-row">
          <span>{tt('charts.alert.condition')}</span>
          <select className="ind-in wide" value={condNow} onChange={(e) => { setCondState(e.target.value as ChartAlertCond); setErr('') }}>
            {conds.map((c) => <option key={c} value={c}>{tt(`charts.alert.cond.${c}`)}</option>)}
          </select>
        </label>

        {kind === 'price' && !isMove(condNow) && (isBand(condNow) ? (
          <div className="alert-row">
            <span>{tt('charts.alert.range')}</span>
            <div className="alert-pair">{numIn(lo, setLo, tt('charts.alert.lower'))}<i>–</i>{numIn(hi, setHi, tt('charts.alert.upper'))}</div>
          </div>
        ) : (
          <label className="alert-row"><span>{tt('charts.alert.value')}</span>{numIn(level, setLevel, tt('charts.alert.value'))}</label>
        ))}

        {kind === 'indicator' && !isMove(condNow) && (isBand(condNow) ? (
          <div className="alert-row">
            <span>{tt('charts.alert.range')}</span>
            <div className="alert-pair">{numIn(tlo, setTlo, tt('charts.alert.lower'))}<i>–</i>{numIn(thi, setThi, tt('charts.alert.upper'))}</div>
          </div>
        ) : (
          <>
            <label className="alert-row">
              <span>{tt('charts.alert.against')}</span>
              <select className="ind-in wide" value={tgt} onChange={(e) => setTgt(e.target.value)}>
                <option value="value">{tt('charts.alert.aValue')}</option>
                {src?.ind && PRICE_SCALE_INDS.has(src.ind.type) && <option value="price">{tt('charts.alert.price')}</option>}
                {indPlots.map((p) => <option key={p} value={`plot:${p}`}>{tt(`charts.alert.plot.${p}`, { defaultValue: p })}</option>)}
              </select>
            </label>
            {tgt === 'value' && <label className="alert-row"><span>{tt('charts.alert.value')}</span>{numIn(tv, setTv, tt('charts.alert.value'))}</label>}
          </>
        ))}

        {isMove(condNow) && (
          <div className="alert-row">
            <span>{tt('charts.alert.move')}</span>
            <div className="alert-pair">
              {numIn(moveV, setMoveV, tt('charts.alert.moveBy'))}
              <i>{condNow === 'moveUpPct' || condNow === 'moveDownPct' ? '%' : ''}</i>
              <span className="alert-in-unit">{tt('charts.alert.within')}</span>
              <input className="ind-in" inputMode="numeric" value={moveN} onChange={(e) => setVal(setMoveN, e.target.value)} aria-label={tt('charts.alert.bars')} />
              <span className="alert-in-unit">{tt('charts.alert.barsUnit')}</span>
            </div>
          </div>
        )}

        <div className="alert-row">
          <span>{tt('charts.alert.trigger')}</span>
          <span className="ind-seg alert-seg" role="radiogroup" aria-label={tt('charts.alert.trigger')}>
            {triggers.map((g) => (
              <button key={g} type="button" role="radio" aria-checked={triggerNow === g} className={triggerNow === g ? 'on' : ''} onClick={() => setTrigger(g)}>
                {tt(`charts.alert.trig.${g}`)}
              </button>
            ))}
          </span>
        </div>
        {showInterval && (
          <label className="alert-row">
            <span>{tt('charts.alert.interval')}</span>
            <select className="ind-in wide" value={interval} onChange={(e) => setIv(e.target.value)}>
              {SERVER_INTERVALS.map((iv) => <option key={iv} value={iv}>{intervalLabel(iv)}</option>)}
            </select>
          </label>
        )}
        <div className="alert-row">
          <span>{tt('charts.alert.expiry')}</span>
          <div className="alert-pair">
            <label className="alert-chk"><input type="checkbox" checked={never} onChange={(e) => setNever(e.target.checked)} />{tt('charts.alert.never')}</label>
            {!never && <input type="datetime-local" className="ind-in wide" value={expires} onChange={(e) => setVal(setExpires, e.target.value)} aria-label={tt('charts.alert.expiry')} />}
          </div>
        </div>
        <label className="alert-row top">
          <span>{tt('charts.alert.message')}</span>
          <textarea className="ind-in wide alert-msg" rows={2} maxLength={200} value={message} placeholder={preview} onChange={(e) => setMessage(e.target.value)} />
        </label>
        <div className="alert-row">
          <span>{tt('charts.alert.notify')}</span>
          <div className="alert-pair wrap">
            <label className="alert-chk"><input type="checkbox" checked disabled />{tt('charts.alert.inApp')}</label>
            <label className="alert-chk"><input type="checkbox" checked={push} onChange={(e) => setPush(e.target.checked)} />{tt('charts.alert.push')}</label>
            <label className="alert-chk"><input type="checkbox" checked={email} onChange={(e) => setEmail(e.target.checked)} />{tt('charts.alert.email')}</label>
          </div>
        </div>
        <p className="chart-dlg-note">{tt(closeBased(kind, condNow) || triggerNow === 'close' ? 'charts.alert.noteClose' : 'charts.alert.noteTick')}</p>
        <button type="submit" hidden />
      </form>
    </ChartDialog>
  )
}
