// 奖项编辑表的行状态 ⇄ 接口入参（v2：按期、两种模式）。数字字段在输入框里是字符串，保存时才换算。
// 校验与后端 services/lucky/odds.validate 同规则，只为提前提示；保存时仍以后端为准。
//   按份量 qty：每格「份数」必填（≥0 整数），合计份数 > 0；概率不填（发 0）。
//   按概率 prob：每格「概率 %」0–100、最多两位小数、合计 = 100%；「份数上限」可空（空 = 不限）。
//   两种模式：2–12 格、名称、PRO 天数 1–3650、自定义奖品要选领取方式、份数不能少于已发出数。
// Prize editor row state <-> API payload (v2: per round, two modes). Numeric fields are strings while
// typing and only converted on save. Validation mirrors the backend's odds.validate purely as an early
// hint; the backend remains the final authority.
//   qty: every slot needs a stock (integer >= 0) and the total stock must be > 0; odds are sent as 0.
//   prob: every slot needs 0–100% with at most two decimals, summing to 100%; the stock cap is optional.
//   Both: 2–12 slots, names, PRO days 1–3650, a claim mode for custom prizes, stock >= already given.
import type { LuckyClaimMode, LuckyMode, LuckyPrizeAdmin, LuckyPrizeInput, LuckyPrizeKind } from '../../../api/luckyTypes'
import type { FestivalKey } from '../../../festival/calendar'
import { PALETTE } from '../../lucky/wheelArt'

export interface PrizeRow {
  key: string; id?: string; name: string; description: string; imageUrl: string; color: string
  kind: LuckyPrizeKind; proDays: string; probPct: string; stock: string
  claimMode: LuckyClaimMode | ''; claimHint: string; stockUsed: number
}

let seq = 0
export const blankRow = (kind: LuckyPrizeKind = 'none'): PrizeRow => ({
  key: `new-${++seq}`, name: '', description: '', imageUrl: '', color: '', kind, proDays: '', probPct: '0',
  stock: '', claimMode: '', claimHint: '', stockUsed: 0,
})

export const fromAdmin = (p: LuckyPrizeAdmin): PrizeRow => ({
  key: p.id, id: p.id, name: p.name, description: p.description ?? '', imageUrl: p.imageUrl ?? '',
  color: p.color ?? '', kind: p.kind, proDays: p.proDays ? String(p.proDays) : '', probPct: String(p.probBp / 100),
  stock: p.stock == null ? '' : String(p.stock),
  claimMode: p.claimMode ?? '', claimHint: p.claimHint ?? '', stockUsed: p.stockUsed,
})

const blank = (s: string) => s.trim() === ''
// 空白（含只有空格）= 不填；否则必须是合法数字，这里不再把 NaN 悄悄变成 null。
// Blank (incl. whitespace-only) = not set; anything else must be a real number, so NaN can never
// quietly turn into null (= unlimited) on save.
const num = (s: string) => (blank(s) ? null : Number(s))
const bp = (s: string) => Math.round((Number(s) || 0) * 100)
const isInt = (s: string, min: number) => /^\d+$/.test(s.trim()) && Number(s) >= min

export const totalPct = (rows: PrizeRow[]) => rows.reduce((a, r) => a + bp(r.probPct), 0) / 100
/** 按份量模式的总份数（不合法的格按 0 算）/ Total stock in qty mode (invalid cells count as 0). */
export const totalQty = (rows: PrizeRow[]) => rows.reduce((a, r) => a + (isInt(r.stock, 0) ? Number(r.stock) : 0), 0)

// 格子没存颜色时转盘按序号取 LuckyWheel 的 PALETTE；这里直接引用同一份，不再各抄一遍。
// A slot with no saved colour is painted with LuckyWheel's PALETTE entry by index; import the same
// array rather than keeping a second copy.
export const autoColor = (i: number) => PALETTE[i % PALETTE.length]

