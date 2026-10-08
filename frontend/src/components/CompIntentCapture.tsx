// 比赛推广链接的报名意图捕获端：未登录访客打开 /c/<compId> 时记下这场比赛（见
// utils/compIntent.ts），注册 / 登录 / 补全资料 / 直连绑定成功后据此送回站内比赛页。
// /c（无 id，主推比赛）由 PublicCompetitionPage 取到 id 后自己调用 storeCompIntent。
//
// 挂载位置与理由同 RefCapture：BrowserRouter 内（要 useLocation）、Routes 外且排在
// Routes 之前（覆盖全部路由、首访同一次提交里先写入）。已登录的人不记——公开页会直接
// 把他带去站内比赛页，记下来只会让他以后每次登录都被拐过去。
// 整个 effect 包在 try 里，理由同 RefCapture：本组件在 RouteErrorBoundary 之外，抛出去
// 就是整站白屏；而这批流量恰好以社交 App 内置浏览器为主。
//
// Capture side of the competition intent: a logged-out visitor opening /c/<compId> gets the
// competition remembered (utils/compIntent.ts) so sign-up / sign-in / profile completion /
// direct bind can send them back. /c (featured, no id) is stored by PublicCompetitionPage once
// it knows the id. Mounted like RefCapture: inside BrowserRouter, outside and before Routes.
// Signed-in visitors are not recorded — the public page forwards them straight away, and a
// stored intent would hijack every later sign-in. The whole effect sits in a try for the same
// reason as RefCapture: this is outside RouteErrorBoundary, and a throw blanks the site.
import { useEffect } from 'react'
import { matchPath, useLocation } from 'react-router-dom'
import { useAuth } from '../store/auth'
import { storeCompIntent } from '../utils/compIntent'

export default function CompIntentCapture() {
  const { pathname } = useLocation()
  const { isAuthed } = useAuth()

  useEffect(() => {
    if (isAuthed) return
    try {
      const compId = matchPath('/c/:compId', pathname)?.params.compId
      if (compId) storeCompIntent(compId)
    } catch {
      // 记不下就放弃，页面照常渲染 / unable to record: drop it, the page still renders
    }
  }, [pathname, isAuthed])

  return null
}
