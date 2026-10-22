// 幸运轮盘 v2（rev 46）接口类型；与 backend/app/routers/lucky_wheel.py 一一对应。
// v2：多期并行，每期有自己的名称、奖品模式（按份量 qty / 按概率 prob）、一套奖品和「在用户端显示」开关。
// 注意：后端日期时间是不带 Z 的 naive UTC 字符串，解析请用 api/utils 的 parseTime。
// Lucky-wheel v2 (rev 46) API types, mirroring backend/app/routers/lucky_wheel.py. v2 runs several
// rounds side by side; each has its own name, prize mode (qty / prob), prize set and visible switch.
// Datetimes are naive-UTC strings without a `Z`; parse them with parseTime from api/utils.
export type LuckyPrizeKind = 'pro_days' | 'none' | 'retry' | 'custom'
export type LuckyClaimMode = 'form' | 'ticket'
export type LuckyFulfillment = 'auto_done' | 'pending' | 'submitted' | 'delivered' | 'cancelled'
export type LuckyPhase = 'upcoming' | 'active' | 'ended'
// qty = 按份量（抽奖箱：剩余份数即权重）/ prob = 按概率（万分比权重，可选份数上限）
// qty = by quantity (a raffle box: remaining stock is the weight) / prob = by probability (bp weights, optional cap)
export type LuckyMode = 'qty' | 'prob'

/** 用户端的期：不给模式、概率、份数 / A round as users see it: no mode, odds or stock. */
export interface LuckyRoundPublic { id: string; name: string; startsAt: string; endsAt: string; phase: LuckyPhase }
export interface LuckyRoundStats { issued: number; used: number; unused: number; pendingClaims: number; draws: number }
/** 管理端的期 / A round as the admin sees it. */
export interface LuckyRoundAdmin extends LuckyRoundPublic {
  mode: LuckyMode; visible: boolean; endedAt: string | null; stats: LuckyRoundStats
}
export interface LuckyPrizePublic {
  id: string; name: string; description: string | null; imageUrl: string | null
  color: string | null; kind: LuckyPrizeKind; proDays: number | null
}
export interface LuckyPrizeAdmin extends LuckyPrizePublic {
  probBp: number; stock: number | null; stockUsed: number
  claimMode: LuckyClaimMode | null; claimHint: string | null
}
export interface LuckyPrizeInput {
  id?: string; name: string; description?: string | null; imageUrl?: string | null; color?: string | null
  kind: LuckyPrizeKind; proDays?: number | null
  // prob 模式必填（0–100）；qty 模式忽略（发 0）/ required in prob mode; ignored in qty mode (sent as 0)
  probPct?: number | null
  // qty 模式必填（≥0 整数）；prob 模式为份数上限，null = 不限 / required in qty mode; an optional cap in prob mode
  stock?: number | null
  claimMode?: LuckyClaimMode | null; claimHint?: string | null
}
export interface LuckyTicketBatchPublic { reason: string | null; issuedAt: string; count: number }
/** GET /lucky-wheel 里的一期 / One round in GET /lucky-wheel. */
export interface LuckyRoundState {
  round: LuckyRoundPublic
  prizes: LuckyPrizePublic[]
  // reason 为 null = 「再来一次」补发的券（没有批次）/ null reason = retry-refund tickets (no batch)
  tickets: { unused: number; batches: LuckyTicketBatchPublic[] }
}
export interface LuckyState { rounds: LuckyRoundState[] }
export interface LuckyDraw {
  id: string; createdAt: string; slotIndex: number | null
  prize: Pick<LuckyPrizePublic, 'id' | 'name' | 'description' | 'imageUrl' | 'color' | 'kind' | 'proDays'> &
    { claimMode: LuckyClaimMode | null; claimHint: string | null }
  fulfillmentStatus: LuckyFulfillment; claimInfo: string | null; supportTicketId: string | null; adminNote: string | null
  // 按概率模式抽中已抽完的格 = 未中奖（券照用、无奖品效果）/ prob mode landed on a sold-out slot = no win
  soldOut: boolean
  roundId: string; roundName: string
}
export interface LuckySpinResult extends LuckyDraw { ticketsLeft: number; round: LuckyRoundPublic }
export interface LuckyRoundDetail { round: LuckyRoundAdmin; prizes: LuckyPrizeAdmin[] }
export interface LuckyRoundCreate { name: string; startsAt: string; endsAt: string; mode: LuckyMode }
export interface LuckyRoundPatch { name?: string; startsAt?: string; endsAt?: string }
export interface LuckyRoundDeleted { deleted: { draws: number; tickets: number; batches: number; prizes: number } }
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
export interface LuckyIssueBody { roundId: string; reason: string; requestId: string; items: LuckyIssueItem[] }
export interface LuckyIssueResult { id: string; userCount: number; ticketCount: number; notified: boolean }
export interface LuckyBatch {
  id: string; reason: string; createdAt: string; userCount: number; ticketCount: number; used: number; notified: boolean
}
export interface LuckyAdminDraw {
  id: string; createdAt: string; roundId: string; roundName: string; soldOut: boolean
  user: { id: string; email: string; nickname: string | null }
  prize: { id: string; name: string; kind: LuckyPrizeKind; proDays: number | null; claimMode: LuckyClaimMode | null; probBp: number | null }
  fulfillmentStatus: LuckyFulfillment; claimInfo: string | null; supportTicketId: string | null
  adminNote: string | null; handledAt: string | null
}
