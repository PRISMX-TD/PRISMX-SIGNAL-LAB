// Web Push 订阅工具 / Web Push subscription helpers
import { recordDiag } from "./pushDiag"
import { pushSupported } from "./pushEnv"

// pushSupported 的实现已移到 pushEnv.ts（连同新增的 PushEnv 细分状态），这里重导出，
// 让现有那五个 import 点不必改动，同时避免两份实现并存漂移。
// 其余环境探测函数（detectPushEnv / isStandalone / …）由组件直接从 pushEnv.ts 导入，
// 不在这里转发——多一层转发只会让"某个符号到底住在哪"变得更难回答。
//
// pushSupported's implementation moved to pushEnv.ts (along with the new PushEnv
// states); re-exported here so the five existing import sites stay untouched and
// no second copy can drift. The other detectors (detectPushEnv / isStandalone /
// …) are imported straight from pushEnv.ts by their consumers — an extra
// forwarding layer would only make "where does this symbol live" harder to answer.
export { pushSupported } from "./pushEnv"

function urlBase64ToUint8Array(base64: string) {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4)
  const raw = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/")
  const decoded = window.atob(raw)
  const out = new Uint8Array(decoded.length)
  for (let i = 0; i < decoded.length; i++) out[i] = decoded.charCodeAt(i)
  return out
}

let _reg: ServiceWorkerRegistration | null = null

// 只等待注册，不再自己注册一次。
//
// 注册统一由 main.tsx 在 load 事件里做一次（SW 现在还管离线壳，对所有人都要生效，
// 不能只在"用户开推送"这条路径上才存在）。这里原来又 register 了一遍：注册本身是
// 幂等的，真正的问题是两条路径抢着写同一个诊断格子——pushDiag 是 Map，后写覆盖
// 先写，于是排查推送故障时看到的 "sw-register" 可能是 main.tsx 那次的结果而不是
// 推送路径的；而且模块级的 _reg 与 main.tsx 的注册是两份互不知情的状态，谁先谁
// 后不确定。改成 navigator.serviceWorker.ready 之后，"注册"只有一处、一个写入点。
// ready 是一个永不 reject 的 promise：SW 注册失败时它永远挂起，所以下面给它加了
// 时限——没有这道时限，注册失败的设备上整条开启通知的链路会静默卡死在这里，
// 用户看到的是一个转圈转不完的开关。
//
// Wait for the registration; don't perform one. Registration happens once in
// main.tsx on the load event (the worker now also serves the offline shell, which
// everyone needs, so it can no longer live only on the "user enabled push" path).
// This function used to register again: registration is idempotent, but the two
// paths raced to write the same diagnostics slot — pushDiag is a Map where the
// later write wins, so the "sw-register" entry seen while debugging push could be
// main.tsx's outcome rather than the push path's — and the module-level _reg was a
// second piece of state unaware of main.tsx's registration, with no defined
// ordering between them. With navigator.serviceWorker.ready there is one
// registration and one writer.
// ready never rejects: when registration fails it simply stays pending forever,
// hence the deadline below. Without it the whole enable-notifications flow would
// silently hang here on a device where the worker failed to install, and the user
// would just watch a toggle spin.
const SW_READY_TIMEOUT_MS = 10_000

export async function getSWReg(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return null
  if (_reg) return _reg
  try {
    _reg = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), SW_READY_TIMEOUT_MS)),
    ])
    if (!_reg) {
      recordDiag("sw-ready", "Service Worker 未在时限内就绪 / worker not ready within the deadline")
      return null
    }
    recordDiag("sw-ready")
  } catch (err) {
    // 仍然吞掉异常（拿不到 SW 不该影响应用启动），但原因记进诊断——此前这里的
    // 静默 catch 让 sw.js 的语法错误藏了很久。
    // Still swallowed (no worker must not break app boot), but the reason is
    // recorded — the silent catch here hid a syntax error in sw.js for a long time.
    recordDiag("sw-ready", err)
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
    let key: string
    try {
      key = await getVapidKey()
      recordDiag("vapid-key")
    } catch (err) {
      recordDiag("vapid-key", err)
      throw err
    }
    try {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key),
      })
      recordDiag("subscribe")
    } catch (err) {
      recordDiag("subscribe", err)
      throw err
    }
  } else {
    recordDiag("subscribe")
  }
  const raw = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } }
  try {
    await report(raw.endpoint!, raw.keys!)
    recordDiag("report")
  } catch (err) {
    recordDiag("report", err)
    throw err
  }
  return true
}
