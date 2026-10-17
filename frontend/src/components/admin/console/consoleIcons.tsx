// 管理控制台侧栏与工具条的线性图标。全站图标都是内联 SVG（见 Layout 的 NavIcon、客服后台的 deskIcons），
// 这里沿用同一写法：24 视框、1.6 线宽、currentColor。
// Line icons for the admin console rail and toolbars. Icons across the app are inline SVG (Layout's
// NavIcon, the support console's deskIcons); same recipe: 24 viewBox, 1.6 stroke, currentColor.
import type { ReactNode } from 'react'
import type { AdminGroup } from './sections'

function Svg({ children, size = 18 }: { children: ReactNode; size?: number }) {
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

const GROUP_PATHS: Record<AdminGroup, ReactNode> = {
  // 仪表：总览 / gauge: overview
  overview: (
    <>
      <path d="M4 16a8 8 0 1 1 16 0" />
      <path d="M12 16l3.5-4.5" />
      <path d="M4 20h16" />
    </>
  ),
  // 两个人：用户 / two people: users
  users: (
    <>
      <circle cx="9" cy="8.5" r="3.2" />
      <path d="M3.5 19.5c.6-3.2 2.8-5 5.5-5s4.9 1.8 5.5 5" />
      <path d="M15.5 5.6a3.2 3.2 0 0 1 0 6" />
      <path d="M17.5 14.8c1.6.6 2.7 2.2 3 4.7" />
    </>
  ),
  // 上扬折线：增长 / rising line: growth
  growth: (
    <>
      <path d="M4 17l5-5 3.5 3.5L20 8" />
      <path d="M15 8h5v5" />
    </>
  ),
  // 一页纸：内容 / a page: content
  content: (
    <>
      <path d="M7 3.5h7l4 4V19a1.5 1.5 0 0 1-1.5 1.5h-9.5A1.5 1.5 0 0 1 5.5 19V5A1.5 1.5 0 0 1 7 3.5z" />
      <path d="M14 3.5V8h4" />
      <path d="M8.5 12.5h7M8.5 16h5" />
    </>
  ),
  // 耳机：客服 / headset: support
  support: (
    <>
      <path d="M4 14v-2a8 8 0 0 1 16 0v2" />
      <rect x="3" y="14" width="4" height="6" rx="1.5" />
      <rect x="17" y="14" width="4" height="6" rx="1.5" />
      <path d="M19 20a3 3 0 0 1-3 2h-3" />
    </>
  ),
  // 两条滑杆：设置 / two sliders: settings
  settings: (
    <>
      <path d="M4 7.5h9M17 7.5h3M4 16.5h3M11 16.5h9" />
      <circle cx="15" cy="7.5" r="2" />
      <circle cx="9" cy="16.5" r="2" />
    </>
  ),
}

export function GroupIcon({ group, size }: { group: AdminGroup; size?: number }) {
  return <Svg size={size}>{GROUP_PATHS[group]}</Svg>
}

export const IconArrowUpRight = ({ size = 14 }: { size?: number }) => (
  <Svg size={size}>
    <path d="M8 16L16 8" />
    <path d="M9.5 8H16v6.5" />
  </Svg>
)

export const IconReplay = ({ size = 16 }: { size?: number }) => (
  <Svg size={size}>
    <path d="M4 12a8 8 0 1 0 2.4-5.7" />
    <path d="M4 4.5V8h3.5" />
    <path d="M12 8.5V12l2.5 1.5" />
  </Svg>
)

export const IconSearch = ({ size = 15 }: { size?: number }) => (
  <Svg size={size}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m20 20-4.2-4.2" />
  </Svg>
)

export const IconClose = ({ size = 14 }: { size?: number }) => (
  <Svg size={size}>
    <path d="M6 6l12 12M18 6L6 18" />
  </Svg>
)

export const IconHistory = ({ size = 14 }: { size?: number }) => (
  <Svg size={size}>
    <path d="M5 4.5h11.5A2.5 2.5 0 0 1 19 7v12.5H7.5A2.5 2.5 0 0 1 5 17V4.5z" />
    <path d="M9 9h6M9 12.5h6M9 16h3.5" />
  </Svg>
)
