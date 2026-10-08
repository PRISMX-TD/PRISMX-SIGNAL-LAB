// 比赛「公开推广」区与终审检查的纯逻辑。校验口径与后端一致（设计 §1.7、§1.14），
// 后端仍是唯一的闸；前端提前拦只是不让管理员点了白等一个必然的 400。
// Pure logic for the competition promotion section and the pre-settle check. Mirrors
// the backend rules (design §1.7, §1.14); the server stays the real gate — this just
// avoids clicks that are guaranteed to 400.
import type {
  CompetitionEnrollment,
  CompetitionFunnel,
  CompetitionIntegrityFlag,
  CompetitionTrack,
  ParticipantAdminRow,
} from '../../../api/types'

export type PublicViewIssue = 'notDemo' | 'notSignup' | 'noUrl' | 'urlNotHttps'

export function isHttpsUrl(raw: string): boolean {
  try {
    const u = new URL(raw.trim())
    return u.protocol === 'https:' && u.hostname !== ''
  } catch {
    return false
  }
}

// 公开页的硬条件（§1.7）：模拟赛 + 报名制 + https 开户链接。
// Hard requirements for a public page (§1.7): demo + signup + an https account link.
export function publicViewIssues(input: {
  track: CompetitionTrack
  enrollment: CompetitionEnrollment
  openAccountUrl: string
}): PublicViewIssue[] {
  const out: PublicViewIssue[] = []
  if (input.track !== 'demo') out.push('notDemo')
  if (input.enrollment !== 'signup') out.push('notSignup')
  const url = input.openAccountUrl.trim()
  if (!url) out.push('noUrl')
  else if (!isHttpsUrl(url)) out.push('urlNotHttps')
  return out
}

// 表单层：公开打开时全量校验；关闭时只要求「填了的开户链接是 https」。
// Form level: full check when public is on; otherwise only "a filled link must be https".
export function formPromoIssues(form: {
  publicView: boolean
  track: CompetitionTrack
  enrollment: CompetitionEnrollment
  openAccountUrl: string
}): PublicViewIssue[] {
  if (form.publicView) return publicViewIssues(form)
  const url = form.openAccountUrl.trim()
  return url && !isHttpsUrl(url) ? ['urlNotHttps'] : []
}

export function openAccountUrlValue(raw: string): string | null {
  const v = raw.trim()
  return v === '' ? null : v
}

// 漏斗列顺序即转化顺序 / column order is the conversion order
export const FUNNEL_STEPS = ['clicks', 'views', 'ctas', 'openAccounts', 'registrations', 'verified', 'bound', 'entries'] as const
export type FunnelStep = (typeof FUNNEL_STEPS)[number]
export type FunnelCounts = Record<FunnelStep, number>

// 合计 = 各链接之和 + 无来源访问（只有浏览 / 点报名 / 点开户三步）。
// Totals = sum over links + no-ref visits (which only have views / ctas / openAccounts).
export function funnelTotals(f: CompetitionFunnel): FunnelCounts {
  const out = Object.fromEntries(FUNNEL_STEPS.map((s) => [s, 0])) as FunnelCounts
  for (const row of f.links) for (const s of FUNNEL_STEPS) out[s] += row[s] ?? 0
  out.views += f.noRef.views
  out.ctas += f.noRef.ctas
  out.openAccounts += f.noRef.openAccounts
  return out
}

export function convRate(num: number, den: number): string {
  if (!(den > 0)) return '—'
  return `${(Math.round((num / den) * 1000) / 10).toFixed(1)}%`
}

// 终审闸门（§1.14）：前 10 名任一条目有标记 → 必须 acknowledgeFlags。
// Settle gate (§1.14): any flagged top-10 entry requires acknowledgeFlags.
export const SETTLE_ACK_TOP_N = 10

export interface RankedFlag extends CompetitionIntegrityFlag {
  rank: number | null
  top: boolean
}

// 名次取 finalRank，没有就取实时 liveRank（ended 未终审时只有后者）。前端只是近似，
// 后端按自己的排名判；所以确认框只要有标记就显示，前 10 有标记时才强制勾选。
// Rank is finalRank, else liveRank (only the latter exists before settling). This is an
// approximation — the server ranks on its own — so the ack box shows whenever there are
// flags and is mandatory only for flagged top-10 rows.
export function rankFlags(
  flags: CompetitionIntegrityFlag[],
  participants: Array<Pick<ParticipantAdminRow, 'id' | 'liveRank' | 'finalRank'>>,
): RankedFlag[] {
  const rankById = new Map(participants.map((p) => [p.id, p.finalRank ?? p.liveRank ?? null]))
  const last = Number.MAX_SAFE_INTEGER
  return flags
    .map((f) => {
      const rank = rankById.get(f.participantId) ?? null
      return { ...f, rank, top: rank != null && rank <= SETTLE_ACK_TOP_N }
    })
    .sort((a, b) => (a.rank ?? last) - (b.rank ?? last))
}

export function needsAck(flags: RankedFlag[]): boolean {
  return flags.some((f) => f.top)
}

// 完整性标记详情（Part A 给的是对象：balanceAtSignup / netCashflow / sources /
// revokedReason / hedgePairs）压成一行可读文本；未知键原样 key=value。
// Flattens Part A's detail object into one readable line; unknown keys as key=value.
export function formatFlagDetail(detail: Record<string, unknown> | null | undefined): string {
  if (!detail) return ''
  const parts: string[] = []
  for (const [k, v] of Object.entries(detail)) {
    if (v == null || v === '' || (Array.isArray(v) && v.length === 0)) continue
    if (typeof v === 'number') parts.push(`${k}=${Number.isInteger(v) ? v : v.toFixed(2)}`)
    else if (Array.isArray(v)) parts.push(`${k}=${v.map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(',')}`)
    else if (typeof v === 'object') parts.push(`${k}=${JSON.stringify(v)}`)
    else parts.push(`${k}=${String(v)}`)
  }
  return parts.join(' · ')
}
