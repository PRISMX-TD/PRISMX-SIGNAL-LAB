// 客服台（设计 2026-10-17）的接口类型。形状照 backend/app/routers/support.py 与
// services/support_view.py 的返回值；权限过滤全在后端，字段缺失 = 调用者无权看。
// Support-desk API types (design 2026-10-17), mirroring backend/app/routers/support.py and
// services/support_view.py. Permission filtering is server-side: an absent field means the
// caller may not see it.

import type { AdminUser } from './types'

export type SupportTier = 'internal' | 'outsourced'
export type FollowUpGoal = 'open_mt5' | 'open_signallab' | 'renew' | 'activate_trial' | 'revisit' | 'other'
export type FollowUpPriority = 'low' | 'normal' | 'high'
export type FollowUpStatus =
  | 'pending' | 'contacted' | 'interested' | 'converted' | 'no_interest' | 'unreachable' | 'revoked' | 'expired'
// 客服自己能切到的状态（revoked / expired 只有 admin / 系统给）/ statuses an agent can set
export type FollowUpStaffStatus = 'pending' | 'contacted' | 'interested' | 'converted' | 'no_interest' | 'unreachable'
export type FollowUpChannel = 'phone' | 'email' | 'in_app' | 'other'
export type ConversionKind = 'mt5_real' | 'signallab_register' | 'signallab_verified' | 'signallab_paid'
export type ConversionStatus = 'confirmed' | 'pending_review' | 'rejected'
export type SupportRequestKind = 'comp_days' | 'follow_up' | 'conversion_manual'
export type SupportRequestStatus = 'pending' | 'approved' | 'rejected'

// 可选的跟进目标（renew 续费 2026-10-18 起不再提供，只在旧记录里出现）/ goals on offer (renew only on old rows)
export const FOLLOW_UP_GOALS: FollowUpGoal[] = ['open_mt5', 'open_signallab', 'activate_trial', 'revisit', 'other']
// 显示 / 统计用的全集 / every goal a stored row may carry
export const ALL_FOLLOW_UP_GOALS: FollowUpGoal[] = [...FOLLOW_UP_GOALS, 'renew']
export const FOLLOW_UP_PRIORITIES: FollowUpPriority[] = ['low', 'normal', 'high']
export const FOLLOW_UP_STAFF_STATUSES: FollowUpStaffStatus[] = [
  'pending', 'contacted', 'interested', 'converted', 'no_interest', 'unreachable',
]
export const FOLLOW_UP_CHANNELS: FollowUpChannel[] = ['phone', 'email', 'in_app', 'other']
export const CONVERSION_KINDS: ConversionKind[] = ['signallab_register', 'signallab_verified', 'signallab_paid', 'mt5_real']

export interface SupportMe {
  id: string
  nickname: string | null
  email: string
  role: 'support' | 'admin'
  isAdmin: boolean
  tier: SupportTier
  revealLimit: number | null
  revealsToday: number | null
  watermark: string | null
  settings: { compDaysMax: number }
}

export interface SupportMt5Account {
  id: string
  bound: boolean
  real: boolean | null
  broker: string | null
  channel: 'gateway' | 'bridge' | null
  online: boolean
  // admin：完整；内部：后 4 位；外包：没有 / admin full, internal last 4, outsourced absent
  login?: string | null
  server?: string | null
  balance?: number | null
  equity?: number | null
  currency?: string | null
  balanceRange?: string | null
  equityRange?: string | null
}

export interface SupportCustomer {
  id: string
  nickname: string | null
  createdAt: string | null
  lang: string | null
  region: string | null
  inviteCode: string | null
  inviteLabel: string | null
  plan: 'FREE' | 'PRO'
  planExpiresAt: string | null
  planIsTrial: boolean
  trialUsed: boolean
  emailVerified: boolean
  competitions: { id: string; name: string; status: string }[]
  lastActiveAt: string | null
  bridgeOnline: boolean
  gatewayOnline: boolean
  disabled: boolean
  doNotContact: boolean
  email: string | null
  emailMasked: boolean
  phone: string | null
  phoneMasked: boolean
  hasPhone: boolean
  mt5Accounts: SupportMt5Account[]
  openAccountUrl: string | null
  paidTotalUsd?: number
}

export interface FollowUp {
  id: string
  userId: string
  nickname: string | null
  assigneeId: string
  assignedBy: string | null
  goal: FollowUpGoal
  priority: FollowUpPriority
  note: string | null
  status: FollowUpStatus
  nextContactAt: string | null
  expiresAt: string | null
  createdAt: string | null
  closedAt: string | null
  firstContactAt: string | null
  active: boolean
  overdue: boolean
  assigneeName?: string | null
  email?: string | null
  // 管理员的跟进进度才带：记录条数、最近一条、是否停滞 / admin progress view only
  notesCount?: number
  lastNoteAt?: string | null
  lastNote?: { content: string; channel: FollowUpChannel; authorName: string | null } | null
  stale?: boolean
  assignedByName?: string | null
}

export interface FollowUpNote {
  id: string
  followUpId: string
  authorId: string
  authorName: string | null
  channel: FollowUpChannel
  content: string
  outcome: string | null
  createdAt: string
}

