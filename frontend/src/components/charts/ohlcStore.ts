// 主图图例（OHLC 行）的外部 store：十字线一秒改几十次，不能走页面 state（理由同 legendStore）。
// External store for the main legend's OHLC row: the crosshair changes it dozens of times a
// second, so it can't be page state (same reasoning as legendStore).
import { useSyncExternalStore } from 'react'

export interface OhlcRow {
  t: number
  o: number
  h: number
  l: number
  c: number
  v: number
  // 上一根收盘，算涨跌用；没有则用本根开盘 / previous close for the change; open when absent
  prev: number | null
  hovering: boolean
}

export interface OhlcStore {
  get: () => OhlcRow | null
  set: (r: OhlcRow | null) => void
  subscribe: (fn: () => void) => () => void
}

export function createOhlcStore(): OhlcStore {
  let value: OhlcRow | null = null
  const subs = new Set<() => void>()
  return {
    get: () => value,
    set: (r) => {
      if (r === value) return
      if (r && value && r.t === value.t && r.o === value.o && r.h === value.h && r.l === value.l && r.c === value.c && r.v === value.v && r.prev === value.prev && r.hovering === value.hovering) return
      value = r
      subs.forEach((fn) => fn())
    },
    subscribe: (fn) => {
      subs.add(fn)
      return () => { subs.delete(fn) }
    },
  }
}

export function useOhlc(store: OhlcStore): OhlcRow | null {
  return useSyncExternalStore(store.subscribe, store.get, store.get)
}
