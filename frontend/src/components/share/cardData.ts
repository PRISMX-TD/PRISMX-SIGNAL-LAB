// 分享卡的纯数据适配：站内数据（平仓、月度、勋章、比赛）-> 模板读取的字段。
// 不依赖渲染（没有 react-dom/server、二维码），页面可以直接静态引用；渲染相关在 cardEnv.ts。
// Pure data adapters for share cards: site data -> template fields. No rendering deps, so pages
// can import it statically; rendering lives in cardEnv.ts.
import type { TFunction } from 'i18next'
import { materialOf } from '../badges/medal'
import { baseSymbol, displaySymbol, parseTime, toPips } from '../../api/utils'

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))

export type CardType = 'A' | 'B' | 'C' | 'D'
export type CardStyle = 'scope' | 'eldark' | 'tidark' | 'lpdark'
export const CARD_STYLES: CardStyle[] = ['scope', 'eldark', 'tidark', 'lpdark']
export const DEFAULT_STYLE: CardStyle = 'scope'

export interface CardState { mode: 'win' | 'loss'; privacy: boolean; medal: string; key: string }
export interface CardTemplate { name: string; blurb: string; css: string; render(type: CardType, state: CardState): string }

export interface TradeCard {
  symbol: string; side: 'BUY' | 'SELL'; sideTxt: string
  open: number; close: number; lots: number; pnl: number; pct: number | null; pips: number | null
  hold: string; exit: string; path: number[]; elSym: string; elNum: string
}
export interface MonthCard {
  year: number; month: number; abbr: string; firstWeekday: number; days: number[]
  total: number; pct: number | null; winRate: number; trades: number; bestDay: number; bestPnl: number
}
export interface BadgeCard { id: string; tier: number; name: string; tierTxt: string; material: string; rarity: number }
export interface CompCard { name: string; rank: number; rankSuffix: string; ret: number; participants: number; medal: { id: string; tier: number } }

export interface CardInput {
  trade?: TradeCard
  month?: MonthCard
  badge?: BadgeCard
  comp?: CompCard
}

// ── 适配器 / adapters ──

// 后端的时间可能是不带时区的 UTC 字符串，必须走 parseTime（补 Z），直接 new Date 会按本地时间解析。
// Backend timestamps may be naive UTC; always go through parseTime (appends Z) instead of new Date.
const ms = (iso: string | null | undefined) => parseTime(iso)?.getTime() ?? NaN

export function fmtDuration(t: TFunction, ms: number): string {
  const min = Math.max(1, Math.round(ms / 60000))
  const d = Math.floor(min / 1440), h = Math.floor((min % 1440) / 60), m = min % 60
  if (d > 0) return t('share.card.durD', { d, h })
  if (h > 0) return t('share.card.durH', { h, m })
  return t('share.card.durM', { m })
}

// 元素风格的「元素符号」：贵金属用真实元素，其余品种取代码前两位。
// The element style's symbol: real elements for precious metals, first two letters otherwise.
const ELEMENTS: Record<string, [string, string]> = { XAUUSD: ['Au', '79'], XAGUSD: ['Ag', '47'], XPTUSD: ['Pt', '78'], XPDUSD: ['Pd', '46'] }
function elementOf(symbol: string): [string, string] {
  const hit = ELEMENTS[baseSymbol(symbol)]
  if (hit) return hit
  const s = displaySymbol(symbol).replace(/[^A-Za-z]/g, '')
  return [s.charAt(0).toUpperCase() + s.charAt(1).toLowerCase(), '']
}

export interface TradeRowLike {
  symbol: string; side: 'BUY' | 'SELL'; volume: number
  openPrice: number | null; closePrice: number | null; openTime: string | null; closeTime: string | null; net: number
}

export function tradeCard(t: TFunction, row: TradeRowLike, balance: number | null | undefined, path?: number[]): TradeCard {
  const open = row.openPrice ?? row.closePrice ?? 0
  const close = row.closePrice ?? open
  const dir = row.side === 'BUY' ? 1 : -1
  const rawPips = row.openPrice != null && row.closePrice != null ? toPips(row.symbol, row.closePrice - row.openPrice) : null
  const pips = rawPips == null ? null : Math.round(rawPips * 10) / 10 * Math.sign((close - open) * dir || row.net || 1)
  // 收益率按「平仓前余额」估算（当前余额减去这笔盈亏），拿不到余额就不给，隐私模式随之关闭。
  // Return is estimated against the pre-trade balance (current balance minus this P&L); without it, privacy mode is off.
  const base = balance != null && balance > 0 ? balance - row.net : 0
  const pct = base > 0 ? Math.round((row.net / base) * 10000) / 100 : null
  const held = ms(row.closeTime) - ms(row.openTime)
  const [elSym, elNum] = elementOf(row.symbol)
  return {
    symbol: esc(displaySymbol(row.symbol)), side: row.side,
    sideTxt: t(row.side === 'BUY' ? 'share.card.long' : 'share.card.short'),
    open, close, lots: row.volume, pnl: row.net, pct, pips,
    hold: Number.isFinite(held) && held > 0 ? fmtDuration(t, held) : '',
    exit: t('share.card.stopTag'),
    path: path && path.length >= 2 ? path : [open, (open + close) / 2, close],
    elSym, elNum,
  }
}

export interface ClosedLike { profit: number; closedAt: string | null; mt5Login?: string; positionTicket?: number }

