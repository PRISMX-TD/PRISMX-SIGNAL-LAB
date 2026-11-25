// 实例样式的合成：定义里的默认值 ← 实例覆盖项。引擎、图例、设置对话框共用，保证三处看到的颜色一致。
// Effective instance styles: definition defaults ← instance overrides. Shared by the engine,
// the legend and the settings dialog so all three agree on colours.
import type { CandleColors } from '../chartConfig'
import type { FillDef, HlineDef, IndDef, IndInstance, LineDash, PlotDef, PlotKind } from './types'

export interface EffPlot { visible: boolean; color: string; colors: string[]; opacity: number; width: number; dash: LineDash; kind: PlotKind }
export interface EffHline { visible: boolean; color: string; dash: LineDash; value: number; opacity: number }
export interface EffFill { visible: boolean; color: string; colorB: string; opacity: number }

export function plotStyle(inst: IndInstance, p: PlotDef): EffPlot {
  const s = inst.styles[p.key] ?? {}
  const colors = p.colors ? p.colors.map((c, i) => s.colors?.[i] ?? c) : []
  return {
    visible: s.visible ?? true,
    color: s.color ?? (p.colors ? colors[0] : p.color),
    colors,
    opacity: s.opacity ?? 100,
    width: s.width ?? p.width ?? 1,
    dash: s.dash ?? p.dash ?? 'solid',
    kind: s.kind ?? p.kind,
  }
}

export function hlineStyle(inst: IndInstance, h: HlineDef): EffHline {
  const s = inst.styles[`h:${h.key}`] ?? {}
  return { visible: s.visible ?? true, color: s.color ?? h.color, dash: s.dash ?? h.dash ?? 'dashed', value: s.value ?? h.value, opacity: s.opacity ?? 60 }
}

export function fillStyle(inst: IndInstance, f: FillDef): EffFill {
  const s = inst.styles[`f:${f.key}`] ?? {}
  return { visible: s.visible ?? true, color: s.color ?? f.color, colorB: s.colors?.[0] ?? f.colorB ?? f.color, opacity: s.opacity ?? f.opacity }
}

// 'up' / 'down' → K 线涨跌色；带透明度时转 rgba / 'up' / 'down' → candle colours; rgba when translucent
export function resolveColor(c: string, candle: CandleColors, opacity = 100): string {
  const hex = c === 'up' ? candle.up : c === 'down' ? candle.down : c
  if (opacity >= 100) return hex
  const m = /^#([0-9a-f]{6})$/i.exec(hex)
  if (!m) return hex
  const n = parseInt(m[1], 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${Math.max(0, opacity) / 100})`
}

// 图例标题里的参数：默认取数值 / 数据源 / 均线类型输入，按顺序空格分隔。
// The legend title's parameters: numeric / source / MA-type inputs in order, space separated.
export function instArgs(def: IndDef, inst: IndInstance, srcName: (v: string) => string): string {
  if (def.title) return def.title(inst.inputs)
  const parts: string[] = []
  for (const d of def.inputs) {
    const v = inst.inputs[d.key]
    if (d.key === 'offset' && v === 0) continue
    if (d.kind === 'int' || d.kind === 'float') parts.push(String(v))
    else if (d.kind === 'source') parts.push(srcName(String(v)))
    else if (d.kind === 'symbol') parts.push(String(v))
  }
  return parts.join(' ')
}
