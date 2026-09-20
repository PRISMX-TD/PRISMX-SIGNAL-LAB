// MediaQueryList 的订阅兜底 / subscribing to a MediaQueryList, safely
//
// `mql.addEventListener('change', fn)` 需要 MediaQueryList 实现 EventTarget，而
// **Safari 直到 14 才给它加上**。本项目的构建下限显式包含 `safari12`
// （vite.config.ts 的 target），也就是 iOS 12 / 13 属于目标范围。
//
// 在那些浏览器上 `addEventListener` 是 undefined，effect 里直接抛 TypeError；
// React 把它冒泡到 ErrorBoundary，**整个落地页白屏**。这不是「动效降级」，
// 是首屏全废——而落地页恰好是唯一一个匿名访客必经的页面。
// 旧接口 `addListener` / `removeListener` 从 Safari 6 起就有，且在现代浏览器里
// 仍然可用（只是标记为废弃），所以特性检测一次、两边都覆盖即可。
//
// 返回一个退订函数，调用方在 effect 的 cleanup 里调用。
//
// 2026-09-20：从 components/landing/ 搬到 utils/。它原本只服务落地页的两个组件，
// 但 utils/useMediaQuery.ts 犯的是一模一样的错（订单页的手机/桌面分支靠它，
// Safari 12/13 上一进 /orders 就白屏），而从 utils/ 反向 import 落地页组件目录
// 是错误的依赖方向。搬过来之后三个调用点共用同一份判据。
// 2026-09-20: moved here from components/landing/. It served the landing page's
// two components, but utils/useMediaQuery.ts had the identical bug (the orders
// page's phone/desktop split depends on it, so Safari 12/13 blanked /orders on
// entry), and importing a landing-page component from utils/ would be the wrong
// dependency direction. All three call sites now share one implementation.
//
// `mql.addEventListener('change', fn)` requires MediaQueryList to implement
// EventTarget, which Safari only did from version 14. This project's build target
// explicitly includes `safari12` (see vite.config.ts), so iOS 12/13 are in scope.
// There, `addEventListener` is undefined and the effect throws a TypeError that
// React bubbles to the ErrorBoundary, blanking the entire landing page — not a
// degraded animation but a dead first screen, on the one page every anonymous
// visitor has to pass through.
// The legacy `addListener` / `removeListener` pair has existed since Safari 6 and
// still works in modern browsers (merely deprecated), so one feature check covers
// both. Returns an unsubscribe function for the effect's cleanup.

/** 老接口的形状；现代 lib.dom 里这两个方法是 deprecated，但类型仍在。
 *  The legacy shape; still typed in lib.dom, just deprecated. */
type LegacyMql = MediaQueryList & {
  addListener?: (cb: (e: MediaQueryListEvent) => void) => void
  removeListener?: (cb: (e: MediaQueryListEvent) => void) => void
}

export function onMediaQuery(mql: MediaQueryList, fn: () => void): () => void {
  const m = mql as LegacyMql
  if (typeof m.addEventListener === 'function') {
    m.addEventListener('change', fn)
    return () => m.removeEventListener('change', fn)
  }
  if (typeof m.addListener === 'function') {
    m.addListener(fn)
    return () => m.removeListener?.(fn)
  }
  // 两个接口都没有：不订阅，但**绝不抛**。挂载时读到的那次 matches 仍然生效，
  // 只是不再跟随断点变化——对一台不会旋转的老机器来说这是可接受的降级。
  // Neither API: subscribe to nothing, but never throw. The value read at mount
  // still applies; it just stops following breakpoint changes.
  return () => {}
}
