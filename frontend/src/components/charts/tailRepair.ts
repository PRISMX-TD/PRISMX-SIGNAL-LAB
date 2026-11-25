// K 线尾部自愈：本地凭报价先开出来的 bar 与服务器对不上时，怎么发现、怎么纠正。
// 2026-11-25 用户截图：图表最右侧一段 K 线变成一排同价的小横线，手动刷新才恢复。成因：
// 页面在后台时全站报价不再更新（live.tsx 丢弃后台的 GLOBAL_QUOTES），可页面仍会重渲染，
// LiveBarSync 的 effect 跟着重跑，每过一个 K 线边界就拿那个**过期的** bid 开一根新 bar——
// 开盘价 = 上一根收盘 = 同一个过期 bid，于是 o=h=l=c，一排横线。回到前台后轮询只拿最新两根，
// 缺口检测又拿「本地最后一根」比，被这排假 bar 骗过；更早那几根即使被轮询纠正了也只写进
// candlesRef，图上不重画。这里放两个纯函数，供 useChartData 判断「要不要重拉尾部」与
// 「要不要整段重画」。
// Self-healing chart tail: detecting and correcting bars the client opened from quotes that the
// server never confirmed. 2026-11-25 user report: the right edge turned into a row of flat dashes
// at one price until a manual refresh. Cause: while the page is hidden the site-wide quotes stop
// updating (live.tsx drops background GLOBAL_QUOTES), yet the page still re-renders, so
// LiveBarSync's effect re-ran and opened a new bar at each boundary from the *stale* bid — open =
// previous close = the same stale bid, hence o=h=l=c. Back in the foreground the poll only fetches
// the newest two bars, the hole check compared against the local last bar (fooled by the fakes),
// and corrected older bars only reached candlesRef, never the chart. Two pure helpers here let
// useChartData decide "refill the tail?" and "repaint everything?".
import type { Candle } from '../../api/types'

// 服务器确认过的最新 bar 时间之后，响应最早那根还隔着整根以上：中间有本地补不上的洞。
// 用「服务器确认过的」而不是「本地最后一根」比较：本地凭报价开的 bar 不算数。
// A whole bar or more between the newest server-confirmed bar and the response's first bar: a
// hole the poll can't fill. Compared against server-confirmed time, not the local last bar, so
// bars opened locally from quotes don't count.
export function tailHasHole(serverLastT: number, firstRespT: number | undefined, spacing: number | null): boolean {
  if (spacing == null || !(serverLastT > 0) || firstRespT == null) return false
  return firstRespT > serverLastT + spacing
}

// 响应里比本地最后一根更早的 bar，是否与本地那根不同（或本地根本没有）。是的话图上画的
// 已经不对，需要整段重画——lightweight-charts 的 update() 改不了更早的 bar。
// Whether any response bar older than the local last bar differs from the local copy (or is
// missing locally). If so the chart shows stale bars and needs a full repaint — update() can't
// touch earlier bars.
export function olderBarsChanged(local: readonly Candle[], resp: readonly Candle[], lastT: number): boolean {
  for (const b of resp) {
    if (b.t >= lastT) continue
    let found: Candle | undefined
    // 从尾部往前找：响应只有最近几根。/ Scan back from the tail: the response is only the newest few.
    for (let i = local.length - 1; i >= 0; i--) {
      const x = local[i]
      if (x.t === b.t) { found = x; break }
      if (x.t < b.t) break
    }
    if (!found || found.o !== b.o || found.h !== b.h || found.l !== b.l || found.c !== b.c) return true
  }
  return false
}
