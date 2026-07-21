// 通用环形进度表：把"一个 0~100 的数字有多好"用一圈进度环直观地表达出来，
// 比孤零零的大字号数字更容易一眼扫到"大概什么水平"。纯展示组件，不认识
// 数据语义——颜色、要不要按阈值分档，都由调用方决定（"我的交易表现"用
// 单一强调色，"纪律分"按分数分三档变色），这里只画环。
//
// Generic radial progress ring: turns a 0~100 number into an at-a-glance
// "how good is this" ring, easier to read than a bare big number alone.
// Presentational only — it doesn't know what the number means; color and
// any threshold-based tiering is the caller's call (trading performance uses
// one accent color, discipline score swaps colors by tier) — this just draws
// the ring.
interface Props {
  value: number // 0~100
  color: string
  size?: number
  strokeWidth?: number
  children?: React.ReactNode
}

export default function RadialGauge({ value, color, size = 104, strokeWidth = 9, children }: Props) {
  const clamped = Math.max(0, Math.min(100, value))
  const radius = (size - strokeWidth) / 2
  const circumference = 2 * Math.PI * radius
  const offset = circumference * (1 - clamped / 100)

  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
        <circle
          cx={size / 2} cy={size / 2} r={radius}
          fill="none" stroke="currentColor" strokeWidth={strokeWidth}
          className="text-white/[0.06]"
        />
        <circle
          cx={size / 2} cy={size / 2} r={radius}
          fill="none" stroke={color} strokeWidth={strokeWidth}
          strokeDasharray={circumference} strokeDashoffset={offset}
          strokeLinecap="round"
          style={{ transition: 'stroke-dashoffset 0.5s ease' }}
        />
      </svg>
      {children && (
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          {children}
        </div>
      )}
    </div>
  )
}
