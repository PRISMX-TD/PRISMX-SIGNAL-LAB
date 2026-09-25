// 构建时预渲染：把公开页渲染成真实 HTML 写进 dist/，并产出 app.html（SPA 壳
// + noindex，vercel.json 的 rewrite 兜底）与 sitemap.xml。
// 执行顺序见 package.json：vite build（客户端）→ vite build --ssr → 本脚本。
// 产物全部是静态文件，运行时零后端成本。
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(root, 'dist')
const { PUBLIC_PAGES, ORIGIN, renderPage } = await import(
  new URL('../dist-ssr/entry-server.js', import.meta.url).href
)

const template = readFileSync(join(dist, 'index.html'), 'utf8')
const SEO_BLOCK = /<!-- SEO:BEGIN -->[\s\S]*?<!-- SEO:END -->/

if (!SEO_BLOCK.test(template)) {
  throw new Error('dist/index.html 缺少 <!-- SEO:BEGIN/END --> 标记：index.html 的标记块被移动或删除了？')
}
if (!template.includes('<div id="root"></div>')) {
  throw new Error('dist/index.html 找不到空的 <div id="root"></div> 挂载点')
}
if (!/<html lang="[^"]*"/.test(template)) {
  throw new Error('dist/index.html 的 <html lang="..."> 属性形态变了——预渲染无法注入每页语言')
}

// ⓪ 每个公开页的 modulepreload 清单（来自 vite.config.ts 里 build.manifest 产出的
//    dist/.vite/manifest.json）。页面组件是懒加载的：没有这几条 <link>，浏览器要等入口
//    包下载、执行完，走到 import() 才开始拉页面 chunk——而 main.tsx 首次 render 前正是
//    在 await 这个 chunk（防 Suspense 把预渲染内容清成空白），串行一轮就是首屏可交互
//    晚一个往返。英文页额外预加载英文语言包（i18n/index.ts 里它是动态 import）。
//    入口 index.html 自己的静态依赖 Vite 已经写了 modulepreload，这里排除掉不重复。
//    清单读完即删：它列出全部源码路径，不该随站点公开发布。缺清单时只告警、照常预渲染。
// (0) Per-page modulepreload lists from dist/.vite/manifest.json (build.manifest in
//     vite.config.ts). Page components are lazy; without these links the page chunk
//     only starts downloading once the entry has run and reached import(), while
//     main.tsx awaits exactly that chunk before its first render. English pages also
//     preload the lazy en locale bundle. The entry's own static imports are already
//     preloaded by Vite and skipped. The manifest is deleted after reading (it lists
//     every source path); if it is missing we only warn.
const PAGE_SOURCES = {
  home: 'src/pages/LandingPage.tsx',
  terms: 'src/pages/LegalPage.tsx',
  privacy: 'src/pages/LegalPage.tsx',
  risk: 'src/pages/LegalPage.tsx',
  faq: 'src/pages/FaqPage.tsx',
}
const LOCALE_SOURCES = { en: 'src/i18n/en.json' }
const manifestPath = join(dist, '.vite', 'manifest.json')
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : null
if (!manifest) console.warn('prerender: 缺少 dist/.vite/manifest.json，公开页不注入 modulepreload')
rmSync(join(dist, '.vite'), { recursive: true, force: true })

// 入口已经（静态）带上的 chunk：不再重复预加载 / chunks the entry already loads statically
const entryKey = manifest && Object.keys(manifest).find((k) => manifest[k].isEntry)
const entryFiles = new Set()
;(function collect(key) {
  const c = manifest && manifest[key]
  if (!c || entryFiles.has(c.file)) return
  entryFiles.add(c.file)
  ;(c.imports || []).forEach(collect)
})(entryKey)

function preloadTags(sources) {
  if (!manifest) return ''
  const js = []
  const css = []
  const seen = new Set()
  const visit = (key) => {
    const c = manifest[key]
    if (!c || seen.has(key)) return
    seen.add(key)
    if (!entryFiles.has(c.file)) {
      js.push(c.file)
      ;(c.css || []).forEach((f) => css.push(f))
    }
    ;(c.imports || []).forEach(visit)
  }
  for (const src of sources) {
    if (!manifest[src]) throw new Error(`manifest 里找不到 ${src}：页面或语言包路径变了？同步改 prerender.mjs 的 PAGE_SOURCES / LOCALE_SOURCES`)
    visit(src)
  }
  return [
    ...[...new Set(css)].map((f) => `<link rel="stylesheet" crossorigin href="/${f}">`),
    ...[...new Set(js)].map((f) => `<link rel="modulepreload" crossorigin href="/${f}">`),
  ].join('\n    ')
}

// ① SPA 壳 app.html：登录后路由的 rewrite 兜底。noindex 一举两得——这些路由
//    本就不该进搜索结果，也防止 Google 收录一堆空壳 URL。
const shell = template.replace(SEO_BLOCK, '<meta name="robots" content="noindex" />\n    <title>Signal Lab</title>')
writeFileSync(join(dist, 'app.html'), shell)

// ② 公开页 × 2 语言
const langs = ['zh', 'en']
for (const page of PUBLIC_PAGES) {
  for (const lang of langs) {
    const { appHtml, headHtml, htmlLang } = await renderPage(page.id, lang)
    // 替换一律用回调形式：注入内容含 "$"（定价的 $0、$xx 文案），直接作为
    // 替换串会触发 String.replace 的 $& / $' 特殊语义，静默产出损坏的 HTML。
    const preloads = preloadTags([PAGE_SOURCES[page.id], ...(LOCALE_SOURCES[lang] ? [LOCALE_SOURCES[lang]] : [])])
    const html = template
      .replace(/<html lang="[^"]*"/, () => `<html lang="${htmlLang}"`)
      .replace(SEO_BLOCK, () => headHtml)
      .replace('</head>', () => (preloads ? `  ${preloads}\n  </head>` : '</head>'))
      .replace('<div id="root"></div>', () => `<div id="root">${appHtml}</div>`)
    const path = page.path[lang]
    const outDir = path === '/' ? dist : join(dist, ...path.slice(1).split('/'))
    mkdirSync(outDir, { recursive: true })
    writeFileSync(join(outDir, 'index.html'), html)
    console.log(`prerendered ${path}`)
  }
}

// ③ sitemap.xml：全部公开 URL，每条带成对 hreflang 互指
const alt = (hreflang, href) => `<xhtml:link rel="alternate" hreflang="${hreflang}" href="${href}"/>`
const urls = PUBLIC_PAGES.flatMap((p) =>
  langs.map((lang) => {
    const loc = ORIGIN + p.path[lang]
    return `  <url><loc>${loc}</loc>${alt('zh-CN', ORIGIN + p.path.zh)}${alt('en', ORIGIN + p.path.en)}${alt('x-default', ORIGIN + p.path.zh)}</url>`
  })
)
writeFileSync(
  join(dist, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${urls.join('\n')}\n</urlset>\n`
)
console.log(`prerender done: ${PUBLIC_PAGES.length * langs.length} pages + app.html + sitemap.xml`)