export interface SupportConversion {
  id: string
  userId: string
  kind: ConversionKind
  source: 'auto' | 'manual'
  status: ConversionStatus
  followUpId: string | null
  createdAt: string
  creditedToMe: boolean
  creditedTo?: string | null
  detail?: Record<string, unknown>
  userName?: string | null
  creditedName?: string | null
}

export interface SupportCardTicket {
  id: string
  title: string
  category: string
  status: string
  priority: string
  updatedAt: string
  assigneeId: string | null
}

export interface SupportCard {
  customer: SupportCustomer
  followUp: FollowUp | null
  notes: FollowUpNote[]
  conversions: SupportConversion[]
  tickets: SupportCardTicket[]
  // 最近动态（2026-10-28）/ recent activity
  activity?: UserActivityItem[]
}

// 用户最近动态的一条（后端 services/user_activity.py）。字段按 kind 不同而不同。
// One recent-activity entry (backend services/user_activity.py); fields depend on kind.
export type UserActivityItem =
  | { kind: 'signup'; at: string }
  | {
      kind: 'comp'
      at: string
      compId: string
      name: string
      status: string
      metric: string
      login: string | null
      rank: number | null
      total: number | null
      score: number | null
      disqualified: boolean
    }
  | { kind: 'lucky'; at: string; prize: string | null; prizeKind: string | null; status: string; soldOut: boolean; ticketId: string | null }
  | { kind: 'payment'; at: string; plan: string; amountUsd: number }
  | { kind: 'plan'; at: string; field: string; old: string | null; new: string | null; by: string | null }
  | { kind: 'ticket'; at: string; ticketId: string; title: string; category: string; status: string }
  | { kind: 'event'; at: string; event: string; login: string | null }

// 管理端用户档案抽屉 / the admin user drawer
export interface AdminUserOverview {
  user: AdminUser
  customer: SupportCustomer
  ips: { ip: string; place: string | null; lastSeenAt: string | null }[]
  sameIpUsers: number
  activity: UserActivityItem[]
}

export interface SupportRequest {
  id: string
  kind: SupportRequestKind
  requesterId: string
  requesterName: string | null
  targetUserId: string
  targetName?: string | null
  payload: Record<string, unknown>
  status: SupportRequestStatus
  reviewerId: string | null
  reviewedAt: string | null
  note: string | null
  createdAt: string
}

export interface SupportTemplate {
  id: string
  title: string
  body: string
  lang: string | null
  updatedAt: string | null
}

export interface SupportMember {
  id: string
  email: string
  nickname: string | null
  tier: SupportTier | null
  effectiveTier: SupportTier
  revealLimit: number | null
  effectiveRevealLimit: number
  disabled: boolean
  openTickets: number
  activeFollowUps: number
  revealsToday: number
  lastActiveAt: string | null
}

export interface SupportSettings {
  support_comp_days_max: number
  support_follow_up_days: number
  support_outsourced_reveal_daily: number
  support_alert_reveal_per_hour: number
  support_alert_views_per_hour: number
}

export interface AssignBlocker {
  userId: string
  missing: boolean
  doNotContact: boolean
  optedOut: boolean
  activeFollowUp: boolean
  activeAssigneeId: string | null
  staff: boolean
}

export interface AssignInput {
  userIds: string[]
  assigneeId: string
  goal: FollowUpGoal
  priority: FollowUpPriority
  expiresAt?: string | null
  nextContactAt?: string | null
  note?: string | null
  includeOptedOut?: boolean
}

export interface SupportStatsRow {
  staffId: string
  nickname: string | null
  email: string
  role: string
  tier: SupportTier
  assigned: number
  contacted: number
  interested: number
  convertedFollowUps: number
  conversions: Record<ConversionKind, number>
  conversionRate: number | null
  avgFirstContactHours: number | null
}

// 管理员「跟进进度」：每位客服手上的进行中跟进、标签分布、停滞数与近 7 天记录数。
// Admin follow-up progress: each agent's active follow-ups, label mix, stale count and notes in 7 days.
export interface SupportProgressRow {
  staffId: string
  nickname: string | null
  email: string
  role: string
  tier: SupportTier
  disabled: boolean
  active: number
  distribution: Partial<Record<FollowUpStatus, number>>
  stale: number
  notes7d: number
  lastNoteAt: string | null
}

export interface SupportProgress {
  staleDays: number
  totals: { active: number; stale: number; notes7d: number; pending: number }
  items: SupportProgressRow[]
}

export interface FollowUpEvent {
  id: string
  at: string
  action: string
  actorId: string | null
  actorType: string
  actorName: string | null
  data: Record<string, unknown>
}

// 一条跟进的完整记录（管理员抽屉）/ one follow-up's full record (admin drawer)
export interface AdminFollowUpRecord {
  followUp: FollowUp
  user: {
    id: string
    email: string | null
    nickname: string | null
    plan: string | null
    createdAt: string | null
    lastActiveAt: string | null
    doNotContact: boolean
  } | null
  notes: FollowUpNote[]
  events: FollowUpEvent[]
  names: Record<string, string>
  conversions: SupportConversion[]
}
