// 规则 AST 的前端类型定义与常量。与后端 services/strategy/rules.py 的
// INDICATOR_SPECS / COMPARE_OPS / PRICE_FIELDS 一一对应——两侧都需要这份清单
// （后端校验、前端渲染选择器），且前端不能在运行时才发现某个参数越界。
// 键名与大小写必须与后端字面一致：条件组用 logic（AND / OR 大写），指标操作数
// 用 fn。后端 _walk 靠 "logic" in node 区分节点类型，键名对不上会被当成一条
// 比较，再报「未知比较符」。改动指标时两侧必须同步。
// Frontend types and constants for the rule AST, mirroring
// services/strategy/rules.py's INDICATOR_SPECS / COMPARE_OPS / PRICE_FIELDS.
// Both sides need the list (the backend validates, the frontend renders
// pickers) and the frontend must not discover an out-of-range param only at
// request time. Key names and casing must match the backend verbatim: groups
// use `logic` (uppercase AND / OR), indicator operands use `fn`. The backend's
// _walk distinguishes node types via `"logic" in node`, so a mismatched key is
// read as a comparison and then rejected as an unknown operator. Keep in sync.

export const COMPARE_OPS = ['crosses_above', 'crosses_below', 'gt', 'lt', 'gte', 'lte'] as const
export type CompareOp = (typeof COMPARE_OPS)[number]

export const PRICE_FIELDS = ['open', 'high', 'low', 'close'] as const
export type PriceField = (typeof PRICE_FIELDS)[number]

// 支持的六档周期，与后端 rules.INTERVAL_SECONDS 的键集合一致。
// The six supported intervals, matching the keys of rules.INTERVAL_SECONDS.
export const INTERVALS = [
  { code: '1', label: '1m' },
  { code: '5', label: '5m' },
  { code: '15', label: '15m' },
  { code: '60', label: '1H' },
  { code: '240', label: '4H' },
  { code: 'D', label: '1D' },
] as const

// 滥用上限：与后端 rules.py 的 MAX_* 常量、MAX_SHIFT / SCALE_RANGE 逐项相等。
// 前端用它禁用「添加条件」，后端用它返回 400——同一组数值两处执行。
// Abuse limits, equal item-for-item to rules.py's MAX_* constants plus
// MAX_SHIFT / SCALE_RANGE. The frontend disables "add condition" with them; the
// backend 400s with them. One set of numbers enforced in two places.
export const RULE_LIMITS = {
  maxConditions: 12,
  maxDepth: 3,
  maxIndicatorInstances: 8,
  maxIntervals: 3,
  maxSymbols: 5,
  maxShift: 300,
  scaleMin: 0.5,
  scaleMax: 1.5,
} as const

export interface IndicatorParamSpec {
  min: number
  max: number
  isInt: boolean
  default: number
}

// 每个指标的参数定义。与后端 INDICATOR_SPECS 的 (min, max, is_int) 三元组同构。
// Per-indicator param definitions, structurally identical to the backend's
// (min, max, is_int) tuples.
export const INDICATOR_SPECS: Record<string, Record<string, IndicatorParamSpec>> = {
  sma: { period: { min: 2, max: 300, isInt: true, default: 20 } },
  ema: { period: { min: 2, max: 300, isInt: true, default: 20 } },
  rsi: { period: { min: 2, max: 50, isInt: true, default: 14 } },
  atr: { period: { min: 2, max: 100, isInt: true, default: 14 } },
  macd_dif: {
    fastPeriod: { min: 2, max: 50, isInt: true, default: 12 },
    slowPeriod: { min: 3, max: 100, isInt: true, default: 26 },
    signalPeriod: { min: 2, max: 50, isInt: true, default: 9 },
  },
  macd_dea: {
    fastPeriod: { min: 2, max: 50, isInt: true, default: 12 },
    slowPeriod: { min: 3, max: 100, isInt: true, default: 26 },
    signalPeriod: { min: 2, max: 50, isInt: true, default: 9 },
  },
  boll_upper: {
    period: { min: 5, max: 100, isInt: true, default: 20 },
    mult: { min: 0.5, max: 5, isInt: false, default: 2 },
  },
  boll_middle: {
    period: { min: 5, max: 100, isInt: true, default: 20 },
    mult: { min: 0.5, max: 5, isInt: false, default: 2 },
  },
  boll_lower: {
    period: { min: 5, max: 100, isInt: true, default: 20 },
    mult: { min: 0.5, max: 5, isInt: false, default: 2 },
  },
  donchian_high: { period: { min: 5, max: 100, isInt: true, default: 20 } },
  donchian_low: { period: { min: 5, max: 100, isInt: true, default: 20 } },
}

