// Meta Pixel 的边界：只有公开页、注册入口和升级页上报，其余一律不发。
//
// 2026-11-16（体验报告 L9）从「黑名单」改成「白名单」。像素是用来衡量广告投放的：落地页、
// 登录 / 注册页、公开比赛页、法务与常见问题，再加上付费转化发生的升级页。登录后的工作页面
// （行情图表、仪表盘、交易、策略……）不在漏斗里，原来却每次打开都加载 fbevents.js（约 99 KB）
// 并上报一次 PageView。改成白名单后，以后新增的页面默认不上报，要上报得显式加进来。
//
// 原来黑名单挡的那些敏感页（重置密码 / 邮箱验证令牌、后台、工单、账号……）都不在白名单里，
// 自然不发：fbevents.js 上报 PageView 时会把**完整地址**（含查询串）作为 dl 参数发给 Meta，
// 一次性令牌、用户 ID、工单号都会原样落到第三方那里。带 token 参数的地址仍然额外挡一道。
//
// ⚠️ index.html 里的像素基础代码（内联脚本，不能 import）复制了一份同样的清单，标记为
// /*PIXEL_ALLOWED_PATHS*/。两边必须一致——scripts/csp-hashes.test.mjs 会对比，改这里记得
// 一起改那边（改了内联脚本还要重算 vercel.json 里的 CSP 哈希：node scripts/check-csp-hashes.mjs --write）。
//
// Boundary for the Meta Pixel: only public pages, the sign-up entry and the upgrade page
// report. Since 2026-11-16 (QA report L9) this is an allowlist rather than a denylist: the
// pixel measures ad spend, so it belongs on the landing pages, login / sign-up, the public
// competition page, legal and FAQ, plus the upgrade page where paid conversion happens.
// The signed-in working pages (charts, dashboard, orders, strategies…) are not part of that
// funnel, yet each used to load fbevents.js (~99 KB) and report a PageView. With an
// allowlist a new page reports nothing until it is added here on purpose. The sensitive
// pages the old denylist covered (reset / verify tokens, admin, tickets, account…) are
// simply not listed: fbevents.js sends the full URL (query string included) as `dl`. Any
// URL carrying a token param is still refused as well. index.html's inline base code keeps
// a copy of this list (marked /*PIXEL_ALLOWED_PATHS*/); scripts/csp-hashes.test.mjs checks
// they match. Editing that inline script also means regenerating the CSP hashes.

/** '/' 只精确匹配首页；其余精确匹配或作为前缀（后跟 /）匹配。比较前统一小写、去尾斜杠
 *  （react-router 默认大小写不敏感）。'/en' 因此涵盖 /en/intro、/en/terms、/en/faq 等英文公开页。
 *  '/' matches the home page only; the rest match exactly or as a prefix followed by '/',
 *  lowercased with trailing slashes trimmed (react-router matches case-insensitively).
 *  '/en' therefore covers the English public pages (/en/intro, /en/terms, /en/faq…). */
export const PIXEL_ALLOWED_PATHS = [
  '/',
  '/en',
  '/intro',
  '/login',
  '/terms',
  '/privacy',
  '/risk',
  '/faq',
  '/c',
  '/upgrade',
] as const

/** 任意页面只要查询串里带 token 参数也一律不发 / any URL carrying a token param is skipped too */
const TOKEN_PARAM = /[?&]token=/i

export function isPixelAllowedPath(pathname: string): boolean {
  const p = (pathname || '').toLowerCase().replace(/\/+$/, '')
  for (const d of PIXEL_ALLOWED_PATHS) {
    if (d === '/' ? p === '' : p === d || p.startsWith(`${d}/`)) return true
  }
  return false
}

export function isPixelBlocked(pathname: string, search = ''): boolean {
  return !isPixelAllowedPath(pathname) || TOKEN_PARAM.test(search || '')
}
