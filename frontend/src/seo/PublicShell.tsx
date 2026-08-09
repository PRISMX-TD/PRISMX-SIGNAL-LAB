// 公开页外壳：包在每个公开路由外面（见 App.tsx）。两件事：
// ① 按路由声明的语言同步 i18n（syncLanguage，不写偏好——被动访问 /en 不该
//    覆盖用户主动选过的语言）；
// ② SPA 内部导航时同步 title/description/canonical：预渲染的 head 只对首次
//    加载生效，从首页点到 /faq 时 head 还停在首页那套，这里补上。
import { useEffect, type ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import { useAuth } from '../store/auth'
import { syncLanguage } from '../i18n'
import { langFromPath, pageById, ORIGIN, type PageId, type PublicLang } from './meta'

export default function PublicShell({ lang, page, children }: { lang: PublicLang; page: PageId; children: ReactNode }) {
  // useAuth 在这里是安全的：PublicShell 只在客户端路由树（AuthProvider 之内）
  // 出现；预渲染入口（seo/entry-server.tsx）直接渲染页面组件，不经过本组件。
  const { isAuthed } = useAuth()

  useEffect(() => {
    // 首页对已登录用户只是个跳板（Home 立刻重定向去 /dashboard），此时不能
    // 同步语言——否则英文偏好的用户输入根域名，会被「中文首页」的声明悄悄
    // 切回中文界面。法务页与 FAQ 页登录后也能看，URL 语言照常生效。
    if (page === 'home' && isAuthed) return
    syncLanguage(lang)
  }, [lang, page, isAuthed])

  useEffect(() => {
    const def = pageById(page)
    document.title = def.title[lang]
    document.querySelector('meta[name="description"]')?.setAttribute('content', def.description[lang])
    document.querySelector('link[rel="canonical"]')?.setAttribute('href', ORIGIN + def.path[lang])
  }, [page, lang])

  return <>{children}</>
}

// 当前公开页的语言（从 URL 推导）。放这里而不是 meta.ts：要用 react-router 的 hook。
export function usePublicLang(): PublicLang {
  const { pathname } = useLocation()
  return langFromPath(pathname) ?? 'zh'
}
