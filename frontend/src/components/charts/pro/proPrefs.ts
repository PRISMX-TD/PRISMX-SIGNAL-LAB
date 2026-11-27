// 专业版终端的布局偏好：用哪套界面、右侧开着哪个面板、面板宽度、交易面板高度与开合。
// 单独存在 chartv2 / pro 一个键里，不进 ChartPrefs（模板只管图表外观，不该带走窗口布局）。
// Pro terminal layout prefs: which shell, the open right-side widget, its width, and the
// trading panel's height / open state. Stored under its own chartv2 / pro key, not in
// ChartPrefs (templates carry the chart's look, never the window layout).
import { useCallback, useMemo, useRef } from 'react'
import { usePrefs } from '../../../store/prefs'
import { CHART_PREFS_NS } from '../useChartPrefs'

export const PRO_PREFS_KEY = 'pro'

export type ProLayout = 'classic' | 'pro'
// data = 数据窗口，tree = 画线对象树（阶段 6）/ data = data window, tree = drawing object tree (phase 6)
export type ProWidget = 'watch' | 'trade' | 'alerts' | 'data' | 'tree'
export const PRO_WIDGETS: readonly ProWidget[] = ['watch', 'trade', 'alerts', 'data', 'tree']

export interface ProPrefs {
  layout: ProLayout
  // null = 右侧面板收起 / null = the side panel is collapsed
  widget: ProWidget | null
  panelW: number
  dockOpen: boolean
  dockH: number
  // 专注模式：收起画线竖轨、右侧面板与交易面板 / focus mode: hide the rail, side panel and trading panel
  focus: boolean
  // 自选表显示哪些列：趋势格、最新价 / which watchlist columns show: trend cells, last price
  wlTrend: boolean
  wlPrice: boolean
  // 品种详情卡里「交易时段」「合约规格」两段是否展开（收起后刷新也记得）
  // Whether the symbol card's sessions / spec sections are expanded (a collapse survives a reload)
  metaSess: boolean
  metaSpec: boolean
}

export const PANEL_MIN = 260
export const PANEL_MAX = 520
export const DOCK_MIN = 140
export const DOCK_MAX = 520

export const DEFAULT_PRO_PREFS: ProPrefs = {
  layout: 'classic',
  widget: 'watch',
  panelW: 312,
  dockOpen: true,
  dockH: 220,
  focus: false,
  wlTrend: true,
  wlPrice: true,
  metaSess: true,
  metaSpec: true,
}

const clamp = (v: unknown, d: number, lo: number, hi: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.round(Math.min(hi, Math.max(lo, v))) : d

export function normalizeProPrefs(raw: unknown): ProPrefs {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const d = DEFAULT_PRO_PREFS
  return {
    layout: r.layout === 'pro' ? 'pro' : 'classic',
    widget: r.widget === null ? null : PRO_WIDGETS.includes(r.widget as ProWidget) ? (r.widget as ProWidget) : d.widget,
    panelW: clamp(r.panelW, d.panelW, PANEL_MIN, PANEL_MAX),
    dockOpen: typeof r.dockOpen === 'boolean' ? r.dockOpen : d.dockOpen,
    dockH: clamp(r.dockH, d.dockH, DOCK_MIN, DOCK_MAX),
    focus: typeof r.focus === 'boolean' ? r.focus : d.focus,
    wlTrend: typeof r.wlTrend === 'boolean' ? r.wlTrend : d.wlTrend,
    wlPrice: typeof r.wlPrice === 'boolean' ? r.wlPrice : d.wlPrice,
    metaSess: typeof r.metaSess === 'boolean' ? r.metaSess : d.metaSess,
    metaSpec: typeof r.metaSpec === 'boolean' ? r.metaSpec : d.metaSpec,
  }
}

export function useProPrefs(): [ProPrefs, (u: Partial<ProPrefs> | ((p: ProPrefs) => ProPrefs)) => void] {
  const { getPref, setPref } = usePrefs()
  const raw = getPref<unknown>(CHART_PREFS_NS, PRO_PREFS_KEY, null)
  const prefs = useMemo(() => normalizeProPrefs(raw), [raw])
  const ref = useRef(prefs)
  ref.current = prefs
  const update = useCallback((u: Partial<ProPrefs> | ((p: ProPrefs) => ProPrefs)) => {
    const next = typeof u === 'function' ? u(ref.current) : { ...ref.current, ...u }
    ref.current = next
    setPref(CHART_PREFS_NS, PRO_PREFS_KEY, next)
  }, [setPref])
  return [prefs, update]
}
