// 自选表的用户分组（TradingView 的自选列表分组）：用户自己建的命名分组，每组一串品种。
// 存在云端偏好 chartv2 / wlGroups（[{id, name, symbols}]），跨设备同步；不动 chartv2 的其它键。
// 读回一律过 normalizeWlGroups：坏数据丢掉、名字截断、去重、数量封顶。
// User groups in the watchlist (TradingView's watchlist sections): named groups of symbols the
// user creates. Stored in the cloud prefs under chartv2 / wlGroups ([{id, name, symbols}]), synced
// across devices, leaving the other chartv2 keys alone. Every read goes through
// normalizeWlGroups: bad entries dropped, names trimmed, duplicates removed, counts capped.
import { useCallback, useMemo, useRef } from 'react'
import { usePrefs } from '../../../store/prefs'
import { CHART_PREFS_NS } from '../useChartPrefs'

export const WL_GROUPS_KEY = 'wlGroups'
export const MAX_GROUPS = 20
export const MAX_GROUP_SYMBOLS = 200
export const MAX_GROUP_NAME = 24

export interface WlGroup { id: string; name: string; symbols: string[] }

export type WlGroupsAction =
  | { type: 'create'; id: string; name: string; symbols?: string[] }
  | { type: 'rename'; id: string; name: string }
  | { type: 'delete'; id: string }
  | { type: 'add'; id: string; symbol: string }
  | { type: 'remove'; id: string; symbol: string }
  | { type: 'toggle'; id: string; symbol: string }

const cleanName = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, MAX_GROUP_NAME)
const uniq = (xs: string[]) => [...new Set(xs)]

export function normalizeWlGroups(raw: unknown): WlGroup[] {
  if (!Array.isArray(raw)) return []
  const out: WlGroup[] = []
  const ids = new Set<string>()
  for (const g of raw) {
    if (!g || typeof g !== 'object') continue
    const r = g as Record<string, unknown>
    if (typeof r.id !== 'string' || !r.id || ids.has(r.id) || typeof r.name !== 'string') continue
    const name = cleanName(r.name)
    if (!name) continue
    const symbols = Array.isArray(r.symbols) ? uniq(r.symbols.filter((s): s is string => typeof s === 'string' && s.length > 0 && s.length <= 32)).slice(0, MAX_GROUP_SYMBOLS) : []
    ids.add(r.id)
    out.push({ id: r.id, name, symbols })
    if (out.length >= MAX_GROUPS) break
  }
  return out
}

/** 分组的纯 reducer；无效操作原样返回同一个数组 / pure reducer; a no-op returns the same array */
export function wlGroupsReducer(state: WlGroup[], a: WlGroupsAction): WlGroup[] {
  const at = state.findIndex((g) => g.id === a.id)
  const put = (g: WlGroup) => state.map((x, i) => (i === at ? g : x))
  switch (a.type) {
    case 'create': {
      const name = cleanName(a.name)
      if (!name || at >= 0 || state.length >= MAX_GROUPS) return state
      return [...state, { id: a.id, name, symbols: uniq(a.symbols ?? []).slice(0, MAX_GROUP_SYMBOLS) }]
    }
    case 'rename': {
      const name = cleanName(a.name)
      if (at < 0 || !name || state[at].name === name) return state
      return put({ ...state[at], name })
    }
    case 'delete':
      return at < 0 ? state : state.filter((g) => g.id !== a.id)
    case 'add': {
      if (at < 0 || state[at].symbols.includes(a.symbol) || state[at].symbols.length >= MAX_GROUP_SYMBOLS) return state
      return put({ ...state[at], symbols: [...state[at].symbols, a.symbol] })
    }
    case 'remove': {
      if (at < 0 || !state[at].symbols.includes(a.symbol)) return state
      return put({ ...state[at], symbols: state[at].symbols.filter((s) => s !== a.symbol) })
    }
    case 'toggle':
      if (at < 0) return state
      return wlGroupsReducer(state, { ...a, type: state[at].symbols.includes(a.symbol) ? 'remove' : 'add' })
  }
}

export const newGroupId = () => `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

/** 读写用户分组；连点时从 ref 取最新一份再改（同 useFavoriteSymbols）。
 *  Read / write the groups; quick successive edits apply on the latest copy via a ref (like useFavoriteSymbols). */
export function useWlGroups(): [WlGroup[], (a: WlGroupsAction) => void] {
  const { getPref, setPref } = usePrefs()
  const raw = getPref<unknown>(CHART_PREFS_NS, WL_GROUPS_KEY, [])
  const groups = useMemo(() => normalizeWlGroups(raw), [raw])
  const ref = useRef(groups)
  ref.current = groups
  const dispatch = useCallback((a: WlGroupsAction) => {
    const next = wlGroupsReducer(ref.current, a)
    if (next === ref.current) return
    ref.current = next
    setPref(CHART_PREFS_NS, WL_GROUPS_KEY, next)
  }, [setPref])
  return [groups, dispatch]
}
