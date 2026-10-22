// 幸运轮盘（rev 45）接口类型；与 backend/app/routers/lucky_wheel.py 一一对应。
// 注意：后端日期时间是不带 Z 的 naive UTC 字符串，解析请用 api/utils 的 parseTime。
// Lucky-wheel (rev 45) API types, mirroring backend/app/routers/lucky_wheel.py. Datetimes are
// naive-UTC strings without a `Z`; parse them with parseTime from api/utils.
export type LuckyPrizeKind = 'pro_days' | 'none' | 'retry' | 'custom'
export type LuckyClaimMode = 'form' | 'ticket'
export type LuckySoldOut = 'to_fallback' | 'redistribute'
export type LuckyFulfillment = 'auto_done' | 'pending' | 'submitted' | 'delivered' | 'cancelled'
export type LuckyPhase = 'none' | 'upcoming' | 'active' | 'ended'

export interface LuckyRound { id: string; startsAt: string; endsAt: string; phase: LuckyPhase }
export interface LuckyPrizePublic {
  id: string; name: string; description: string | null; imageUrl: string | null
  color: string | null; kind: LuckyPrizeKind; proDays: number | null
}
export interface LuckyPrizeAdmin extends LuckyPrizePublic {
  probBp: number; stock: number | null; stockUsed: number; perUserLimit: number | null
  onSoldOut: LuckySoldOut; claimMode: LuckyClaimMode | null; claimHint: string | null
}
export interface LuckyPrizeInput {
  id?: string; name: string; description?: string | null; imageUrl?: string | null; color?: string | null
  kind: LuckyPrizeKind; proDays?: number | null; probPct: number; stock?: number | null
  perUserLimit?: number | null; onSoldOut: LuckySoldOut; claimMode?: LuckyClaimMode | null; claimHint?: string | null
}
export interface LuckyState {
  visible: boolean
  round: LuckyRound | null
  prizes: LuckyPrizePublic[]
  // reason 为 null = 「再来一次」补发的券（没有批次）/ null reason = retry-refund tickets (no batch)
  tickets: { unused: number; batches: { reason: string | null; issuedAt: string; count: number }[] }
}
export interface LuckyDraw {
  id: string; createdAt: string; slotIndex: number | null
  prize: Pick<LuckyPrizePublic, 'id' | 'name' | 'description' | 'imageUrl' | 'color' | 'kind' | 'proDays'> &
    { claimMode: LuckyClaimMode | null; claimHint: string | null }
  fulfillmentStatus: LuckyFulfillment; claimInfo: string | null; supportTicketId: string | null; adminNote: string | null
}
export interface LuckySpinResult extends LuckyDraw { ticketsLeft: number; round: LuckyRound | null }
export interface LuckyAdminConfig { visible: boolean; round: LuckyRound | null; prizes: LuckyPrizeAdmin[] }
export interface LuckyTier { fromRank: number; toRank: number; count: number }
export type LuckyRankSource =
  | { type: 'comp'; compId: string; tiers: LuckyTier[] }
  | { type: 'board'; board: 'return_pct' | 'win_rate'; period: string; tiers: LuckyTier[] }
export type LuckySource = 'manual' | 'comp_rank' | 'board_rank'
export interface LuckyIssueRow {
  userId: string; email: string; nickname: string | null; rank: number | null; count: number
  source: LuckySource; sourceRef: string | null; label: string
}
export interface LuckyIssueItem { userId: string; count: number; source: LuckySource; sourceRef?: string | null; rank?: number | null }
export interface LuckyBatch {
  id: string; reason: string; createdAt: string; userCount: number; ticketCount: number; used: number; notified: boolean
}
export interface LuckyAdminDraw {
  id: string; createdAt: string; roundId: string
  user: { id: string; email: string; nickname: string | null }
  prize: { id: string; name: string; kind: LuckyPrizeKind; proDays: number | null; claimMode: LuckyClaimMode | null; probBp: number | null }
  fulfillmentStatus: LuckyFulfillment; claimInfo: string | null; supportTicketId: string | null
  adminNote: string | null; handledAt: string | null
}
