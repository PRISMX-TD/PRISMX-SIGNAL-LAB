// 一个操作数的编辑器：三种形态（指标 / 常量 / 价格字段）切换 + 各自的参数。
// 切换形态时整个替换操作数对象而不是补字段——三种形态是判别联合，残留字段
// （比如从 indicator 切到 price 还留着 fn）会被后端 _validate_operand 当成
// 「不接受的参数」直接 400。
//
// An operand editor: switch between the three shapes (indicator / const /
// price) plus each one's params. Switching replaces the whole operand object
// rather than patching fields — the shapes form a discriminated union, and a
// leftover field (e.g. `fn` surviving a switch from indicator to price) is
// rejected outright by the backend's _validate_operand as an unexpected param.
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Select from '../Select'
import {
  INDICATOR_LABEL_KEYS,
  INDICATOR_NAMES,
  INDICATOR_SPECS,
  INTERVALS,
  PARAM_LABEL_KEYS,
  PRICE_FIELDS,
  PRICE_FIELD_LABEL_KEYS,
  RULE_LIMITS,
  defaultParamsFor,
  type PriceField,
  type RuleOperand,
} from './ruleTypes'

export interface NumberFieldProps {
  label: string
  value: number
  min: number
  max: number
  isFloat: boolean
  onChange: (v: number) => void
}

// 数字输入框：自己维护一份文本缓冲，只在失焦（或回车）时才解析 + 夹紧 + 回传。
// 与 StrategiesPage 原有的 NumberField 同一套修法——每敲一个字符就解析夹紧，会
// 让用户清空重打时被强制弹回旧值，根本删不掉。这里搬进构建器目录，让规则相关
// 组件不必再依赖被拆解的页面。
// Number input keeping its own text buffer, parsing/clamping/propagating only on
// blur (or Enter). Same fix as StrategiesPage's original NumberField: parsing on
// every keystroke bounces the user back to the old value mid-edit, making the
// field impossible to clear. Moved into the builder directory so the rule
// components don't depend on the page being dismantled.
export function NumberField({ label, value, min, max, isFloat, onChange }: NumberFieldProps) {
  const [text, setText] = useState(String(value))
  useEffect(() => { setText(String(value)) }, [value])

  const commit = () => {
    const n = isFloat ? parseFloat(text) : parseInt(text, 10)
    const clamped = !Number.isFinite(n) ? value : Math.min(max, Math.max(min, n))
    setText(String(clamped))
    if (clamped !== value) onChange(clamped)
  }

  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-wide text-slate-500">{label}</span>
      <input
        type="number"
        className="input py-1 text-xs"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
      />
    </label>
  )
}

export interface OperandPickerProps {
  operand: RuleOperand
  onChange: (next: RuleOperand) => void
  // 该策略订阅的周期。操作数的 interval 只能从这里选——后端要求 AST 引用的
  // 周期是策略 intervals 的子集，否则创建时 400。空表示只能用主周期。
  // The strategy's own intervals. An operand's interval may only be picked from
  // these: the backend requires the AST's intervals to be a subset of the
  // strategy's, else creation 400s. Empty means main interval only.
  availableIntervals: string[]
  // 已用满周期数时禁止再新增一个不同周期（仍可选已在用的那几个）。
  // When the interval budget is spent, block picking a *new* interval (the ones
  // already in use stay selectable).
  usedIntervals: string[]
}

