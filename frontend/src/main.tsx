// 必须是第一条 import：给老引擎补 Promise.allSettled 等运行时 API（见文件头说明）。
// Must stay the first import: runtime API shims for older engines (see its header).
import './polyfills'
import React from 'react'
import ReactDOM from 'react-dom/client'
import './styles/index.css'
import { i18nReady } from './i18n'
import App, { bootPreload } from './App'
import { onIdle } from './utils/idle'
import { recordDiag } from './utils/pushDiag'
import { FESTIVAL_DEMO } from './festival/FestivalProvider'
import { installMockBackend, mockActive } from './festival/demo/mockBackend'

// 产品决定：无论安卓还是 iOS，无论浏览器标签页还是主屏幕安装的 PWA，都不允许
// 双指缩放/双击缩放——页面本身用 initial-scale=1.0 + width=device-width 做到了
// "打开即自适应屏幕"，缩放只会破坏原生 App 的观感。这与早前版本"仅 standalone
// 锁定、浏览器保留 WCAG 1.4.4 缩放能力"的方案不同：那一版在浏览器标签页里遗留
// 了可缩放入口，与产品要的"全平台都不能缩放"冲突，故改为下方无条件生效。
//
// Product decision: disable pinch/double-tap zoom everywhere — Android or iOS,
// browser tab or Home-Screen-installed PWA. initial-scale=1.0 + width=device-width
// already makes the page auto-fit the screen on load; zoom only breaks the
// native-app feel. This supersedes the earlier "standalone-only lock, browser
// keeps WCAG 1.4.4 zoom" approach, which left zoom reachable from a plain
// browser tab — the opposite of "no zoom on any platform."

