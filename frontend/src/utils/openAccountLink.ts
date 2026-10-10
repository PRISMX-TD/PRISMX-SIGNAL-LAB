// 代理专属开户链接（后端 services/open_account.py 的前端镜像）：
// · isAgentOpenUrl：代理页 / 管理抽屉发请求前的同口径预检——只收 Make Capital 的 https 地址、
//   ≤500 字符、不含空白、不带 user@ 前缀。后端仍是唯一权威，这里只为早点给提示。
// · publicOpenAccountHref：公开比赛页「开模拟账户」指向后端跳转口，由服务端按访客最近的
//   ref（代理优先）挑开户链接并记漏斗。apiBase 由调用方传入（API_BASE 是活绑定，便于测试）。
// · competitionOpenAccountUrl：渲染开户链接时按来源选口径——代理的走白名单，比赛自己的
//   （管理员填的）只走 safeHttpUrl。
// Frontend mirror of services/open_account.py: a pre-flight check matching the backend's
// rule (the backend stays authoritative), and the public page's open-account href, which
// points at the server redirect that picks the URL from the visitor's recent refs.

import { safeHttpUrl } from './safeUrl'

export const ALLOWED_OPEN_ACCOUNT_HOSTS = ['makecapital.com'] as const
const MAX_LEN = 500

// 与后端同一套字符规则：整串里反斜杠（浏览器当 / 处理，于是解析出的主机与真正去的不一样）、
// 空白、控制字符、非 ASCII 一律不收；netloc 必须恰好是「主机」或「主机:端口」（因此主机段里
// 的 % 也过不了）。路径 / 查询 / 片段里允许百分号编码——真实 IB 链接的查询值会带。
// Same rules as the backend: backslash (browsers treat it as "/", so the parsed host differs
// from the real one), whitespace, control and non-ASCII chars are refused anywhere; the
// authority must be exactly host or host:port (so "%" there fails too). Percent-encoding is
// allowed in path/query/fragment, since real IB links carry it.
const UNSAFE_CHARS = /[\\\s\u0000-\u001f\u007f-\uffff]/
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

/** 代理链接渲染前的最后一道：只放行与后端同一口径的 Make Capital https 地址，其余返回 ''（不渲染）。
 *  只用于**代理**可控的地址；比赛自己的开户链接用 competitionOpenAccountUrl。
 *  Last gate before rendering an agent-controlled link: the backend's Make Capital https rule,
 *  '' (don't render) otherwise. For agent URLs only; see competitionOpenAccountUrl. */
export function safeOpenAccountUrl(raw: string | null | undefined): string {
  const url = (raw || '').trim()
  return isAgentOpenUrl(url) ? url : ''
}

/** 比赛页「开户」链接按来源选口径：
 *  · 代理的（站内详情 openAccountFromAgent=true，代理自己能改）→ Make Capital 白名单，不在名单里就当没有；
 *  · 比赛自己的（管理员填的，后端只要求 https、可以是任意券商）→ 可信，只挡非 http(s)（safeHttpUrl）。
 *  以前两种一律走白名单，管理员给比赛配的非 Make Capital 链接会静默消失。
 *  公开页载荷里的 openAccountUrl 永远是比赛自己的（代理链接走后端跳转口），后台预览同理。
 *  Open-account link by source: an agent's (in-app detail with openAccountFromAgent, editable by
 *  the agent) must pass the Make Capital allowlist; the competition's own (admin-set, https-only
 *  server-side, any broker) is trusted and only filtered by safeHttpUrl. Both used to go through
 *  the allowlist, silently hiding admin-set non-Make Capital links. The public payload (and the
 *  admin preview) always carries the competition's own URL; agent links go via the redirect. */
export function competitionOpenAccountUrl(raw: string | null | undefined, fromAgent = false): string {
  return fromAgent ? safeOpenAccountUrl(raw) : safeHttpUrl(raw)
}

export function publicOpenAccountHref(apiBase: string, compId: string, refs: string[]): string {
  const base = `${apiBase}/api/public/competitions/${encodeURIComponent(compId)}/open-account`
  return refs.length > 0 ? `${base}?refs=${encodeURIComponent(refs.join(','))}` : base
}
