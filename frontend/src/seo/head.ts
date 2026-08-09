// 预渲染 head 生成：按「路由×语言」产出 SEO:BEGIN/END 区块的替换内容。
// 只被预渲染链路（entry-server → prerender.mjs）使用；浏览器端对应的运行时
// 逻辑是 PublicShell 的 head 同步（title/description/canonical 三项）。
import type { TFunction } from 'i18next'
import { ORIGIN, pageById, type PageId, type PublicLang } from './meta'
import { FAQ_KEYS } from './faqContent'

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export function buildHead(id: PageId, lang: PublicLang, t: TFunction): string {
  const page = pageById(id)
  const url = ORIGIN + page.path[lang]
  const title = page.title[lang]
  const desc = page.description[lang]
  const ogImage = `${ORIGIN}/og-image.png`
  const lines = [
    `<title>${esc(title)}</title>`,
    `<meta name="description" content="${esc(desc)}" />`,
    `<link rel="canonical" href="${url}" />`,
    // hreflang 成对互指，x-default 指中文版（站点默认语言）
    `<link rel="alternate" hreflang="zh-CN" href="${ORIGIN + page.path.zh}" />`,
    `<link rel="alternate" hreflang="en" href="${ORIGIN + page.path.en}" />`,
    `<link rel="alternate" hreflang="x-default" href="${ORIGIN + page.path.zh}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="Signal Lab" />`,
    `<meta property="og:url" content="${url}" />`,
    `<meta property="og:title" content="${esc(title)}" />`,
    `<meta property="og:description" content="${esc(desc)}" />`,
    `<meta property="og:image" content="${ogImage}" />`,
    `<meta property="og:image:width" content="1200" />`,
    `<meta property="og:image:height" content="630" />`,
    `<meta property="og:locale" content="${lang === 'en' ? 'en_US' : 'zh_CN'}" />`,
    `<meta property="og:locale:alternate" content="${lang === 'en' ? 'zh_CN' : 'en_US'}" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${esc(title)}" />`,
    `<meta name="twitter:description" content="${esc(desc)}" />`,
    `<meta name="twitter:image" content="${ogImage}" />`,
  ]
  for (const ld of buildJsonLd(id, t)) {
    // JSON 里的 < 转义成 \u003c，防止文案未来出现 </script> 时截断脚本块
    lines.push(`<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, '\\u003c')}</script>`)
  }
  return lines.join('\n    ')
}

function buildJsonLd(id: PageId, t: TFunction): object[] {
  if (id === 'home') {
    return [
      { '@context': 'https://schema.org', '@type': 'Organization', name: 'PRISMX', url: `${ORIGIN}/`, logo: `${ORIGIN}/icons/icon-512.png` },
      { '@context': 'https://schema.org', '@type': 'WebSite', name: 'Signal Lab', url: `${ORIGIN}/` },
    ]
  }
  if (id === 'faq') {
    return [
      {
        '@context': 'https://schema.org',
        '@type': 'FAQPage',
        mainEntity: FAQ_KEYS.map((k) => ({
          '@type': 'Question',
          name: t(k.q),
          acceptedAnswer: { '@type': 'Answer', text: t(k.a) },
        })),
      },
    ]
  }
  return []
}
