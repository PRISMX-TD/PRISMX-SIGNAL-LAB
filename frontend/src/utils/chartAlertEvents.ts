// 图表警报的 WS 事件（后端 rev 56）转成 window 事件：store/live.tsx 收到后派发，警报 store 与
// 图表页自己订阅。CHART_ALERTS_UPDATE 不带内容（重拉列表）；CHART_ALERT_FIRED 带触发详情（弹提示、闪线）。
// Chart alert WS events (backend rev 56) re-dispatched as window events by store/live.tsx; the
// alert store and the chart page subscribe. CHART_ALERTS_UPDATE carries nothing (refetch);
// CHART_ALERT_FIRED carries the fire (toast, flash the line).
import type { ChartAlertFired } from '../api/types'

export const CHART_ALERTS_UPDATE_EVENT = 'prismx:chart-alerts-update'
export const CHART_ALERT_FIRED_EVENT = 'prismx:chart-alert-fired'

export function emitChartAlertsUpdate(): void {
  window.dispatchEvent(new CustomEvent(CHART_ALERTS_UPDATE_EVENT))
}

export function emitChartAlertFired(detail: ChartAlertFired): void {
  window.dispatchEvent(new CustomEvent<ChartAlertFired>(CHART_ALERT_FIRED_EVENT, { detail }))
}

export function onChartAlertsUpdate(cb: () => void): () => void {
  window.addEventListener(CHART_ALERTS_UPDATE_EVENT, cb)
  return () => window.removeEventListener(CHART_ALERTS_UPDATE_EVENT, cb)
}

export function onChartAlertFired(cb: (d: ChartAlertFired) => void): () => void {
  const h = (ev: Event) => {
    const d = (ev as CustomEvent<ChartAlertFired>).detail
    if (d && typeof d.id === 'string') cb(d)
  }
  window.addEventListener(CHART_ALERT_FIRED_EVENT, h)
  return () => window.removeEventListener(CHART_ALERT_FIRED_EVENT, h)
}
