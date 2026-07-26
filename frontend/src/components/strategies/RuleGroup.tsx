// 条件组：一个 AND / OR 连接符 + 一列子节点，每个子节点按类型递归渲染成
// 条件组或一条比较。递归的终止条件是「子节点不是组」，深度由 depth prop 传递，
// 达到 RULE_LIMITS.maxDepth 时不再提供「添加子组」。
//
// 上限在这里统一判定并直接禁用按钮，而不是等后端 400：用户搭到第 13 个条件时
// 才被拒绝，前面 12 步的操作都白费。usage 由父级（策略编辑区）算整棵树后传进
// 来——本组件只看到自己这一支，算不出全局用量。
//
// A rule group: one AND / OR connective plus a list of children, each recursed
// into either a nested group or a single comparison. Recursion bottoms out when
// a child isn't a group; depth is threaded through the `depth` prop, and "add
// nested group" disappears at RULE_LIMITS.maxDepth.
//
// Limits are judged here and disable the buttons outright rather than waiting
// for a 400: being rejected only when adding the 13th condition wastes the
// twelve steps before it. `usage` is computed over the whole tree by the parent
// (the strategy editor) and passed in — this component only sees its own branch
// and can't derive global usage.
import { useTranslation } from 'react-i18next'
import Select from '../Select'
import RuleConditionRow from './RuleCondition'
import {
  RULE_LIMITS,
  emptyCondition,
  emptyGroup,
  isGroup,
  type RuleGroup,
  type RuleNode,
  type RuleUsage,
} from './ruleTypes'

export interface RuleGroupEditorProps {
  group: RuleGroup
  onChange: (next: RuleGroup) => void
  // 当前层级，根组为 1。用于判断能否再嵌套，以及缩进样式。
  // Current level, 1 at the root. Drives both the nesting check and indentation.
  depth: number
  // 整棵信封（多空两侧合起来）的用量，由父级用 ruleUsage() 算好传入。
  // Usage across the whole envelope (both sides), computed by the parent with
  // ruleUsage().
  usage: RuleUsage
  availableIntervals: string[]
  onRemove?: () => void
}

export default function RuleGroupEditor({
  group, onChange, depth, usage, availableIntervals, onRemove,
}: RuleGroupEditorProps) {
  const { t } = useTranslation()

  const setChild = (index: number, next: RuleNode) => {
    const children = [...group.children]
    children[index] = next
    onChange({ ...group, children })
  }

  const removeChild = (index: number) => {
    onChange({ ...group, children: group.children.filter((_, i) => i !== index) })
  }

  const addCondition = () => {
    if (usage.blocked) return
    onChange({ ...group, children: [...group.children, emptyCondition()] })
  }

  const addGroup = () => {
    if (usage.blocked || depth >= RULE_LIMITS.maxDepth) return
    onChange({ ...group, children: [...group.children, emptyGroup()] })
  }

  // 被哪一项挡住的提示文案。三种上限的提示各不相同——只说「已达上限」用户不知道
  // 该删条件还是该少用一个周期。
  // Which limit is blocking. The three messages differ deliberately: a bare
  // "limit reached" leaves the user guessing whether to drop a condition or an
  // interval.
  const blockedHint =
    usage.blocked === 'conditions'
      ? t('strategy.limitConditions', { max: RULE_LIMITS.maxConditions })
      : usage.blocked === 'indicatorInstances'
        ? t('strategy.limitIndicators', { max: RULE_LIMITS.maxIndicatorInstances })
        : usage.blocked === 'intervals'
          ? t('strategy.limitIntervals', { max: RULE_LIMITS.maxIntervals })
          : null

  const depthReached = depth >= RULE_LIMITS.maxDepth
  const btnClass =
    'rounded-lg border border-white/10 bg-white/5 px-3 py-1 text-xs text-slate-300 transition hover:border-prism-400/50 hover:text-prism-200 disabled:cursor-not-allowed disabled:opacity-40'

  return (
    <div className={`rounded-xl border border-white/10 bg-white/[0.01] p-2.5 ${depth > 1 ? 'mt-1' : ''}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[10px] uppercase tracking-wide text-slate-500">{t('strategy.ruleLogic')}</span>
        <Select
          className="w-28"
          value={group.logic}
          options={[
            { value: 'AND', label: t('strategy.ruleLogicAnd') },
            { value: 'OR', label: t('strategy.ruleLogicOr') },
          ]}
          onChange={(v) => onChange({ ...group, logic: v === 'OR' ? 'OR' : 'AND' })}
        />
        <span className="text-[11px] text-slate-500">
          {t('strategy.ruleUsageConditions', { used: usage.conditions, max: RULE_LIMITS.maxConditions })}
        </span>
        {onRemove && (
          <button
            type="button"
            onClick={onRemove}
            className="ml-auto rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-xs text-slate-400 transition hover:border-down/40 hover:text-down"
          >
            {t('strategy.ruleRemoveGroup')}
          </button>
        )}
      </div>

      <div className="mt-2 flex flex-col gap-2">
        {group.children.map((child, i) =>
          isGroup(child) ? (
            <RuleGroupEditor
              key={i}
              group={child}
              onChange={(next) => setChild(i, next)}
              depth={depth + 1}
              usage={usage}
              availableIntervals={availableIntervals}
              onRemove={() => removeChild(i)}
            />
          ) : (
            <RuleConditionRow
              key={i}
              condition={child}
              onChange={(next) => setChild(i, next)}
              onRemove={group.children.length > 1 ? () => removeChild(i) : undefined}
              availableIntervals={availableIntervals}
              usedIntervals={usage.intervalCodes}
            />
          )
        )}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button type="button" onClick={addCondition} disabled={usage.blocked != null} className={btnClass}>
          {t('strategy.ruleAddCondition')}
        </button>
        <button type="button" onClick={addGroup} disabled={usage.blocked != null || depthReached} className={btnClass}>
          {t('strategy.ruleAddGroup')}
        </button>
        {blockedHint && <span className="text-[11px] text-amber-200/80">{blockedHint}</span>}
        {!blockedHint && depthReached && (
          <span className="text-[11px] text-slate-500">{t('strategy.limitDepth', { max: RULE_LIMITS.maxDepth })}</span>
        )}
      </div>
    </div>
  )
}
