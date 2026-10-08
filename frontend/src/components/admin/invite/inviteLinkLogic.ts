// 邀请链接页签的纯逻辑：分类、筛选、搜索、统计条、徽标、编辑抽屉的改动判断。
// 全部是纯函数，组件只负责渲染——筛选口径改了只改这里、测试兜底。
// Pure logic for the invite-links tab: kind, filters, search, the stats strip, badges
// and the edit drawer's dirty check. Components only render.
import type { InviteLink, InviteLinkKind, InviteLinkPatch } from '../../../api/types'
import { isAgentOpenUrl } from '../../../utils/openAccountLink'

export type KindFilter = 'all' | InviteLinkKind
export const KIND_FILTERS: KindFilter[] = ['all', 'agent', 'platform', 'competition']

// 渠道建议值（设计 §1.4）。存的是这串字面量本身（数据，不是界面文案），所以不走 i18n。
// Channel suggestions (design §1.4). These literals are stored as data, not UI copy.
export const CHANNEL_SUGGESTIONS: readonly string[] = ['FB广告', 'Google广告', '抖音', '小红书', '微信群', 'Telegram', '线下', '合作方', '其他']
export const CHANNEL_MAX = 32

// 渠道下拉的两个特殊值：'' = 不限；NO_CHANNEL = 只看没设渠道的。
// Two special channel-filter values: '' = any; NO_CHANNEL = links without a channel.
export const ALL_CHANNELS = ''
export const NO_CHANNEL = '__none__'

export interface LinkFilter {
  kind: KindFilter
  channel: string
  q: string
  showInactive: boolean
}

// 停用链接默认隐藏（§5.6）/ disabled links hidden by default (§5.6)
export const DEFAULT_FILTER: LinkFilter = { kind: 'all', channel: ALL_CHANNELS, q: '', showInactive: false }

// 后端总会给 kind；推导只是给「前端先于后端上线」那几分钟兜底，口径与后端一致（§1.1）。
// The backend always sends kind; deriving it only covers a frontend that ships first,
// using the same rule as the server (§1.1).
export function linkKind(l: Pick<InviteLink, 'kind' | 'competitionId' | 'agents'>): InviteLinkKind {
  if (l.kind === 'competition' || l.kind === 'agent' || l.kind === 'platform') return l.kind
  if (l.competitionId) return 'competition'
  return (l.agents ?? []).length > 0 ? 'agent' : 'platform'
}

// 搜索范围：标记 / 码 / 渠道 / 比赛名 / 代理昵称与邮箱（§5.2「标记/码/代理名」，多搜两样无害）。
// Search covers label / code / channel / competition name / agent nickname + email.
export function matchesSearch(l: InviteLink, q: string): boolean {
  const term = q.trim().toLowerCase()
  if (!term) return true
  const hay = [
    l.label,
    l.code,
    l.channel ?? '',
    l.competitionName ?? '',
    ...(l.agents ?? []).flatMap((a) => [a.nickname ?? '', a.email]),
  ]
  return hay.some((s) => s.toLowerCase().includes(term))
}

export function matchesChannel(l: InviteLink, channel: string): boolean {
  if (channel === ALL_CHANNELS) return true
  if (channel === NO_CHANNEL) return !l.channel
  return l.channel === channel
}

export function filterLinks(links: InviteLink[], f: LinkFilter): InviteLink[] {
  return links.filter(
    (l) =>
      (f.showInactive || l.isActive) &&
      (f.kind === 'all' || linkKind(l) === f.kind) &&
      matchesChannel(l, f.channel) &&
      matchesSearch(l, f.q),
  )
}

// 分段按钮上的数字：只受「显示已停用」影响，不受渠道 / 搜索影响——它回答的是「这一类
// 总共有几条」，跟着搜索变会让人以为链接丢了。
// Segment counts follow show-inactive only, not channel/search: they answer "how many
// of this kind exist"; tracking the search would read as links going missing.
export function kindCounts(links: InviteLink[], showInactive: boolean): Record<KindFilter, number> {
  const out: Record<KindFilter, number> = { all: 0, agent: 0, platform: 0, competition: 0 }
  for (const l of links) {
    if (!showInactive && !l.isActive) continue
    out.all += 1
    out[linkKind(l)] += 1
  }
  return out
}

