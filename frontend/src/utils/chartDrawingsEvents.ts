// 图表画线的跨设备同步事件（后端 rev 55）。
//
// 后端每次保存画线成功都会给该用户的所有在线连接推 WS CHART_DRAWINGS_UPDATE {symbol, updatedAt}
// （含发起保存的这台）。store/live.tsx 收到后转成 window 事件 prismx:chart-drawings-update，
// 画线层用 onChartDrawingsUpdate 订阅：正开着这个品种、且 updatedAt 与自己最近一次保存的返回不同，
// 就 chartApi.getDrawings 重拉。不带画线本身，免得每次保存都把整组画线推给所有设备。
//
// Cross-device sync event for chart drawings (backend rev 55). Every successful save pushes WS
// CHART_DRAWINGS_UPDATE {symbol, updatedAt} to all of the user's connections (the saving device
// included). store/live.tsx re-dispatches it as the window event prismx:chart-drawings-update; the
// drawing layer subscribes with onChartDrawingsUpdate and refetches via chartApi.getDrawings when it
// shows that symbol and updatedAt differs from its own latest save response. No drawings payload,
// so a save never fans the whole array out to every device.
import type { ChartDrawingsUpdate } from '../api/types'

export const CHART_DRAWINGS_UPDATE_EVENT = 'prismx:chart-drawings-update'

export function emitChartDrawingsUpdate(detail: ChartDrawingsUpdate): void {
  window.dispatchEvent(new CustomEvent<ChartDrawingsUpdate>(CHART_DRAWINGS_UPDATE_EVENT, { detail }))
}

// 返回取消订阅的函数，直接当 useEffect 的清理函数用。
// Returns the unsubscribe function, ready to be a useEffect cleanup.
export function onChartDrawingsUpdate(cb: (detail: ChartDrawingsUpdate) => void): () => void {
  const handler = (ev: Event) => {
    const detail = (ev as CustomEvent<ChartDrawingsUpdate>).detail
    if (detail && typeof detail.symbol === 'string') cb(detail)
  }
  window.addEventListener(CHART_DRAWINGS_UPDATE_EVENT, handler)
  return () => window.removeEventListener(CHART_DRAWINGS_UPDATE_EVENT, handler)
}
