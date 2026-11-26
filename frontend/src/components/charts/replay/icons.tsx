// 回放 / 对比用的小图标（24 网格、1.8 描边，与图表其它图标同一套画法；自绘，不用 TradingView 素材）。
// Small icons for replay / compare (24 grid, 1.8 stroke, same style as the other chart icons; drawn
// in-house, no TradingView assets).
import type { ReactNode } from 'react'

export function Ico({ children, size = 16 }: { children: ReactNode; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {children}
    </svg>
  )
}

export const RI = {
  // 回放：逆时针箭头 + 播放三角 / replay: counter-clockwise arrow + play triangle
  replay: <><path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3" /><path d="M4 4.5V8h3.5" /><path d="M10.5 9.2l4.3 2.8-4.3 2.8z" /></>,
  play: <path d="M8 5.5l10 6.5-10 6.5z" fill="currentColor" />,
  pause: <><path d="M8.5 5.5v13" /><path d="M15.5 5.5v13" /></>,
  step: <><path d="M6 6l8 6-8 6z" fill="currentColor" /><path d="M18 6v12" /></>,
  // 选起点：一条竖线 + 两侧箭头 / pick start: a vertical line with arrows either side
  cut: <><path d="M12 3.5v17" /><path d="M7 9l-3 3 3 3" /><path d="M17 9l3 3-3 3" /></>,
  realtime: <><path d="M5 6l6 6-6 6" /><path d="M12 6l6 6-6 6" /></>,
  calendar: <><rect x="3.5" y="5" width="17" height="15" rx="2" /><path d="M3.5 10h17M8 3v4M16 3v4" /></>,
  dice: <><rect x="4" y="4" width="16" height="16" rx="3.5" /><circle cx="9" cy="9" r="1.1" fill="currentColor" stroke="none" /><circle cx="15" cy="15" r="1.1" fill="currentColor" stroke="none" /><circle cx="15" cy="9" r="1.1" fill="currentColor" stroke="none" /><circle cx="9" cy="15" r="1.1" fill="currentColor" stroke="none" /></>,
  x: <path d="M6 6l12 12M18 6L6 18" />,
  // 对比：两条走势线 / compare: two trend lines
  compare: <><path d="M3.5 17l5-5.5 3.5 3 8.5-9" /><path d="M3.5 12.5l5-2.5 3.5 1.5 4-2.5" strokeDasharray="2.2 2.4" /><path d="M18 15.5v5M15.5 18h5" /></>,
  eye: <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12zm10 3a3 3 0 100-6 3 3 0 000 6z" />,
  eyeOff: <path d="M3 3l18 18M10.6 5.1A10 10 0 0112 5c6.4 0 10 7 10 7a17 17 0 01-3.1 3.9M6.6 6.6C3.8 8.5 2 12 2 12s3.6 7 10 7a9.6 9.6 0 004.2-1M9.9 9.9a3 3 0 004.2 4.2" />,
  gear: <path d="M12 15a3 3 0 100-6 3 3 0 000 6zm7.4-3a7.4 7.4 0 00-.1-1.2l2-1.6-2-3.4-2.4 1a7.6 7.6 0 00-2-1.2L14.5 3h-5l-.4 2.6a7.6 7.6 0 00-2 1.2l-2.4-1-2 3.4 2 1.6a7.4 7.4 0 000 2.4l-2 1.6 2 3.4 2.4-1a7.6 7.6 0 002 1.2l.4 2.6h5l.4-2.6a7.6 7.6 0 002-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2z" />,
  // 显示方式：百分比 / 新价格轴 / 新窗格 / display modes: percent / new scale / new pane
  percent: <><path d="M18 6L6 18" /><circle cx="7.5" cy="7.5" r="2.2" /><circle cx="16.5" cy="16.5" r="2.2" /></>,
  scale: <><path d="M17 4v16" /><path d="M17 7h3M17 12h3M17 17h3" /><path d="M4 15l4-4 3 2 4-5" /></>,
  pane: <><rect x="3.5" y="4" width="17" height="16" rx="2" /><path d="M3.5 13h17" /><path d="M6.5 17.5l3-2 3 1 4-2.5" /></>,
}
