// 推荐官中心用到的几枚线性图标。全站图标都是内联 SVG（见 Layout 的 NavIcon），这里沿用同一写法：
// 24 视框、1.6 线宽、currentColor，尺寸跟着调用处给。
// The few line icons the Ambassador Hub uses. Icons across the app are inline SVG (see Layout's
// NavIcon); same recipe here: 24 viewBox, 1.6 stroke, currentColor.
import type { ReactNode } from 'react'

function Svg({ children, size = 16 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="shrink-0"
    >
      {children}
    </svg>
  )
}

export const IconSearch = ({ size }: { size?: number }) => (
  <Svg size={size}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m20 20-4.2-4.2" />
  </Svg>
)

export const IconCopy = ({ size }: { size?: number }) => (
  <Svg size={size}>
    <rect x="8.5" y="8.5" width="11" height="11" rx="2.5" />
    <path d="M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5" />
  </Svg>
)

export const IconCheck = ({ size }: { size?: number }) => (
  <Svg size={size}>
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </Svg>
)

export const IconChevron = ({ size }: { size?: number }) => (
  <Svg size={size}>
    <path d="m6 9.5 6 6 6-6" />
  </Svg>
)

export const IconArrow = ({ size }: { size?: number }) => (
  <Svg size={size}>
    <path d="M5 12h13M13 6.5l5.5 5.5-5.5 5.5" />
  </Svg>
)

export const IconInfo = ({ size }: { size?: number }) => (
  <Svg size={size}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 11v5.5M12 7.8v.2" />
  </Svg>
)

export const IconUsers = ({ size }: { size?: number }) => (
  <Svg size={size}>
    <circle cx="9" cy="8.5" r="3.5" />
    <path d="M2.5 19.5c.8-3.3 3.3-5 6.5-5s5.7 1.7 6.5 5" />
    <path d="M16 5.2a3.5 3.5 0 0 1 0 6.6M18.5 14.8c1.5.8 2.6 2.4 3 4.7" />
  </Svg>
)
