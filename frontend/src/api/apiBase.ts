// API 基础地址：生产用 VITE_API_BASE 指向线上后端，开发留空走 Vite 代理。
// 例外：页面是从备用域名 pmxsl.com 打开的（主域名在大陆被封时用），接口也走备用域名的
// api.pmxsl.com——否则主域名被封时，备用网站照样调不通接口。两套域名都经香港边缘节点
// 转发到同一个后端（ops/hk-edge）。
// 单独成一个无依赖的小模块：clientErrorReport 在出错路径上也要用，不能拖进整个 client。
// API base: prod uses VITE_API_BASE to point at the deployed backend; dev leaves it empty to use the Vite proxy.
// Exception: a page opened from the backup domain pmxsl.com (for when the main domain is blocked in
// mainland China) calls api.pmxsl.com too — otherwise the backup site would still hit the blocked API.
// Both domains go through the HK edge to the same backend (ops/hk-edge).
// A dependency-free module so clientErrorReport can use it on the error path without pulling in client.
const BACKUP_DOMAIN = 'pmxsl.com'

function resolveApiBase(): string {
  const configured = ((import.meta.env.VITE_API_BASE as string | undefined) ?? '').replace(/\/$/, '')
  if (!configured || typeof location === 'undefined') return configured
  const host = location.hostname
  if (host === BACKUP_DOMAIN || host.endsWith(`.${BACKUP_DOMAIN}`)) return `https://api.${BACKUP_DOMAIN}`
  return configured
}

export const API_BASE = resolveApiBase()
