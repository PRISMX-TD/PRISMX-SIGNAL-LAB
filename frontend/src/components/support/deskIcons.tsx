// 客服后台用到的几枚线性图标。全站图标都是内联 SVG（见 Layout 的 NavIcon），这里沿用同一写法：
// 24 视框、1.6 线宽、currentColor，尺寸跟着字号走。
// The few line icons the support console uses. Icons across the app are inline SVG (see Layout's
// NavIcon); same recipe here: 24 viewBox, 1.6 stroke, currentColor, sized by the font size.
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

export const IconBack = ({ size }: { size?: number }) => (
  <Svg size={size}>
    <path d="M15 5l-7 7 7 7" />
  </Svg>
)

export const IconClose = ({ size }: { size?: number }) => (
  <Svg size={size}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Svg>
)

export const IconInbox = ({ size }: { size?: number }) => (
  <Svg size={size}>
    <path d="M3.5 13.5 6 5.5h12l2.5 8" />
    <path d="M3.5 13.5V18a1.5 1.5 0 0 0 1.5 1.5h14a1.5 1.5 0 0 0 1.5-1.5v-4.5h-5a3.5 3.5 0 0 1-7 0h-5Z" />
  </Svg>
)

export const IconUsers = ({ size }: { size?: number }) => (
  <Svg size={size}>
    <circle cx="9" cy="8.5" r="3.5" />
    <path d="M2.5 19.5c.8-3.3 3.3-5 6.5-5s5.7 1.7 6.5 5" />
    <path d="M16 5.2a3.5 3.5 0 0 1 0 6.6M18.5 14.8c1.5.8 2.6 2.4 3 4.7" />
  </Svg>
)

export const IconUser = ({ size }: { size?: number }) => (
  <Svg size={size}>
    <circle cx="12" cy="8.5" r="4" />
    <path d="M4.5 20c1-3.8 4-5.8 7.5-5.8s6.5 2 7.5 5.8" />
  </Svg>
)

export const IconSend = ({ size }: { size?: number }) => (
  <Svg size={size}>
    <path d="M4 12 20 4l-6 16-2.5-6.5L4 12Z" />
  </Svg>
)

export const IconShield = ({ size }: { size?: number }) => (
  <Svg size={size}>
    <path d="M12 3.5 19 6v5.5c0 4.3-2.9 7.6-7 9-4.1-1.4-7-4.7-7-9V6l7-2.5Z" />
    <path d="M12 8.5v4M12 15.5v.01" />
  </Svg>
)
