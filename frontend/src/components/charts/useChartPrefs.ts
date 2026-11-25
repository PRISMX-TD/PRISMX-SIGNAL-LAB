// chartv2 偏好的读写：直接从全站 prefs 派生（别的设备经 WS 推来的改动立刻生效），
// 写的时候整份替换 chartv2 / prefs 一个键，prefs store 负责防抖落库。
// Read/write the chartv2 prefs, derived straight from the app-wide prefs store (changes
// pushed from another device over WS apply at once); writes replace the single
// chartv2 / prefs key and the store debounces the save.
import { useCallback, useMemo, useRef } from 'react'
import { usePrefs } from '../../store/prefs'
import { DEFAULT_CHART_PREFS, normalizeChartPrefs, type ChartPrefs } from './chartPrefs'
import { isValidInterval } from './intervals'

export const CHART_PREFS_NS = 'chartv2'
export const CHART_PREFS_KEY = 'prefs'

export type ChartPrefsUpdate = Partial<ChartPrefs> | ((p: ChartPrefs) => ChartPrefs)

export function useChartPrefs(): [ChartPrefs, (u: ChartPrefsUpdate) => void, () => void] {
  const { getPref, setPref } = usePrefs()
  const raw = getPref<unknown>(CHART_PREFS_NS, CHART_PREFS_KEY, null)
  const prefs = useMemo(() => normalizeChartPrefs(raw, isValidInterval), [raw])
  const ref = useRef(prefs)
  ref.current = prefs
  const update = useCallback((u: ChartPrefsUpdate) => {
    const next = typeof u === 'function' ? u(ref.current) : { ...ref.current, ...u }
    ref.current = next
    setPref(CHART_PREFS_NS, CHART_PREFS_KEY, next)
  }, [setPref])
  // 恢复默认：保留周期、收藏和模板（那些不算「外观」）。
  // Reset to defaults, keeping the interval, favourites and templates (not "look").
  const reset = useCallback(() => {
    const cur = ref.current
    update({ ...DEFAULT_CHART_PREFS, interval: cur.interval, favIntervals: cur.favIntervals, templates: cur.templates, timezone: cur.timezone })
  }, [update])
  return [prefs, update, reset]
}