// 渠道下拉的选项：实际出现过的渠道，建议值按建议顺序在前，其余按字母。
// Channel options: channels actually in use, suggestions first in their order, then A–Z.
export function channelOptions(links: InviteLink[]): string[] {
  const set = new Set<string>()
  for (const l of links) if (l.channel) set.add(l.channel)
  const order = (c: string) => {
    const i = CHANNEL_SUGGESTIONS.indexOf(c)
    return i === -1 ? CHANNEL_SUGGESTIONS.length : i
  }
  return [...set].sort((a, b) => order(a) - order(b) || a.localeCompare(b))
}

export function hasUnchanneled(links: InviteLink[]): boolean {
  return links.some((l) => !l.channel)
}

export interface LinkSummary {
  total: number
  active: number
  clicks: number
  registrations: number
  // null = 后端没给 registrationsMonth（统计条显示「—」，不显示一个假的 0）
  // null = the backend sent no registrationsMonth (shown as "—", never a fake 0)
  registrationsMonth: number | null
}

// 统计条按全量算，不随筛选变（§5.1）。/ The stats strip covers every link, not the filtered view.
export function summarize(links: InviteLink[]): LinkSummary {
  const out: LinkSummary = { total: 0, active: 0, clicks: 0, registrations: 0, registrationsMonth: null }
  for (const l of links) {
    out.total += 1
    if (l.isActive) out.active += 1
    out.clicks += l.clicks
    out.registrations += l.registrations
    if (typeof l.registrationsMonth === 'number') out.registrationsMonth = (out.registrationsMonth ?? 0) + l.registrationsMonth
  }
  return out
}

export function normalizeChannel(raw: string): string | null {
  const v = raw.trim().slice(0, CHANNEL_MAX)
  return v === '' ? null : v
}

const KIND_BADGE_CLASS: Record<InviteLinkKind, string> = {
  agent: 'bg-prism-500/15 text-prism-200',
  platform: 'bg-white/5 text-neutral-300',
  competition: 'bg-amber-400/15 text-amber-300',
}

export function kindBadgeClass(kind: InviteLinkKind): string {
  return KIND_BADGE_CLASS[kind]
}

// 列表第二行灰字（§5.3）：比赛链接 → 比赛名；代理链接 → 代理名（昵称优先，否则邮箱）。
// The grey second line: competition name for competition links, agent names for agent links.
export function secondaryLine(l: InviteLink): string | null {
  const kind = linkKind(l)
  if (kind === 'competition') return l.competitionName ?? l.competitionId
  if (kind === 'agent') return (l.agents ?? []).map((a) => a.nickname || a.email).join('、')
  return null
}

// 编辑抽屉「保存」要送的 PATCH：只放改了的字段；标记被清空、或代理开户链接填了但不合规时
// 返回 null（不许存）。openAccountUrl 草稿不传 = 不碰这个字段（比赛链接没有这一栏）。
// The drawer's PATCH: only changed fields; null when nothing changed, the label is blank or
// the agent open-account URL is filled but invalid. No openAccountUrl draft = field untouched
// (competition links don't have it).
export function labelPatch(
  link: Pick<InviteLink, 'label' | 'channel'> & { openAccountUrl?: string | null },
  draft: { label: string; channel: string; openAccountUrl?: string },
): InviteLinkPatch | null {
  const label = draft.label.trim()
  if (!label) return null
  const patch: InviteLinkPatch = {}
  if (label !== link.label) patch.label = label
  const channel = normalizeChannel(draft.channel)
  if (channel !== (link.channel ?? null)) patch.channel = channel
  if (draft.openAccountUrl !== undefined) {
    const url = draft.openAccountUrl.trim() || null
    if (url !== null && !isAgentOpenUrl(url)) return null
    if (url !== (link.openAccountUrl ?? null)) patch.openAccountUrl = url
  }
  return Object.keys(patch).length > 0 ? patch : null
}
