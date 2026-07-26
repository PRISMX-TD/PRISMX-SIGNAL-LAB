// 条件列表的前端类型：一份配置 = 品种 + 周期 + 逻辑 + 若干条件，每条条件是
// (indicator, usage, params) 三元组。空头侧不在这里出现——后端按每个用法登记的
// 镜像用法实时推出，UI 只编辑做多方向。
//
// 这里刻意不放指标清单、参数范围、用法枚举：那些全部来自
// GET /strategies/usages。前端曾经手抄过一份副本，结果是加一个用法要改两处，
// 漏改的那次表现为「界面允许填、保存却 400」。类型描述形状，数值由后端下发。
//
// Frontend types for the condition list: one payload = symbol + interval +
// logic + conditions, each condition an (indicator, usage, params) triple. The
// short side never appears here — the backend derives it from each usage's
// registered mirror, and the UI only edits the long direction.
//
// Deliberately absent: the indicator catalogue, param ranges and usage enums.
// Those all come from GET /strategies/usages. The frontend used to keep a hand
// written copy, which meant adding a usage took two edits, and the edit that
// got missed showed up as "the form accepted it, the save 400'd". Types
// describe shape here; the numbers come from the backend.

export type ConditionLogic = 'AND' | 'OR'

// 参数值只有这三种：枚举是字符串（如 maType: 'EMA'），int / float 都是 number。
// Param values come in exactly these: enums are strings (e.g. maType: 'EMA'),
// int and float are both numbers.
export type ParamValue = string | number

export interface StrategyCondition {
  indicator: string
  usage: string
  params: Record<string, ParamValue>
}

export interface ConditionPayload {
  logic: ConditionLogic
  symbol: string
  interval: string
  conditions: StrategyCondition[]
}

// ---------- GET /strategies/usages 的响应 / the usages catalogue ----------

export interface UsageParamSpec {
  kind: 'int' | 'float' | 'enum'
  default: ParamValue
  // enum 的 min/max 为 null，int/float 的 options 为 null——两者互斥，由 kind 决定
  // 该读哪一组。
  // min/max are null for enums and options is null for int/float — mutually
  // exclusive, with `kind` telling you which pair to read.
  min: number | null
  max: number | null
  options: string[] | null
}

export interface UsageSpec {
  key: string
  // 该用法在做空方向对应的用法；null 表示无方向性（ATR 的波动条件），多空共用
  // 同一判定。UI 需要据此提示「此条件多空通用」。
  // The usage this one maps to on the short side; null means non-directional
  // (ATR's volatility conditions), where both sides share one verdict. The UI
  // labels those "applies to both directions".
  mirror: string | null
  params: Record<string, UsageParamSpec>
}

export interface IndicatorSpec {
  key: string
  usages: UsageSpec[]
}

export interface UsageCatalog {
  intervals: string[]
  maxConditions: number
  indicators: IndicatorSpec[]
}

// ---------- 展示用文案键 / i18n keys for display ----------

// 指标与用法的文案键都是「前缀 + 后端 key」的机械映射，故按规则拼而不是逐条列
// 表：新增用法时后端加一行、i18n 加一条，这里不需要改。
// Indicator and usage label keys are a mechanical "prefix + backend key" map, so
// they're derived rather than enumerated: a new usage needs a backend line and
// an i18n entry, and nothing here.
export const indicatorLabelKey = (indicator: string) => `strategy.ind.${indicator}`

export const usageLabelKey = (usage: string) => `strategy.usage.${usage}`

export const paramLabelKey = (param: string) => `strategy.param.${param}`

// 周期标签不走 i18n：'15' → 15m 这种记号在中英文里写法相同，做成文案键只会多出
// 十二条永远一样的条目。目录下发的是原始 code，未知 code 原样显示而不是留空。
// Interval labels bypass i18n: notation like '15' → 15m is identical in every
// locale, and keys for it would only add a dozen entries that never differ. The
// catalogue ships raw codes; an unknown one is shown as-is rather than blank.
export const INTERVAL_LABELS: Record<string, string> = {
  '1': '1m',
  '5': '5m',
  '15': '15m',
  '60': '1H',
  '240': '4H',
  D: '1D',
}

export const intervalLabel = (code: string) => INTERVAL_LABELS[code] ?? code

// 参数值域缺失时的兜底，仅用于 number 输入的 clamp。后端对每个 int/float 参数
// 都给了 min/max，走到兜底说明目录有缺漏，此时放行由后端校验兜底比拒绝输入好。
// Fallback bounds for clamping number inputs. The backend supplies min/max for
// every int/float param, so hitting the fallback means the catalogue is
// incomplete — better to pass it through and let the backend validate than to
// block typing.
export const clampParam = (value: number, spec: UsageParamSpec): number => {
  const lo = spec.min ?? Number.NEGATIVE_INFINITY
  const hi = spec.max ?? Number.POSITIVE_INFINITY
  if (Number.isNaN(value)) return typeof spec.default === 'number' ? spec.default : lo
  return Math.min(hi, Math.max(lo, value))
}

// 用后端下发的默认值组装一条新条件的参数。
// Build a new condition's params from the backend-provided defaults.
export const defaultParams = (usage: UsageSpec): Record<string, ParamValue> =>
  Object.fromEntries(Object.entries(usage.params).map(([name, spec]) => [name, spec.default]))
