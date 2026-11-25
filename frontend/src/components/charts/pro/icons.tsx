// 专业版终端的图标：与图表页现有的内联图标同一套线条（24 格、圆头、描边 1.8），
// 全项目一直是这种手绘线条图标，没有引图标库，这里保持同一家族。
// Pro terminal icons: the same line style as the chart page's existing inline icons
// (24 grid, round caps, 1.8 stroke). The project has always used these instead of an
// icon library, so this stays in the one family.
import type { ReactNode, SVGProps } from 'react'

type P = SVGProps<SVGSVGElement> & { size?: number }

function Svg({ size = 16, children, ...rest }: P & { children: ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden {...rest}>
      {children}
    </svg>
  )
}

export const IcApps = (p: P) => <Svg {...p}><rect x="4" y="4" width="6.5" height="6.5" rx="1.6" /><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.6" /><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.6" /><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.6" /></Svg>
export const IcSearch = (p: P) => <Svg {...p}><circle cx="11" cy="11" r="6.5" /><path d="M20 20l-4.2-4.2" /></Svg>
export const IcChevron = (p: P) => <Svg {...p}><path d="M6 9l6 6 6-6" /></Svg>
export const IcChevronRight = (p: P) => <Svg {...p}><path d="M9 6l6 6-6 6" /></Svg>
export const IcFx = (p: P) => <Svg {...p}><path d="M3 17l5-6 4 4 8-9" /><path d="M3 21h18" /></Svg>
export const IcBell = (p: P) => <Svg {...p}><path d="M6 16V11a6 6 0 0112 0v5l2 2H4z" /><path d="M10 21h4" /></Svg>
export const IcCamera = (p: P) => <Svg {...p}><path d="M4 8h3l2-3h6l2 3h3v11H4z" /><circle cx="12" cy="13" r="3.5" /></Svg>
export const IcGear = (p: P) => <Svg {...p}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z" /></Svg>
export const IcFocus = (p: P) => <Svg {...p}><path d="M4 9V5a1 1 0 011-1h4M15 4h4a1 1 0 011 1v4M20 15v4a1 1 0 01-1 1h-4M9 20H5a1 1 0 01-1-1v-4" /><circle cx="12" cy="12" r="2.5" /></Svg>
export const IcExpand = (p: P) => <Svg {...p}><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" /></Svg>
export const IcCollapse = (p: P) => <Svg {...p}><path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7" /></Svg>
export const IcList = (p: P) => <Svg {...p}><path d="M9 6h11M9 12h11M9 18h11" /><circle cx="4.5" cy="6" r="1" /><circle cx="4.5" cy="12" r="1" /><circle cx="4.5" cy="18" r="1" /></Svg>
export const IcTrade = (p: P) => <Svg {...p}><path d="M7 4v16M7 4L3.5 7.5M7 4l3.5 3.5M17 20V4M17 20l-3.5-3.5M17 20l3.5-3.5" /></Svg>
export const IcClose = (p: P) => <Svg {...p}><path d="M6 6l12 12M18 6L6 18" /></Svg>
export const IcPlus = (p: P) => <Svg {...p}><path d="M12 5v14M5 12h14" /></Svg>
export const IcPen = (p: P) => <Svg {...p}><path d="M4 20l4-1 10.5-10.5a2.1 2.1 0 00-3-3L5 16z" /><path d="M14 7l3 3" /></Svg>
export const IcBriefcase = (p: P) => <Svg {...p}><rect x="3" y="7" width="18" height="13" rx="2.5" /><path d="M9 7V5.5A1.5 1.5 0 0110.5 4h3A1.5 1.5 0 0115 5.5V7M3 13h18" /></Svg>
export const IcKeyboard = (p: P) => <Svg {...p}><rect x="2.5" y="6" width="19" height="12" rx="2.5" /><path d="M6.5 10h1M10.5 10h1M14.5 10h1M6.5 14h11" /></Svg>
export const IcCalendar = (p: P) => <Svg {...p}><rect x="3.5" y="5" width="17" height="15" rx="2.5" /><path d="M3.5 10h17M8 3v4M16 3v4" /></Svg>
export const IcMore = (p: P) => <Svg {...p}><circle cx="5" cy="12" r="1.3" fill="currentColor" /><circle cx="12" cy="12" r="1.3" fill="currentColor" /><circle cx="19" cy="12" r="1.3" fill="currentColor" /></Svg>
export const IcPanel = (p: P) => <Svg {...p}><rect x="3" y="4" width="18" height="16" rx="2.5" /><path d="M15 4v16" /></Svg>
export const IcDock = (p: P) => <Svg {...p}><rect x="3" y="4" width="18" height="16" rx="2.5" /><path d="M3 14h18" /></Svg>
export const IcClassic = (p: P) => <Svg {...p}><rect x="3" y="4" width="18" height="16" rx="2.5" /><path d="M8.5 4v16M15.5 4v16" /></Svg>
export const IcSpark = (p: P) => <Svg {...p}><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" /></Svg>
export const IcWifiOff = (p: P) => <Svg {...p}><path d="M3 3l18 18M8.5 16.5a5 5 0 017 0M5 12.6a10 10 0 015.2-2.5M19 12.6a10 10 0 00-2.6-1.8M2 8.8a15 15 0 014.4-2.6M22 8.8A15 15 0 0011.6 5" /><circle cx="12" cy="20" r="0.8" fill="currentColor" /></Svg>
export const IcCheck = (p: P) => <Svg {...p}><path d="M5 12.5l4.5 4.5L19 7.5" /></Svg>
export const IcArrowUp = (p: P) => <Svg {...p}><path d="M12 19V5M5.5 11.5L12 5l6.5 6.5" /></Svg>
export const IcArrowDown = (p: P) => <Svg {...p}><path d="M12 5v14M5.5 12.5L12 19l6.5-6.5" /></Svg>
export const IcReturn = (p: P) => <Svg {...p}><path d="M20 5v7a3 3 0 01-3 3H5M9 11l-4 4 4 4" /></Svg>
export const IcHome = (p: P) => <Svg {...p}><path d="M4 11l8-6.5 8 6.5V19a1 1 0 01-1 1h-4.5v-5h-5v5H5a1 1 0 01-1-1z" /></Svg>
export const IcSignal = (p: P) => <Svg {...p}><path d="M4 18v-3M9 18v-6M14 18V9M19 18V6" /></Svg>
export const IcOrders = (p: P) => <Svg {...p}><rect x="4.5" y="3.5" width="15" height="17" rx="2.5" /><path d="M8.5 8h7M8.5 12h7M8.5 16h4" /></Svg>
export const IcTrophy = (p: P) => <Svg {...p}><path d="M8 4h8v5a4 4 0 01-8 0z" /><path d="M8 6H5a3 3 0 003 4M16 6h3a3 3 0 01-3 4M12 13v4M8.5 20h7M10 17h4" /></Svg>
