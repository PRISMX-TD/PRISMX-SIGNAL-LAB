// 周期切换按钮组。桌面工具条、手机工具条、全屏态右上角三处共用（2026-09-06
// 之前是三份逐字相同的 map）。seg = 工具条里的 .term-tf 药丸段；fullscreen =
// 全屏态右上角的紧凑横排。
// Interval switch shared by the desktop toolbar, mobile toolbar and the
// fullscreen top-right corner (three identical copies before 2026-09-06).
import { INTERVALS } from './chartConfig'
import { onRovingKeyDown } from '../../utils/rovingTabs'

export default function IntervalSeg({ value, onChange, variant = 'seg' }: {
  value: string
  onChange: (code: string) => void
  variant?: 'seg' | 'fullscreen'
}) {
  if (variant === 'fullscreen') {
    // 按钮圆角同心：外框 rounded-lg 8 − 边框 1 − p-0.5（本项目 4px）= 3。/ Concentric: 8 − 1 − 4 = 3.
    return (
      <div className="absolute top-2 right-12 z-30 flex items-center gap-0.5 rounded-lg border border-white/10 bg-ink-900/70 backdrop-blur-sm p-0.5">
        {INTERVALS.map((iv) => (
          <button
            key={iv.code}
            onClick={() => onChange(iv.code)}
            className={`rounded-[3px] px-2 py-1 text-xs font-medium transition ${
              value === iv.code
                ? 'bg-prism-600 text-white'
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
    <div className="term-tf" role="tablist" onKeyDown={onRovingKeyDown}>
      {INTERVALS.map((iv) => (
        <button
          key={iv.code}
          type="button"
          role="tab"
          aria-selected={value === iv.code}
          tabIndex={value === iv.code ? 0 : -1}
          onClick={() => onChange(iv.code)}
          className={value === iv.code ? 'on' : ''}
        >
          {iv.label}
        </button>
      ))}
    </div>
  )
}
