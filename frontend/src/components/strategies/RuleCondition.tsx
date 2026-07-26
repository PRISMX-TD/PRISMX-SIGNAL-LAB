// 一条比较：左操作数 · 比较符 · 右操作数。三块都由 OperandPicker / Select 渲染，
// 本组件只负责布局、删除按钮，以及把改动往上传。
// 不在这里做校验：合法区间已经由 OperandPicker 的 NumberField 夹紧，条件数等
// 上限由父级 RuleGroupEditor 统一判定（它才看得到整棵树）。
//
// One comparison: left operand · operator · right operand. All three are
// rendered by OperandPicker / Select; this component only handles layout, the
// delete button, and bubbling changes upward. No validation here: valid ranges
// are already clamped by OperandPicker's NumberField, and limits like the
// condition count are judged by the parent RuleGroupEditor, which is the only
// one that sees the whole tree.
import { useTranslation } from 'react-i18next'
import Select from '../Select'
import OperandPicker from './OperandPicker'
import {
  COMPARE_OPS,
  OP_LABEL_KEYS,
  type CompareOp,
  type RuleCondition,
  type RuleOperand,
} from './ruleTypes'

export interface RuleConditionRowProps {
  condition: RuleCondition
  onChange: (next: RuleCondition) => void
  // 删除自己。父级在「这是本组最后一个子节点」时不传，从而隐藏删除按钮——
  // 后端要求条件组非空，允许删到空会让保存必然 400。
  // Remove self. The parent omits this when the node is its group's last child,
  // hiding the delete button: the backend requires non-empty groups, so allowing
  // the last one to go would guarantee a 400 on save.
  onRemove?: () => void
  availableIntervals: string[]
  usedIntervals: string[]
}

export default function RuleConditionRow({
  condition, onChange, onRemove, availableIntervals, usedIntervals,
}: RuleConditionRowProps) {
  const { t } = useTranslation()

  const setSide = (side: 'left' | 'right', operand: RuleOperand) => {
    onChange({ ...condition, [side]: operand })
  }

  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.02] p-2.5">
      <div className="flex items-start gap-2">
        <div className="flex flex-1 flex-col gap-2 sm:flex-row sm:items-start">
          <OperandPicker
            operand={condition.left}
            onChange={(o) => setSide('left', o)}
            availableIntervals={availableIntervals}
            usedIntervals={usedIntervals}
          />
          <div className="flex flex-col gap-1 sm:w-40 sm:shrink-0 sm:pt-2">
            <span className="text-[10px] uppercase tracking-wide text-slate-500">{t('strategy.ruleOperator')}</span>
            <Select
              className="w-full"
              value={condition.op}
              options={COMPARE_OPS.map((op) => ({ value: op, label: t(OP_LABEL_KEYS[op]) }))}
              onChange={(v) => onChange({ ...condition, op: v as CompareOp })}
            />
          </div>
          <OperandPicker
            operand={condition.right}
            onChange={(o) => setSide('right', o)}
            availableIntervals={availableIntervals}
            usedIntervals={usedIntervals}
          />
        </div>
        {onRemove && (
          <button
            type="button"
            onClick={onRemove}
            aria-label={t('strategy.ruleRemoveCondition')}
            title={t('strategy.ruleRemoveCondition')}
            className="shrink-0 rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-xs text-slate-400 transition hover:border-down/40 hover:text-down"
          >
            ×
          </button>
        )}
      </div>
    </div>
  )
}
