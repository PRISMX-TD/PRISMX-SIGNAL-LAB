// 未登录访客打开受保护页面时该去哪。站内比赛页（/competitions?c=<id>）的地址常被直接
// 复制转发，未登录的人打开它应看到公开比赛页 /c/<id>，而不是被丢去登录页；比赛未公开时
// 公开页自己会显示「不存在或未公开」并给登录入口。其余受保护页面照旧去 /login。
// ?ref= 原样带过去（RefCapture 在任何路由都会先记下，带过去只是让地址栏保持一致）。
// Where a logged-out visitor goes from a protected URL. The in-app competition URL
// (/competitions?c=<id>) gets shared verbatim; a logged-out opener should land on the
// public page /c/<id>, not the login page (a non-public competition shows its own
// not-found notice with a login link). Everything else still goes to /login.
import { isCompId } from './compIntent'

export function loggedOutRedirect(pathname: string, search: string): string {
  if (pathname.replace(/\/+$/, '') !== '/competitions') return '/login'
  const params = new URLSearchParams(search)
  const c = params.get('c')
  const ref = params.get('ref')
  const target = isCompId(c) ? `/c/${c.toLowerCase()}` : '/c'
  return ref ? `${target}?ref=${encodeURIComponent(ref)}` : target
}
