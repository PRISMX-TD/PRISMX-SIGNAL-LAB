// 指标参数（周期 / 颜色 / 线宽线型 / 副图高度）的类型、默认值与合并逻辑。独立成
// 文件是因为 ChartsPage、IndicatorSettingsModal、useChartEngine、indicatorCatalog
// 都要用，避免互相 import 组件。
// 2026-09-08 指标库从 6 个扩到 14 个，并给每个指标加了线宽 / 线型（副图再加高度档）。
// Indicator parameter types, defaults and merge logic. Own file because the
// page, the modal, the engine and the catalog all import it. 2026-09-08: the
// library grew from 6 to 14 indicators, each with line width / style (sub-panes
// also get a height step).

// MA/EMA 是变长的均线列表（用户可加/删条数），周期与颜色按下标一一对应。
// MA/EMA are variable-length lists of lines; periods and colors correspond by index.
export interface LinesConfig {
  periods: number[]
  colors: string[]
}

// lightweight-charts 的 lineWidth 只接受整数像素 / lineWidth is integer pixels in lightweight-charts
export type LineWidth = 1 | 2 | 3
export type LineDash = 'solid' | 'dashed'
export type PaneSize = 'sm' | 'md' | 'lg'
export interface LineStyleCfg {
  width: LineWidth
  dash: LineDash
}
export interface SubPaneCfg {
  size: PaneSize
}

export interface IndicatorSettings {
  ma: LinesConfig & LineStyleCfg
  ema: LinesConfig & LineStyleCfg
  boll: { period: number; mult: number; color: string } & LineStyleCfg
  donch: { period: number; color: string } & LineStyleCfg
  vwap: { color: string } & LineStyleCfg
  st: { period: number; mult: number; upColor: string; downColor: string } & LineStyleCfg
  sar: { step: number; max: number; color: string }
  volume: { upColor: string; downColor: string } & SubPaneCfg
  obv: { color: string } & LineStyleCfg & SubPaneCfg
  rsi: { period: number; color: string; overbought: number; oversold: number } & LineStyleCfg & SubPaneCfg
  macd: { fast: number; slow: number; signal: number; macdColor: string; signalColor: string } & LineStyleCfg & SubPaneCfg
  kdj: { period: number; kSmooth: number; dSmooth: number; kColor: string; dColor: string; jColor: string } & LineStyleCfg & SubPaneCfg
  cci: { period: number; color: string } & LineStyleCfg & SubPaneCfg
  wr: { period: number; color: string } & LineStyleCfg & SubPaneCfg
  atr: { period: number; color: string } & LineStyleCfg & SubPaneCfg
}

// 颜色预设：不给原生 RGB 取色器，只给一小把跟站内配色协调的备选色，点选即可。
// Color presets: no native RGB picker — a small palette matching the site.
export const COLOR_PRESETS = [
  '#f5c451', // amber
  '#a78bfa', // purple
  '#22d3ee', // cyan
  '#38bdf8', // sky
  '#fb7185', // rose
  '#2ee07e', // green (up)
  '#ff4d67', // red (down)
  '#facc15', // yellow
  '#f472b6', // pink
  '#94a3b8', // slate
]

// 均线条数上下限：至少留一条（否则开关开着却什么都不画，容易让人以为坏了），
// 上限只是防止列表失控变长，不是技术限制。
// Line-count bounds: at least one (a toggle that draws nothing reads as broken);
// the upper bound just keeps the list from growing unbounded.
export const MIN_LINES = 1
export const MAX_LINES = 6

const LINE: LineStyleCfg = { width: 1, dash: 'solid' }
const SUB: SubPaneCfg = { size: 'md' }

export const DEFAULT_INDICATOR_SETTINGS: IndicatorSettings = {
  ma: { periods: [7, 25, 99], colors: ['#f5c451', '#a78bfa', '#22d3ee'], ...LINE },
  ema: { periods: [12, 26], colors: ['#38bdf8', '#fb7185'], ...LINE },
  boll: { period: 20, mult: 2, color: '#a78bfa', ...LINE },
  donch: { period: 20, color: '#22d3ee', ...LINE },
  vwap: { color: '#ffa85c', ...LINE, width: 2 },
  st: { period: 10, mult: 3, upColor: '#2ee07e', downColor: '#ff4d67', ...LINE, width: 2 },
  sar: { step: 0.02, max: 0.2, color: '#94a3b8' },
  volume: { upColor: '#2ee07e', downColor: '#ff4d67', ...SUB },
  obv: { color: '#38bdf8', ...LINE, ...SUB },
  rsi: { period: 14, color: '#facc15', overbought: 70, oversold: 30, ...LINE, ...SUB },
  macd: { fast: 12, slow: 26, signal: 9, macdColor: '#38bdf8', signalColor: '#fb7185', ...LINE, ...SUB },
  kdj: { period: 9, kSmooth: 3, dSmooth: 3, kColor: '#f5c451', dColor: '#38bdf8', jColor: '#f472b6', ...LINE, ...SUB },
  cci: { period: 20, color: '#ffa85c', ...LINE, ...SUB },
  wr: { period: 14, color: '#22d3ee', ...LINE, ...SUB },
  atr: { period: 14, color: '#94a3b8', ...LINE, ...SUB },
}

// 加一条均线：周期取最后一条 +10（凑个还算合理的默认值），颜色从预设色板
// 按当前条数循环取，尽量避免和已有线撞色。
// Add a line: period = last + 10, color cycles through the palette by count.
export function addLine<T extends LinesConfig>(cfg: T): T {
  if (cfg.periods.length >= MAX_LINES) return cfg
  const lastPeriod = cfg.periods[cfg.periods.length - 1] ?? 10
  const color = COLOR_PRESETS[cfg.colors.length % COLOR_PRESETS.length]
  return { ...cfg, periods: [...cfg.periods, lastPeriod + 10], colors: [...cfg.colors, color] }
}

export function removeLine<T extends LinesConfig>(cfg: T, index: number): T {
  if (cfg.periods.length <= MIN_LINES) return cfg
  return {
    ...cfg,
    periods: cfg.periods.filter((_, i) => i !== index),
    colors: cfg.colors.filter((_, i) => i !== index),
  }
}

// 按子对象逐个合并（而非整份替换），这样云端存的旧数据缺某个新增字段时
// （比如这次新加的 8 个指标、线宽线型）能自动回填默认值，不会整段变成 undefined。
// Merge per sub-object so an older saved document missing new fields (the 8
// new indicators, line width/style) falls back to defaults field by field.
export function mergeIndicatorSettings(
  base: IndicatorSettings,
  partial: Partial<IndicatorSettings> | null | undefined
): IndicatorSettings {
  if (!partial) return base
  const out = { ...base } as Record<string, unknown>
  for (const key of Object.keys(base) as (keyof IndicatorSettings)[]) {
    const p = partial[key] as Record<string, unknown> | undefined
    if (!p || typeof p !== 'object') continue
    // 均线列表：周期与颜色必须成对且非空，否则整段用默认，免得 periods 有三条
    // colors 只有两条。/ Line lists: periods/colors must pair up and be non-empty.
    if (key === 'ma' || key === 'ema') {
      const periods = Array.isArray(p.periods) ? (p.periods as number[]) : null
      const colors = Array.isArray(p.colors) ? (p.colors as string[]) : null
      if (!periods || !periods.length || !colors || colors.length !== periods.length) {
        out[key] = { ...base[key], ...p, periods: base[key].periods, colors: base[key].colors }
        continue
      }
    }
    out[key] = { ...(base[key] as object), ...p }
  }
  return out as unknown as IndicatorSettings
}
