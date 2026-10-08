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

// 与后端同一套字符规则：反斜杠（浏览器当 / 处理，于是解析出的主机与真正去的不一样）、
// 百分号、空白、控制字符、非 ASCII 一律不收；netloc 必须恰好是「主机」或「主机:端口」。
// Same rules as the backend: backslash (browsers treat it as "/", so the parsed host differs
// from the real one), "%", whitespace, control and non-ASCII chars are refused, and the
// authority must be exactly host or host:port.
const UNSAFE_CHARS = /[\\%\s\u0000-\u001f\u007f-\uffff]/
const AUTHORITY_RE = /^([a-z0-9.-]+)(:[0-9]{1,5})?$/

export function isAgentOpenUrl(raw: string): boolean {
  const url = raw.trim()
  if (!url || url.length > MAX_LEN || UNSAFE_CHARS.test(url)) return false
  // 不用 new URL()：它会把反斜杠、百分号编码等「修正」掉，正好掩盖要挡的东西。按原串切。
  // Not new URL(): it normalises backslashes and encodings away — the very things to catch.
  const m = /^https:\/\/([^/?#]*)/i.exec(url)
  if (!m) return false
  const auth = AUTHORITY_RE.exec(m[1].toLowerCase())
  if (!auth) return false
  const host = auth[1]
  return ALLOWED_OPEN_ACCOUNT_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))
}

export function publicOpenAccountHref(apiBase: string, compId: string, refs: string[]): string {
  const base = `${apiBase}/api/public/competitions/${encodeURIComponent(compId)}/open-account`
  return refs.length > 0 ? `${base}?refs=${encodeURIComponent(refs.join(','))}` : base
}
