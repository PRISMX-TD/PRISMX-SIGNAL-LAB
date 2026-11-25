// 画线数据模型与工具清单（阶段 2 第一批，2026-11-25）。
// 存储格式向后兼容：老画线只有 id / type / pts / color / locked / lineWidth / lineStyle，新字段全是可选，
// 读到不认识的 type 直接跳过不画（以后加工具时老页面不崩）。
// Drawing model and tool list (phase 2 batch 1, 2026-11-25). The stored shape is backward
// compatible: old drawings only carry id / type / pts / color / locked / lineWidth / lineStyle, every
// new field is optional, and an unknown type is skipped (old pages survive future tools).

export type DrawType =
  | 'trend' | 'ray' | 'info' | 'extended' | 'angle' | 'hline' | 'hray' | 'vline' | 'crossline'
  | 'channel'
  | 'fib' | 'fibExt'
  | 'long' | 'short'
  | 'priceRange' | 'dateRange' | 'datePriceRange'
  | 'brush' | 'arrow' | 'rect'
  | 'text' | 'priceLabel'

export type Tool = 'cursor' | 'cross' | DrawType
export type LineStyle = 'solid' | 'dashed' | 'dotted'
export type MagnetMode = 'off' | 'weak' | 'strong'

export interface Point { t: number; p: number }
export interface FibLevel { v: number; on: boolean; color?: string }
// 按周期显示：分钟 / 小时 / 日 / 周 / 月，缺省 = 全显示 / visibility per interval group, absent = all
export type VisGroup = 'm' | 'h' | 'd' | 'w' | 'M'
export type Vis = Partial<Record<VisGroup, boolean>>

export interface Drawing {
  id: string
  type: DrawType
  pts: Point[]
  color: string
  locked?: boolean
  hidden?: boolean
  name?: string
  lineWidth?: number
  lineStyle?: LineStyle
  // 文字（文本 / 价格标签，以及线类工具的附注）/ text (text & price label, and a note on line tools)
  text?: string
  fontSize?: number
  textColor?: string
  // 填充（矩形、通道、范围、斐波那契、仓位）；缺省按工具默认 / fill (rect, channel, ranges, fib, positions)
  fill?: boolean
  extendLeft?: boolean
  extendRight?: boolean
  // 读数标签（信息线、范围工具、价格标签、斐波那契价位）/ readout labels
  showLabel?: boolean
  levels?: FibLevel[]
  // 多空仓位：账户规模、风险百分比 / position tools: account size, risk percent
  account?: number
  risk?: number
  vis?: Vis
}

export type CreateMode = 'click' | 'drag' | 'three' | 'free'
export interface ToolMeta { create: CreateMode; textual?: boolean; lineLike?: boolean; fillable?: boolean }

export const TOOL_META: Record<DrawType, ToolMeta> = {
  trend: { create: 'drag', lineLike: true },
  ray: { create: 'drag', lineLike: true },
  info: { create: 'drag', lineLike: true },
  extended: { create: 'drag', lineLike: true },
  angle: { create: 'drag', lineLike: true },
  hline: { create: 'click' },
  hray: { create: 'click' },
  vline: { create: 'click' },
  crossline: { create: 'click' },
  channel: { create: 'three', fillable: true },
  fib: { create: 'drag', fillable: true },
  fibExt: { create: 'three', fillable: true },
  long: { create: 'drag', fillable: true },
  short: { create: 'drag', fillable: true },
  priceRange: { create: 'drag', fillable: true },
  dateRange: { create: 'drag', fillable: true },
  datePriceRange: { create: 'drag', fillable: true },
  brush: { create: 'free' },
  arrow: { create: 'drag', lineLike: true },
  rect: { create: 'drag', fillable: true },
  text: { create: 'click', textual: true },
  priceLabel: { create: 'click' },
}

export const DRAW_TYPES = Object.keys(TOOL_META) as DrawType[]
export const isDrawType = (s: unknown): s is DrawType => typeof s === 'string' && s in TOOL_META

// 工具分组（左侧竖轨每组一个按钮，弹出组内工具；记住每组上次用的）。
// Tool groups (one rail button per group with a flyout; each remembers its last tool).
export interface ToolGroup { id: string; tools: Tool[] }
export const TOOL_GROUPS: ToolGroup[] = [
  { id: 'cursors', tools: ['cursor', 'cross'] },
  { id: 'lines', tools: ['trend', 'ray', 'info', 'extended', 'angle', 'hline', 'hray', 'vline', 'crossline'] },
  { id: 'channels', tools: ['channel'] },
  { id: 'fibs', tools: ['fib', 'fibExt'] },
  { id: 'projection', tools: ['long', 'short'] },
  { id: 'measurers', tools: ['priceRange', 'dateRange', 'datePriceRange'] },
  { id: 'shapes', tools: ['rect', 'brush', 'arrow'] },
  { id: 'texts', tools: ['text', 'priceLabel'] },
]
export const ALL_TOOLS: Tool[] = TOOL_GROUPS.flatMap((g) => g.tools)

