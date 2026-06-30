// PRISMX Signal Lab · Service Worker for Web Push
// 接收推送事件：弹系统通知，点击后打开或聚焦 /app。

self.addEventListener("push", (event) => {
  const data = event.data?.json() ?? { title: "PRISMX Signal", body: "新信号" }
  const promise = self.registration.showNotification(data.title, {
    body: data.body || "",
    icon: data.icon || "/favicon.svg",
    badge: "/favicon.svg",
    tag: "prismx-signal",
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
