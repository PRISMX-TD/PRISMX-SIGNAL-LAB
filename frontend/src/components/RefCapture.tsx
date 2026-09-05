// 邀请链接归因的捕获端。任意入口 URL 带 ?ref=码 时：存 localStorage（后点覆盖
// 先点，30 天有效，见 api/client.ts 的 storeRef/readRef）、并向后端打一次点击
// 计数（同一会话同一码只打一次，sessionStorage 防重）。
//
// 与 MetaPixel 同样的挂载位置与理由：BrowserRouter 内（要 useLocation）、Routes
// 外（要覆盖全部路由——落地页、/login 直达、/faq 等都可能是带 ref 的第一落点）。
// 落地页是预渲染静态页，Node 侧不执行 effect，捕获只能发生在浏览器端——正好。
//
// 打点直接用 fetch 而不是 client.ts 的 request()：这是无鉴权的 fire-and-forget，
// 后端一律 204 无响应体，request() 会去 res.json() 解析空体而抛错。
// Capture side of invite attribution. Stores ?ref= into localStorage (last
// click wins, 30-day TTL) and pings the click counter once per code per
// session. Mounted like MetaPixel: inside BrowserRouter, outside Routes, so
// every entry URL is covered. Uses raw fetch, not request(): fire-and-forget
// against an always-204 empty body that request() would try to JSON-parse.
import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import { inviteApi, storeRef } from '../api/client'

const CLICKED_KEY = 'prismx.ref.clicked'

export default function RefCapture() {
  const { search } = useLocation()

  useEffect(() => {
    // 整个 effect 体包在 try 里，而不是只包 storeRef：这里有三处存储写入
    // （localStorage 一处、sessionStorage 两处），一次全覆盖。存储写入是会抛的
    // ——配额耗尽、旧版 Safari 隐私模式、受限的 App 内置 WebView 都会让
    // setItem 直接 throw。而本组件是 RouteErrorBoundary 的**兄弟**节点（App.tsx）、
    // main.tsx 又没有顶层边界，effect 里抛出去就一路冒到 React 根节点，整棵树
    // 被卸载——用户看到的是白屏。而且它专挑本功能要抓的那批流量犯：带 ?ref= 的
    // 访问，且社交 App 内置浏览器占比更高。归因是尽力而为的软指标，任何情况下
    // 都不该弄坏页面本身；同 MetaPixel 判 fbq 存在，理由一样。
    // The whole effect body sits inside one try, not just storeRef: there are
    // three storage writes here (one localStorage, two sessionStorage) and this
    // covers all of them at once. Storage writes do throw — quota exhausted,
    // legacy Safari private mode, restricted in-app WebViews. RefCapture is a
    // *sibling* of RouteErrorBoundary (App.tsx) and main.tsx mounts <App/> with
    // no top-level boundary, so a throw escapes to the React root and unmounts
    // the whole tree — a blank page, firing only on the ?ref= traffic this
    // feature exists to capture and skewed toward social in-app browsers.
    // Attribution is best-effort and must never break the page (same reasoning
    // as MetaPixel's fbq guard).
    try {
      const code = new URLSearchParams(search).get('ref')?.trim()
      if (!code || code.length > 32) return
      storeRef(code)
      if (sessionStorage.getItem(CLICKED_KEY) === code) return
      sessionStorage.setItem(CLICKED_KEY, code)
      inviteApi.click(code).catch(() => {
        // 打点失败不打扰用户：点击数本就是软指标 / soft metric, fail silently
      })
    } catch {
      // 存储不可用就放弃这次归因，页面照常渲染 / storage unusable: drop
      // attribution for this visit, the page still renders
    }
  }, [search])

  return null
}