// 按本地时区把平仓记录归到自然月，逐日汇总净盈亏。
// Bucket closed trades into a calendar month (local time) and sum net P&L per day.
export function monthCard(trades: ClosedLike[], year: number, month: number, balance: number | null | undefined): MonthCard | null {
  const inMonth = trades.filter((tr) => {
    const d = parseTime(tr.closedAt)
    return !!d && d.getFullYear() === year && d.getMonth() + 1 === month
  })
  if (!inMonth.length) return null
  const nDays = new Date(year, month, 0).getDate()
  const days = Array.from({ length: nDays }, () => 0)
  for (const tr of inMonth) days[parseTime(tr.closedAt)!.getDate() - 1] += tr.profit
  const r2 = (v: number) => Math.round(v * 100) / 100
  for (let i = 0; i < nDays; i++) days[i] = r2(days[i])
  const total = r2(inMonth.reduce((s, tr) => s + tr.profit, 0))
  // 笔数与胜率按「仓位」算：一笔分批平仓的多条腿合成一笔，和平仓明细、胜率卡的口径一致。
  // Count and win rate are per position: partial-close legs merge into one trade, matching the closed list.
  const byPos = new Map<string, number>()
  inMonth.forEach((tr, i) => {
    const k = tr.positionTicket != null ? `${tr.mt5Login ?? ''}:${tr.positionTicket}` : `leg${i}`
    byPos.set(k, (byPos.get(k) ?? 0) + tr.profit)
  })
  const nTrades = byPos.size
  const wins = [...byPos.values()].filter((v) => v > 0).length
  let best = 0
  days.forEach((v, i) => { if (v > days[best]) best = i })
  const dow = new Date(year, month - 1, 1).getDay()
  const base = balance != null && balance > 0 ? balance - total : 0
  return {
    year, month,
    abbr: new Intl.DateTimeFormat('en-US', { month: 'short' }).format(new Date(year, month - 1, 1)),
    firstWeekday: dow === 0 ? 7 : dow,
    days, total,
    pct: base > 0 ? Math.round((total / base) * 1000) / 10 : null,
    winRate: Math.round((wins / nTrades) * 1000) / 10,
    trades: nTrades, bestDay: best + 1, bestPnl: days[best],
  }
}

const ROMAN = ['', 'I', 'II', 'III']
export function badgeCard(t: TFunction, b: { id: string; tier: number; maxTier: number; owners: number; tierOwners: number[] }, population: number): BadgeCard {
  const mat = materialOf(b.id, b.maxTier > 0 ? b.tier : null)
  // 卡片只认五种材质；乌金、素面按金、铜处理。/ Cards know five materials; onyx and plain fold into gold and bronze.
  const material = mat === 'onyx' ? 'gold' : mat === 'plain' ? 'bronze' : mat
  const tiered = b.maxTier > 0
  const tierTxt = tiered
    ? `${t(`share.card.tier.${b.tier}`)} ${ROMAN[b.tier] ?? ''}`.trim()
    : t(mat === 'legend' ? 'share.card.legend' : mat === 'limited' ? 'share.card.limited' : 'share.card.special')
  // tierOwners 是各档「当前」持有人数（升档后只算在新档），「获得过本档」= 本档及以上之和。
  // tierOwners counts current holders per tier; "earned this tier" = this tier and above.
  const owners = tiered && b.tierOwners.length ? b.tierOwners.slice(b.tier - 1).reduce((a, n) => a + (n ?? 0), 0) : b.owners
  const rarity = population > 0 ? Math.max(0.1, Math.round((owners / population) * 1000) / 10) : 0
  return { id: b.id, tier: tiered ? b.tier : 0, name: t(`gamification.badges.${b.id}.name`), tierTxt, material, rarity }
}

const ordinal = (n: number) => {
  const v = n % 100
  if (v >= 11 && v <= 13) return 'th'
  return ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'
}
export function compCard(name: string, rank: number, ret: number, participants: number): CompCard {
  return {
    name, rank, rankSuffix: ordinal(rank), ret, participants,
    // 赛场勋章：冠军金、前三银、其余铜 / arena medal: gold for 1st, silver for top 3, bronze otherwise
    medal: { id: 'arena', tier: rank === 1 ? 3 : rank <= 3 ? 2 : 1 },
  }
}

// 单笔战报的信号曲线：取持仓期间的真实 K 线收盘价（约 30 根），拿不到就返回 null，模板退回开平仓两点。
// The trade card's signal line: real candle closes over the holding period (~30 bars); null if unavailable,
// in which case the template falls back to the open/close points.
const STEPS = [1, 5, 15, 60, 240]
export async function loadTradePath(row: TradeRowLike): Promise<number[] | null> {
  if (!row.openTime || !row.closeTime || row.openPrice == null || row.closePrice == null) return null
  const t0 = ms(row.openTime) / 1000, t1 = ms(row.closeTime) / 1000
  if (!(t1 > t0)) return null
  const holdMin = (t1 - t0) / 60
  const step = STEPS.find((m) => holdMin / m <= 40) ?? 240
  const limit = Math.min(500, Math.ceil(holdMin / step) + 4)
  const { chartApi } = await import('../../api/client')
  const r = await chartApi.history(baseSymbol(row.symbol), String(step), limit, Math.floor(t1 + step * 60))
  const sec = (t: number) => (t > 1e12 ? t / 1000 : t)
  const closes = r.bars.filter((b) => sec(b.t) >= t0 - step * 60 && sec(b.t) <= t1).map((b) => b.c)
  if (closes.length < 3) return null
  return [row.openPrice, ...closes.slice(1, -1), row.closePrice]
}
