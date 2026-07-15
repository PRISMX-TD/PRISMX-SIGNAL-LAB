// PRISMX Signal Lab · Service Worker for Web Push
// 接收推送事件：弹系统通知，点击后打开或聚焦 /app。

self.addEventListener("push", (event) => {
  let data = { title: "PRISMX Signal", body: "新信号" }
  if (event.data) {
    try {
      data = event.data.json()
    } catch {
      // 非 JSON 载荷（如 DevTools 手动推送）回退为纯文本 / fallback for non-JSON payload
      data = { title: "PRISMX Signal", body: event.data.text() }
    }
  }
  const promise = self.registration.showNotification(data.title, {
    body: data.body || "",
    icon: data.icon || "/favicon.svg",
    badge: "/favicon.svg",
    // 每条信号用唯一 tag，避免后一条覆盖前一条导致“丢通知”；renotify 确保每条都提醒。
    // Unique tag per signal so a new one doesn't replace the previous; renotify alerts each time.
    tag: data.tag || `prismx-signal-${Date.now()}`,
    renotify: true,
    requireInteraction: false,
    data: { url: data.url || "/app" },
  })
  event.waitUntil(promise)
})

// 浏览器可能主动轮换/作废推送订阅（Chrome 尤其常见）。不处理这个事件的话，
// 旧 endpoint 推送时 410、被后端清理，这台设备就静默"失聪"了，直到用户手动
// 重开开关。这里用旧订阅同一把公钥立即重订阅；新订阅会在用户下次打开站点时
// 由 Layout 的 ensure 逻辑上报给后端（SW 里拿不到 JWT，没法直接上报）。
// Browsers can rotate/expire a push subscription on their own (Chrome
// especially). Unhandled, the old endpoint 410s, the backend prunes it, and
// this device silently goes deaf until the user manually re-toggles. Re-
// subscribe immediately with the same key; the new subscription gets reported
// to the backend on the next site visit by Layout's ensure logic (no JWT is
// available inside the SW to report directly).
self.addEventListener("pushsubscriptionchange", (event) => {
  const key = event.oldSubscription?.options?.applicationServerKey
  if (!key) return
  event.waitUntil(
    self.registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: key,
    })
  )
})

self.addEventListener("notificationclick", (event) => {
  event.notification.close()
  const url = event.notification.data?.url || "/app"
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clients) => {
        for (const client of clients) {
          if (client.url.includes(url) && "focus" in client) {
            return client.focus()
          }
        }
        return self.clients.openWindow(url)
      })
  )
})
