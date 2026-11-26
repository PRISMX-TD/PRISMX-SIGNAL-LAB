// 多图之间的十字线 / 可见范围同步。每格图表就绪后登记进来；只有「领头」那一格（鼠标在它上面，
// 鼠标不在任何一格上时是当前格）的变化会推给其它格——别的格被动跟着动时触发的回调一律忽略，
// 不会来回弹。换算见 syncMath.ts。
// Crosshair / visible-range sync between the charts of a multi-chart layout. Each cell registers once
// its chart is ready; only the "driver" (the cell under the mouse, else the active cell) pushes changes
// to the others — callbacks fired by a follower being moved are ignored, so nothing ping-pongs. The
// maths is in syncMath.ts.
import type { IChartApi, ISeriesApi, LogicalRange, MouseEventParams, SeriesType, Time } from 'lightweight-charts'
import { isChartAlive } from '../chartLifecycle'
import { crosshairBar, mapLogicalRange } from './syncMath'

export interface SyncEntry {
  chart: IChartApi
  series: ISeriesApi<SeriesType>
  // 图上实际显示的 K 线时间（升序）/ times of the bars actually shown (ascending)
  barTimes: () => number[]
  symbol: () => string
  // 横轴不是时间的图（砖形、卡吉…）不参与 / charts whose x axis isn't time (Renko, Kagi…) opt out
  timeBased: () => boolean
  // 被动跟随时把状态行 / 指标图例换到第 k 根（null = 收起）；setCrosshairPosition 不会触发 crosshairMove
  // Show bar k in the status line / indicator legends while following (null = cleared); setCrosshairPosition fires no crosshairMove
  legendAt?: (k: number | null) => void
}

export interface SyncBus {
  register: (idx: number, e: SyncEntry) => () => void
  setHover: (idx: number | null) => void
  setActive: (idx: number) => void
  setFlags: (f: { crosshair: boolean; time: boolean }) => void
  // 把领头格（或指定格）的可见范围立刻推一次（打开时间同步、换网格后用）
  // Push the driver's (or a given cell's) visible range once (after enabling time sync or a grid change)
  pushRange: (from?: number) => void
}

export function createSyncBus(): SyncBus {
  const entries = new Map<number, SyncEntry>()
  let hover: number | null = null
  let active = 0
  let flags = { crosshair: false, time: false }
  const driver = () => (hover != null && entries.has(hover) ? hover : active)

  const clearOne = (e: SyncEntry) => {
    if (!isChartAlive(e.chart)) return
    try { e.chart.clearCrosshairPosition(); e.legendAt?.(null) } catch { /* 已销毁 / gone */ }
  }
  const clearOthers = (src: number) => {
    entries.forEach((e, i) => { if (i !== src) clearOne(e) })
  }

  const onCross = (src: number, p: MouseEventParams<Time>) => {
    if (!flags.crosshair || src !== hover) return
    const from = entries.get(src)
    if (!from) return
    if (p.time == null || p.point == null || !from.timeBased()) { clearOthers(src); return }
    const t = p.time as number
    const srcPrice = from.series.coordinateToPrice(p.point.y)
    entries.forEach((e, i) => {
      if (i === src || !isChartAlive(e.chart)) return
      try {
        if (!e.timeBased()) { clearOne(e); return }
        const times = e.barTimes()
        const k = crosshairBar(times, t)
        if (k < 0) { clearOne(e); return }
        // 同一品种：横线放在同一价位；不同品种：放在那根的收盘价（竖线才是重点）
        // Same symbol: the horizontal line at the same price; another symbol: that bar's close (the vertical line is what matters)
        let price: number | null = e.symbol() === from.symbol() && srcPrice != null ? Number(srcPrice) : null
        if (price == null) {
          const bar = e.series.dataByIndex(k) as { close?: number; value?: number } | null
          price = bar?.close ?? bar?.value ?? null
        }
        if (price == null) { clearOne(e); return }
        e.chart.setCrosshairPosition(price, times[k] as Time, e.series)
        e.legendAt?.(k)
      } catch { /* 切换中 / switching */ }
    })
  }

  const applyRange = (src: number, r: LogicalRange | null) => {
    if (!flags.time || r == null) return
    const from = entries.get(src)
    if (!from || !from.timeBased()) return
    const st = from.barTimes()
    entries.forEach((e, i) => {
      if (i === src || !isChartAlive(e.chart) || !e.timeBased()) return
      const m = mapLogicalRange(st, e.barTimes(), { from: r.from as number, to: r.to as number })
      if (!m) return
      try { e.chart.timeScale().setVisibleLogicalRange(m) } catch { /* 无数据 / no data */ }
    })
  }

  const onRange = (src: number, r: LogicalRange | null) => {
    if (src !== driver()) return
    applyRange(src, r)
  }

  return {
    register(idx, e) {
      entries.set(idx, e)
      const cross = (p: MouseEventParams<Time>) => onCross(idx, p)
      const range = (r: LogicalRange | null) => onRange(idx, r)
      e.chart.subscribeCrosshairMove(cross)
      e.chart.timeScale().subscribeVisibleLogicalRangeChange(range)
      return () => {
        if (entries.get(idx) === e) entries.delete(idx)
        if (!isChartAlive(e.chart)) return
        try {
          e.chart.unsubscribeCrosshairMove(cross)
          e.chart.timeScale().unsubscribeVisibleLogicalRangeChange(range)
        } catch { /* 已销毁 / gone */ }
      }
    },
    setHover(idx) {
      const was = hover
      hover = idx
      // 鼠标离开领头格：其它格的十字线一起收掉 / the mouse left the driver: clear the others' crosshairs
      if (idx == null && was != null && flags.crosshair) clearOthers(was)
    },
    setActive(idx) { active = idx },
    setFlags(f) {
      const turnedOnTime = f.time && !flags.time
      flags = { ...f }
      if (!f.crosshair) entries.forEach(clearOne)
      if (turnedOnTime) this.pushRange()
    },
    pushRange(fromIdx) {
      const src = fromIdx ?? driver()
      const e = entries.get(src)
      if (!e || !isChartAlive(e.chart)) return
      applyRange(src, e.chart.timeScale().getVisibleLogicalRange())
    },
  }
}
