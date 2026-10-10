// Meta Pixel 的隐私边界：哪些页面一律不上报。
//
// fbevents.js 上报 PageView 时会把**完整地址**（含查询串）作为 dl 参数发给 Meta——
// /reset-password?token=…、/verify-email?token=… 这类一次性令牌，以及后台 / 工单里带的
// 用户 ID、工单号，都会原样落到第三方那里。这些页面本来也不是广告漏斗的一部分，直接不发。
//
// ⚠️ index.html 里的像素基础代码（内联脚本，不能 import）复制了一份同样的清单，标记为
// /*PIXEL_BLOCKED_PATHS*/。两边必须一致——scripts/csp-hashes.test.mjs 会对比，改这里记得
// 一起改那边（改了内联脚本还要重算 vercel.json 里的 CSP 哈希：node scripts/check-csp-hashes.mjs --write）。
//
// Privacy boundary for the Meta Pixel: pages that never report. fbevents.js sends the
// full URL (query string included) as `dl`, which would hand one-time reset / verify
// tokens and admin / ticket IDs to a third party. index.html's inline base code keeps a
// copy of this list (marked /*PIXEL_BLOCKED_PATHS*/); scripts/csp-hashes.test.mjs checks
// they match. Editing that inline script also means regenerating the CSP hashes.

/** 精确匹配或作为前缀（后跟 /）匹配；比较前统一小写、去尾斜杠（react-router 默认大小写不敏感）。
 *  Exact or prefix-with-slash match, lowercased and trailing slashes trimmed
 *  (react-router matches case-insensitively by default). */
export const PIXEL_BLOCKED_PATHS = [
  '/reset-password',
  '/forgot-password',
  '/verify-email',
  '/complete-profile',
  '/unsubscribe',
  '/admin',
  '/agent',
  '/simulator',
  '/support',
  '/account',
] as const

/** 任意页面只要查询串里带 token 参数也一律不发 / any URL carrying a token param is skipped too */
const TOKEN_PARAM = /[?&]token=/i

export function isPixelBlocked(pathname: string, search = ''): boolean {
  const p = (pathname || '').toLowerCase().replace(/\/+$/, '')
  for (const d of PIXEL_BLOCKED_PATHS) {
    if (p === d || p.startsWith(`${d}/`)) return true
  }
  return TOKEN_PARAM.test(search || '')
}
