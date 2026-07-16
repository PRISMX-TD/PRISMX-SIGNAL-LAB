// 指标参数（周期/颜色等）的类型、默认值与合并逻辑。独立成文件是因为
// ChartsPage.tsx 和 IndicatorSettingsModal.tsx 都要用，避免互相 import 页面组件。
// Indicator parameter (periods/colors/etc.) types, defaults, and merge logic.
// Split into its own file because both ChartsPage.tsx and
// IndicatorSettingsModal.tsx need it, avoiding a page-component importing
// another page-component.
export interface IndicatorSettings {
  ma: { periods: [number, number, number]; colors: [string, string, string] }
  ema: { periods: [number, number]; colors: [string, string] }
  boll: { period: number; mult: number; color: string }
  volume: { upColor: string; downColor: string }
  rsi: { period: number; color: string; overbought: number; oversold: number }
  macd: { fast: number; slow: number; signal: number; macdColor: string; signalColor: string }
}

export const DEFAULT_INDICATOR_SETTINGS: IndicatorSettings = {
  ma: { periods: [7, 25, 99], colors: ['#f5c451', '#a78bfa', '#22d3ee'] },
  ema: { periods: [12, 26], colors: ['#38bdf8', '#fb7185'] },
  boll: { period: 20, mult: 2, color: '#a78bfa' },
  volume: { upColor: '#2ee07e', downColor: '#ff4d67' },
  rsi: { period: 14, color: '#facc15', overbought: 70, oversold: 30 },
  macd: { fast: 12, slow: 26, signal: 9, macdColor: '#38bdf8', signalColor: '#fb7185' },
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
    ma: { ...base.ma, ...partial.ma },
    ema: { ...base.ema, ...partial.ema },
    boll: { ...base.boll, ...partial.boll },
    volume: { ...base.volume, ...partial.volume },
    rsi: { ...base.rsi, ...partial.rsi },
    macd: { ...base.macd, ...partial.macd },
  }
}
