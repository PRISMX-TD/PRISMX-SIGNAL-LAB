// PRISMX Signal Lab · Service Worker
// ① Web Push：接收推送事件，弹系统通知，点击后打开或聚焦 /app。
// ② 离线壳：断网时导航请求回落到一张自带样式的离线页，而不是浏览器的报错页。

// ---------- 离线壳 / offline shell ----------
//
// 加这一段之前，把站点装成 PWA 之后断网打开主屏图标，看到的是浏览器的
// "无法访问此网站"——一个装了图标、起了名字的应用，掉线时露出的却是浏览器的
// 错误页，观感上等同于「这个 App 坏了」。
//
// 设计上刻意保守，因为一个坏掉的 Service Worker 能把整个站点缓存死：
//
// 1. **只缓存离线页本身**（以及它需要的图标），不缓存 /assets/ 下带 hash 的
//    构建产物。那些文件由 Vercel 的 CDN 负责，且文件名随内容变化天然安全；
//    在 SW 里再缓存一层只会多一个「用户拿到旧版本」的失效路径，收益却很小。
// 2. **导航请求一律 network-first**，只有网络真的失败才回落到离线页。绝不
//    cache-first：那会让用户在有网的情况下看到缓存的旧页面。
// 3. **非导航请求完全不拦截**（直接 return，不调用 respondWith），API、
//    WebSocket、图片全部走原生路径，SW 不参与。
// 4. skipWaiting + clients.claim：新版本立即接管，不必等所有标签页关闭。
//    没有这两句，改完 SW 之后用户可能好几天都跑在旧的那份上。
// 5. 缓存名带版本号，activate 时删掉其它版本，不留垃圾。
//
// Before this, installing the site as a PWA and opening it offline showed the
// browser's "can't reach this site" page — an app with its own icon and name
// exposing a browser error page, which reads as "this app is broken".
//
// Deliberately conservative, because a broken service worker can cache a site
// into a corner:
//
// 1. **Only the offline page itself is cached** (plus the icon it needs), never
//    the hashed build output under /assets/. Those are the CDN's job and are
//    inherently safe by filename; caching them again here would only add another
//    way for a user to get stuck on an old build, for very little gain.
// 2. **Navigations are always network-first**, falling back to the offline page
//    only when the network genuinely fails. Never cache-first — that would serve
//    a stale page to someone who is online.
// 3. **Non-navigation requests aren't intercepted at all** (plain return, no
//    respondWith), so API calls, WebSockets and images take their native path.
// 4. skipWaiting + clients.claim so a new version takes over immediately instead
//    of waiting for every tab to close — without them a user can run the old
//    worker for days after a change.
// 5. The cache name is versioned and other versions are deleted on activate.
const CACHE = "prismx-shell-v1"
const OFFLINE_URL = "/offline.html"
const SHELL = [OFFLINE_URL, "/icons/icon-192.png"]

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL))
      // 壳缓存失败不能阻止安装：装不上 SW 就连推送也一起没了，而推送才是这个
      // SW 最初存在的理由。离线页缺失只是少一个兜底。
      // A failed shell cache must not block installation: without the worker
      // there's no push either, and push is why this worker exists at all. A
      // missing offline page only costs the fallback.
      .catch(() => {})
      .then(() => self.skipWaiting())
  )
})

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  )
})

self.addEventListener("fetch", (event) => {
  const req = event.request
  // 只管页面导航。其余请求（API / WS / 静态资源）一概不碰——不调用
  // respondWith 就等于把它们交回浏览器原生处理。
  // Navigations only. Everything else (API / WS / static assets) is left alone —
  // not calling respondWith hands the request back to the browser untouched.
  if (req.mode !== "navigate") return
  event.respondWith(
    fetch(req).catch(() =>
      caches.match(OFFLINE_URL).then((r) => r || new Response("offline", { status: 503 }))
    )
  )
})

// ---------- Web Push ----------
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
    icon: data.icon || "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
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
