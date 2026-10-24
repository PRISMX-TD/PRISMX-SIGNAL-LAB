// Web Push 订阅工具 / Web Push subscription helpers
import { isNativeApp } from "./inAppBrowser"
import { recordDiag } from "./pushDiag"
import { pushSupported } from "./pushEnv"
import { setDeviceSubState } from "./pushDeviceState"
import { readStorage, removeStorage, writeStorage } from "./safeStorage"

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

// pushManager.subscribe 的上限。Chrome 要先连 Google 推送服务（FCM）拿通道，大陆网络下
// 这一步可能既不成功也不失败地一直挂着——通知开关跟着一直转圈、点不动。到点按失败处理，
// 调用方照常报「这台设备可能收不到后台通知」。
// Ceiling for pushManager.subscribe. Chrome must reach Google's push service (FCM) first,
// and on mainland networks that can hang without ever settling — the notification toggle
// spun and stayed disabled with it. On expiry it counts as a failure and the caller says
// this device may not get background notifications, as for any other failure.
const SUBSCRIBE_TIMEOUT_MS = 20_000

function subscribeWithTimeout(reg: ServiceWorkerRegistration, applicationServerKey: string) {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(applicationServerKey),
    }),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("pushManager.subscribe timed out")), SUBSCRIBE_TIMEOUT_MS)
    }),
  ]).finally(() => clearTimeout(timer))
}

// 这台设备上一次成功上报给后端的 endpoint。
//
// 用来认出「死订阅」：派发时推送服务回 410/404（App 是 FCM UNREGISTERED），后端把那一行
// 删了，可浏览器手里还是那条订阅——iOS 与多数 Chromium 根本不发 pushsubscriptionchange，
// getSubscription() 照旧把它返回来。以前回前台把它原样再报一遍，后端插回去，下一次推送
// 又 410 清掉，这台设备永远收不到、也永远不会自己好（「以前能收到，后来就没了」）。
// 现在上报时告诉后端「这个我以前报过」，后端发现行已经没了就回 stale，这里退订、重新
// 订阅一个新 endpoint 再报。
// 键带 prismx. 前缀：登出时 auth.tsx 的 clearUserScopedStorage 会一并清掉——登出本来就
// 把后端那一行删了，下次登录按「没报过」处理才对。
//
// The endpoint this device last reported successfully, used to recognise a dead
// subscription: dispatch prunes a row on 410/404 (FCM UNREGISTERED for the app) while the
// browser keeps returning it from getSubscription() — iOS and most Chromium never fire
// pushsubscriptionchange. Re-reporting it on each foreground had the backend re-insert it,
// the next push prune it again, and the device never heal. The report now says "I've
// reported this before"; a missing row comes back as stale and we resubscribe. The
// prismx. prefix means logout clears it along with the backend row.
const REPORTED_KEY = "prismx.pushReported"

function wasReported(endpoint: string): boolean {
  return readStorage(REPORTED_KEY) === endpoint
}

/** 退订 / 关掉通知时调：本设备不再有「报过的」订阅。/ Forget the reported endpoint. */
export function forgetReportedSubscription(): void {
  removeStorage(REPORTED_KEY)
}

type SubReport = (
  endpoint: string,
  keys: { p256dh: string; auth: string },
  previouslyReported: boolean,
) => Promise<unknown>

/** 把一条已经拿到手的订阅（如 SW 轮换后广播来的新 endpoint）报给后端并记下。
 *  Report a subscription already in hand (e.g. the SW's renewed endpoint) and remember it. */
export async function reportSubscription(
  endpoint: string,
  keys: { p256dh: string; auth: string },
  report: SubReport,
): Promise<void> {
  await report(endpoint, keys, false)
  writeStorage(REPORTED_KEY, endpoint)
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
//
// 2026-10-24：开关那条路（utils/notifications.ts 的 enableNotifications）也改走这里。它原来
// 自己 subscribe + 上报：pushManager.subscribe() 遇到已有订阅会原样返回那一条，于是一条死
// 订阅在用户重新开关时又被当成新的插回后端，上面的死订阅识别被它绕过去。现在只有这一处
// 建订阅 / 上报，两条路的行为一致。订阅这一步也带上了 20 秒时限（原来只有开关那条有）：
// 大陆网络下 Chrome 的 subscribe 会一直挂着。
// Since 2026-10-24 the toggle path (enableNotifications) also comes through here. It used to
// subscribe and report on its own, and since pushManager.subscribe() hands back an existing
// subscription, re-toggling re-inserted a dead one as new, bypassing the stale check. One
// place now creates and reports subscriptions, with the 20s subscribe ceiling on both paths.
export async function ensurePushSubscription(
  getVapidKey: () => Promise<string>,
  report: SubReport,
): Promise<boolean> {
  if (!pushSupported() || Notification.permission !== "granted") return false
  const reg = await getSWReg()
  if (!reg) return false

  const subscribeFresh = async (): Promise<PushSubscription> => {
    let key: string
    try {
      key = await getVapidKey()
      recordDiag("vapid-key")
    } catch (err) {
      recordDiag("vapid-key", err)
      throw err
    }
    try {
      const fresh = await subscribeWithTimeout(reg, key)
      recordDiag("subscribe")
      return fresh
    } catch (err) {
      recordDiag("subscribe", err)
      // App 里订阅失败 = 连不上 Google，壳已经转到前台服务长连接兜底（APP Pack 的
      // boot/keepAlive.ts），通知照样到——不标 failed，免得大陆用户每次打开都看到「重试」横幅。
      // In the app a failed subscribe means Google is unreachable and the shell has switched
      // to its foreground-service socket fallback, so notifications still arrive — not "failed".
      if (!isNativeApp()) setDeviceSubState("failed")
      throw err
    }
  }
  const send = async (s: PushSubscription, previouslyReported: boolean) => {
    const raw = s.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } }
    let res: unknown
    try {
      res = await report(raw.endpoint!, raw.keys!, previouslyReported)
      recordDiag("report")
    } catch (err) {
      recordDiag("report", err)
      throw err
    }
    const stale = !!res && typeof res === "object" && (res as { stale?: unknown }).stale === true
    return { endpoint: raw.endpoint!, stale }
  }

  let sub = await reg.pushManager.getSubscription()
  let isNew = false
  if (!sub) {
    sub = await subscribeFresh()
    isNew = true
  } else {
    recordDiag("subscribe")
  }
  let out = await send(sub, !isNew && wasReported(sub.endpoint))
  if (out.stale) {
    // 后端说这条早就死了（见 REPORTED_KEY 的注释）：退订，换一条新的再报。退订失败也照样
    // 往下走——subscribe() 拿回同一条的话，下一轮回前台会再试。
    // The backend says it's dead (see REPORTED_KEY): drop it and report a fresh one.
    try {
      await sub.unsubscribe()
    } catch {
      /* 退不掉也继续 / carry on regardless */
    }
    forgetReportedSubscription()
    sub = await subscribeFresh()
    out = await send(sub, false)
  }
  writeStorage(REPORTED_KEY, out.endpoint)
  setDeviceSubState("ok")
  return true
}
