// 指标参数（周期/颜色等）的类型、默认值与合并逻辑。独立成文件是因为
// ChartsPage.tsx 和 IndicatorSettingsModal.tsx 都要用，避免互相 import 页面组件。
// Indicator parameter (periods/colors/etc.) types, defaults, and merge logic.
// Split into its own file because both ChartsPage.tsx and
// IndicatorSettingsModal.tsx need it, avoiding a page-component importing
// another page-component.

// MA/EMA 是变长的均线列表（用户可加/删条数），周期与颜色按下标一一对应。
// MA/EMA are variable-length lists of lines (the user can add/remove lines);
// periods and colors correspond by index.
export interface LinesConfig {
  periods: number[]
  colors: string[]
}

export interface IndicatorSettings {
  ma: LinesConfig
  ema: LinesConfig
  boll: { period: number; mult: number; color: string }
  volume: { upColor: string; downColor: string }
  rsi: { period: number; color: string; overbought: number; oversold: number }
  macd: { fast: number; slow: number; signal: number; macdColor: string; signalColor: string }
}

// 颜色预设：不给原生 RGB 取色器，只给一小把跟站内配色协调的备选色，点选即可。
// Color presets: no native RGB picker — just a small palette that matches the
// site's existing palette, pick with one click.
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
// Line-count bounds: at least one (otherwise the toggle is on but nothing
// draws, which reads as broken); the upper bound is just to keep the list
// from growing unbounded, not a technical limit.
export const MIN_LINES = 1
export const MAX_LINES = 6

export const DEFAULT_INDICATOR_SETTINGS: IndicatorSettings = {
  ma: { periods: [7, 25, 99], colors: ['#f5c451', '#a78bfa', '#22d3ee'] },
  ema: { periods: [12, 26], colors: ['#38bdf8', '#fb7185'] },
  boll: { period: 20, mult: 2, color: '#a78bfa' },
  volume: { upColor: '#2ee07e', downColor: '#ff4d67' },
  rsi: { period: 14, color: '#facc15', overbought: 70, oversold: 30 },
  macd: { fast: 12, slow: 26, signal: 9, macdColor: '#38bdf8', signalColor: '#fb7185' },
}

// 加一条均线：周期取最后一条 +10（凑个还算合理的默认值），颜色从预设色板
// 按当前条数循环取，尽量避免和已有线撞色。
// Add a line: period defaults to the last one + 10 (a reasonably sensible
// guess), color cycles through the preset palette by current count, trying
// to avoid clashing with existing lines.
export function addLine(cfg: LinesConfig): LinesConfig {
  if (cfg.periods.length >= MAX_LINES) return cfg
  const lastPeriod = cfg.periods[cfg.periods.length - 1] ?? 10
  const color = COLOR_PRESETS[cfg.colors.length % COLOR_PRESETS.length]
  return { periods: [...cfg.periods, lastPeriod + 10], colors: [...cfg.colors, color] }
}

export function removeLine(cfg: LinesConfig, index: number): LinesConfig {
  if (cfg.periods.length <= MIN_LINES) return cfg
  return {
    periods: cfg.periods.filter((_, i) => i !== index),
    colors: cfg.colors.filter((_, i) => i !== index),
  }
}

// 按子对象逐个合并（而非整份替换），这样云端存的旧数据缺某个新增字段时
// （比如以后又加了一个指标）能自动回填默认值，不会整段变成 undefined。
// Merge per sub-object (rather than a wholesale replace) so an older saved
// cloud document missing a newly-added field (e.g. a future new indicator)
// falls back to its default instead of the whole thing turning undefined.
export function mergeIndicatorSettings(
  base: IndicatorSettings,
  partial: Partial<IndicatorSettings> | null | undefined
): IndicatorSettings {
  if (!partial) return base
  return {
    ma: partial.ma && partial.ma.periods?.length ? { ...base.ma, ...partial.ma } : base.ma,
    ema: partial.ema && partial.ema.periods?.length ? { ...base.ema, ...partial.ema } : base.ema,
    boll: { ...base.boll, ...partial.boll },
    volume: { ...base.volume, ...partial.volume },
    rsi: { ...base.rsi, ...partial.rsi },
    macd: { ...base.macd, ...partial.macd },
  }
}