export function problems(rows: PrizeRow[], mode: LuckyMode): string[] {
  const out = new Set<string>()
  if (rows.length < 2 || rows.length > 12) out.add('admin.lucky.err.slots')
  if (mode === 'prob' && rows.reduce((a, r) => a + bp(r.probPct), 0) !== 10000) out.add('admin.lucky.err.total')
  for (const r of rows) {
    if (!r.name.trim()) out.add('admin.lucky.err.name')
    if (r.kind === 'pro_days' && !(Number.isInteger(Number(r.proDays)) && Number(r.proDays) >= 1 && Number(r.proDays) <= 3650)) out.add('admin.lucky.err.days')
    if (r.kind === 'custom' && !r.claimMode) out.add('admin.lucky.err.claimMode')
    if (mode === 'prob') {
      const p = blank(r.probPct) ? 0 : Number(r.probPct)
      if (!Number.isFinite(p) || p < 0 || p > 100) out.add('admin.lucky.err.prob')
      else if (Math.abs(p * 100 - Math.round(p * 100)) > 1e-6) out.add('admin.lucky.err.decimals')
      if (!blank(r.stock) && !isInt(r.stock, 0)) out.add('admin.lucky.err.capNumber')
      else if (!blank(r.stock) && Number(r.stock) < r.stockUsed) out.add('admin.lucky.err.stockBelowUsed')
    } else {
      if (blank(r.stock)) out.add('admin.lucky.err.stockRequired')
      else if (!isInt(r.stock, 0)) out.add('admin.lucky.err.stockNumber')
      else if (Number(r.stock) < r.stockUsed) out.add('admin.lucky.err.stockBelowUsed')
    }
  }
  if (mode === 'qty' && rows.length > 0 && totalQty(rows) <= 0 && !out.has('admin.lucky.err.stockRequired') && !out.has('admin.lucky.err.stockNumber')) {
    out.add('admin.lucky.err.qtyTotal')
  }
  return [...out]
}

export const toInput = (rows: PrizeRow[], mode: LuckyMode): LuckyPrizeInput[] => rows.map((r) => ({
  ...(r.id ? { id: r.id } : {}),
  name: r.name.trim(), description: r.description.trim() || null, imageUrl: r.imageUrl || null,
  color: /^#[0-9a-fA-F]{6}$/.test(r.color) ? r.color : null, kind: r.kind,
  proDays: r.kind === 'pro_days' ? num(r.proDays) : null,
  // 按份量模式不看概率，固定发 0（后端存 0）/ qty mode ignores odds; always send 0 (stored as 0)
  probPct: mode === 'prob' ? bp(r.probPct) / 100 : 0,
  stock: num(r.stock),
  claimMode: r.kind === 'custom' ? (r.claimMode || null) : null,
  claimHint: r.kind === 'custom' ? r.claimHint.trim() || null : null,
}))

// ── 预览：分布图与「试转」/ preview: the share bar and the local test spin ──

/**
 * 每格在当前设置下的抽中权重，与后端同口径：按份量 = 剩余份数（份数 - 已发出，不合法按 0）；
 * 按概率 = 万分比。按概率模式里份数已满的格权重不变（落在那里算未中奖，概率不会分给别的格）。
 * Each slot's weight under the current settings, same rules as the backend: qty = remaining stock
 * (stock - given, invalid counts as 0); prob = basis points. A sold-out slot keeps its odds in prob mode
 * (landing there is a miss; the odds are never handed to other slots).
 */
export function previewWeights(rows: PrizeRow[], mode: LuckyMode): number[] {
  return rows.map((r) => {
    if (mode === 'prob') return Math.max(0, bp(r.probPct))
    return isInt(r.stock, 0) ? Math.max(0, Number(r.stock) - r.stockUsed) : 0
  })
}

/** 每格占比（%，一位小数）；全部为 0 时都是 0 / Share of each slot in %, one decimal; all zero when the total is 0. */
export function sharePct(weights: number[]): number[] {
  const sum = weights.reduce((a, w) => a + w, 0)
  return weights.map((w) => (sum > 0 ? Math.round((w / sum) * 1000) / 10 : 0))
}

/**
 * 按权重挑一格；rand ∈ [0, 1)。权重全为 0 返回 -1（试转按钮据此提示，不转）。
 * Pick a slot by weight; rand in [0, 1). Returns -1 when every weight is 0 (the test spin then explains instead of spinning).
 */
export function pickWeighted(weights: number[], rand: number): number {
  const sum = weights.reduce((a, w) => a + Math.max(0, w), 0)
  if (sum <= 0) return -1
  let x = Math.min(Math.max(rand, 0), 0.999999999) * sum
  for (let i = 0; i < weights.length; i++) {
    const w = Math.max(0, weights[i])
    if (x < w) return i
    x -= w
  }
  for (let i = weights.length - 1; i >= 0; i--) if (weights[i] > 0) return i
  return -1
}

export type FestivalChoice = 'auto' | 'none' | FestivalKey
export const FESTIVAL_CHOICES: FestivalChoice[] = ['auto', 'none', 'spring', 'midautumn', 'halloween', 'christmas', 'newyear']

/** 预览用哪个节日皮肤：「自动」跟着站点当前的节日 / Which festival skin the preview uses; auto follows the site. */
export const resolveFestival = (choice: FestivalChoice, site: FestivalKey | null): FestivalKey | null =>
  choice === 'auto' ? site : choice === 'none' ? null : choice

/** 按概率模式里份数已经发完的格（试转抽到它时提示「用户抽到算未中奖」）/ A prob-mode slot whose cap is used up. */
export const slotSoldOut = (r: PrizeRow, mode: LuckyMode) =>
  mode === 'prob' && isInt(r.stock, 0) && Number(r.stock) <= r.stockUsed
