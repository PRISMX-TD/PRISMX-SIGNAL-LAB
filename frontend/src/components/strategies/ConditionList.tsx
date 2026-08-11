// 条件列表：一个 AND / OR 连接符 + 一列条件，扁平无嵌套。
//
// 没有嵌套是刻意的：嵌套组能表达的策略，新手看不懂也调不动，而后端已经把结构
// 限死成一层。相应地也没有「深度」概念，只有一个条件数上限，来自后端目录的
// maxConditions，达到上限时直接禁用「添加条件」而不是等提交被 400。
//
// 空头方向不在这里编辑：每个用法在后端登记了镜像用法，做空侧由镜像实时推出。
//
// The condition list: one AND / OR connective plus a flat list of conditions, no
// nesting.
//
// Flat is deliberate: strategies that need nested groups are ones a beginner
// can't read or tune, and the backend has pinned the structure to one level
// anyway. So there's no depth notion either, just a condition cap taken from the
// catalogue's maxConditions, which disables "add condition" outright instead of
// waiting for a 400 on submit.
//
// The short direction isn't edited here: every usage registers a mirror in the
// backend and the short side is derived from it.
import { useTranslation } from 'react-i18next'
import Select from '../Select'
import ConditionRow from './ConditionRow'
import {
  defaultParams,
  type ConditionLogic,
  type IndicatorSpec,
  type StrategyCondition,
} from './conditionTypes'

export interface ConditionListProps {
  logic: ConditionLogic
  conditions: StrategyCondition[]
  indicators: IndicatorSpec[]
  maxConditions: number
  onChange: (next: { logic: ConditionLogic; conditions: StrategyCondition[] }) => void
}

export default function ConditionList({
  logic, conditions, indicators, maxConditions, onChange,
}: ConditionListProps) {
  const { t } = useTranslation()

  const setCondition = (index: number, next: StrategyCondition) => {
    onChange({ logic, conditions: conditions.map((c, i) => (i === index ? next : c)) })
  }

  const removeCondition = (index: number) => {
    onChange({ logic, conditions: conditions.filter((_, i) => i !== index) })
  }

  const addCondition = () => {
    if (conditions.length >= maxConditions) return
    const first = indicators[0]
    const firstUsage = first?.usages[0]
    if (!first || !firstUsage) return
    onChange({
      logic,
      conditions: [
        ...conditions,
        { indicator: first.key, usage: firstUsage.key, params: defaultParams(firstUsage) },
      ],
    })
  }

  const atCap = conditions.length >= maxConditions

  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.01] p-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[10px] uppercase tracking-wide text-neutral-500">{t('strategy.condLogic')}</span>
        <Select
          className="w-32"
          value={logic}
          options={[
            { value: 'AND', label: t('strategy.condLogicAnd') },
            { value: 'OR', label: t('strategy.condLogicOr') },
          ]}
          onChange={(v) => onChange({ logic: v === 'OR' ? 'OR' : 'AND', conditions })}
        />
        <span className="text-[11px] text-neutral-500">
          {t('strategy.condCount', { used: conditions.length, max: maxConditions })}
        </span>
      </div>

      <div className="mt-2 flex flex-col gap-2">
        {conditions.map((condition, i) => (
          <ConditionRow
            key={i}
            condition={condition}
            indicators={indicators}
            onChange={(next) => setCondition(i, next)}
            onRemove={conditions.length > 1 ? () => removeCondition(i) : undefined}
          />
        ))}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={addCondition}
          disabled={atCap}
          className="rounded-lg border border-white/10 bg-white/5 px-3 py-1 text-xs text-neutral-300 transition hover:border-prism-400/50 hover:text-prism-200 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {t('strategy.condAdd')}
        </button>
        {atCap && (
          <span className="text-[11px] text-amber-200/80">{t('strategy.condLimit', { max: maxConditions })}</span>
        )}
      </div>
    </div>
  )
}
