// 预渲染入口：由 `vite build --ssr` 打成 dist-ssr/entry-server.js，再被
// scripts/prerender.mjs 在 Node 里调用。只渲染公开页，且刻意做到三个「不」：
// 不 import main.tsx（那里有模块顶层的浏览器事件监听）；不挂 AuthProvider/
// PrefsProvider（公开页组件不消费它们，挂了反而把 localStorage 依赖拖进 Node）；
// 不渲染 Home 包装（它要 useAuth，这里直接渲染 LandingPage）。
import type { ReactElement } from 'react'
import { renderToString } from 'react-dom/server'
import { StaticRouter } from 'react-router-dom/server'
import i18n from '../i18n'
import en from '../i18n/en.json'
import LandingPage from '../pages/LandingPage'
import LegalPage from '../pages/LegalPage'
import FaqPage from '../pages/FaqPage'
import { pageById, type PageId, type PublicLang } from './meta'
import { buildHead } from './head'

export { PUBLIC_PAGES, ORIGIN } from './meta'

// 浏览器端英文包是动态 import 按需拉的（见 i18n/index.ts）；预渲染要同一次进程里
// 连续渲染中英两套页面，这里直接静态塞进去，changeLanguage('en') 就不走异步加载。
// In the browser the en bundle is a lazy import (see i18n/index.ts); prerendering
// renders both languages in one process, so it is added statically here and
// changeLanguage('en') never goes through the async loader.
i18n.addResourceBundle('en', 'translation', en, true, true)

const PAGE_ELEMENTS: Record<PageId, () => ReactElement> = {
  home: () => <LandingPage />,
  terms: () => <LegalPage doc="terms" />,
  privacy: () => <LegalPage doc="privacy" />,
  risk: () => <LegalPage doc="risk" />,
  faq: () => <FaqPage />,
}

export async function renderPage(
  id: PageId,
  lang: PublicLang
): Promise<{ appHtml: string; headHtml: string; htmlLang: string }> {
  await i18n.changeLanguage(lang)
  const path = pageById(id).path[lang]
  const appHtml = renderToString(<StaticRouter location={path}>{PAGE_ELEMENTS[id]()}</StaticRouter>)
  return {
    appHtml,
    headHtml: buildHead(id, lang, i18n.getFixedT(lang)),
    htmlLang: lang === 'en' ? 'en' : 'zh-CN',
  }
}
