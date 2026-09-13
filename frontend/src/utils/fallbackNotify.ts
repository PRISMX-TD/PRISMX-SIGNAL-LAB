// 收不到推送的设备：把后端经 WebSocket 捎来的同一条通知，在本地弹出来。
//
// 为什么需要：中国大陆的网络连不上 Google 的服务器，那些设备永远拿不到 FCM token，
// 也就永远不会有推送订阅——后端每个推送函数里的「没有订阅就返回」对它们恒成立，
// 偏好设成什么样都收不到一条。后端因此在**做出「这个用户该收到这条通知」的同一处**，
// 把标题正文经 WebSocket 再发一份（PUSH_FALLBACK，见 backend/app/services/push_dispatch.py
// 的 _ws_fallback）。判定全在后端，这里不重复任何一条规则。
//
// 三道闸，任何一道不过就什么都不做：
//   1. 没给通知权限 → 不弹（也不去要权限：那要用户手势，这里没有）
//   2. 页面正开着 → 不弹。界面里已经实时更新了，再弹一条是纯噪音
//   3. 这台设备有正常的推送订阅 → 不弹。后端那条真推送会送到，弹了就是两遍
//
// 第 3 条是现有 Web / PWA 用户完全不受影响的原因：他们有订阅，这个函数对他们永远
// 是空操作。只有「开了通知、但这台设备订阅不上」的设备才会走到最后一步——
// 在 App 里那正是靠前台服务维持长连接的那条路（见 APP Pack 的 boot/keepAlive.ts）。
//
// Devices that can never receive push: show the notification the backend
// mirrored over the WebSocket. See the file header comment above — all the
// "should this user be notified" rules stay on the backend; this only decides
// whether *this device* still needs a local notification (no permission, a
// visible page, or an existing push subscription all mean "no").

import { getSWReg } from "./push"

// 与 public/sw.js 里的同名函数一字不差（那份是给 Service Worker 用的，sw.js 是直接
// 交付的纯 JS，import 不进来，只能各留一份）。改这里记得同时改那里：口径不一致的
// 后果是两条路径对同一个 url 给出不同落点，而两边都"看起来正常"。
// Kept byte-identical to the same function in public/sw.js — that file ships as
// plain JS and cannot import from here, so the rule exists twice on purpose.
function safeNotificationUrl(raw: unknown): string {
  if (typeof raw !== "string" || !raw.startsWith("/") || raw.startsWith("//")) {
    return "/app"
  }
  return raw
}

export interface FallbackNotification {
  title?: string
  body?: string
  /** 点开后去哪。只接受站内相对路径，交给 safeNotificationUrl 收口。 */
  url?: string
  /** 同一条内容重复下发时用来盖掉上一条（公告就带它）。 */
  tag?: string
}

/** 后端 WS 消息的 data 字段。返回是否真的弹了，供测试与调试用。 */
export async function showFallbackNotification(raw: unknown): Promise<boolean> {
  try {
    const n = (raw || {}) as FallbackNotification
    const title = typeof n.title === "string" ? n.title.trim() : ""
    if (!title) return false
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return false
    if (typeof document !== "undefined" && !document.hidden) return false

    const reg = await getSWReg()
    // 有订阅 = 真推送这条路是通的，后端那一份会送到，别弹第二遍。
    // getSubscription 在某些环境会抛（权限被撤、存储被清），抛了就当没有订阅——
    // 宁可多弹一条，也不要在唯一能收到消息的那条路上静默失败。
    let hasSubscription = false
    try {
      hasSubscription = !!(await reg?.pushManager?.getSubscription())
    } catch {
      hasSubscription = false
    }
    if (hasSubscription) return false

    const options: NotificationOptions & { tag?: string } = {
      body: typeof n.body === "string" ? n.body : "",
      icon: "/icons/icon-192.png",
      data: { url: safeNotificationUrl(n.url) },
    }
    if (typeof n.tag === "string" && n.tag) options.tag = n.tag

    // 两条标准路径：有注册对象就用它（SW 通知能在页面关掉后继续存在，App 里由
    // 桥转成本地通知），否则退回 new Notification()。
    if (reg && typeof reg.showNotification === "function") {
      await reg.showNotification(title, options)
      return true
    }
    new Notification(title, options)
    return true
  } catch {
    // 兜底路径本身绝不能把 WS 消息处理带崩。
    return false
  }
}
