// 图表画布色板：深色（沿用现在的页面底色）与浅色两套。画布上的颜色全部从这里取，
// 不再硬编码在引擎里；图上 DOM 浮层（图例、菜单）跟着 .term-chart[data-ctheme] 换色。
// Canvas palettes: dark (the current page colours) and light. Every canvas colour comes
// from here instead of being hard-coded in the engine; DOM overlays on the chart (legend,
// menus) follow .term-chart[data-ctheme].

export type ChartThemePref = 'dark' | 'light' | 'system'
export type ChartThemeName = 'dark' | 'light'

export interface ChartPalette {
  bg: string
  text: string
  grid: string
  border: string
  crosshair: string
  crossLabelBg: string
  watermark: string
  sessionBreak: string
  // 买价 / 卖价线（TradingView 默认：买价蓝、卖价红）/ bid & ask lines (TradingView defaults)
  bid: string
  ask: string
  muted: string
}

export const CHART_PALETTES: Record<ChartThemeName, ChartPalette> = {
  dark: {
    bg: '#09090b',
    text: '#94a3b8',
    grid: 'rgba(255, 255, 255, 0.045)',
    border: 'rgba(255, 255, 255, 0.07)',
    crosshair: '#9598A1',
    crossLabelBg: '#363A45',
    watermark: 'rgba(255, 255, 255, 0.05)',
    sessionBreak: 'rgba(148, 163, 184, 0.28)',
    bid: '#2962FF',
    ask: '#F7525F',
    muted: 'rgba(148, 163, 184, 0.55)',
  },
  light: {
    bg: '#ffffff',
    text: '#131722',
    grid: 'rgba(42, 46, 57, 0.06)',
    border: '#e0e3eb',
    crosshair: '#9598A1',
    crossLabelBg: '#131722',
    watermark: 'rgba(19, 23, 34, 0.06)',
    sessionBreak: 'rgba(42, 46, 57, 0.22)',
    bid: '#2962FF',
    ask: '#F7525F',
    muted: 'rgba(42, 46, 57, 0.45)',
  },
}

export function resolveChartTheme(pref: ChartThemePref, systemDark: boolean): ChartThemeName {
  if (pref === 'system') return systemDark ? 'dark' : 'light'
  return pref
}
