import React from 'react'
import ReactDOM from 'react-dom/client'
import './styles/index.css'
import './i18n'
import App from './App'
import { recordDiag } from './utils/pushDiag'

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
// 用 load 事件延后：注册会争抢首屏的网络与主线程，而它带来的收益（离线兜底）
// 在首屏渲染完之后才有意义。
//
// Service worker registration. Previously the only path that registered it was
// "user enables push" (see getSWReg in utils/push.ts), so for anyone who never
// turned push on, the worker simply didn't exist. It now also provides the offline
// shell (see public/sw.js), which should apply to everyone — hence one
// registration at app start. Failures are silent: not registering only costs the
// offline fallback and push, and must not affect the app booting. Deferred to the
// load event because registration competes with first paint for network and main
// thread, while what it buys (an offline fallback) only matters afterwards.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .then(() => recordDiag('sw-register'))
      // 失败仍然不影响启动，但原因记进诊断供面板读取。
      // Still non-fatal to boot, but the reason is recorded for the panel.
      .catch((err) => recordDiag('sw-register', err))
  })
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

// Android / 其他平台：多指触摸直接阻止（单指滚动不受影响）。
// Android / everything else: block any multi-touch gesture outright (single-
// finger scrolling is untouched).
document.addEventListener('touchmove', e => {
  if (e.touches.length > 1) e.preventDefault()
}, { passive: false })

// 双击缩放：iOS 用 300ms 内两次 touchend 判定双击，CSS touch-action 覆盖不到
// 这个路径（pan-y 本该连双击缩放一起关掉，但 iOS 在部分版本上仍会漏放）。
// Double-tap zoom: iOS detects a double-tap via two touchend events within
// 300ms, a path CSS touch-action doesn't reliably cover on every iOS version
// even though pan-y is supposed to disable it too.
let lastTouchEnd = 0
document.addEventListener('touchend', e => {
  const now = Date.now()
  if (now - lastTouchEnd <= 300) e.preventDefault()
  lastTouchEnd = now
}, { passive: false })

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
