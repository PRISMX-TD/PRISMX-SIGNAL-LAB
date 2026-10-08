// 推广链接的唯一拼法。三处共用：管理端邀请链接页签、比赛编辑页的本场推广链接、代理页。
// 拼 ORIGIN 而不是 window.location.origin——在 Vercel 预览域名上操作后台时复制出去的
// 必须仍是正式域名（裸域名还会 308）。以前每个页面各写一份 `${ORIGIN}/?ref=`，比赛链接
// 加进来后就是三种形状，别再分散。
// The one place promo URLs are built: the admin invite tab, the competition editor's
// promo links and the agent page. ORIGIN, not window.location.origin — copied links must
// stay canonical when the admin works on a preview host (the bare domain also 308s).
// Each page used to carry its own `${ORIGIN}/?ref=`; with competition links there are
// three shapes, so they live here.
import { ORIGIN } from '../seo/meta'

const enc = encodeURIComponent

// 普通 / 代理邀请链接：落地页带 ref。/ Plain or agent invite link: landing page with ref.
export function inviteUrl(code: string): string {
  return `${ORIGIN}/?ref=${enc(code)}`
}

// 代理的「比赛链接」：固定 /c，打开时显示当前主推比赛（设计 §1.2）。
// The agent's competition link: fixed /c, resolving to the featured competition (§1.2).
export function agentCompetitionUrl(code: string): string {
  return `${ORIGIN}/c?ref=${enc(code)}`
}

// 某场比赛的公开页（不带 ref）。/ A competition's public page, no ref.
export function competitionPublicUrl(compId: string): string {
  return `${ORIGIN}/c/${enc(compId)}`
}

// 一条邀请链接「复制」出去的默认网址：比赛推广链接直达本场公开页，其余走首页。
// The default URL a link copies to: competition promo links open their competition,
// everything else the landing page.
export function promoLinkUrl(link: { code: string; competitionId?: string | null }): string {
  return link.competitionId ? `${competitionPublicUrl(link.competitionId)}?ref=${enc(link.code)}` : inviteUrl(link.code)
}
