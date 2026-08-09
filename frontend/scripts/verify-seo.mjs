// 构建校验：断言预渲染产物的关键 SEO 特征，挂在 postbuild 自动执行。
// 存在意义：预渲染是「悄悄坏掉也不报错」的典型——某个组件加了句模块顶层的
// window 访问、标记块被挪动、文案键改名，产物就会缺页或缺内容，而站点表面
// 一切正常。这里把关键特征钉死，坏了就让构建红掉。
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist')
const ORIGIN = 'https://prismxsignallab.com'
let failures = 0
const fail = (msg) => {
  failures++
  console.error(`  ✗ ${msg}`)
}
const read = (rel) => {
  const p = join(dist, rel)
  if (!existsSync(p)) {
    fail(`缺少文件 ${rel}`)
    return null
  }
  return readFileSync(p, 'utf8')
}
const expect = (rel, html, needle, label) => {
  if (html && !html.includes(needle)) fail(`${rel} 缺少${label}：${needle}`)
}
const expectInH1 = (rel, html, needle, label) => {
  if (!html) return
  const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)
  if (!h1Match || !h1Match[1].includes(needle)) {
    fail(`${rel} 的 <h1> 中缺少${label}：${needle}`)
  }
}
const expectInTitle = (rel, html, needle, label) => {
  if (!html) return
  const titleMatch = html.match(/<title>([\s\S]*?)<\/title>/)
  if (!titleMatch || !titleMatch[1].includes(needle)) {
    fail(`${rel} 的 <title> 中缺少${label}：${needle}`)
  }
}

// [文件, canonical 路径, html lang, 正文标志文案, title 标志文案]
const PAGES = [
  ['index.html', '/', 'zh-CN', '情绪归零', '信号实验室'],
  ['en/index.html', '/en', 'en', 'Emotions to zero', 'Trading Signals'],
  ['terms/index.html', '/terms', 'zh-CN', '服务条款', '服务条款'],
  ['en/terms/index.html', '/en/terms', 'en', 'Terms of Service', 'Terms of Service'],
  ['privacy/index.html', '/privacy', 'zh-CN', '隐私政策', '隐私政策'],
  ['en/privacy/index.html', '/en/privacy', 'en', 'Privacy Policy', 'Privacy Policy'],
  ['risk/index.html', '/risk', 'zh-CN', '风险披露', '风险披露'],
  ['en/risk/index.html', '/en/risk', 'en', 'Risk Disclosure', 'Risk Disclosure'],
  ['faq/index.html', '/faq', 'zh-CN', '常见问题', '常见问题'],
  ['en/faq/index.html', '/en/faq', 'en', 'Frequently Asked', 'FAQ'],
]

for (const [file, path, htmlLang, bodyText, titleText] of PAGES) {
  const html = read(file)
  if (!html) continue
  expect(file, html, '<h1', '<h1> 标签')
  expectInH1(file, html, bodyText, '正文标志文案')
  expect(file, html, `<title>`, 'title 标签')
  expectInTitle(file, html, titleText, 'title 标志文案')
  expect(file, html, `<html lang="${htmlLang}"`, 'lang 声明')
  expect(file, html, `<link rel="canonical" href="${ORIGIN}${path}" />`, 'canonical')
  expect(file, html, 'hreflang="zh-CN"', 'hreflang zh-CN')
  expect(file, html, 'hreflang="en"', 'hreflang en')
  expect(file, html, 'hreflang="x-default"', 'hreflang x-default')
  if (html.includes('name="robots" content="noindex"')) fail(`${file} 不该含 noindex`)
}

const home = read('index.html')
if (home) {
  expect('index.html', home, '"@type":"Organization"', 'Organization JSON-LD')
  expect('index.html', home, '"@type":"WebSite"', 'WebSite JSON-LD')
}
const faq = read('faq/index.html')
if (faq) expect('faq/index.html', faq, '"@type":"FAQPage"', 'FAQPage JSON-LD')

const shell = read('app.html')
if (shell) {
  expect('app.html', shell, '<meta name="robots" content="noindex" />', 'noindex')
  expect('app.html', shell, '<div id="root"></div>', '空 root（不该混入预渲染内容）')
}

const sitemap = read('sitemap.xml')
if (sitemap) {
  const locs = (sitemap.match(/<loc>/g) || []).length
  if (locs !== 10) fail(`sitemap.xml 应有 10 个 <loc>，实际 ${locs}`)
}
read('robots.txt')

if (failures) {
  console.error(`SEO 校验失败：${failures} 处`)
  process.exit(1)
}
console.log('SEO 校验通过 ✓')
