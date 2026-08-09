// 公开页「路由 × 语言」的单一事实来源：URL 矩阵 + 每页 SEO 文案。
// 预渲染脚本（scripts/prerender.mjs 经 entry-server）与浏览器端
// （PublicShell 的 head 同步、i18n 的 URL 语言判定）共用这一份数据。
// 带 www：Vercel 以 www.prismxsignallab.com 为主域名，裸域名 308 跳转过来。
// canonical 必须指向真正返回 200 的那个地址，否则等于告诉搜索引擎「正版地址
// 是一个会把你弹走的 URL」。
export const ORIGIN = 'https://www.prismxsignallab.com'

export type PublicLang = 'zh' | 'en'
export type PageId = 'home' | 'terms' | 'privacy' | 'risk' | 'faq'

export interface PageDef {
  id: PageId
  path: Record<PublicLang, string>
  title: Record<PublicLang, string>
  description: Record<PublicLang, string>
}

export const PUBLIC_PAGES: PageDef[] = [
  {
    id: 'home',
    path: { zh: '/', en: '/en' },
    title: {
      zh: 'Signal Lab · 信号实验室 · by PRISMX',
      en: 'Signal Lab · Trading Signals with Discipline · by PRISMX',
    },
    description: {
      zh: '每条信号只锁定三个数字——进场、止损、止盈，一键直达你自己的 MT5。资金始终在你自己的券商账户，判定规则公开。',
      en: 'Every signal locks three numbers — entry, stop, target — sent to your own MT5 in one tap. Funds stay in your own broker account; scoring rules are public.',
    },
  },
  {
    id: 'terms',
    path: { zh: '/terms', en: '/en/terms' },
    title: { zh: '服务条款 · Signal Lab', en: 'Terms of Service · Signal Lab' },
    description: {
      zh: '阅读 Signal Lab（信号实验室）的服务条款：账号注册、订阅与付费、双方的权利义务与责任边界。',
      en: 'Read the Signal Lab Terms of Service: account registration, subscriptions and payment, rights, obligations and liability boundaries.',
    },
  },
  {
    id: 'privacy',
    path: { zh: '/privacy', en: '/en/privacy' },
    title: { zh: '隐私政策 · Signal Lab', en: 'Privacy Policy · Signal Lab' },
    description: {
      zh: '了解 Signal Lab 如何收集、使用与保护你的个人数据，包括 Cookie、分析工具与第三方服务的使用披露。',
      en: 'How Signal Lab collects, uses and protects your personal data, including cookies, analytics and third-party service disclosures.',
    },
  },
  {
    id: 'risk',
    path: { zh: '/risk', en: '/en/risk' },
    title: { zh: '风险披露 · Signal Lab', en: 'Risk Disclosure · Signal Lab' },
    description: {
      zh: '外汇与差价合约交易含高风险。阅读 Signal Lab 的完整风险披露：历史表现不代表未来，决策与风险始终由你承担。',
      en: 'Forex and CFD trading carries high risk. Read the full Signal Lab risk disclosure: past performance never guarantees future results.',
    },
  },
  {
    id: 'faq',
    path: { zh: '/faq', en: '/en/faq' },
    title: { zh: '常见问题 · Signal Lab', en: 'FAQ · Signal Lab' },
    description: {
      zh: '关于 Signal Lab 的常见问题：资金安全、接入条件、信号判定规则、FREE 与 PRO 的区别、定价与支付方式。',
      en: 'Frequently asked questions about Signal Lab: fund safety, requirements, signal scoring rules, FREE vs PRO, pricing and payment.',
    },
  },
]

export function pageById(id: PageId): PageDef {
  // PUBLIC_PAGES 覆盖了 PageId 的全部取值，find 不可能落空；断言只是让
  // TS 不把返回类型放宽成 undefined。
  return PUBLIC_PAGES.find((p) => p.id === id)!
}

const stripSlash = (p: string) => (p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p)

export function pageFromPath(pathname: string): { page: PageDef; lang: PublicLang } | null {
  const p = stripSlash(pathname)
  for (const page of PUBLIC_PAGES) {
    if (page.path.zh === p) return { page, lang: 'zh' }
    if (page.path.en === p) return { page, lang: 'en' }
  }
  return null
}

export function langFromPath(pathname: string): PublicLang | null {
  return pageFromPath(pathname)?.lang ?? null
}

// 当前路径在另一种语言下的对应地址；非公开页原样返回（调用方不会遇到，兜底而已）。
export function counterpartPath(pathname: string, lang: PublicLang): string {
  const hit = pageFromPath(pathname)
  return hit ? hit.page.path[lang] : pathname
}

// 以中文版路径为 key 取指定语言的路径：内链本地化用（如页脚的 /terms 链接
// 在英文页上要指向 /en/terms）。
export function localePath(lang: PublicLang, zhPath: string): string {
  const page = PUBLIC_PAGES.find((p) => p.path.zh === zhPath)
  return page ? page.path[lang] : zhPath
}
