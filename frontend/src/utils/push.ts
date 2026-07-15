// Web Push 订阅工具 / Web Push subscription helpers
const SW_URL = "/sw.js"

function urlBase64ToUint8Array(base64: string) {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4)
  const raw = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/")
  const decoded = window.atob(raw)
  const out = new Uint8Array(decoded.length)
  for (let i = 0; i < decoded.length; i++) out[i] = decoded.charCodeAt(i)
  return out
}

let _reg: ServiceWorkerRegistration | null = null

export async function getSWReg(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return null
  if (_reg) return _reg
  try {
    _reg = await navigator.serviceWorker.register(SW_URL, { scope: "/" })
    // 等 SW 就绪 / wait until ready
    await navigator.serviceWorker.ready
  } catch {
    _reg = null
  }
  return _reg
}

export async function subscribePush(applicationServerKey: string) {
  const reg = await getSWReg()
  if (!reg) return null
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(applicationServerKey),
  })
  const raw = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } }
  return { endpoint: raw.endpoint!, keys: raw.keys! }
}

export async function unsubscribePush() {
  const reg = await getSWReg()
  if (!reg) return
  const sub = await reg.pushManager.getSubscription()
  if (sub) await sub.unsubscribe()
}

// 当前运行环境是否具备 Web Push 能力。iOS 上只有"从主屏幕以独立模式启动的
// Web App"（iOS 16.4+）才有 PushManager——在 Safari 标签页里（包括没有
// manifest 时加到主屏幕的书签式打开）这两个对象根本不存在。
// Whether this environment supports Web Push at all. On iOS only a web app
// launched standalone from the Home Screen (iOS 16.4+) gets PushManager — in
// a Safari tab (including bookmark-style home-screen launches when there's no
// manifest) these objects simply don't exist.
export function pushSupported(): boolean {
  return (
    typeof Notification !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window
  )
}

// 确保"这台设备"有一个有效的推送订阅并已上报后端。
// 通知开关是账号级的（存在后端、跨设备同步），但推送订阅是设备级的——只在
// 用户翻动开关那一台设备上创建过。此前在桌面开启后，手机上开关显示"已开启"，
// 但手机从未订阅，自然一条通知都收不到。这里在授权已给出的前提下静默补齐：
// 没有订阅就新建，已有订阅也重新上报一次（自愈后端已清理/SW 轮换后的失联）。
// Ensure THIS device has a live push subscription reported to the backend.
// The notification toggle is account-level (stored server-side, synced across
// devices), but a push subscription is per-device — it was only ever created
// on the device where the user flipped the toggle. Enable on desktop and the
// phone shows the toggle ON while having no subscription at all, hence zero
// notifications. With permission already granted, silently heal: subscribe if
// missing, and re-report an existing subscription (self-heals backend prunes
// and SW-side rotations).
export async function ensurePushSubscription(
  getVapidKey: () => Promise<string>,
  report: (endpoint: string, keys: { p256dh: string; auth: string }) => Promise<unknown>,
): Promise<boolean> {
  if (!pushSupported() || Notification.permission !== "granted") return false
  const reg = await getSWReg()
  if (!reg) return false
  let sub = await reg.pushManager.getSubscription()
  if (!sub) {
    const key = await getVapidKey()
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(key),
    })
  }
  const raw = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } }
  await report(raw.endpoint!, raw.keys!)
  return true
}