// Alt+字母（按 e.code 认键）。避开图表快捷键 Alt+R / G / L / P / I。
// Alt+letter (matched on e.code), avoiding the chart's Alt+R / G / L / P / I.
export const TOOL_HOTKEYS: Partial<Record<Tool, { code: string; shift?: boolean }>> = {
  trend: { code: 'KeyT' }, hline: { code: 'KeyH' }, hray: { code: 'KeyJ' }, vline: { code: 'KeyV' },
  crossline: { code: 'KeyC' }, fib: { code: 'KeyF' }, rect: { code: 'KeyR', shift: true }, ray: { code: 'KeyT', shift: true },
  brush: { code: 'KeyB', shift: true }, text: { code: 'KeyX', shift: true }, priceRange: { code: 'KeyM', shift: true },
}

export const COLORS = ['#22d3ee', '#a78bfa', '#2ee07e', '#ff4d67', '#f5c451']
// 浮动栏 / 设置里的完整色板 / the full palette in the floating bar and settings
export const PALETTE = [
  '#f8fafc', '#94a3b8', '#475569', '#0f172a',
  '#ff4d67', '#fb923c', '#f5c451', '#2ee07e',
  '#22d3ee', '#2962ff', '#a78bfa', '#f472b6',
]
export const LINE_WIDTHS = [1, 2, 3, 4]

export const FIB_RETRACE_LEVELS: FibLevel[] = [
  { v: 0, on: true }, { v: 0.236, on: true }, { v: 0.382, on: true }, { v: 0.5, on: true },
  { v: 0.618, on: true }, { v: 0.786, on: true }, { v: 1, on: true },
  { v: 1.618, on: false }, { v: 2.618, on: false }, { v: 3.618, on: false }, { v: 4.236, on: false },
]
export const FIB_EXT_LEVELS: FibLevel[] = [
  { v: 0, on: true }, { v: 0.236, on: false }, { v: 0.382, on: true }, { v: 0.5, on: false },
  { v: 0.618, on: true }, { v: 0.786, on: false }, { v: 1, on: true },
  { v: 1.618, on: true }, { v: 2.618, on: true }, { v: 3.618, on: false }, { v: 4.236, on: false },
]
export const levelsOf = (d: Drawing): FibLevel[] => d.levels ?? (d.type === 'fibExt' ? FIB_EXT_LEVELS : FIB_RETRACE_LEVELS)

// 缺省值 / defaults
export const fillOf = (d: Drawing): boolean => d.fill ?? !!TOOL_META[d.type]?.fillable
export const showLabelOf = (d: Drawing): boolean => d.showLabel ?? true
export const fontSizeOf = (d: Drawing): number => d.fontSize ?? 14
export const DEFAULT_ACCOUNT = 10000
export const DEFAULT_RISK = 1

export const uid = () => 'dw_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)

// 周期 → 显示分组 / interval code → visibility group
export function visGroupOf(interval: string): VisGroup {
  if (/^\d+$/.test(interval)) return Number(interval) < 60 ? 'm' : 'h'
  if (/W$/.test(interval)) return 'w'
  if (/M$/.test(interval)) return 'M'
  return 'd'
}
export const visibleOn = (d: Drawing, interval: string): boolean => !d.hidden && d.vis?.[visGroupOf(interval)] !== false

// 存储清洗：丢掉不认识的类型和坏点，补齐必填字段 / sanitize stored drawings
export function sanitizeDrawings(raw: unknown): Drawing[] {
  if (!Array.isArray(raw)) return []
  const out: Drawing[] = []
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue
    const d = r as Drawing
    if (!isDrawType(d.type) || typeof d.id !== 'string' || !Array.isArray(d.pts) || d.pts.length === 0) continue
    if (!d.pts.every((p) => p && Number.isFinite(p.t) && Number.isFinite(p.p))) continue
    out.push({ ...d, color: typeof d.color === 'string' ? d.color : COLORS[0] })
  }
  return out
}

// 两点工具的「另一端」：仓位工具三点、通道三点等由各自的创建逻辑补齐。
// Position tools need a stop point: derived from entry and target on creation.
export function finishPoints(type: DrawType, pts: Point[]): Point[] {
  if (type === 'long' || type === 'short') {
    const [a, b] = pts
    const up = type === 'long'
    const dist = Math.abs(b.p - a.p) || Math.abs(a.p) * 0.002
    const target = a.p + (up ? dist : -dist)
    const stop = a.p - (up ? dist : -dist)
    const t0 = Math.min(a.t, b.t), t1 = Math.max(a.t, b.t)
    return [{ t: t0, p: a.p }, { t: t1, p: target }, { t: t1, p: stop }]
  }
  return pts
}

// 样式字段（模板 / 默认样式只存这些，不存坐标和文字）/ style fields (templates & defaults keep only these)
export const STYLE_KEYS = ['color', 'lineWidth', 'lineStyle', 'fill', 'extendLeft', 'extendRight', 'showLabel', 'levels', 'fontSize', 'textColor', 'account', 'risk'] as const
export type StyleProps = Partial<Pick<Drawing, typeof STYLE_KEYS[number]>>
export function styleOf(d: Drawing): StyleProps {
  const out: Record<string, unknown> = {}
  for (const k of STYLE_KEYS) if (d[k] !== undefined) out[k] = d[k]
  return out as StyleProps
}
export interface DrawTemplate { name: string; style: StyleProps }

// 文本 / 线上附注是否可编辑 / which tools take text
export const takesText = (t: DrawType): boolean => t === 'text' || !!TOOL_META[t]?.lineLike || t === 'rect' || t === 'channel'
