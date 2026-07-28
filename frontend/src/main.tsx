import React from 'react'
import ReactDOM from 'react-dom/client'
import './styles/index.css'
import './i18n'
import App from './App'

// 这里原本有一段「锁死缩放」的代码。已随 index.html 的 viewport 一起移除，
// 浏览器模式下保留 WCAG 1.4.4 要求的缩放能力。PWA standalone（主屏图标启动）
// 在下方的 isStandalone 分支中重新启用缩放锁定——用户从主屏打开时才期待 App
// 行为，浏览器打开时保持网页应有的无障碍标准。
//
// This used to hold a "lock zoom" block. Removed alongside the viewport change
// in index.html; browser mode keeps zoom as required by WCAG 1.4.4. PWA
// standalone (launched from the Home Screen) re-enables the zoom lock in the
// isStandalone block below — users only expect app behaviour from the Home
// Screen icon, not from a browser tab.

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
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {})
  })
}

// PWA standalone 模式下锁死缩放与横向拖动，营造原生 App 手感。
// 浏览器模式保留缩放→无障碍（WCAG 1.4.4），仅在从主屏幕图标启动的
// 独立窗口里禁用——那才是用户期望的"App 行为"。
// Lock zoom and horizontal drag in PWA standalone mode for a native-app feel.
// Browser access keeps zoom → accessibility (WCAG 1.4.4); zoom is only locked
// when launched standalone from the Home Screen, where users expect app behaviour.
const isStandalone = window.matchMedia('(display-mode: standalone)').matches
if (isStandalone) {
  // 改写 viewport meta：加上 user-scalable=no / maximum-scale=1。
  // Android Chrome 会遵守；iOS Safari 从 10 起忽略，但下面用 gesturestart 补防。
  const vp = document.querySelector('meta[name="viewport"]')
  if (vp) vp.setAttribute('content', 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover')

  // iOS Safari standalone PWA 特有：CSS touch-action: pan-y 对它不生效，
  // 双指缩放必须通过 gesture 事件拦截。
  document.addEventListener('gesturestart', e => e.preventDefault())
  document.addEventListener('gesturechange', e => e.preventDefault())

  // Android / 其他平台：多指触摸直接阻止（单指滚动不受影响）。
  document.addEventListener('touchmove', e => {
    if (e.touches.length > 1) e.preventDefault()
  }, { passive: false })
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
