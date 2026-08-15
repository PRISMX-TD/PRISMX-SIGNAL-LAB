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
import { API_BASE, storeRef } from '../api/client'

const CLICKED_KEY = 'prismx.ref.clicked'

export default function RefCapture() {
  const { search } = useLocation()

  useEffect(() => {
    const code = new URLSearchParams(search).get('ref')?.trim()
    if (!code || code.length > 32) return
    storeRef(code)
    if (sessionStorage.getItem(CLICKED_KEY) === code) return
    sessionStorage.setItem(CLICKED_KEY, code)
    fetch(`${API_BASE}/api/invite/click`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    }).catch(() => {
      // 打点失败不打扰用户：点击数本就是软指标 / soft metric, fail silently
    })
  }, [search])

  return null
}
