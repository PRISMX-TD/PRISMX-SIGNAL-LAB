// 推送运行环境探测。此前只有一个布尔值 pushSupported()，UI 只能二选一显示
// "能用"或"不支持"——而"不支持"底下藏着三种处境完全不同的用户：iOS 16.4+ 在
// Safari 标签页里（装到主屏幕就能用）、iOS 低于 16.4（升级系统才行）、权限已被
// 拒绝（要去系统设置里改）。三者给同一句"请添加到主屏幕"，第二种加完还是不能用，
// 陷入死循环；第三种则完全没被提到。
//
// 硬约束：本文件所有函数必须纯同步。iOS Safari 只在"用户手势后同步调用
// requestPermission()"时才弹权限框，通知开关路径上多一个 await 就会让权限框
// 永远不出现（见 utils/notifications.ts 的注释）。
//
// Push environment detection. There used to be just a boolean pushSupported(),
// so the UI could only say "works" or "unsupported" — while "unsupported"
// covers three very different situations: iOS 16.4+ in a Safari tab (installing
// to the Home Screen fixes it), iOS below 16.4 (needs an OS upgrade), and
// permission already denied (needs a change in system settings). All three got
// the same "add to Home Screen" hint: the second stays broken after following
// it, and the third was never addressed.
//
// Hard constraint: every function here must be purely synchronous. iOS Safari
// only shows the permission sheet when requestPermission() is called
// synchronously off a user gesture; one extra await on the toggle path makes it
// never appear (see the notes in utils/notifications.ts).

import type { DeviceSubState } from "./pushDeviceState"

export type PushEnv =
  | "granted"            // API 齐备且已授权 / capable and already granted
  | "ready"              // API 齐备，权限可申请 / capable, permission requestable
  | "denied"             // API 齐备但权限被拒 / capable but permission denied
  | "ios-needs-install"  // iOS 16.4+ 处于 Safari 标签页 / iOS 16.4+ in a Safari tab
  | "ios-too-old"        // iOS 低于 16.4 / iOS below 16.4
  | "unsupported"        // 其它平台确实不支持 / genuinely unsupported elsewhere

/** iOS 支持 Web Push 的最低版本 / minimum iOS version with Web Push support */
const IOS_PUSH_MIN_MAJOR = 16
const IOS_PUSH_MIN_MINOR = 4

/**
 * 是否以独立应用模式启动（已添加到主屏幕）。
 * navigator.standalone 是 iOS 专有属性，display-mode 是标准写法，取或覆盖全平台。
 * Whether we're running as an installed app. navigator.standalone is iOS-only,
 * display-mode is the standard; OR-ing both covers every platform.
 */
export function isStandalone(): boolean {
  try {
    const iosStandalone = (navigator as Navigator & { standalone?: boolean }).standalone === true
    return iosStandalone || window.matchMedia("(display-mode: standalone)").matches
  } catch {
    return false
  }
}

/**
 * 是否 iOS/iPadOS。iPad 自 iOS 13 起 UA 伪装成 macOS，靠 maxTouchPoints 补判
 * （桌面 Mac 不报告多点触控）。
 * Whether this is iOS/iPadOS. iPads have masqueraded as macOS in the UA since
 * iOS 13, so maxTouchPoints disambiguates (desktop Macs report no multi-touch).
 */
export function isIOS(): boolean {
  const ua = navigator.userAgent
  if (/iPad|iPhone|iPod/.test(ua)) return true
  return /Macintosh/.test(ua) && navigator.maxTouchPoints > 1
}

/**
 * 从 UA 解析 iOS 主次版本号，解析不出返回 null。
 * UA 解析本身不可靠，因此结果只用来区分提示文案，绝不用于决定功能开关——
 * 开关一律以 pushSupported() 的真实能力探测为准。判断错了最多文案不精确，
 * 不会误锁功能。
 * Parse the iOS major/minor from the UA; null when it can't be determined.
 * UA parsing is unreliable, so this only picks which hint to show and never
 * gates functionality — that's always decided by pushSupported()'s real
 * capability check. A wrong guess costs wording accuracy, not access.
 */
export function iosVersion(): { major: number; minor: number } | null {
  const m = /OS (\d+)[._](\d+)/.exec(navigator.userAgent)
  if (!m) return null
  return { major: Number(m[1]), minor: Number(m[2]) }
}

/**
 * 当前运行环境是否具备 Web Push 能力。真实能力探测，是功能开关的唯一依据。
 * iOS 上只有"从主屏幕以独立模式启动的 Web App"（iOS 16.4+）才有 PushManager——
 * 在 Safari 标签页里（包括没有 manifest 时加到主屏幕的书签式打开）这两个对象
 * 根本不存在。这也是下面 detectPushEnv 需要 standalone 判定的原因。
 *
 * Whether this environment can do Web Push. A real capability check — the only
 * thing that gates functionality. On iOS only a web app launched standalone
 * from the Home Screen (iOS 16.4+) gets PushManager — in a Safari tab
 * (including bookmark-style home-screen launches when there's no manifest)
 * these objects simply don't exist, which is why detectPushEnv below needs the
 * standalone check.
 */
