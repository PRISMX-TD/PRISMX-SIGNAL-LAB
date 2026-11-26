// 成交量分布（固定范围 / 锚定）的「输入」与「样式」页，照 TradingView FRVP 的设置排布。
// The volume profile's Inputs and Style tabs, laid out like TradingView's FRVP settings.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import Switch from '../../Switch'
import { AlphaColorPicker } from '../ind/ColorPicker'
import { type Drawing, type VpLine, type VpOpts, PALETTE, showLabelOf } from './model'
import { vpOf } from './ext/volume'

type Tr = (k: string, o?: Record<string, unknown>) => string
interface Props { d: Drawing; set: (patch: Partial<Drawing>) => void; tt: Tr }

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="chart-set-row">
      <span className="chart-set-lbl"><b>{label}</b></span>
      {children}
    </div>
  )
}

function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: { v: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <span className="ind-seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.v} type="button" role="radio" aria-checked={value === o.v} className={value === o.v ? 'on' : ''} onClick={() => onChange(o.v)}>{o.label}</button>
      ))}
    </span>
  )
}

// 整数输入：越界或非数字时不回写 / integer input; out-of-range or non-numeric text isn't written back
function Int({ value, onChange, label, min, max }: { value: number; onChange: (v: number) => void; label: string; min: number; max: number }) {
  const [text, setText] = useState(String(value))
  const last = useRef(value)
  useEffect(() => { if (value !== last.current) { last.current = value; setText(String(value)) } }, [value])
  return (
    <input className="ind-in" inputMode="numeric" aria-label={label} value={text} style={{ width: 88 }}
      onChange={(e) => {
        setText(e.target.value)
        const v = Number(e.target.value)
        if (e.target.value.trim() !== '' && Number.isInteger(v) && v >= min && v <= max) { last.current = v; onChange(v) }
      }} />
  )
}

// 勾选框 + 名称在左、取色在右（TradingView 样式页的写法）/ checkbox + name on the left, colour on the right
function CheckColor({ label, on, color, onToggle, onColor, indent }: { label: string; on?: boolean; color: string; onToggle?: (v: boolean) => void; onColor: (c: string) => void; indent?: boolean }) {
  return (
    <div className={`chart-set-row vp-row${indent ? ' sub' : ''}`}>
      <label className="vp-chk">
        {onToggle ? <input type="checkbox" checked={!!on} onChange={(e) => onToggle(e.target.checked)} /> : <span className="vp-chk-pad" />}
        <b>{label}</b>
      </label>
      <AlphaColorPicker presets={PALETTE} value={color} label={label} onChange={onColor} />
    </div>
  )
}

const useVp = (d: Drawing, set: Props['set']) => {
  const o = vpOf(d)
  const setVp = (patch: Partial<VpOpts>) => set({ vp: { ...(d.vp ?? {}), ...patch } })
  return { o, setVp }
}

export function VpInputs({ d, set, tt }: Props) {
  const { o, setVp } = useVp(d, set)
  return (
    <>
      <Row label={tt('charts.draw.vp.layout')}>
        <Seg value={o.layout} label={tt('charts.draw.vp.layout')} onChange={(v) => setVp({ layout: v })}
          options={[{ v: 'rows', label: tt('charts.draw.vp.layoutRows') }, { v: 'ticks', label: tt('charts.draw.vp.layoutTicks') }]} />
      </Row>
      {o.layout === 'rows' ? (
        <Row label={tt('charts.draw.vp.rowSize')}>
          <Int value={d.rows ?? 24} min={2} max={400} label={tt('charts.draw.vp.rowSize')} onChange={(v) => set({ rows: v })} />
        </Row>
      ) : (
        <Row label={tt('charts.draw.vp.ticksPerRow')}>
          <Int value={o.ticks} min={1} max={100000} label={tt('charts.draw.vp.ticksPerRow')} onChange={(v) => setVp({ ticks: v })} />
        </Row>
      )}
      <Row label={tt('charts.draw.vp.volume')}>
        <Seg value={o.volume} label={tt('charts.draw.vp.volume')} onChange={(v) => setVp({ volume: v })}
          options={[{ v: 'updown', label: tt('charts.draw.vp.volUpDown') }, { v: 'total', label: tt('charts.draw.vp.volTotal') }, { v: 'delta', label: tt('charts.draw.vp.volDelta') }]} />
      </Row>
      <Row label={tt('charts.draw.vp.vaPct')}>
        <Int value={o.vaPct} min={1} max={100} label={tt('charts.draw.vp.vaPct')} onChange={(v) => setVp({ vaPct: v })} />
      </Row>
      <Row label={tt('charts.draw.extendRight')}>
        <Switch checked={!!d.extendRight} onChange={(v) => set({ extendRight: v })} aria-label={tt('charts.draw.extendRight')} />
      </Row>
      {o.layout === 'ticks' && <small>{tt('charts.draw.vp.ticksHint')}</small>}
      <small>{tt('charts.draw.tickVolHint')}</small>
    </>
  )
}

