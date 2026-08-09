// Meta Pixel 的单页应用（SPA）补丁。
//
// index.html 里的基础代码只在**首次加载**时发一次 PageView。本站是 react-router
// 前端路由，用户点导航时页面不会重新加载，fbq 也就不会再发 PageView——不补这一
// 段的话，Meta 后台只能看到"落地页 1 次浏览"，用户后续走到 /upgrade 完成付款的
// 整条路径全部丢失，受众定位与转化优化都建立在残缺数据上。
//
// 这是 Meta 官方对 SPA 的标准做法（在路由变化时手动 fbq('track','PageView')），
// 不是变通。
//
// 刻意挂在 BrowserRouter 内、Routes 外，覆盖**全部**路由：落地页、登录页、法务页
// 都在 Layout 之外，而落地页恰恰是广告流量的第一落点、最需要被追踪的一页。
// 项目自己的埋点（utils/pageTracking.ts）只覆盖 Layout 内的登录后页面，两者目的
// 不同，不要合并。
//
// SPA patch for the Meta Pixel. The base code in index.html fires PageView only on
// the initial document load; with client-side routing no further PageViews are sent
// unless we send them. This is Meta's documented approach for single-page apps.
// Mounted inside BrowserRouter but outside Routes so it covers every route —
// the landing page (the first stop for ad traffic) lives outside Layout, which is
// all the app's own telemetry covers.
import { useEffect, useRef } from 'react'
import { useLocation } from 'react-router-dom'

declare global {
  interface Window {
    fbq?: (...args: unknown[]) => void
  }
}

export default function MetaPixel() {
  const { pathname, search } = useLocation()

  // 跳过首次运行：基础代码已经为首屏发过一次 PageView，这里再发就重了。
  // Skip the first run: the base code already sent PageView for the initial load.
  const firstRun = useRef(true)

  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false
      return
    }
    // fbq 可能不存在——广告拦截插件会直接掐掉 connect.facebook.net，或者脚本还没
    // 加载完。基础代码里的存根会把调用排进队列，但拦截场景下连存根都没有，所以
    // 必须判存在再调，否则每次换页都抛一次 TypeError。
    // fbq may be absent: ad blockers cut connect.facebook.net entirely. The base
    // code's stub queues calls, but under a blocker even the stub is gone — guard
    // or every navigation throws.
    if (typeof window.fbq !== 'function') return
    window.fbq('track', 'PageView')
  }, [pathname, search])

  return null
}
