// 指标布局的读写：从全站 prefs 派生（别的设备改了经 WS 推来立刻生效）。新键为空时按旧开关迁移出
// 一份（uid 固定，渲染之间稳定）；用户第一次改动才整份写进 chartv2 / ind。
// Read/write the indicator layout, derived from the app-wide prefs (another device's edits arrive
// over WS). While the new key is empty, a layout is migrated from the legacy toggles (fixed uids,
// stable between renders); the first user edit writes the whole thing to chartv2 / ind.
import { useCallback, useMemo, useRef } from 'react'
import { usePrefs } from '../../../store/prefs'
import { IND_KEY, IND_NS, migrateLegacy, normalizeLayout } from './store'
import type { IndLayout } from './types'

export type IndLayoutUpdate = (l: IndLayout) => IndLayout

export function useIndLayout(): [IndLayout, (u: IndLayoutUpdate) => void] {
  const { getPref, setPref } = usePrefs()
  const raw = getPref<unknown>(IND_NS, IND_KEY, null)
  const legacyFlags = getPref<unknown>('charts', 'indicators', null)
  const legacySettings = getPref<unknown>('charts', 'indicatorSettings', null)
  const layout = useMemo(
    () => (raw ? normalizeLayout(raw) : migrateLegacy(legacyFlags, legacySettings)),
    [raw, legacyFlags, legacySettings],
  )
  const ref = useRef(layout)
  ref.current = layout
  const update = useCallback((u: IndLayoutUpdate) => {
    const next = u(ref.current)
    if (next === ref.current) return
    ref.current = next
    setPref(IND_NS, IND_KEY, next)
  }, [setPref])
  return [layout, update]
}
