// 每种指标自己的模板：用户把一个指标的参数和样式存成有名字的模板，之后在设置框里一键套用。
// 单独存在 chartv2 / indPresets（跨设备同步），不放进 chartv2 / ind：旧版 App 读写 ind 时会把不认识的
// 字段丢掉，放在旁边的键里旧版碰不到。每种最多 30 个，同名覆盖。
// Per-indicator templates: the user saves one indicator's inputs and styles under a name and applies
// it from the settings dialog later. Stored on its own key chartv2 / indPresets (synced), not inside
// chartv2 / ind: older App bundles drop unknown fields when they rewrite ind, and they never touch a
// separate key. At most 30 per kind; saving an existing name overwrites it.
import { useCallback, useMemo, useRef } from 'react'
import { usePrefs } from '../../../store/prefs'
import { CHART_PREFS_NS } from '../useChartPrefs'
import { defOf } from './registry'
import { cleanInputs, cleanStyles } from './store'
import type { Inputs, PlotStyle } from './types'

export const IND_PRESETS_KEY = 'indPresets'
export const MAX_PRESETS = 30
export interface IndPreset { name: string; inputs: Inputs; styles: Record<string, PlotStyle> }
export type IndPresets = Record<string, IndPreset[]>

export function normalizePresets(raw: unknown): IndPresets {
  const out: IndPresets = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [type, list] of Object.entries(raw as Record<string, unknown>)) {
    if (!defOf(type) || !Array.isArray(list)) continue
    const seen = new Set<string>()
    const kept: IndPreset[] = []
    for (const x of list) {
      const r = x && typeof x === 'object' ? (x as Record<string, unknown>) : {}
      const name = typeof r.name === 'string' ? r.name.trim().slice(0, 40) : ''
      if (!name || seen.has(name)) continue
      seen.add(name)
      kept.push({ name, inputs: cleanInputs(type, r.inputs), styles: cleanStyles(r.styles) })
    }
    if (kept.length) out[type] = kept.slice(-MAX_PRESETS)
  }
  return out
}

// 存一个（同名覆盖，放到最后）/ save one (same name overwrites and moves to the end)
export function withPreset(all: IndPresets, type: string, p: IndPreset): IndPresets {
  const list = (all[type] ?? []).filter((x) => x.name !== p.name)
  return { ...all, [type]: [...list, p].slice(-MAX_PRESETS) }
}

export function withoutPreset(all: IndPresets, type: string, name: string): IndPresets {
  const list = (all[type] ?? []).filter((x) => x.name !== name)
  const next = { ...all }
  if (list.length) next[type] = list
  else delete next[type]
  return next
}

export function useIndPresets(type: string): { list: IndPreset[]; save: (p: IndPreset) => void; remove: (name: string) => void } {
  const { getPref, setPref } = usePrefs()
  const raw = getPref<unknown>(CHART_PREFS_NS, IND_PRESETS_KEY, null)
  const all = useMemo(() => normalizePresets(raw), [raw])
  const ref = useRef(all)
  ref.current = all
  const save = useCallback((p: IndPreset) => {
    const name = p.name.trim().slice(0, 40)
    if (!name) return
    const next = withPreset(ref.current, type, { ...p, name })
    ref.current = next
    setPref(CHART_PREFS_NS, IND_PRESETS_KEY, next)
  }, [setPref, type])
  const remove = useCallback((name: string) => {
    const next = withoutPreset(ref.current, type, name)
    ref.current = next
    setPref(CHART_PREFS_NS, IND_PRESETS_KEY, next)
  }, [setPref, type])
  return { list: all[type] ?? [], save, remove }
}
