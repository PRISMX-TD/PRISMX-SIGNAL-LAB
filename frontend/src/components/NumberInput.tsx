// 受控数字框：编辑中的文本是本地状态，不是那个数字。
//
// 用户反馈「手机上数字框没法全部删掉重新输入」。根因是 `value={数字}` 加
// `onChange={(e) => set(Number(e.target.value) || 默认值)}`：删到空串的那一拍
// 立刻变成 0（或被夹到最小值）写回框里，最后一位永远删不掉。桌面上习惯全选覆盖
// 所以测不出来，手机上逐字退格就撞上了。
//
// 做法与策略编辑器的 NumberField / ConditionRow 的 NumParam 一致：
//   · 输入期间只动本地 text；空串、`2.` 都是合法的中间态；
//   · 打出来的数已经在范围内就顺手回传（不改写文本），这样不失焦直接点「保存」
//     也拿得到新值；
//   · 失焦或回车时才夹紧/取整；解析不出数字就还原成原值。
// 用 type="text" + inputMode 而不是 type="number"：后者会把 `2.` 这种中间态的
// `.value` 报成空串，小数点被吞掉。
//
// Controlled number input whose in-progress text is local state, not the number.
// Binding `value={number}` with `Number(e.target.value) || fallback` turned an
// emptied field into 0 on the spot, so the last digit could never be deleted —
// invisible on desktop (select-all and overwrite), hit on phones (backspace).
// Valid in-range values propagate live without rewriting the text (so tapping
// Save without blurring still sees them); clamping happens on blur / Enter, and
// an unparseable entry reverts. type="text" + inputMode, because type="number"
// reports `2.` as an empty value and swallows the decimal point.
import { useEffect, useRef, useState } from 'react'

interface Props {
  value: number
  onChange: (n: number) => void
  min?: number
  max?: number
  /** 只允许整数 / integers only */
  integer?: boolean
  className?: string
  disabled?: boolean
  placeholder?: string
  'aria-label'?: string
}

export default function NumberInput({
  value,
  onChange,
  min = -Infinity,
  max = Infinity,
  integer = false,
  className = 'input',
  disabled,
  placeholder,
  'aria-label': ariaLabel,
}: Props) {
  const parse = (s: string) => (integer ? parseInt(s, 10) : parseFloat(s))
  const [text, setText] = useState(String(value))
  // 开始编辑时的值：删空后失焦要回到它，而不是删到一半时顺手回传的那个数。
  // Value at focus: an emptied field reverts to it, not to a half-deleted value.
  const startValue = useRef(value)

  // 外部改了值（加载完成、保存后服务器回填）才同步；由本框自己回传引起的变化
  // 不覆盖正在输入的文本（否则 `2.` 会被改写成 `2`）。
  // Sync only on outside changes; a value we just propagated ourselves must not
  // rewrite the text being typed (`2.` would become `2`).
  useEffect(() => {
    setText((cur) => (parse(cur) === value ? cur : String(value)))
  }, [value])

  const commit = () => {
    const n = parse(text)
    const next = Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : startValue.current
    setText(String(next))
    if (next !== value) onChange(next)
  }

  const allowNeg = min < 0

  return (
    <input
      type="text"
      inputMode={integer ? 'numeric' : 'decimal'}
      className={className}
      value={text}
      disabled={disabled}
      placeholder={placeholder}
      aria-label={ariaLabel}
      onChange={(e) => {
        const pattern = integer ? (allowNeg ? /[^0-9-]/g : /[^0-9]/g) : allowNeg ? /[^0-9.-]/g : /[^0-9.]/g
        const s = e.target.value.replace(pattern, '')
        setText(s)
        const n = parse(s)
        if (Number.isFinite(n) && n >= min && n <= max && n !== value) onChange(n)
      }}
      onFocus={() => { startValue.current = value }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
      }}
    />
  )
}
