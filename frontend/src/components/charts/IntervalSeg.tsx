// 周期切换按钮组。桌面工具栏、手机工具栏、全屏态右上角三处共用（2026-09-06
// 之前是三份逐字相同的 map）。seg = 工具栏里的 .term-ivseg 分段；fullscreen =
// 全屏态右上角的紧凑横排。
// Interval switch shared by the desktop toolbar, mobile toolbar and the
// fullscreen top-right corner (three identical copies before 2026-09-06).
import { INTERVALS } from './chartConfig'

export default function IntervalSeg({ value, onChange, variant = 'seg' }: {
  value: string
  onChange: (code: string) => void
  variant?: 'seg' | 'fullscreen'
}) {
  if (variant === 'fullscreen') {
    return (
      <div className="absolute top-2 right-12 z-30 flex items-center gap-0.5 rounded-lg border border-white/10 bg-ink-900/70 backdrop-blur-sm p-0.5">
        {INTERVALS.map((iv) => (
          <button
            key={iv.code}
            onClick={() => onChange(iv.code)}
            className={`rounded-md px-2 py-1 text-[11px] font-medium transition ${
              value === iv.code
                ? 'bg-prism-600/40 text-prism-200'
                : 'text-neutral-400 hover:text-neutral-100'
            }`}
          >
            {iv.label}
          </button>
        ))}
      </div>
    )
  }
  return (
    <div className="term-ivseg">
      {INTERVALS.map((iv) => (
        <button
          key={iv.code}
          type="button"
          onClick={() => onChange(iv.code)}
          className={value === iv.code ? 'on' : ''}
        >
          {iv.label}
        </button>
      ))}
    </div>
  )
}