export default function OperandPicker({ operand, onChange, availableIntervals, usedIntervals }: OperandPickerProps) {
  const { t } = useTranslation()

  const kindOptions = [
    { value: 'indicator', label: t('strategy.operandIndicator') },
    { value: 'price', label: t('strategy.operandPrice') },
    { value: 'const', label: t('strategy.operandConst') },
  ]

  const switchKind = (kind: string) => {
    if (kind === operand.kind) return
    if (kind === 'indicator') onChange({ kind: 'indicator', fn: 'ema', params: defaultParamsFor('ema') })
    else if (kind === 'price') onChange({ kind: 'price', field: 'close' })
    else onChange({ kind: 'const', value: 0 })
  }

  const switchFn = (fn: string) => {
    if (operand.kind !== 'indicator') return
    // 换指标必须换掉整份 params：不同指标的参数名不同（period vs fastPeriod），
    // 保留旧的会带上「不接受的参数」。
    // Swapping the indicator must swap the whole params map: different
    // indicators take different param names (period vs fastPeriod), and keeping
    // the old ones smuggles in unexpected params.
    onChange({ ...operand, fn, params: defaultParamsFor(fn) })
  }

  // interval 下拉：空值代表「跟随主周期」（不写 interval 字段）。已用满 3 个
  // 周期时，未在用的那几个置灰——与后端 MAX_INTERVALS 同一条限制。
  // The interval dropdown: the empty value means "follow the main interval" (no
  // interval field emitted). With the 3-interval budget spent, the unused ones
  // grey out — the same limit as the backend's MAX_INTERVALS.
  const intervalBudgetSpent = usedIntervals.length >= RULE_LIMITS.maxIntervals
  const intervalOptions = [
    { value: '', label: t('strategy.operandIntervalMain') },
    ...availableIntervals.map((code) => {
      const label = INTERVALS.find((iv) => iv.code === code)?.label ?? code
      const locked = intervalBudgetSpent && !usedIntervals.includes(code)
      return { value: code, label: locked ? `${label} · ${t('strategy.limitIntervalsShort')}` : label }
    }),
  ]

  const setInterval_ = (v: string) => {
    if (operand.kind === 'const') return
    if (v && intervalBudgetSpent && !usedIntervals.includes(v)) return
    const next = { ...operand }
    if (v) next.interval = v
    else delete next.interval
    onChange(next)
  }

  // shift / scale 的写入同样按「默认值就不写这个字段」处理，见下方注释。
  // shift / scale writes follow the same "omit at the default" rule; see below.
  const setShift = (v: number) => {
    if (operand.kind === 'const') return
    const next = { ...operand }
    if (v > 0) next.shift = v
    else delete next.shift
    onChange(next)
  }

  const setScale = (v: number) => {
    if (operand.kind === 'const') return
    const next = { ...operand }
    if (v !== 1) next.scale = v
    else delete next.scale
    onChange(next)
  }

  return (
    <div className="flex flex-1 flex-col gap-2 rounded-lg border border-white/10 bg-white/[0.02] p-2">
      <Select className="w-full" value={operand.kind} options={kindOptions} onChange={switchKind} />

      {operand.kind === 'const' && (
        <NumberField
          label={t('strategy.operandConstValue')}
          value={operand.value}
          min={-1e9}
          max={1e9}
          isFloat
          onChange={(v) => onChange({ kind: 'const', value: v })}
        />
      )}

      {operand.kind === 'price' && (
        <Select
          className="w-full"
          value={operand.field}
          options={PRICE_FIELDS.map((f) => ({ value: f, label: t(PRICE_FIELD_LABEL_KEYS[f]) }))}
          onChange={(v) => onChange({ ...operand, field: v as PriceField })}
        />
      )}

      {operand.kind === 'indicator' && (
        <>
          <Select
            className="w-full"
            value={operand.fn}
            options={INDICATOR_NAMES.map((fn) => ({ value: fn, label: t(INDICATOR_LABEL_KEYS[fn] ?? fn) }))}
            onChange={switchFn}
          />
          <div className="grid grid-cols-2 gap-2">
            {Object.entries(INDICATOR_SPECS[operand.fn] ?? {}).map(([name, spec]) => (
              <NumberField
                key={name}
                label={t(PARAM_LABEL_KEYS[name] ?? name)}
                value={operand.params[name] ?? spec.default}
                min={spec.min}
                max={spec.max}
                isFloat={!spec.isInt}
                onChange={(v) => onChange({ ...operand, params: { ...operand.params, [name]: v } })}
              />
            ))}
          </div>
        </>
      )}

      {operand.kind !== 'const' && (
        <>
          <Select className="w-full" value={operand.interval ?? ''} options={intervalOptions} onChange={setInterval_} />
          {/* shift / scale：取前 N 根、乘以系数。默认 0 / 1 时不写进 AST，
              保持载荷与预设一致（预设里没有这两个字段）。
              shift / scale: take the value N bars back, multiply by a factor.
              Left out of the AST at their 0 / 1 defaults, keeping the payload
              identical to the presets, which carry neither field. */}
          <div className="grid grid-cols-2 gap-2">
            <NumberField
              label={t('strategy.operandShift')}
              value={operand.shift ?? 0}
              min={0}
              max={RULE_LIMITS.maxShift}
              isFloat={false}
              onChange={setShift}
            />
            <NumberField
              label={t('strategy.operandScale')}
              value={operand.scale ?? 1}
              min={RULE_LIMITS.scaleMin}
              max={RULE_LIMITS.scaleMax}
              isFloat
              onChange={setScale}
            />
          </div>
        </>
      )}
    </div>
  )
}