// Service Worker 注册。此前只有「用户开启推送」这一条路径会注册它（见
// utils/push.ts 的 getSWReg），所以从不开推送的用户身上，这个 SW 根本不存在。
// 现在 SW 还负责离线壳（见 public/sw.js），那部分对所有人都该生效，所以在应用
// 启动时统一注册一次。
// 失败静默：注册不上只是少一层离线兜底与推送能力，不该影响应用本身启动。
// 延后到空闲时：注册会争抢首屏的网络与主线程，而它带来的收益（离线兜底）
// 在首屏渲染完之后才有意义（为什么不再用 load 事件见下方）。
//
// Service worker registration. Previously the only path that registered it was
// "user enables push" (see getSWReg in utils/push.ts), so for anyone who never
// turned push on, the worker simply didn't exist. It now also provides the offline
// shell (see public/sw.js), which should apply to everyone — hence one
// registration at app start. Failures are silent: not registering only costs the
// offline fallback and push, and must not affect the app booting. Deferred to an
// idle period (not the load event any more, see below) because registration competes with first paint for network and main
// thread, while what it buys (an offline fallback) only matters afterwards.
// 2026-09-19：这里是全站**唯一**的注册点。utils/push.ts 的 getSWReg 曾经自己再注册
// 一遍，两条路径抢着写同一个 sw-register 诊断格子（pushDiag 是 Map，后写覆盖先写），
// 排查推送时看到的可能是这一次的结果而不是推送路径的；它现在改成等
// navigator.serviceWorker.ready，不再注册。
// Since 2026-09-19 this is the only registration site. getSWReg in utils/push.ts
// used to register again, and the two racing paths wrote the same sw-register
// diagnostics slot (pushDiag is a Map, last write wins), so the entry seen while
// debugging push could belong to this call rather than the push path. It now
// awaits navigator.serviceWorker.ready instead of registering.
if ('serviceWorker' in navigator) {
  const registerSW = () => {
    navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .then(() => recordDiag('sw-register'))
      // 失败仍然不影响启动，但原因记进诊断供面板读取。
      // Still non-fatal to boot, but the reason is recorded for the panel.
      .catch((err) => recordDiag('sw-register', err))
  }
  // 2026-09-25：不再等 window load。load 要等页面上**所有**子资源结束，包括
  // connect.facebook.net / accounts.google.com 这类在大陆连不通、会挂到超时的第三方
  // 脚本——注册因此被拖后几十秒甚至整段会话都没发生，推送链路就断在第一步。
  // 改成 DOMContentLoaded 之后等一次浏览器空闲（onIdle 自带 setTimeout 兜底）：仍然
  // 让开首屏，但不再和第三方的网络状况绑在一起。
  // readyState 已经过了 loading 就直接排空闲，别再挂监听器：模块脚本是 defer 执行的，
  // 跑到这里时 DOMContentLoaded 往往已经触发过，错过的事件监听器永远不会回调——而
  // getSWReg 只等不注册，这里没跑就没有第二条路。
  // Since 2026-09-25 this no longer waits for window load, which waits for every
  // subresource including third-party scripts (connect.facebook.net,
  // accounts.google.com) that hang until timeout from mainland China — delaying
  // registration by tens of seconds or for the whole session. Now: after
  // DOMContentLoaded, on the next idle period (onIdle has a setTimeout fallback).
  // If readyState is already past "loading" (module scripts run deferred, so
  // DOMContentLoaded has often fired by now), schedule directly: a missed event's
  // listener never fires, and getSWReg only waits rather than registering.
  const scheduleSW = () => {
    onIdle(registerSW, 3000)
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', scheduleSW, { once: true })
  else scheduleSW()
}

// viewport meta 里的 user-scalable=no（见 index.html）覆盖 Android Chrome；
// iOS Safari 从 10 起忽略这条声明本身，下面用 gesturestart/touchend 在事件层面
// 兜底拦截，两边合起来才是全平台锁死。
// user-scalable=no in the viewport meta (see index.html) covers Android
// Chrome; iOS Safari has ignored that directive since iOS 10, so the
// gesturestart/touchend listeners below intercept it at the event level —
// together they lock zoom on every platform.

// iOS Safari（含浏览器标签页与 standalone PWA）：CSS touch-action: pan-y 对
// 双指缩放不生效，缩放走的是 gesture 事件而不是 touch 事件，必须单独拦截。
// iOS Safari (browser tab and standalone PWA alike): CSS touch-action: pan-y
// does not stop pinch-zoom there — zoom runs through gesture events, not touch
// events, so it needs its own interception.
document.addEventListener('gesturestart', e => e.preventDefault())
document.addEventListener('gesturechange', e => e.preventDefault())

// 2026-09-25：删掉了原来这里的 document 级 touchmove（passive: false，多指时
// preventDefault）。它想挡的双指缩放已经有三层覆盖：Android 靠 viewport 的
// user-scalable=no + body 的 touch-action: pan-y（layer-base.css，pan-y 不含
// pinch-zoom）；iOS 靠上面的 gesturestart/gesturechange。而它本身的代价是实打实的：
// 一个 passive:false 的 document 级 touchmove 会让浏览器每一次滚动都先等主线程跑完
// 监听器才能开始滚——图表页这种主线程忙的页面上就是滚动掉帧。
// Removed (2026-09-25): the document-level touchmove (passive: false, preventDefault
// on multi-touch). Pinch zoom is already covered three ways — Android by the
// viewport's user-scalable=no plus body touch-action: pan-y (layer-base.css; pan-y
// excludes pinch-zoom), iOS by gesturestart/gesturechange above — while a
// non-passive document touchmove makes every scroll wait on the main thread first,
// i.e. scroll jank on busy pages such as the charts terminal.

// 双击缩放：iOS 用 300ms 内两次 touchend 判定双击，CSS touch-action 覆盖不到
// 这个路径（pan-y 本该连双击缩放一起关掉，但 iOS 在部分版本上仍会漏放）。
// 落在可交互控件上的第二次点击**不拦**：对 touchend 调 preventDefault 会连带吞掉
// 浏览器合成的 click，于是「＋手数」「−手数」这类要连点的按钮 300ms 内只认第一下。
// 控件上的双击缩放照样被 body 的 touch-action: pan-y 挡住（touch-action 沿祖先链取
// 交集，按钮继承了这条限制），这里只需兜住空白区域。
// Double-tap zoom: iOS detects a double-tap via two touchend events within
// 300ms, a path CSS touch-action doesn't reliably cover on every iOS version
// even though pan-y is supposed to disable it too. A second tap landing on an
// interactive control is NOT intercepted: preventDefault on touchend also
// swallows the synthesized click, so rapid-tap buttons (lot size +/−) only
// registered the first tap within 300ms. Double-tap zoom on controls is still
// blocked by body's touch-action: pan-y (touch-action intersects down the
// ancestor chain), so this only needs to cover non-interactive areas.
const TAP_THROUGH = 'button, a, input, select, textarea, label, [role="button"], [contenteditable="true"]'
let lastTouchEnd = 0
document.addEventListener('touchend', e => {
  const now = Date.now()
  const target = e.target
  const onControl = target instanceof Element && target.closest(TAP_THROUGH) !== null
  if (!onControl && now - lastTouchEnd <= 300) e.preventDefault()
  lastTouchEnd = now
}, { passive: false })

// 节日演示：从演示面板进入「App 演示」后，用示例数据代替后端（生产构建不生效）。
// Festival demo: after "Enter app demo" in the demo panel, sample data stands in
// for the backend. Inert in production builds.
if (FESTIVAL_DEMO && mockActive()) installMockBackend()

// 首次 render 前先等两件事，都是为了不让 Suspense 把预渲染 HTML 清成空白：
// ① 语言包就绪（初始语言为 en 时要等英文包，见 i18n/index.ts）；
// ② 公开页（落地页 / 法务 / FAQ）的页面 chunk 就绪（见 App.tsx 的 lazyPage）。
// 两者都有 modulepreload 提前开拉（scripts/prerender.mjs 注入），通常早已到位；
// 其余路由 bootPreload 立即 resolve，不推迟首帧。等待期间用户看到的是预渲染好的静态
// 页面，比闪一下空白占位好。任何一步失败都照常 render（各自有兜底与重试）。
// 仍是 createRoot 而不是 hydrateRoot：预渲染与客户端首帧并不逐字一致（登录态、节日
// 装饰、localStorage 语言），hydration 不匹配的代价比这里整块替换一次更大。
// Before the first render wait for (1) the locale bundle (en needs its lazy bundle)
// and (2) the public page's chunk, so Suspense never blanks the prerendered HTML.
// Both are usually already in thanks to modulepreload (injected by prerender.mjs);
// other routes resolve immediately. Failures still render. Still createRoot, not
// hydrateRoot: prerender and the first client frame aren't identical (auth state,
// festival decor, stored language) and mismatches would cost more than one swap.
Promise.all([i18nReady, bootPreload(window.location.pathname)])
  .catch(() => {})
  .then(() => {
    ReactDOM.createRoot(document.getElementById('root')!).render(
      <React.StrictMode>
        <App />
      </React.StrictMode>,
    )
  })
