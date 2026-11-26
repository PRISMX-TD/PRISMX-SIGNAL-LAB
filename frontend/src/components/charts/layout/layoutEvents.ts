// 图表布局的跨设备同步事件（后端 rev 57）。后端每次写布局（新建 / 改 / 删）都给该用户的所有在线连接
// 推 WS CHART_LAYOUTS_UPDATE {id}（含发起的这台）；store/live.tsx 收到后转成 window 事件，
// 布局 hook 订阅它：重拉列表，当前布局被别处改了、本地又没有没存的改动时就套用远端那份。
// Cross-device sync event for chart layouts (backend rev 57). Every layout write (create / update /
// delete) pushes WS CHART_LAYOUTS_UPDATE {id} to all of the user's connections (the writer included);
// store/live.tsx re-dispatches it as a window event and the layout hook refetches the list, applying the
// active layout's remote copy when nothing local is unsaved.
export interface ChartLayoutsUpdate {
  id: string | null
}

export const CHART_LAYOUTS_UPDATE_EVENT = 'prismx:chart-layouts-update'

export function emitChartLayoutsUpdate(detail: ChartLayoutsUpdate): void {
  window.dispatchEvent(new CustomEvent<ChartLayoutsUpdate>(CHART_LAYOUTS_UPDATE_EVENT, { detail }))
}

// 返回取消订阅的函数 / returns the unsubscribe function
export function onChartLayoutsUpdate(cb: (detail: ChartLayoutsUpdate) => void): () => void {
  const handler = (ev: Event) => cb((ev as CustomEvent<ChartLayoutsUpdate>).detail ?? { id: null })
  window.addEventListener(CHART_LAYOUTS_UPDATE_EVENT, handler)
  return () => window.removeEventListener(CHART_LAYOUTS_UPDATE_EVENT, handler)
}