export const INDICATOR_NAMES = Object.keys(INDICATOR_SPECS)

// 操作数三种形态：指标 / 价格字段 / 常量。shift 与 scale 是指标与价格共有的
// 可选修饰（取前 N 根、乘以系数），默认 0 与 1；常量不需要（直接改 value）。
// Three operand shapes: indicator, price field, constant. `shift` and `scale`
// are optional modifiers shared by the indicator and price shapes (take the
// value N bars back, multiply by a factor), defaulting to 0 and 1; a constant
// needs neither, since its value is edited directly.
export type RuleOperand =
  | { kind: 'indicator'; fn: string; params: Record<string, number>; interval?: string; shift?: number; scale?: number }
  | { kind: 'price'; field: PriceField; interval?: string; shift?: number; scale?: number }
  | { kind: 'const'; value: number }

export interface RuleCondition {
  left: RuleOperand
  op: CompareOp
  right: RuleOperand
}

export interface RuleGroup {
  logic: 'AND' | 'OR'
  children: RuleNode[]
}

export type RuleNode = RuleCondition | RuleGroup

// 信封：多空两侧各一棵树，任一侧可为 null（只做多或只做空），但不能都为 null。
// Envelope: one tree per side; either may be null (long-only or short-only),
// but not both.
export interface RuleEnvelope {
  long: RuleGroup | null
  short: RuleGroup | null
}

export function isGroup(node: RuleNode): node is RuleGroup {
  return (node as RuleGroup).children !== undefined
}

export function defaultParamsFor(fn: string): Record<string, number> {
  const spec = INDICATOR_SPECS[fn]
  const out: Record<string, number> = {}
  if (!spec) return out
  for (const [name, s] of Object.entries(spec)) out[name] = s.default
  return out
}

export function emptyCondition(): RuleCondition {
  return {
    left: { kind: 'indicator', fn: 'ema', params: { period: 20 } },
    op: 'crosses_above',
    right: { kind: 'indicator', fn: 'ema', params: { period: 50 } },
  }
}

export function emptyGroup(): RuleGroup {
  return { logic: 'AND', children: [emptyCondition()] }
}

function walkNodes(envelope: RuleEnvelope, visit: (node: RuleNode, depth: number) => void): void {
  const walk = (node: RuleNode, depth: number) => {
    visit(node, depth)
    if (isGroup(node)) node.children.forEach((c) => walk(c, depth + 1))
  }
  if (envelope.long) walk(envelope.long, 1)
  if (envelope.short) walk(envelope.short, 1)
}

export function countConditions(envelope: RuleEnvelope): number {
  let n = 0
  walkNodes(envelope, (node) => { if (!isGroup(node)) n += 1 })
  return n
}

// 指标实例去重的 key 与后端 _indicator_key 同构：fn + 排序后的参数 + interval
// + shift + scale。shift / scale 参与去重是刻意的：否则「同一均线的当根与前一
// 根」会被算成一个实例，上限失去意义。
// The dedup key mirrors the backend's _indicator_key: fn + sorted params +
// interval + shift + scale. Including shift/scale is deliberate: otherwise
// "this bar's and last bar's same MA" would count as one instance and the limit
// would mean nothing.
function indicatorKey(o: RuleOperand): string {
  if (o.kind !== 'indicator') return ''
  const params = Object.keys(o.params).sort().map((k) => `${k}=${o.params[k]}`).join(',')
  return `${o.fn}|${params}|${o.interval ?? ''}|${o.shift ?? 0}|${o.scale ?? 1}`
}

export function countIndicatorInstances(envelope: RuleEnvelope): number {
  const seen = new Set<string>()
  walkNodes(envelope, (node) => {
    if (isGroup(node)) return
    for (const side of [node.left, node.right]) {
      if (side.kind === 'indicator') seen.add(indicatorKey(side))
    }
  })
  return seen.size
}

// 某一侧树的最大嵌套深度。根组算第 1 层，与后端 _walk 的 depth 起点一致。
// Max nesting depth of one side's tree. The root group is level 1, matching the
// backend _walk's starting depth.
export function groupDepth(group: RuleGroup): number {
  const walk = (node: RuleNode, depth: number): number =>
    isGroup(node) ? Math.max(depth, ...node.children.map((c) => walk(c, depth + 1))) : depth
  return walk(group, 1)
}

