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
  // 第二批（2026-11-25）/ batch 2
  | 'regression' | 'flatChannel' | 'disjointChannel'
  | 'pitchfork' | 'schiffPitchfork' | 'modSchiffPitchfork' | 'insidePitchfork' | 'pitchfan'
  | 'fibChannel' | 'fibTimeZone' | 'fibFan' | 'fibTime' | 'fibCircles' | 'fibArcs' | 'gannFan' | 'gannBox'
  | 'xabcd' | 'cypher' | 'abcd' | 'headShoulders' | 'trianglePattern' | 'threeDrives'
  | 'elliottImpulse' | 'elliottCorrection' | 'elliottTriangle' | 'elliottDouble' | 'elliottTriple'
  | 'cyclicLines' | 'timeCycles' | 'sineLine'
  | 'forecast'
  | 'highlighter' | 'arrowMarker' | 'arrowUp' | 'arrowDown'
  | 'rotatedRect' | 'path' | 'circle' | 'ellipse' | 'polyline' | 'triangle' | 'arc' | 'curve' | 'doubleCurve' | 'sector'
  | 'anchoredText' | 'note' | 'priceNote' | 'pin' | 'callout' | 'comment' | 'signpost' | 'flag' | 'emoji'
  // 第三批（2026-11-25）/ batch 3
  | 'fibSpiral' | 'fibWedge' | 'gannSquare' | 'gannSquareFixed'
  | 'barsPattern' | 'ghostFeed' | 'anchoredVwap' | 'fixedRangeVP' | 'anchoredVP'
  | 'table' | 'image'

// presenter = 演示光标（不是画线，鼠标后面拖一道激光笔的光）/ presenter = a laser-pointer cursor, not a drawing
export type Tool = 'cursor' | 'cross' | 'presenter' | DrawType
// 指针类工具（不画线，按光标模式处理点击 / 悬停）/ pointer tools (no drawing; clicks and hover act as the cursor)
export const isPointer = (t: Tool): t is 'cursor' | 'cross' | 'presenter' => t === 'cursor' || t === 'cross' || t === 'presenter'
export type LineStyle = 'solid' | 'dashed' | 'dotted'
export type MagnetMode = 'off' | 'weak' | 'strong'

export interface Point { t: number; p: number }
export interface FibLevel { v: number; on: boolean; color?: string }
// 成交量分布的线：开关 + 颜色 / a volume-profile line: on/off + colour
export interface VpLine { on: boolean; color: string }
export interface VpOpts {
  /** 行布局：按行数，或按每行几个最小跳动 / row layout: a row count, or ticks per row */
  layout: 'rows' | 'ticks'
  ticks: number
  /** 成交量：上涨 / 下跌分开、总量、差值 / volume: up / down, total, delta */
  volume: 'updown' | 'total' | 'delta'
  /** 价值区占总量的百分比 / value area as % of total volume */
  vaPct: number
  /** 画直方图 / draw the histogram */
  hist: boolean
  /** 每行的量写在条末 / write each row's volume at the bar end */
  values: boolean
  valuesColor: string
  /** 直方图最长占框宽的百分比 / longest bar as % of the box width */
  widthPct: number
  placement: 'left' | 'right'
  up: string
  down: string
  vaUp: string
  vaDown: string
  vah: VpLine
  val: VpLine
  poc: VpLine
  devPoc: VpLine
  devVa: VpLine
  /** 直方图框底色，空 = 不铺 / box background, empty = none */
  boxBg: string
}
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
  // 折线：最后一点接回第一点（闭合后可填充）/ polyline closed back to its first point (fillable then)
  closed?: boolean
  // 成交量分布的价格行数 / volume profile price rows
  rows?: number
  // 成交量分布的其余设置（对标 TradingView 的 FRVP：输入 + 样式），缺省项见 draw/ext/volume.ts 的 vpOf
  // The rest of the volume profile settings (after TradingView's FRVP inputs + style); defaults in vpOf
  vp?: Partial<VpOpts>
  // 锚定 VWAP 画 ±1σ / ±2σ 带 / anchored VWAP draws the ±1σ / ±2σ bands
  bands?: boolean
  // K 线形态复制：上下翻转 / 左右镜像；bars = 复制下来的 [开, 高, 低, 收]（相对第一根开盘价）
  // Bars pattern: flipped upside down / mirrored left-right; bars = copied [o, h, l, c] relative to the first open
  flip?: boolean
  mirror?: boolean
  bars?: number[][]
  // 图片（data URL，压缩到几十 KB）与不透明度 / image (a data URL squeezed to tens of KB) and opacity
  img?: string
  alpha?: number
  vis?: Vis
}

