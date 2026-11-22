// 登录后路由 → 标签页标题。Layout 在换页时按这张表写 document.title。
// 只能用核心包里的键（nav.*）：Layout 在核心包，i18n.test.ts 会按字符串字面量检查。
// 'page' 表示这个页面自己调 useDocumentTitle 设标题，Layout 在这些路径上一个字也不写：
// 不然切语言时 Layout 会把公告详情这类「标题不随语言变」的页面覆盖掉，而页面的 effect
// 因为依赖没变不会重跑、抢不回来。新页面加了 useDocumentTitle，就把它的路径改成 'page'。
//
// Signed-in route → tab title; Layout writes document.title from this table on navigation.
// Core-bundle keys only (nav.*): Layout is in the core bundle and i18n.test.ts checks string
// literals. 'page' marks pages that set their own title via useDocumentTitle; Layout writes
// nothing on those paths, otherwise a language switch would overwrite e.g. an announcement's
// server-provided title and the page's effect (deps unchanged) would never write it back.
// When a page starts calling useDocumentTitle, change its entry to 'page'.

export const PAGE_OWNED = 'page'

// 顺序无关：匹配规则是「完全相等或以 `路径/` 开头」，/app 不会误中 /app-download。
// Order-independent: a match is "equal, or starts with `path/`", so /app never matches /app-download.
const ROUTE_TITLES: ReadonlyArray<readonly [string, string]> = [
  ['/dashboard', 'nav.dashboard'],
  ['/app', 'nav.signals'],
  ['/charts', 'nav.charts'],
  ['/bind', 'nav.bind'],
  ['/orders', 'nav.orders'],
  ['/achievements', 'nav.growth'],
  ['/leaderboard', 'nav.growth'],
  ['/competitions', 'nav.growth'],
  ['/lucky', 'nav.growth'],
  ['/persona', 'nav.orders'],
  ['/account', 'nav.account'],
  ['/app-download', 'nav.appDownload'],
  ['/support', 'nav.support'],
  ['/support-desk', 'nav.supportDesk'],
  ['/admin', 'nav.admin'],
  ['/agent', PAGE_OWNED],
  ['/announcements', PAGE_OWNED],
  ['/simulator', PAGE_OWNED],
  ['/strategies', PAGE_OWNED],
  ['/upgrade', PAGE_OWNED],
]

/** 返回 i18n 键、PAGE_OWNED，或 null（表里没有：用品牌名）。
 *  Returns an i18n key, PAGE_OWNED, or null (not listed: use the brand name). */
export function routeTitleKey(pathname: string): string | null {
  for (const [path, key] of ROUTE_TITLES) {
    if (pathname === path || pathname.startsWith(`${path}/`)) return key
  }
  return null
}

/** 统一的标题格式 / the one title format: "<name> · Signal Lab", or "Signal Lab". */
export function appTitle(name?: string | null): string {
  return name ? `${name} · Signal Lab` : 'Signal Lab'
}
