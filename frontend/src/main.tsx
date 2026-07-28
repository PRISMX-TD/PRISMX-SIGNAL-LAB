import React from 'react'
import ReactDOM from 'react-dom/client'
import './styles/index.css'
import './i18n'
import App from './App'

// 这里原本有一段「锁死缩放」的代码：拦掉 iOS 的 gesturestart/change/end，再用
// touchend 的 300ms 判定干掉双击缩放。它存在的理由是「iOS Safari 会忽略 viewport
// 里的 user-scalable=no」——那句话没错，但结论反了：iOS 忽略它，恰恰说明这个平台
// 认为页面无权剥夺用户放大的能力。
//
// 已随 index.html 的 viewport 一起移除。本站在手机上要看的全是密集小号数字（K 线、
// 持仓盈亏、已平仓明细、纪律分进度条，全局最小字号 11px），放大看清一个价格是刚需，
// 禁用缩放是 WCAG 1.4.4 的明确违反项。删掉 viewport 里的 user-scalable=no 却留着
// 这段 JS，等于只修了安卓、iOS 依旧锁着——两处必须一起改，否则改了个寂寞。
//
// 顺带说明为什么不必担心「输入框聚焦时自动放大」：那是 iOS 独有的行为，触发条件是
// 输入框字号 < 16px，正解是把字号提到 16px，而不是禁掉整页缩放。
//
// This used to hold a "lock zoom" block: swallow iOS's gesturestart/change/end and
// kill double-tap zoom via a 300ms touchend check. Its stated reason was "iOS
// Safari ignores user-scalable=no in the viewport" — true, but the conclusion was
// backwards: iOS ignores it precisely because the platform holds that a page has
// no business taking zoom away from the user.
//
// Removed alongside the viewport change in index.html. This app is dense numeric UI
// on mobile (candles, position P&L, closed-trade tables, discipline bars; global
// minimum font size 11px), zooming in to read a price is a real need, and disabling
// zoom is a clear WCAG 1.4.4 violation. Dropping user-scalable=no from the viewport
// while leaving this JS in place would have fixed Android only and left iOS locked —
// both had to go together or neither mattered.
//
// On the "inputs auto-zoom on focus" worry: that's iOS-only and triggered by an
// input font size below 16px. The fix for that is a 16px font size, not disabling
// zoom for the whole page.

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

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
