// 发券确认清单：三种来源选出的人合并成一张表，同一人出现两次时按管理员选的方式合并（相加 / 取多的），
// 并标「重复」。每人封顶 100 张、整批 2000 人 / 20000 张，与后端同一上限；名次档位的写反 / 重叠
// 在这里先拦一道（后端仍会 400），省得管理员点完才看到报错。
// The confirm list for issuing tickets: people picked by any of three sources merge into one table;
// a person who appears twice is merged the way the admin chose (add / keep the larger) and flagged
// "duplicate". Limits mirror the backend (100 per person, 2000 users / 20000 tickets per batch);
// reversed / overlapping rank tiers are caught here first as an early hint (the backend still 400s).
import type { LuckyIssueRow, LuckyTier } from '../../../api/luckyTypes'

export type IssueLine = LuckyIssueRow & { dup: boolean }
export type DupMode = 'sum' | 'once'
export const PER_USER_CAP = 100
export const MAX_USERS = 2000
export const MAX_TICKETS = 20000
const PERIOD_KEY = /^\d{4}-W\d{2}$|^\d{4}-\d{2}$/

export const clampCount = (n: number, max = PER_USER_CAP): number =>
  Number.isFinite(n) ? Math.min(max, Math.max(1, Math.floor(n))) : 1

export function merge(list: IssueLine[], incoming: LuckyIssueRow[], mode: DupMode): IssueLine[] {
  const out = list.map((x) => ({ ...x }))
  const at = new Map(out.map((x, i) => [x.userId, i]))
  for (const r of incoming) {
    const i = at.get(r.userId)
    if (i === undefined) {
      at.set(r.userId, out.length)
      out.push({ ...r, count: clampCount(r.count), dup: false })
      continue
    }
    const cur = out[i]
    const count = mode === 'sum' ? cur.count + r.count : Math.max(cur.count, r.count)
    // 「取多的」时新来的更多就整行换成新来的（来源 / 名次跟着走）。
    // In "keep larger" mode the incoming line replaces the whole row when it carries more tickets.
    const base = mode === 'once' && r.count > cur.count ? r : cur
    out[i] = { ...base, count: clampCount(count), dup: true }
  }
  return out
}

export const totals = (list: IssueLine[]) => ({ users: list.length, tickets: list.reduce((a, x) => a + x.count, 0) })

export function limitProblem(list: IssueLine[]): 'users' | 'tickets' | null {
  const t = totals(list)
  return t.users > MAX_USERS ? 'users' : t.tickets > MAX_TICKETS ? 'tickets' : null
}

export function tierProblem(tiers: LuckyTier[]): 'reversed' | 'overlap' | null {
  if (tiers.some((t) => t.fromRank > t.toRank)) return 'reversed'
  const spans = tiers.map((t) => [t.fromRank, t.toRank] as const).sort((a, b) => a[0] - b[0])
  return spans.some((s, i) => i > 0 && s[0] <= spans[i - 1][1]) ? 'overlap' : null
}

export const periodValid = (p: string): boolean => p === 'week' || p === 'month' || PERIOD_KEY.test(p)
