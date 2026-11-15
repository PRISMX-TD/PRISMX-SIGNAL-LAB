// 指标图例的外部 store。十字准线每动一下都会产生一份新的图例数值，但真正要看
// 这份数值的只有 IndicatorLegends 一个组件。它以前是 useChartEngine 里的 useState，
// 而引擎挂在 ChartsPage 顶层，于是手指在图上拖一下，整个图表页（报价条、工具条、
// 自选、下单票、停靠区）跟着重渲染，一秒几十次。现在数值放在这里，只有订阅它的
// 图例重渲染；写入按 rAF 合并（一帧最多通知一次），和当前值逐项相同时不通知。
// External store for the indicator legend. The crosshair produces a new set of legend
// values on every move, but only IndicatorLegends reads them. As useState inside
// useChartEngine, which lives at ChartsPage's top level, every drag re-rendered the
// whole charts page (quote strip, toolbar, watchlist, ticket, dock) dozens of times a
// second. Writes are coalesced to one notify per animation frame, and a value equal
// to the current one notifies nobody.
import { useSyncExternalStore } from 'react'
import { EMPTY_LEGEND, type LegendValues } from './chartConfig'

export interface LegendStore {
  get: () => LegendValues
  set: (next: LegendValues) => void
  subscribe: (cb: () => void) => () => void
  /** 取消还没执行的那一帧；图表销毁时调用 / cancel a pending frame; call on chart teardown */
  dispose: () => void
}

/** 两份图例数值是否逐项相同（两层：指标 id → 线 key → 数值）。/ Two-level value equality. */
export function legendEqual(a: LegendValues, b: LegendValues): boolean {
  if (a === b) return true
  const ids = Object.keys(a) as (keyof LegendValues)[]
  if (ids.length !== Object.keys(b).length) return false
  for (const id of ids) {
    const ra = a[id]
    const rb = b[id]
    if (ra === rb) continue
    if (!ra || !rb) return false
    const keys = Object.keys(ra)
    if (keys.length !== Object.keys(rb).length) return false
    for (const k of keys) if (ra[k] !== rb[k]) return false
  }
  return true
}

type Schedule = (cb: () => void) => number
type Cancel = (id: number) => void

// schedule / cancel 可注入：单测在 node 环境里没有 requestAnimationFrame。
// schedule / cancel are injectable: unit tests run in node, where there is no requestAnimationFrame.
export function createLegendStore(
  schedule: Schedule = (cb) => window.requestAnimationFrame(cb),
  cancel: Cancel = (id) => window.cancelAnimationFrame(id),
): LegendStore {
  let value: LegendValues = EMPTY_LEGEND
  let pending: LegendValues | null = null
  let frame = 0
  const subs = new Set<() => void>()
  const flush = () => {
    frame = 0
    const next = pending
    pending = null
    if (next == null || legendEqual(value, next)) return
    value = next
    subs.forEach((fn) => fn())
  }
  return {
    get: () => value,
    set: (next) => {
      pending = next
      if (frame === 0) frame = schedule(flush)
    },
    subscribe: (cb) => {
      subs.add(cb)
      return () => { subs.delete(cb) }
    },
    dispose: () => {
      if (frame !== 0) cancel(frame)
      frame = 0
      pending = null
    },
  }
}

/** 订阅图例数值：只有调用它的组件会随十字准线重渲染。/ Subscribe; only the caller re-renders. */
export function useLegend(store: LegendStore): LegendValues {
  return useSyncExternalStore(store.subscribe, store.get, store.get)
}