export function pushSupported(): boolean {
  return (
    typeof Notification !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window
  )
}

/**
 * 六态运行环境判定。纯同步，禁止引入任何异步调用。
 * Six-state environment detection. Purely synchronous — never add async calls.
 */
export function detectPushEnv(): PushEnv {
  if (pushSupported()) {
    // 能力齐备，剩下的区别只在权限状态。
    // Fully capable; only the permission state differentiates from here.
    if (Notification.permission === "granted") return "granted"
    if (Notification.permission === "denied") return "denied"
    return "ready"
  }

  // 能力不齐备。iOS 需要进一步区分"装到主屏幕就能用"和"系统版本不够"，
  // 否则会把后者也引导去装主屏幕，装完依然收不到。
  // Not capable. On iOS we must tell "installing fixes it" from "the OS is too
  // old", or the latter gets sent to install to the Home Screen and still
  // receives nothing afterwards.
  if (isIOS()) {
    const v = iosVersion()
    if (v && (v.major < IOS_PUSH_MIN_MAJOR || (v.major === IOS_PUSH_MIN_MAJOR && v.minor < IOS_PUSH_MIN_MINOR))) {
      return "ios-too-old"
    }
    // 版本够（或解析不出版本，此时给可行动的引导比给"不支持"更有用）：
    // 未以独立模式启动就是缺这一步。
    // Version is fine (or unknown — an actionable hint beats "unsupported"):
    // not running standalone is exactly what's missing.
    if (!isStandalone()) return "ios-needs-install"
  }

  return "unsupported"
}

/**
 * PushEnv → 提示文案 i18n key。granted/ready 无需提示，故为 null。
 * 单一映射表供铃铛弹层、提示条、账户页共用，避免三处各写一份判断而跑偏。
 * PushEnv → hint i18n key; null for granted/ready which need no hint. One
 * shared table for the bell popover, banner and account page so the three
 * can't drift apart.
 */
export const PUSH_ENV_HINT_KEYS: Record<PushEnv, string | null> = {
  granted: null,
  ready: null,
  denied: "account.notifPermissionBlocked",
  "ios-needs-install": "account.notifIosNeedsInstall",
  "ios-too-old": "account.notifIosTooOld",
  unsupported: "account.notifUnsupported",
}

/**
 * **账号开关已经开着**时，这台设备还差什么：提示文案 key + 能就地解决的那一步。
 * 两种都不差返回 null（真正就绪）。纯同步。
 *
 * 比 PUSH_ENV_HINT_KEYS 多出来的两格，都是以前界面上「看着开着、其实收不到」的情况：
 *   · ready —— 能力齐备，只是**这台设备从没授权过**。账号开关是跨设备同步的，在电脑上开过、
 *     或者 iPhone 删掉主屏图标重新添加（新图标权限回到 default），这台设备的开关就显示
 *     「开」，却从没弹过权限框、从没订阅。以前铃铛在这一格显示「当前浏览器不支持推送通知」
 *     ——错的，而且开关是开着的，用户只能先关再开才会弹权限框，几乎没人会这么试。
 *     现在给「在本机开启」：点一下同步弹权限框（iOS 只认用户手势里同步发起的申请）。
 *   · granted 但订阅失败 —— 有权限、pushManager.subscribe() 却没成（安卓 Chrome 连不上 FCM、
 *     订阅超时）。以前铃铛是绿的。现在如实提示并给「重试」。
 *
 * What THIS device still lacks while the account toggle is on: hint key plus the action
 * that fixes it in place; null when genuinely ready. Two states beyond PUSH_ENV_HINT_KEYS,
 * both previously shown as "on" while nothing could arrive: `ready` (this device never
 * granted permission — the toggle syncs across devices, and a re-added iPhone home-screen
 * icon starts back at default; the bell used to say "this browser doesn't support push")
 * gets "enable on this device", which must request permission synchronously in the tap;
 * `granted` with a failed subscribe gets an honest hint and "retry".
 */
export function deviceNotifHint(
  env: PushEnv,
  device: DeviceSubState,
): { key: string; action: "enable" | "retry" | null } | null {
  if (env === "ready") return { key: "account.notifDeviceNotAllowed", action: "enable" }
  if (env === "granted") return device === "failed" ? { key: "account.notifDeviceFailed", action: "retry" } : null
  const key = PUSH_ENV_HINT_KEYS[env]
  return key ? { key, action: null } : null
}
