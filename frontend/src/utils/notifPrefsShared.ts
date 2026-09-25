// 通知偏好（GET /notifications/prefs）的共享读取：并发去重 + 短时共享。
//
// 进入应用的同一刻有三个组件各自要这份数据——Layout（补齐本设备推送订阅）、
// NotificationBell（开关状态）、NotifDeviceBanner（仪表盘提示条）——原来是三次一模一样
// 的请求。这里让同一时刻在途的调用共用一个 Promise，结果再保留几秒，挂载稍晚一拍的组件
// 也直接拿到。
// 只用于「读来显示 / 判断」的地方。要把完整偏好原样带回 PUT 的调用（铃铛开启时的
// getCurrent、账户页的设置面板）继续直接调 notificationApi.getPrefs()，拿最新值。
// 开关推送之后调 updateSharedNotifPrefs / invalidateSharedNotifPrefs，别让随后挂载的组件
// 读到开关之前的旧值。
//
// Shared reads of the notification prefs: in-flight dedupe plus a short TTL. On app
// entry Layout, NotificationBell and NotifDeviceBanner each fetched the same thing
// at the same moment — three identical requests. Only for display/decision reads;
// callers that PUT the full prefs back keep calling notificationApi.getPrefs()
// directly. After toggling push, update or invalidate so later mounts don't read
// the pre-toggle value.
import { notificationApi, type NotifPrefsPayload } from '../api/client'

// 足够盖住「同一次进入应用里几个组件先后挂载」，又短到换账号、别处改了设置之后
// 很快就会重新拉。/ Long enough to span one app entry's mounts, short enough to go stale fast.
const TTL_MS = 5000

let inflight: Promise<NotifPrefsPayload> | null = null
let cached: { at: number; value: NotifPrefsPayload } | null = null
// 每次失效 / 覆盖都加一：失效之前发出的请求晚到时不许再写回缓存。
// Bumped on every invalidate/update so a request issued before it can't write back.
let generation = 0

export function getSharedNotifPrefs(): Promise<NotifPrefsPayload> {
  if (cached && Date.now() - cached.at < TTL_MS) return Promise.resolve(cached.value)
  if (inflight) return inflight
  const gen = generation
  const p = notificationApi.getPrefs().then(
    (value) => {
      if (gen === generation) {
        cached = { at: Date.now(), value }
        inflight = null
      }
      return value
    },
    (err) => {
      if (gen === generation) inflight = null
      throw err
    },
  )
  inflight = p
  return p
}

// 本地已知的新值（例如刚开 / 关了推送）直接写进共享值，免得随后挂载的组件读到旧的。
// Write a locally known new value (e.g. push just toggled) so later mounts see it.
export function updateSharedNotifPrefs(patch: Partial<NotifPrefsPayload>): void {
  generation++
  inflight = null
  cached = cached ? { at: Date.now(), value: { ...cached.value, ...patch } } : null
}

export function invalidateSharedNotifPrefs(): void {
  generation++
  inflight = null
  cached = null
}