// 创建方式：click = 点一下；drag = 两点（拖或点两下）；multi = 固定 n 个点依次点；
// free = 按住画（画笔 / 荧光笔）；poly = 点任意多个，双击 / 回车结束（折线、路径）。
// Creation: click = one click; drag = two points (drag or click-click); multi = n points clicked in turn;
// free = press and draw (brush / highlighter); poly = any number of clicks, double-click / Enter finishes.
export type CreateMode = 'click' | 'drag' | 'multi' | 'free' | 'poly'
export interface ToolMeta { create: CreateMode; n?: number; textual?: boolean; lineLike?: boolean; fillable?: boolean }

const M = (n: number, fillable = false): ToolMeta => ({ create: 'multi', n, fillable })
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
  channel: M(3, true),
  fib: { create: 'drag', fillable: true },
  fibExt: M(3, true),
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
  regression: { create: 'drag', fillable: true },
  flatChannel: M(3, true),
  disjointChannel: M(3, true),
  pitchfork: M(3, true),
  schiffPitchfork: M(3, true),
  modSchiffPitchfork: M(3, true),
  insidePitchfork: M(3, true),
  pitchfan: M(3, true),
  fibChannel: M(3, true),
  fibTimeZone: { create: 'drag' },
  fibFan: { create: 'drag', fillable: true },
  fibTime: M(3),
  fibCircles: { create: 'drag', fillable: true },
  fibArcs: { create: 'drag' },
  gannFan: { create: 'drag' },
  gannBox: { create: 'drag', fillable: true },
  xabcd: M(5, true),
  cypher: M(5, true),
  abcd: M(4),
  headShoulders: M(7, true),
  trianglePattern: M(4, true),
  threeDrives: M(7),
  elliottImpulse: M(6),
  elliottCorrection: M(4),
  elliottTriangle: M(6),
  elliottDouble: M(4),
  elliottTriple: M(6),
  cyclicLines: { create: 'drag' },
  timeCycles: { create: 'drag', fillable: true },
  sineLine: { create: 'drag' },
  forecast: { create: 'drag' },
  highlighter: { create: 'free' },
  arrowMarker: { create: 'drag' },
  arrowUp: { create: 'click' },
  arrowDown: { create: 'click' },
  rotatedRect: M(3, true),
  path: { create: 'poly' },
  circle: { create: 'drag', fillable: true },
  ellipse: { create: 'drag', fillable: true },
  polyline: { create: 'poly', fillable: true },
  triangle: M(3, true),
  arc: M(3, true),
  curve: M(3),
  doubleCurve: M(3),
  sector: M(3, true),
  anchoredText: { create: 'click', textual: true },
  note: { create: 'click', textual: true },
  priceNote: { create: 'drag' },
  pin: { create: 'click', textual: true },
  callout: { create: 'drag', textual: true },
  comment: { create: 'click', textual: true },
  signpost: { create: 'click', textual: true },
  flag: { create: 'click' },
  emoji: { create: 'click', textual: true },
  fibSpiral: { create: 'drag' },
  fibWedge: M(3, true),
  gannSquare: { create: 'drag', fillable: true },
  gannSquareFixed: { create: 'drag', fillable: true },
  barsPattern: { create: 'drag' },
  ghostFeed: { create: 'poly' },
  anchoredVwap: { create: 'click' },
  fixedRangeVP: { create: 'drag' },
  anchoredVP: { create: 'click' },
  table: { create: 'click', textual: true },
  image: { create: 'drag' },
}

// 这种工具需要几个点（free / poly 至少 2 个）/ how many points a tool needs (free / poly: at least 2)
export function pointsNeeded(t: DrawType): number {
  const m = TOOL_META[t]
  if (!m) return 2
  if (m.create === 'click') return 1
  if (m.create === 'multi') return m.n ?? 3
  return 2
}

