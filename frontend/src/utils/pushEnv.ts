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
 * Whether this environment can do Web Push. A real capability check — the only
 * thing that gates functionality.
 */
export function pushSupported(): boolean {
  return (
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
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