export function VpStyle({ d, set, tt }: Props) {
  const { o, setVp } = useVp(d, set)
  const line = (k: 'vah' | 'val' | 'poc' | 'devPoc' | 'devVa', label: string) => {
    const v: VpLine = o[k]
    return <CheckColor key={k} label={label} on={v.on} color={v.color} onToggle={(on) => setVp({ [k]: { ...v, on } })} onColor={(color) => setVp({ [k]: { ...v, color } })} />
  }
  return (
    <>
      <div className="chart-set-row vp-row">
        <label className="vp-chk">
          <input type="checkbox" checked={o.hist} onChange={(e) => setVp({ hist: e.target.checked })} />
          <b>{tt('charts.draw.vp.profile')}</b>
        </label>
      </div>
      <div className={`vp-group${o.hist ? '' : ' off'}`}>
        <CheckColor indent label={tt('charts.draw.vp.values')} on={o.values} color={o.valuesColor || '#d1d4dc'}
          onToggle={(values) => setVp({ values })} onColor={(valuesColor) => setVp({ valuesColor })} />
        <div className="chart-set-row vp-row sub">
          <span className="vp-chk"><span className="vp-chk-pad" /><b>{tt('charts.draw.vp.widthPct')}</b></span>
          <Int value={o.widthPct} min={1} max={100} label={tt('charts.draw.vp.widthPct')} onChange={(v) => setVp({ widthPct: v })} />
        </div>
        <div className="chart-set-row vp-row sub">
          <span className="vp-chk"><span className="vp-chk-pad" /><b>{tt('charts.draw.vp.placement')}</b></span>
          <Seg value={o.placement} label={tt('charts.draw.vp.placement')} onChange={(v) => setVp({ placement: v })}
            options={[{ v: 'left', label: tt('charts.draw.vp.left') }, { v: 'right', label: tt('charts.draw.vp.right') }]} />
        </div>
        <CheckColor indent label={tt('charts.draw.vp.up')} color={o.up} onColor={(up) => setVp({ up })} />
        <CheckColor indent label={tt('charts.draw.vp.down')} color={o.down} onColor={(down) => setVp({ down })} />
        <CheckColor indent label={tt('charts.draw.vp.vaUp')} color={o.vaUp} onColor={(vaUp) => setVp({ vaUp })} />
        <CheckColor indent label={tt('charts.draw.vp.vaDown')} color={o.vaDown} onColor={(vaDown) => setVp({ vaDown })} />
      </div>
      {line('vah', tt('charts.draw.vp.vah'))}
      {line('val', tt('charts.draw.vp.val'))}
      {line('poc', tt('charts.draw.vp.poc'))}
      {line('devPoc', tt('charts.draw.vp.devPoc'))}
      {line('devVa', tt('charts.draw.vp.devVa'))}
      <CheckColor label={tt('charts.draw.vp.boxBg')} on={!!o.boxBg} color={o.boxBg || '#3d7bff14'}
        onToggle={(on) => setVp({ boxBg: on ? '#3d7bff14' : '' })} onColor={(boxBg) => setVp({ boxBg })} />
      <Row label={tt('charts.draw.vp.labels')}>
        <Switch checked={showLabelOf(d)} onChange={(v) => set({ showLabel: v })} aria-label={tt('charts.draw.vp.labels')} />
      </Row>
    </>
  )
}
