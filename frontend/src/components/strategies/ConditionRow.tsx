// 一条条件：指标 · 用法 · 该用法的参数。三段都由后端下发的目录驱动——换指标时
// 用法列表跟着换，换用法时参数表单跟着换，参数的取值范围也来自目录。
//
// 换指标/换用法都会重置 params：上一个用法的参数键在新用法里大多不存在（比如从
// ma 的 maType/period 换到 rsi 的 period/level），保留残余键会被后端当未知参数
// 拒掉。宁可让用户重填两个数字，也不要提交时才 400。
//
// One condition: indicator · usage · that usage's params. All three are driven by
// the backend-provided catalogue — changing the indicator swaps the usage list,
// changing the usage swaps the param form, and the ranges come from the catalogue
// too.
//
// Switching indicator or usage resets params: the previous usage's param keys
// mostly don't exist in the new one (going from ma's maType/period to rsi's
// period/level, say), and leftover keys are rejected as unknown params. Better to
// have the user re-enter two numbers than to 400 on submit.
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Select from '../Select'
import {
  clampParam,
  defaultParams,
  indicatorLabelKey,
  paramLabelKey,
  usageLabelKey,
  type IndicatorSpec,
  type ParamValue,
  type StrategyCondition,
  type UsageParamSpec,
} from './conditionTypes'

export interface ConditionRowProps {
  condition: StrategyCondition
  indicators: IndicatorSpec[]
  onChange: (next: StrategyCondition) => void
  // 删除自己。父级在「这是最后一条条件」时不传，从而隐藏删除按钮——后端要求
  // 条件列表非空，允许删到空会让保存必然 400。
  // Remove self. The parent omits this for the last remaining condition, hiding
  // the button: the backend requires a non-empty list, so allowing the last one
  // to go would guarantee a 400 on save.
  onRemove?: () => void
}

