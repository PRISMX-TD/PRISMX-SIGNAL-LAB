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
  min: number
  max: number
  isFloat: boolean
  onChange: (v: number) => void
}

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
