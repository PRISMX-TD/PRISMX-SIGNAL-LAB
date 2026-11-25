// 周期切换按钮组。桌面工具条、手机工具条、全屏态右上角三处共用（2026-09-06
// 之前是三份逐字相同的 map）。seg = 工具条里的 .term-tf 药丸段；fullscreen =
// 全屏态右上角的紧凑横排。2026-11-25 起按钮来自用户的收藏周期（codes），当前周期不在
// 收藏里时临时多显示一个；更多周期 / 自定义在 IntervalMenu。
// Interval switch shared by the desktop toolbar, mobile toolbar and the
// fullscreen top-right corner (three identical copies before 2026-09-06). Since
// 2026-11-25 the buttons are the user's favourite intervals (codes); the current interval
// is appended while it isn't one of them. More / custom intervals live in IntervalMenu.
import { INTERVALS } from './chartConfig'
import { intervalLabel, parseInterval } from './intervals'
import { onRovingKeyDown } from '../../utils/rovingTabs'

// 周期的大致时长（秒），只用来排序。/ Approximate duration (s), for sorting only.
export function intervalSortKey(code: string): number {
  const p = parseInterval(code)
  if (!p) return Number.MAX_SAFE_INTEGER
  const unit = p.unit === 'min' ? 60 : p.unit === 'D' ? 86400 : p.unit === 'W' ? 7 * 86400 : 30 * 86400
  return p.n * unit
}

export function orderedIntervals(codes: readonly string[], current: string): string[] {
  const set = new Set(codes)
  if (current) set.add(current)
  return [...set].sort((a, b) => intervalSortKey(a) - intervalSortKey(b))
}

export default function IntervalSeg({ value, onChange, variant = 'seg', codes }: {
  value: string
  onChange: (code: string) => void
  variant?: 'seg' | 'fullscreen'
  codes?: readonly string[]
}) {
  const list = orderedIntervals(codes ?? INTERVALS.map((i) => i.code), value)
  if (variant === 'fullscreen') {
    // 按钮圆角同心：外框 rounded-lg 8 − 边框 1 − p-0.5（本项目 4px）= 3。/ Concentric: 8 − 1 − 4 = 3.
    return (
      <div className="absolute top-2 right-12 z-30 flex items-center gap-0.5 rounded-lg border border-white/10 bg-ink-900/70 backdrop-blur-sm p-0.5">
        {list.map((code) => (
          <button
            key={code}
            onClick={() => onChange(code)}
            className={`rounded-[3px] px-2 py-1 text-xs font-medium transition ${
              value === code
                ? 'bg-prism-600 text-white'
                : 'text-neutral-400 hover:text-neutral-100'
            }`}
          >
            {intervalLabel(code)}
          </button>
        ))}
      </div>
    )
  }
  return (
    <div className="term-tf" role="tablist" onKeyDown={onRovingKeyDown}>
      {list.map((code) => (
        <button
          key={code}
          type="button"
          role="tab"
          aria-selected={value === code}
          tabIndex={value === code ? 0 : -1}
          onClick={() => onChange(code)}
          className={value === code ? 'on' : ''}
        >
          {intervalLabel(code)}
        </button>
      ))}
    </div>
  )
}
