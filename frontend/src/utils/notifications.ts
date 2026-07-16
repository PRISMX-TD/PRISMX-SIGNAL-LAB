// 通知偏好共享逻辑：账户页的完整设置面板与顶栏铃铛弹层都要做"开/关总开关"
// 这同一件事（权限申请、Service Worker 订阅、prefs 落库三步网络编排），抽成
// 一处避免两地维护、行为跑偏。
// Shared notification-prefs logic: both the account page's full settings panel
// and the top-bar bell popover need to do the same "flip the master switch"
// dance (permission request, Service Worker subscription, prefs save). Pulled
// out here so the two don't drift.
import { notificationApi, pushApi } from "../api/client"
import { subscribePush, unsubscribePush, getSWReg, pushSupported } from "./push"

// 白名单哨兵值：不限（命中任意取值，含以后才出现的品种）。与后端
// push_dispatch.py 的 ALL_SENTINEL 保持一致。
// Whitelist sentinel: unrestricted (matches anything, including symbols that
// don't exist yet). Kept in sync with the backend's ALL_SENTINEL.
export const ALL_SENTINEL = "__ALL__"

export const EVENT_TYPES = ["order_filled", "order_rejected", "auto_manage", "bridge_offline"] as const

export type NotifPrefs = {
  enabled: boolean
  selected_categories: string[]
  selected_symbols: string[]
  event_types: string[]
}

export type EnableFailureReason = "unsupported" | "permission-denied" | "blocked"

export class NotifEnableError extends Error {
  reason: EnableFailureReason
  constructor(reason: EnableFailureReason) {
    super(reason)
    this.reason = reason
  }
}

// 开启失败原因 → i18n key，供任何展示这个错误的地方复用（账户页面板、铃铛弹层）。
// Enable-failure reason → i18n key, reused wherever this error is surfaced
// (the account page panel, the bell popover).
export const ENABLE_ERROR_KEYS: Record<EnableFailureReason, string> = {
  unsupported: "account.notifUnsupported",
  "permission-denied": "account.notifPermissionDenied",
  blocked: "account.notifBlocked",
}

/** 关闭通知：落库 + 清理本设备订阅 / turn off: save prefs + clean up this device's subscription */
export async function disableNotifications(): Promise<void> {
  await Promise.all([
    notificationApi.putPrefs(false, [], [], []),
    (async () => {
      const reg = await getSWReg()
      const currentSub = await reg?.pushManager?.getSubscription()
      if (currentSub) {
        const json = currentSub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } }
        await pushApi.unsubscribe(json.endpoint!, json.keys!)
        await unsubscribePush()
      }
    })(),
  ])
}

/**
 * 开启通知：申请浏览器权限 → 白名单为空则补全默认值 → 落库 + 订阅本设备。
 * 返回实际落库的三项白名单，供调用方同步本地 UI 状态。
 *
 * `getCurrent` 取当前白名单，且必须在权限申请*之后*才调用——iOS Safari 只在
 * "用户手势触发后同步调用 requestPermission()、中间不能有异步间隙"时才会弹出
 * 系统权限框；哪怕只插一次网络请求（如取当前 prefs），这次调用就会被吞掉，
 * 权限永远停在 default，用户点了开关却什么都不会发生。Android/Chrome 对此
 * 宽容得多，本地测试很容易看不出问题。
 *
 * Turn on: request browser permission → fill empty whitelists with defaults →
 * save prefs + subscribe this device. Returns the three whitelists actually
 * saved, so the caller can sync its local UI state.
 *
 * `getCurrent` fetches the current whitelists and must only be called *after*
 * the permission request — iOS Safari only shows the system permission sheet
 * when requestPermission() is called synchronously off a user gesture, with no
 * async gap in between. Even one network round-trip (e.g. fetching current
 * prefs) first is enough to swallow the call: permission stays stuck at
 * default and the user's tap silently does nothing. Android/Chrome is far
 * more forgiving here, so this is easy to miss testing on desktop/Android.
 */
export async function enableNotifications(
  getCurrent: () => Promise<Pick<NotifPrefs, "selected_categories" | "selected_symbols" | "event_types">>,
): Promise<{ cats: string[]; syms: string[]; events: string[] }> {
  if (!pushSupported()) throw new NotifEnableError("unsupported")
  if (Notification.permission === "default") {
    const granted = await Notification.requestPermission()
    if (granted !== "granted") throw new NotifEnableError("permission-denied")
  } else if (Notification.permission === "denied") {
    throw new NotifEnableError("blocked")
  }

  const current = await getCurrent()

  // 白名单为空时默认全选：策略/品种/事件都是白名单语义（空 = 什么都不推），
  // 用户只翻总开关、没逐个勾选时会"已开启却一条都收不到"。品种维度用哨兵值
  // 而非展开当前品种列表，这样以后 EA 新增品种也自动覆盖，不会过时。
  // Default to select-all when whitelists are empty: category/symbol/event are
  // all whitelist-semantics (empty = push nothing), so a user who only flips
  // the master toggle would see "enabled yet receives nothing". The symbol
  // dimension uses the sentinel rather than expanding the current symbol
  // list, so a symbol the EA adds later stays covered automatically.
  const cats = current.selected_categories.length > 0 ? current.selected_categories : [ALL_SENTINEL]
  const syms = current.selected_symbols.length > 0 ? current.selected_symbols : [ALL_SENTINEL]
  const events = current.event_types.length > 0 ? current.event_types : [...EVENT_TYPES]

  const vapidPromise = pushApi.getVapidKey()
  await Promise.all([
    notificationApi.putPrefs(true, cats, events, syms),
    (async () => {
      const [vapid] = await Promise.all([vapidPromise, getSWReg()])
      const sub = await subscribePush(vapid.publicKey)
      if (sub) await pushApi.subscribe(sub.endpoint, sub.keys)
    })(),
  ])

  return { cats, syms, events }
}