// 锚定文本按屏幕位置存（t / p 是画布宽高的 0~1 比例），不随图表平移缩放
// Anchored text is stored in screen space (t / p are 0..1 fractions of the pane) and ignores pan / zoom
export const isScreenAnchored = (t: DrawType): boolean => t === 'anchoredText'

export const DRAW_TYPES = Object.keys(TOOL_META) as DrawType[]
export const isDrawType = (s: unknown): s is DrawType => typeof s === 'string' && s in TOOL_META

// 工具分组（左侧竖轨每组一个按钮，弹出组内工具；记住每组上次用的）。secs = 组内小标题从哪个工具开始。
// Tool groups (one rail button per group with a flyout; each remembers its last tool). secs = where a
// sub-heading starts inside the flyout.
export interface ToolGroup { id: string; tools: Tool[]; secs?: Partial<Record<Tool, string>> }
export const TOOL_GROUPS: ToolGroup[] = [
  { id: 'cursors', tools: ['cursor', 'cross', 'presenter'] },
  { id: 'lines', tools: ['trend', 'ray', 'info', 'extended', 'angle', 'hline', 'hray', 'vline', 'crossline'] },
  {
    id: 'channels',
    tools: ['channel', 'regression', 'flatChannel', 'disjointChannel', 'pitchfork', 'schiffPitchfork', 'modSchiffPitchfork', 'insidePitchfork', 'pitchfan'],
    secs: { channel: 'channels', pitchfork: 'pitchforks' },
  },
  {
    id: 'fibs',
    tools: ['fib', 'fibExt', 'fibChannel', 'fibTimeZone', 'fibFan', 'fibTime', 'fibCircles', 'fibArcs', 'fibSpiral', 'fibWedge', 'gannFan', 'gannBox', 'gannSquareFixed', 'gannSquare'],
    secs: { fib: 'fib', gannFan: 'gann' },
  },
  {
    id: 'patterns',
    tools: ['xabcd', 'cypher', 'abcd', 'headShoulders', 'trianglePattern', 'threeDrives', 'elliottImpulse', 'elliottCorrection', 'elliottTriangle', 'elliottDouble', 'elliottTriple', 'cyclicLines', 'timeCycles', 'sineLine'],
    secs: { xabcd: 'patterns', elliottImpulse: 'elliott', cyclicLines: 'cycles' },
  },
  {
    id: 'projection',
    tools: ['long', 'short', 'forecast', 'barsPattern', 'ghostFeed', 'anchoredVwap', 'fixedRangeVP', 'anchoredVP'],
    secs: { long: 'projection', anchoredVwap: 'volume' },
  },
  { id: 'measurers', tools: ['priceRange', 'dateRange', 'datePriceRange'] },
  {
    id: 'shapes',
    tools: ['brush', 'highlighter', 'arrow', 'arrowMarker', 'arrowUp', 'arrowDown', 'rect', 'rotatedRect', 'path', 'circle', 'ellipse', 'polyline', 'triangle', 'arc', 'curve', 'doubleCurve', 'sector'],
    secs: { brush: 'brushes', arrow: 'arrows', rect: 'shapes' },
  },
  {
    id: 'texts',
    tools: ['text', 'anchoredText', 'note', 'priceNote', 'pin', 'callout', 'comment', 'priceLabel', 'signpost', 'flag', 'emoji', 'table', 'image'],
  },
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
// 能显示的最多根数（K 线形态复制）/ at most this many bars are copied (bars pattern)
export const BARS_PATTERN_MAX = 300
const lv = (on: number[], off: number[] = []): FibLevel[] =>
  [...on.map((v) => ({ v, on: true })), ...off.map((v) => ({ v, on: false }))].sort((a, b) => a.v - b.v)
// 带档位的工具各自的缺省档位 / default levels of each level-based tool
export const DEFAULT_LEVELS: Partial<Record<DrawType, FibLevel[]>> = {
  fib: FIB_RETRACE_LEVELS,
  fibExt: FIB_EXT_LEVELS,
  fibChannel: lv([0, 0.382, 0.618, 1, 1.618], [0.236, 0.5, 0.786, 2.618, 3.618, 4.236]),
  fibTimeZone: lv([0, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89], [144, 233]),
  fibFan: lv([0, 0.25, 0.382, 0.5, 0.618, 0.75, 1]),
  fibTime: lv([0, 0.382, 0.5, 0.618, 1, 1.382, 1.618, 2, 2.618], [2.382, 3, 3.618, 4.236]),
  fibCircles: lv([0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.618], [2.618, 3.618, 4.236]),
  fibArcs: lv([0.236, 0.382, 0.5, 0.618, 0.786, 1]),
  gannBox: lv([0, 0.25, 0.382, 0.5, 0.618, 0.75, 1]),
  pitchfan: lv([0, 0.382, 0.5, 0.618, 1], [0.25, 0.75]),
  fibWedge: lv([0.236, 0.382, 0.5, 0.618, 0.786, 1]),
  gannSquare: lv([0, 0.25, 0.382, 0.5, 0.618, 0.75, 1]),
  gannSquareFixed: lv([0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 1]),
}
export const hasLevels = (t: DrawType): boolean => t in DEFAULT_LEVELS
export const levelsOf = (d: Drawing): FibLevel[] => d.levels ?? DEFAULT_LEVELS[d.type] ?? FIB_RETRACE_LEVELS

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
    const clean: Drawing = { ...d, color: typeof d.color === 'string' ? d.color : COLORS[0] }
    // 复制的 K 线、图片来自云端，形状不对就丢掉这一项 / copied bars and images come from the cloud: drop malformed ones
    if (clean.bars !== undefined && !(Array.isArray(clean.bars) && clean.bars.length <= BARS_PATTERN_MAX
      && clean.bars.every((b) => Array.isArray(b) && b.length === 4 && b.every(Number.isFinite)))) delete clean.bars
    if (clean.img !== undefined && !(typeof clean.img === 'string' && /^data:image\/(png|jpeg|webp);base64,/.test(clean.img))) delete clean.img
    if (clean.vp !== undefined && (typeof clean.vp !== 'object' || clean.vp === null || Array.isArray(clean.vp))) delete clean.vp
    out.push(clean)
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
// 没有线宽 / 线型可调的工具（图标、气泡、文字块、成交量分布）；设置弹窗和浮动工具条共用
// Tools without width / style (icons, bubbles, text blocks, volume profiles); shared by the dialog and the quick bar
export const NO_LINE = new Set<DrawType>(['text', 'priceLabel', 'long', 'short', 'emoji', 'note', 'pin', 'flag', 'arrowUp', 'arrowDown', 'arrowMarker', 'comment', 'callout', 'signpost', 'anchoredText',
  'table', 'image', 'barsPattern', 'ghostFeed', 'fixedRangeVP', 'anchoredVP'])

export const STYLE_KEYS = ['color', 'lineWidth', 'lineStyle', 'fill', 'extendLeft', 'extendRight', 'showLabel', 'levels', 'fontSize', 'textColor', 'account', 'risk', 'rows', 'bands', 'alpha', 'vp'] as const
export type StyleProps = Partial<Pick<Drawing, typeof STYLE_KEYS[number]>>
export function styleOf(d: Drawing): StyleProps {
  const out: Record<string, unknown> = {}
  for (const k of STYLE_KEYS) if (d[k] !== undefined) out[k] = d[k]
  return out as StyleProps
}
export interface DrawTemplate { name: string; style: StyleProps }

// 文本 / 线上附注是否可编辑 / which tools take text
const TEXT_TOOLS = new Set<DrawType>([
  'rect', 'channel', 'rotatedRect', 'circle', 'ellipse', 'triangle', 'polyline', 'path', 'arrowMarker', 'arrowUp', 'arrowDown',
  'forecast', 'priceNote',
])
export const takesText = (t: DrawType): boolean => !!TOOL_META[t]?.textual || !!TOOL_META[t]?.lineLike || TEXT_TOOLS.has(t)
// 表情工具新建时的缺省表情 / the emoji a new emoji drawing starts with
export const DEFAULT_EMOJI = '🚀'
export const EMOJIS = ['🚀', '🔥', '⭐', '✅', '❌', '⚠️', '💰', '📈', '📉', '🎯', '🐂', '🐻', '👍', '👎', '❗', '❓', '💡', '⏰', '🔔', '📌', '😀', '😱', '🤔', '💎']
