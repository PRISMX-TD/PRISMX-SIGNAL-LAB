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
