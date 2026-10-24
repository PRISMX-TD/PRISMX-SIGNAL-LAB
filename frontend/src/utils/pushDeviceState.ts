// 「这台设备」拿没拿到推送通道（最近一次订阅的结果）。
//
// 为什么要有这一格：通知开关是账号级的，铃铛 / 账户页以前只看两样东西——账号开关与浏览器
// 权限。权限是 granted、但这台设备的 pushManager.subscribe() 失败（安卓 Chrome 连不上 FCM、
// 订阅超时）时，铃铛照样是绿的「已开启」，用户没有任何途径知道这台手机其实一条后台通知都
// 收不到，更没有地方点「重试」。订阅只在 Layout 的自愈与开关两处发生，这里把结果留下来给
// 界面读。
//
// 只有「订阅这一步」的成败写进来：取 VAPID 公钥、上报后端失败多半是我们自己的网络抖动，
// 下一次回前台就补上，不该让界面说「这台设备连不上推送服务器」。
//
// Whether THIS device holds a push channel (outcome of the latest subscribe attempt). The
// toggle is account-level and the bell used to look only at that and the browser
// permission: with permission granted but pushManager.subscribe() failing (Android Chrome
// unable to reach FCM, a timed-out subscribe) it still showed a green "on", and the user had
// no way to learn the phone receives no background notification, nor anywhere to retry.
// Only the subscribe step writes here; VAPID-key or report failures are usually our own
// network blips, healed on the next foreground.
import { useSyncExternalStore } from "react"

export type DeviceSubState = "unknown" | "ok" | "failed"

let state: DeviceSubState = "unknown"
const listeners = new Set<() => void>()

export function getDeviceSubState(): DeviceSubState {
  return state
}

export function setDeviceSubState(next: DeviceSubState): void {
  if (next === state) return
  state = next
  for (const l of [...listeners]) l()
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

export function useDeviceSubState(): DeviceSubState {
  return useSyncExternalStore(subscribe, getDeviceSubState, getDeviceSubState)
}
