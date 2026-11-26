// 数据窗口的纯函数：K 线涨跌、指标行（名字 + 各条线的值与颜色）。单测直接跑。
// Pure helpers for the data window: bar change, indicator rows (name + each plot's value and colour).
import type { CandleColors, LegendValues } from '../chartConfig'
import type { OhlcRow } from '../ohlcStore'
import { plotStyle, resolveColor } from '../ind/style'
import type { IndDef, IndInstance } from '../ind/types'

/** 相对上一根收盘的涨跌（没有上一根就对本根开盘）/ change vs the previous close (or this bar's open) */
export function barChange(row: OhlcRow | null): { chg: number; pct: number | null } | null {
  if (!row) return null
  const base = row.prev ?? row.o
  if (!Number.isFinite(base) || !Number.isFinite(row.c)) return null
  const chg = row.c - base
  return { chg, pct: base ? (chg / base) * 100 : null }
}

export interface PlotRow { key: string; label: string; color: string; value: number | null }
export interface IndRow { uid: string; def: IndDef; inst: IndInstance; hidden: boolean; plots: PlotRow[] }

/** 每个指标实例一行；隐藏的实例只留名字。与图例同一套颜色规则（多色线按正负取色）。
 *  One row per instance; hidden instances keep just the name. Same colour rules as the legend
 *  (multi-colour plots tint by sign). */
export function indicatorRows(
  list: readonly IndInstance[],
  legend: LegendValues,
  candle: CandleColors,
  defOf: (type: string) => IndDef | undefined,
): IndRow[] {
  const out: IndRow[] = []
  for (const inst of list) {
    const def = defOf(inst.type)
    if (!def) continue
    const vals = legend[inst.uid] ?? {}
    const plots: PlotRow[] = []
    if (!inst.hidden) {
      for (const p of def.plots) {
        if (p.noLegend || p.shape) continue
        const st = plotStyle(inst, p)
        if (!st.visible) continue
        const v = vals[p.key] ?? null
        if (p.gaps && v == null) continue
        const color = p.colors
          ? resolveColor(v != null && v < 0 ? st.colors[st.colors.length - 1] : st.colors[0], candle)
          : resolveColor(st.color, candle)
        plots.push({ key: p.key, label: p.label, color, value: v })
      }
    }
    out.push({ uid: inst.uid, def, inst, hidden: !!inst.hidden, plots })
  }
  return out
}
