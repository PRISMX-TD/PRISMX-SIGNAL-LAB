// 数字输入框：自己维护一份文本缓冲，只在失焦（或回车）时才解析 + 夹紧 + 回传。
// 每敲一个字符就解析夹紧，会让用户清空重打时被强制弹回旧值，根本删不掉。放在
// 构建器目录下，让策略相关组件与页面共用同一个实现。
// Number input keeping its own text buffer, parsing/clamping/propagating only on
// blur (or Enter). Parsing on every keystroke bounces the user back to the old
// value mid-edit, making the field impossible to clear. It lives in the builder
// directory so the page and the strategy components share one implementation.
import { useEffect, useState } from 'react'

export interface NumberFieldProps {
  label: string
  value: number
  min?: number
  max?: number
  isFloat?: boolean
  onChange: (v: number) => void
  /** 输入框额外类名（指标设置弹窗用窄一点的居中框）/ extra input classes */
  inputClassName?: string
}

// 失焦才解析/夹紧/回传的数字框。每次按键都夹紧会在用户清空重打时把值弹回旧值，
// 第二个数字根本敲不进去——这个坑在指标设置弹窗里踩过。策略编辑器与指标设置
// 弹窗共用这一份；回放模拟的本金框规则不同（≤0 保留旧值、取整），仍单独实现。
// Parses / clamps / propagates on blur only: clamping per keystroke bounced the
// user back to the old value mid-edit. Shared by the strategy editor and the
// indicator settings modal; the simulator's capital field has different rules.
export function NumberField({ label, value, min = 1, max = 500, isFloat = false, onChange, inputClassName = 'py-1 text-xs' }: NumberFieldProps) {
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
      <span className="text-[10px] uppercase tracking-wide text-neutral-500">{label}</span>
      <input
        type="number"
        className={`input ${inputClassName}`}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
      />
    </label>
  )
}