// AST 中引用到的所有显式周期。用于在保存前提示「规则引用了未订阅的周期」，
// 与后端 collect_rules_intervals 同一条校验——在前端先挡一次，用户不必靠 400
// 才知道。
// Every explicit interval referenced by the AST, matching the backend's
// collect_rules_intervals. Used to warn about "rules reference an unsubscribed
// interval" before saving, so the user doesn't need a 400 to find out.
export function collectIntervals(envelope: RuleEnvelope): string[] {
  const out = new Set<string>()
  walkNodes(envelope, (node) => {
    if (isGroup(node)) return
    for (const side of [node.left, node.right]) {
      if (side.kind !== 'const' && side.interval) out.add(side.interval)
    }
  })
  return [...out]
}

export interface RuleUsage {
  conditions: number
  indicatorInstances: number
  intervals: number
  // 已在用的周期代码。OperandPicker 用它区分「这个周期已经在用（仍可选）」与
  // 「这是第 4 个不同周期（禁止）」，只有数量不够判断。
  // The interval codes already in use. OperandPicker needs them to tell "already
  // in use, still selectable" from "this would be a 4th distinct interval,
  // blocked"; a bare count can't distinguish the two.
  intervalCodes: string[]
  depth: number
  // 哪一项已经到顶。null = 都没到顶，可以继续加条件。
  // Which limit is already reached; null means none, so more conditions fit.
  blocked: 'conditions' | 'indicatorInstances' | 'intervals' | null
}

// 一次遍历算出四项用量与「是否已经不能再加条件」。构建器每次渲染都要这份数据
// （禁用按钮、显示 3/12），分开算等于把同一棵树走四遍。
// One pass yielding all four usage counts plus "can another condition still be
// added". The builder needs this on every render (to disable buttons and show
// 3/12), and computing them separately would walk the same tree four times.
export function ruleUsage(envelope: RuleEnvelope): RuleUsage {
  const conditions = countConditions(envelope)
  const indicatorInstances = countIndicatorInstances(envelope)
  const intervalCodes = collectIntervals(envelope)
  const depth = Math.max(
    envelope.long ? groupDepth(envelope.long) : 0,
    envelope.short ? groupDepth(envelope.short) : 0
  )
  const blocked =
    conditions >= RULE_LIMITS.maxConditions
      ? 'conditions'
      : indicatorInstances >= RULE_LIMITS.maxIndicatorInstances
        ? 'indicatorInstances'
        : intervalCodes.length >= RULE_LIMITS.maxIntervals
          ? 'intervals'
          : null
  return { conditions, indicatorInstances, intervals: intervalCodes.length, intervalCodes, depth, blocked }
}

// 文案键映射：所有面向用户的字符串一律走 i18n，组件里不出现中文字面量。
// Label-key maps: every user-facing string goes through i18n; no literal
// Chinese in the components.
export const INDICATOR_LABEL_KEYS: Record<string, string> = {
  sma: 'strategy.indSma',
  ema: 'strategy.indEma',
  rsi: 'strategy.indRsi',
  atr: 'strategy.indAtr',
  macd_dif: 'strategy.indMacdDif',
  macd_dea: 'strategy.indMacdDea',
  boll_upper: 'strategy.indBollUpper',
  boll_middle: 'strategy.indBollMiddle',
  boll_lower: 'strategy.indBollLower',
  donchian_high: 'strategy.indDonchianHigh',
  donchian_low: 'strategy.indDonchianLow',
}

export const OP_LABEL_KEYS: Record<CompareOp, string> = {
  crosses_above: 'strategy.opCrossesAbove',
  crosses_below: 'strategy.opCrossesBelow',
  gt: 'strategy.opGt',
  lt: 'strategy.opLt',
  gte: 'strategy.opGte',
  lte: 'strategy.opLte',
}

export const PRICE_FIELD_LABEL_KEYS: Record<PriceField, string> = {
  open: 'strategy.priceOpen',
  high: 'strategy.priceHigh',
  low: 'strategy.priceLow',
  close: 'strategy.priceClose',
}

export const PARAM_LABEL_KEYS: Record<string, string> = {
  period: 'strategy.period',
  fastPeriod: 'strategy.fastPeriod',
  slowPeriod: 'strategy.slowPeriod',
  signalPeriod: 'strategy.signalPeriod',
  mult: 'strategy.bollMult',
}
