// 「页面/App 在不在前台」的统一判定 + 回前台订阅（带去重）。
//
// 为什么不只看 document.hidden：Capacitor 不调 WebView.onPause，App 锁屏 / 切后台时
// visibilitychange 在不少 WebView 上根本不变（APP Pack resume.ts 也这么写）。App 壳
// 拿到可靠的原生 appStateChange 后会向页面派发 window 事件 'apppack:background' /
// 'apppack:foreground'，这里把它们与 visibilitychange 合并：任一说「在后台」就算后台。
// 回前台时 focus、visibilitychange、apppack:foreground 可能几毫秒内接连触发，onForeground
// 按时间窗去重，同一次回前台只回调一次。
//
// One place to decide "is the page/app in the foreground" and to subscribe to "back to
// foreground" with de-duplication. document.hidden alone is not enough: Capacitor never calls
// WebView.onPause, so on many WebViews visibilitychange does not change when the app is locked
// or backgrounded. The App shell dispatches window events 'apppack:background' /
// 'apppack:foreground' from the reliable native appStateChange; they are merged with
// visibilitychange here (either one saying "background" counts). On return, focus,
// visibilitychange and apppack:foreground can fire within milliseconds of each other, so
// onForeground de-duplicates by time window: one callback per real return.

export const APP_BACKGROUND_EVENT = 'apppack:background'
export const APP_FOREGROUND_EVENT = 'apppack:foreground'
export const FOREGROUND_DEDUPE_MS = 2_000

let shellBackground = false
let installed = false

function install() {
  if (installed || typeof window === 'undefined') return
  installed = true
  window.addEventListener(APP_BACKGROUND_EVENT, () => {
    shellBackground = true
  })
  window.addEventListener(APP_FOREGROUND_EVENT, () => {
    shellBackground = false
  })
  // 页面自己报告可见了，就不再信一个可能漏掉 foreground 事件的旧「后台」标记。
  // The page itself reporting visible overrides a stale "background" flag whose foreground
  // event may have been missed.
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) shellBackground = false
    })
  }
}
install()

/** 页面或 App 壳任一方判定为后台 / hidden per document or per the App shell */
export function isAppHidden(): boolean {
  install()
  return (typeof document !== 'undefined' && document.hidden) || shellBackground
}

/** 仅测试用：复位壳标记 / test-only reset */
export function __resetAppVisibilityForTest() {
  shellBackground = false
  installed = false
}

/**
 * 回前台时调用 cb（focus / visibilitychange 变可见 / apppack:foreground 三路合一），
 * 每个订阅各自按 dedupeMs 去重。返回取消订阅函数。
 * Call cb when returning to the foreground (focus / visibilitychange→visible /
 * apppack:foreground merged); each subscription de-duplicates on its own dedupeMs window.
 */
export function onForeground(
  cb: () => void,
  dedupeMs = FOREGROUND_DEDUPE_MS,
  opts: { focus?: boolean } = {},
): () => void {
  const useFocus = opts.focus !== false
  install()
  let lastAt = -Infinity
  const fire = () => {
    if (isAppHidden()) return
    const now = Date.now()
    if (now - lastAt < dedupeMs) return
    lastAt = now
    cb()
  }
  const onVisibility = () => {
    if (!document.hidden) fire()
  }
  document.addEventListener('visibilitychange', onVisibility)
  if (useFocus) window.addEventListener('focus', fire)
  window.addEventListener(APP_FOREGROUND_EVENT, fire)
  return () => {
    document.removeEventListener('visibilitychange', onVisibility)
    if (useFocus) window.removeEventListener('focus', fire)
    window.removeEventListener(APP_FOREGROUND_EVENT, fire)
  }
}