export default function ConditionRow({ condition, indicators, onChange, onRemove }: ConditionRowProps) {
  const { t } = useTranslation()

  const indicator = indicators.find((i) => i.key === condition.indicator)
  const usage = indicator?.usages.find((u) => u.key === condition.usage)

  const pickIndicator = (key: string) => {
    const next = indicators.find((i) => i.key === key)
    const firstUsage = next?.usages[0]
    if (!firstUsage) return
    onChange({ indicator: key, usage: firstUsage.key, params: defaultParams(firstUsage) })
  }

  const pickUsage = (key: string) => {
    const nextUsage = indicator?.usages.find((u) => u.key === key)
    if (!nextUsage) return
    onChange({ ...condition, usage: key, params: defaultParams(nextUsage) })
  }

  const setParam = (name: string, value: ParamValue) => {
    onChange({ ...condition, params: { ...condition.params, [name]: value } })
  }

  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.02] p-2.5">
      <div className="flex items-start gap-2">
        <div className="flex flex-1 flex-col gap-2 sm:flex-row sm:items-start">
          <div className="flex flex-col gap-1 sm:w-36 sm:shrink-0">
            <span className="text-[10px] uppercase tracking-wide text-neutral-500">{t('strategy.condIndicator')}</span>
            <Select
              className="w-full"
              value={condition.indicator}
              options={indicators.map((i) => ({ value: i.key, label: t(indicatorLabelKey(i.key)) }))}
              onChange={pickIndicator}
            />
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="text-[10px] uppercase tracking-wide text-neutral-500">{t('strategy.condUsage')}</span>
            <Select
              className="w-full"
              value={condition.usage}
              options={(indicator?.usages ?? []).map((u) => ({ value: u.key, label: t(usageLabelKey(u.key)) }))}
              onChange={pickUsage}
            />
            {/* mirror 为 null 的用法（ATR 波动）没有方向性，多空共用同一判定。
                不标出来的话，用户会以为做空方向被自动取反了。
                A null mirror (ATR volatility) is non-directional and shared by
                both sides. Unlabelled, users assume the short side gets
                inverted. */}
            {usage && usage.mirror === null && (
              <span className="text-[11px] text-neutral-500">{t('strategy.condBothDirections')}</span>
            )}
          </div>
        </div>
        {onRemove && (
          <button
            type="button"
            onClick={onRemove}
            aria-label={t('strategy.condRemove')}
            title={t('strategy.condRemove')}
            className="shrink-0 rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-xs text-neutral-400 transition hover:border-down/40 hover:text-down"
          >
            ×
          </button>
        )}
      </div>

      {usage && Object.keys(usage.params).length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {Object.entries(usage.params).map(([name, spec]) => (
            <ParamField
              key={name}
              name={name}
              spec={spec}
              value={condition.params[name]}
              onChange={(v) => setParam(name, v)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// 参数输入：enum 用下拉，int / float 用数字框。数字框在失焦时才夹紧到 [min, max]
// ——输入过程中就夹会让「先删空再重打」变得没法操作（删到空立刻变成 min）。
// A param input: a dropdown for enums, a number box for int/float. Numbers are
/**
 * 数字参数输入框。
 *
 * **编辑中的文本是本地状态，不是那个数字。** 这是修一个用户反馈的缺陷：「没有办法把
 * 数字全部删除重新填写」。
 *
 * 旧版是 `<input type="number" value={数字}>` 加上 `onChange` 里
 * `if (!Number.isNaN(raw)) onChange(raw)`。用户把最后一位删掉时 `e.target.value` 是空串，
 * `parseInt('')` 得 NaN，被那个 if 挡掉——父状态不变，React 随即把**旧数字恢复回 DOM**
 * （受控输入框的既定行为）。结果就是最后一位永远删不掉。本地实测：`14` → 删到 `1` 正常，
 * 再删一下框里还是 `1`。
 *
 * 小数参数更糟：想把 `2` 改成 `2.5`，按下 `.` 的那一拍 `parseFloat('2.')` 是 2，与当前值
 * 相同、不触发重渲染，但 React 的受控恢复会把小数点抹掉；接着按 `5` 就成了 `25`。
 *
 * 之所以一直没被发现：**选中全部再覆盖输入是通的**，而这正是大多数人（包括自测时）的
 * 习惯动作。只有逐字退格的人才会撞上。
 *
 * 现在的做法与图表里的指标设置弹窗（components/charts/IndicatorSettingsModal.tsx 的
 * `Num`）完全一致，那个实现早就是对的、也没有过这类反馈：
 *   · 编辑期间只动本地 text，空串是合法的中间态，不回写父状态；
 *   · 失焦（或回车）时才解析、钳制、提交；解析不出数字就还原成原值。
 *
 * 顺带把 `type="number"` 换成 `inputMode`：number 类型的输入框对 `2.` 这种中间态会
 * 自己把 `.value` 报成空串，正是上面小数那条 bug 的帮凶；`inputMode` 同样能在手机上
 * 唤起数字键盘，而且不带这些自作主张。
 */
function NumParam({ spec, value, onChange, label, step }: {
  spec: UsageParamSpec
  value: ParamValue | undefined
  onChange: (v: ParamValue) => void
  label: string
  step: number
}) {
  const current = typeof value === 'number' ? value : Number(spec.default)
  const [text, setText] = useState(String(current))
  // 外部改了值（换指标/换用法会重置 params、点模板会整条替换）才同步回来。
  useEffect(() => { setText(String(current)) }, [current])

  const commit = () => {
    const raw = spec.kind === 'int' ? parseInt(text, 10) : parseFloat(text)
    // 解析不出数字（空框、只剩一个小数点或负号）就还原成原值，不要凭空跳到 min。
    const next = Number.isFinite(raw) ? clampParam(raw, spec) : current
    setText(String(next))
    if (next !== current) onChange(next)
  }

  return (
    <input
      type="text"
      inputMode={spec.kind === 'int' ? 'numeric' : 'decimal'}
      step={step}
      value={text}
      // 只过滤明显非法的字符，不做任何归一：`2.`、``、`-` 都是合法的中间态。
      // 负号与小数点允许出现是因为 spec.min 可以是 null（clampParam 里退化成 -Infinity），
      // 并不是所有参数都非负。
      onChange={(e) => setText(
        e.target.value.replace(spec.kind === 'int' ? /[^0-9-]/g : /[^0-9.-]/g, ''),
      )}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
      aria-label={label}
      className="w-24 rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-sm text-neutral-100 outline-none transition focus:border-prism-400/50"
    />
  )
}

function ParamField({
  name, spec, value, onChange,
}: {
  name: string
  spec: UsageParamSpec
  value: ParamValue | undefined
  onChange: (v: ParamValue) => void
}) {
  const { t } = useTranslation()
  const label = t(paramLabelKey(name))

  if (spec.kind === 'enum') {
    return (
      <div className="flex flex-col gap-1">
        <span className="text-[10px] uppercase tracking-wide text-neutral-500">{label}</span>
        <Select
          className="w-28"
          value={String(value ?? spec.default)}
          options={(spec.options ?? []).map((o) => ({ value: o, label: o }))}
          onChange={onChange}
        />
      </div>
    )
  }

  const step = spec.kind === 'int' ? 1 : 0.1
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-wide text-neutral-500">
        {label}
        {spec.min != null && spec.max != null && (
          <span className="ml-1 normal-case text-neutral-500">{`${spec.min}–${spec.max}`}</span>
        )}
      </span>
      <NumParam spec={spec} value={value} onChange={onChange} label={label} step={step} />
    </div>
  )
}
