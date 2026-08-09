// 构建时预渲染：把公开页渲染成真实 HTML 写进 dist/，并产出 app.html（SPA 壳
// + noindex，vercel.json 的 rewrite 兜底）与 sitemap.xml。
// 执行顺序见 package.json：vite build（客户端）→ vite build --ssr → 本脚本。
// 产物全部是静态文件，运行时零后端成本。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
    const html = template
      .replace(/<html lang="[^"]*"/, () => `<html lang="${htmlLang}"`)
      .replace(SEO_BLOCK, () => headHtml)
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
