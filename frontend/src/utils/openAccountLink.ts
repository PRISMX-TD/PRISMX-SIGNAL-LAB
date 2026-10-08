// 代理专属开户链接（后端 services/open_account.py 的前端镜像）：
// · isAgentOpenUrl：代理页 / 管理抽屉发请求前的同口径预检——只收 Make Capital 的 https 地址、
//   ≤500 字符、不含空白、不带 user@ 前缀。后端仍是唯一权威，这里只为早点给提示。
// · publicOpenAccountHref：公开比赛页「开模拟账户」指向后端跳转口，由服务端按访客最近的
//   ref（代理优先）挑开户链接并记漏斗。apiBase 由调用方传入（API_BASE 是活绑定，便于测试）。
// Frontend mirror of services/open_account.py: a pre-flight check matching the backend's
// rule (the backend stays authoritative), and the public page's open-account href, which
// points at the server redirect that picks the URL from the visitor's recent refs.

export const ALLOWED_OPEN_ACCOUNT_HOSTS = ['makecapital.com'] as const
const MAX_LEN = 500

export function isAgentOpenUrl(raw: string): boolean {
  const url = raw.trim()
  if (!url || url.length > MAX_LEN || /\s/.test(url)) return false
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return false
  // URL 会把 user@ 之前的部分拆进 username；空 userinfo（`https://@host`）也算可疑，按原串再查一次。
  // `https://@host` leaves username empty, so also check the authority in the raw string.
  const authority = url.slice('https://'.length).split(/[/?#]/)[0]
  if (authority.includes('@')) return false
  const host = parsed.hostname.toLowerCase()
  return ALLOWED_OPEN_ACCOUNT_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))
}

export function publicOpenAccountHref(apiBase: string, compId: string, refs: string[]): string {
  const base = `${apiBase}/api/public/competitions/${encodeURIComponent(compId)}/open-account`
  return refs.length > 0 ? `${base}?refs=${encodeURIComponent(refs.join(','))}` : base
}
