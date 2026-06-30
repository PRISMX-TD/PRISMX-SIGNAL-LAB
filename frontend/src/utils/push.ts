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
