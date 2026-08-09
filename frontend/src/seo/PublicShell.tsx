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
    // 首页对已登录用户只是个跳板（Home 立刻重定向去 /dashboard）。但 i18n 在
    // 模块初始化时已按 URL 把 '/' 判成中文（见 i18n/index.ts 的 urlLang 优先），
    // 光跳过同步不够——要把语言还原成用户存储的偏好，别让「中文首页」的 URL
    // 声明污染登录后的界面语言。localStorage 在这里安全：PublicShell 只在
    // 客户端渲染（见下方 useAuth 注释）。
    if (page === 'home' && isAuthed) {
      syncLanguage(localStorage.getItem('prismx_lang') === 'en' ? 'en' : 'zh')
      return
    }
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
