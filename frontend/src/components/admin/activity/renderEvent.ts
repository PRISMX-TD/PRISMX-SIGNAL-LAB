// 操作日志的「一句话」：后端只给 {kind, params}，句子在这里按当前语言拼（设计 §5.3 / §6）。
//
// 规矩（老板要的是「简单易懂、一句大白话」）：
//   · 句子里不出现订单号、回执码、英文枚举（BUY / SELL_LIMIT / FAILED / MOBILE…）——这些都
//     翻成人话，原值只在详情抽屉的「原始字段」里给。认不出来的值（将来新增的设置项、兜底的
//     admin.other 字段名）照样显示原文：宁可难看也绝不丢（契约 §5.3 的「绝不丢」）。
//   · 指令失败 / 结果未知时句末跟一句翻好的原因（「原因：保证金不足」），券商原话只在详情里。
//   · 价格按值本身的小数位（同一句里的几个价格对齐到同一位数，至少两位；认得的品种不少于它的
//     报价精度，EURUSD 5 位），不加千分位；
//     金额（盈亏、余额）两位小数 + 千分位，盈亏带正负号；不带货币符号（按账户货币，美分账户
//     会大 100 倍——详情里注明）。
//   · 盈亏单独成一段 {pnl}，由组件染红绿；text 是同一句的纯文本（详情标题、单测都用它）。
//   · 缺的 params 键一律按 null（契约 §2.1「容错」），拼不出就退回该 kind 的通用说法。
//
// 每个 kind 一个渲染函数，表用 Record<ActivityKind, …>：后端加了 kind、这里忘了补，tsc 直接
// 报错（和 i18n.test 里 orders.action 那张表同一个套路）。
//
// The activity log's one-line sentence. The backend sends only {kind, params}; the
// sentence is built here in the current language (design §5.3 / §6). Rules: no order
// numbers, retcodes or English enums in the sentence (raw values live in the drawer);
// unrecognised values (future setting keys, the admin.other fallback) still show
// verbatim — ugly beats dropped. A failed / outcome-unknown instruction ends with a
// translated reason ("reason: not enough margin"); the raw broker text stays in the drawer.
// Prices keep their own decimals (aligned within one sentence, at least two, and never
// below a known symbol's quote precision — EURUSD 5), no grouping; money gets two decimals with grouping, P/L gets
// a sign; no currency symbol. P/L is its own {pnl} part so the component can colour it;
// `text` is the same sentence as plain text. Missing params read as null. One renderer
// per kind in a Record<ActivityKind, …>, so a kind added to the backend but not here
// fails tsc.
import type { TFunction } from 'i18next'
import type { ActivityItem, ActivityPerson, ActivityTag } from '../../../api/types'
import { resolvePriceDigits } from '../../charts/chartConfig'
import { bjDate, bjDateTime, bjDayKey, bjHm } from './time'

// 与后端 activity_feed.KINDS 一致（契约 §6 机器可读清单，53 种）。
// Mirrors the backend's activity_feed.KINDS (contract §6, 53 kinds).
export const ACTIVITY_KINDS = [
  'user.register', 'user.login', 'user.email_verified', 'user.password_reset_requested', 'user.password_reset',
  'user.password_changed', 'user.nickname', 'user.phone_set',
  'plan.trial_claim', 'plan.invite_trial', 'plan.payment', 'plan.refund', 'plan.payment_issue', 'plan.auto_expire',
  'mt5.bind', 'mt5.reverify', 'mt5.unbind', 'mt5.revoked', 'user.api_token_reset',
  'trade.open', 'pending.place', 'pending.modify', 'pending.cancel', 'trade.close', 'auto.partial_tp',
  'sltp.modify', 'auto.sl', 'trade.other', 'trade.close_all', 'trade.corrected', 'deal.close',
  'deal.stopout_group', 'auto.settings',
  'admin.user_plan', 'admin.user_role', 'admin.user_attribution', 'admin.user_edit', 'admin.user_disable',
  'admin.user_enable', 'admin.verify_email', 'admin.bulk_edit', 'admin.setting', 'admin.gamification',
  'admin.invite_link', 'admin.agent_assign', 'agent.plan', 'admin.competition', 'admin.competition_participant',
  'admin.announcement', 'admin.email', 'admin.ops', 'admin.ticket', 'admin.other',
] as const
export type ActivityKind = (typeof ACTIVITY_KINDS)[number]

export type Part = string | { pnl: number }
export interface Rendered {
  parts: Part[]
  text: string
}

type P = Record<string, unknown>
type Piece = Part[] | string | null | false | undefined
interface Ctx {
  t: TFunction
  p: P
  item: ActivityItem
}

// ---------- 取值：缺键、类型不对一律当 null / readers: missing or mistyped reads as null ----------
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null)
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const obj = (v: unknown): P | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as P) : null)
const pairOf = (v: unknown): [unknown, unknown] | null => (Array.isArray(v) && v.length === 2 ? [v[0], v[1]] : null)

// ---------- 数字 / numbers ----------
function decimalsOf(v: number): number {
  const s = String(v)
  if (s.includes('e')) return 5
  const frac = s.split('.')[1]
  return frac ? Math.min(frac.length, 5) : 0
}

/** 同一句里几个价格共用的小数位：取最长的那个，至少两位、最多五位。/ Shared decimals for prices in one sentence. */
export function pxDigits(...vals: (number | null)[]): number {
  let d = 2
  for (const v of vals) if (v != null) d = Math.max(d, decimalsOf(v))
  return Math.min(d, 5)
}

/**
 * 带品种的价格位数：品种自己的报价精度（图表页那张兜底表：EURUSD 5 位、USDJPY 3 位…）作下限，
 * 再与这一句里各价格本身的位数取大。于是 EURUSD 上「移除止盈（原 1.085）」读成「原 1.08500」，
 * 和同一品种别的行对齐；认不出的品种只在这一句里对齐。
 * Price decimals for a symbol: the symbol's own quote precision (the charts page's fallback
 * table: EURUSD 5, USDJPY 3…) is the floor, raised by the decimals of the prices in this
 * sentence. So on EURUSD "remove take profit (was 1.085)" reads "was 1.08500", matching the
 * symbol's other rows; an unknown symbol aligns within the sentence only.
 */
export function symDigits(sym: unknown, ...vals: (number | null)[]): number {
  const s = str(sym)
  const known = s ? resolvePriceDigits(s) : null
  return Math.min(5, Math.max(pxDigits(...vals), known ?? 0))
}

export function fmtPx(v: number, digits: number): string {
  return v.toFixed(digits)
}

/** 手数：至少两位小数（0.1 → 0.10），最多三位。/ Lots: at least two decimals, at most three. */
export function fmtLots(v: number): string {
  return v.toFixed(Math.min(3, Math.max(2, decimalsOf(v))))
}

/** 金额：两位小数 + 千分位，不带符号。/ Money: two decimals with grouping, unsigned. */
export function fmtAmount(v: number): string {
  return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/** 盈亏：带正负号；四舍五入后是 0 就不带号（不出现 -0.00）。/ Signed P/L; a rounded zero carries no sign. */
export function fmtPnl(v: number): string {
  const r = Math.round(v * 100) / 100
  const s = fmtAmount(Math.abs(r))
  return r > 0 ? `+${s}` : r < 0 ? `-${s}` : s
}

// ---------- 文案小件 / copy helpers ----------
/** 有就翻，没有就退回给定的原文（i18next 缺键时原样回 key）。/ Translate, or fall back when the key is missing. */
function lbl(t: TFunction, key: string, fallback: string): string {
  const s = t(key)
  return s === key ? fallback : s
}

const q = (t: TFunction, v: string) => t('admin.log.q', { v })
const clip = (s: string, n = 40) => (s.length > n ? `${s.slice(0, n)}…` : s)
// 记录编号（uuid）对管理员没有意义，绝不进句子；原值在详情抽屉里。
// Record ids (uuids) mean nothing to an admin and never go into a sentence; the drawer has them.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const capFirst = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s)
const lowerFirst = (s: string) => (/^[A-Z][a-z]/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s)
const none = (t: TFunction) => t('admin.log.v.none')

function sideLabel(t: TFunction, side: unknown): string | null {
  const s = str(side)
  return s === 'BUY' || s === 'SELL' ? t(`admin.log.v.side.${s}`) : null
}

/** 「XAUUSD 买单 0.10 手」：哪一项没有就省掉哪一项。/ "XAUUSD buy 0.10 lots", omitting what's missing. */
function subj(t: TFunction, sym: unknown, side: unknown, vol: unknown): string {
  const v = num(vol)
  return [str(sym), sideLabel(t, side), v != null ? t('admin.log.x.lots', { v: fmtLots(v) }) : null].filter(Boolean).join(' ')
}

/** 句子骨架：head —— subject，tail1，tail2… / Skeleton: head — subject, tail1, tail2… */
function sentence(t: TFunction, head: Piece, subject: string | null, tail: Piece[] = []): Part[] {
  const out: Part[] = head ? (typeof head === 'string' ? [head] : [...head]) : []
  if (subject) out.push(t('admin.log.sep'), subject)
  for (const x of tail) {
    if (!x || (Array.isArray(x) && x.length === 0)) continue
    out.push(t('admin.log.comma'), ...(typeof x === 'string' ? [x] : x))
  }
  return out
}

/** 「修改会员：」+ 若干项用「；」连起来。/ A heading followed by items joined with semicolons. */
function listed(t: TFunction, headKey: string, items: string[], opts: Record<string, unknown> = {}): string {
  return t(headKey, opts) + items.join(t('admin.log.semi'))
}

function pnlPiece(t: TFunction, pnl: unknown, pending: unknown, labelKey = 'admin.log.x.pnl'): Piece {
  const v = num(pnl)
  if (v != null) return [t(labelKey), ' ', { pnl: v }]
  return pending === true ? t('admin.log.x.pnlPending') : null
}

function balancePiece(t: TFunction, bal: unknown): Piece {
  const v = num(bal)
  return v != null ? t('admin.log.x.balance', { v: fmtAmount(v) }) : null
}

/** 订单的结构化说明 → 括号里的固定文案（被拒 / 结果未知本身靠状态小标签说）。
 *  An order note → a fixed parenthetical (plain fail / unknown are said by the status chip). */
function noteSuffix(t: TFunction, note: unknown): string {
  const n = str(note)
  return n === 'user_cancelled' || n === 'timeout' || n === 'timeout_unknown' ? t(`admin.log.x.note.${n}`) : ''
}

function srcSuffix(t: TFunction, src: unknown): string {
  const s = str(src)
  return s === 'SIG' || s === 'STRAT' ? t(`admin.log.x.src.${s}`) : ''
}

// ---------- 失败原因 / failure reasons ----------
// 指令失败（被拒）或结果未知时，句子末尾跟一句「原因：保证金不足」。券商 / 网关 / 桥接的原话
// （MT_RET_REQUEST_NO_MONEY: 交易被拒绝(检查品种名…)、下单被拒绝 / Order rejected (#10027)…）
// 只在详情抽屉里给，句子里只放翻好的短语：不出返回码、编号，中文句子里不出英文。
// 先认返回码名（网关的 MT_RET_*、终端的 TRADE_RETCODE_*，去掉前缀后同一张表），再认原话里的
// 固定说法（网关 / 桥接 / 后端自己写的那些），再认「(#10027)」这种数字返回码；都认不出，中文
// 取原话的中文那半截短，英文取英文那半，都没有就按状态说「券商拒绝」/「结果未知，请核对持仓」。
// 超时作废 / 超时结果未知 / 发出前撤回 / 仓位已不在，句子里已经有固定说法，不再重复原因。
// A failed (rejected) or outcome-unknown instruction ends with "reason: not enough margin".
// The raw broker / gateway / bridge message stays in the drawer; the sentence gets only a
// translated phrase — no return codes or numbers, and no English in a zh sentence. Order:
// the return-code name (the gateway's MT_RET_*, the terminal's TRADE_RETCODE_*, one table
// once the prefix is stripped), then fixed wordings the gateway / bridge / backend write,
// then a numeric retcode like "(#10027)". Otherwise zh takes the message's Chinese half
// (trimmed), en its English half, and failing both the status decides: "rejected by the
// broker" / "outcome unknown, check positions". Timeouts, user withdrawals and gone
// positions already have a fixed wording in the sentence, so they get no reason.
type Why =
  | 'noMoney' | 'closeExists' | 'noPrice' | 'noQuotes' | 'positionMissing' | 'accountMissing' | 'pendingMissing'
  | 'unconfirmed' | 'gwNoPending' | 'gwUnsupported' | 'gwDown' | 'gatewayTimeout' | 'gwNoReply' | 'staleUnknown'
  | 'invalidFill' | 'positionClosed' | 'invalidStops' | 'invalidVolume' | 'closeVolume' | 'invalidPrice'
  | 'invalidExpiry' | 'invalidRequest' | 'marketClosed' | 'tradeDisabled' | 'priceChanged' | 'limitOrders'
  | 'limitPositions' | 'limitVolume' | 'rejected' | 'brokerError' | 'cancelled' | 'timeout' | 'frozen' | 'locked'
  | 'onlyReal' | 'noConnection' | 'tooMany' | 'noChanges' | 'orderChanged' | 'atServer' | 'atClient'
  | 'longOnly' | 'shortOnly' | 'closeOnly' | 'fifo' | 'hedge' | 'permissions' | 'unknown'

// 返回码名（去掉 MT_RET_ / MT_RET_REQUEST_ / TRADE_RETCODE_ 前缀）→ 原因。两套名字不一样的
// （TOO_MANY / TOO_MANY_REQUESTS、AT_DISABLED_CLIENT / CLIENT_DISABLES_AT…）都列上。
// ERR_NOTFOUND 不在表里：它的意思要看后面那句话（找不到仓位 / 挂单 / 取价失败 / 账号不存在）。
// Return-code name (prefix stripped) → reason; where the two naming schemes differ both are
// listed. ERR_NOTFOUND is deliberately absent: its meaning depends on the text after it.
const CODE_WHY: Record<string, Why> = {
  NO_MONEY: 'noMoney',
  CLOSE_ORDER_EXIST: 'closeExists',
  PLACED_UNCONFIRMED: 'unconfirmed',
  INVALID_FILL: 'invalidFill',
  POSITION_CLOSED: 'positionClosed',
  INVALID_STOPS: 'invalidStops',
  INVALID_VOLUME: 'invalidVolume',
  INVALID_CLOSE_VOLUME: 'closeVolume',
  INVALID_PRICE: 'invalidPrice',
  INVALID_EXP: 'invalidExpiry',
  INVALID_EXPIRATION: 'invalidExpiry',
  INVALID: 'invalidRequest',
  INVALID_ORDER: 'invalidRequest',
  ERR_PARAMS: 'invalidRequest',
  MARKET_CLOSED: 'marketClosed',
  TRADE_DISABLED: 'tradeDisabled',
  PRICE_CHANGED: 'priceChanged',
  REQUOTE: 'priceChanged',
  PRICE_OFF: 'noQuotes',
  LIMIT_ORDERS: 'limitOrders',
  LIMIT_POSITIONS: 'limitPositions',
  LIMIT_VOLUME: 'limitVolume',
  REJECT: 'rejected',
  REJECT_CANCEL: 'rejected',
  ERROR: 'brokerError',
  CANCEL: 'cancelled',
  TIMEOUT: 'timeout',
  ERR_TIMEOUT: 'timeout',
  FROZEN: 'frozen',
  LOCKED: 'locked',
  ONLY_REAL: 'onlyReal',
  CONNECTION: 'noConnection',
  ERR_CONNECTION: 'noConnection',
  ERR_NETWORK: 'noConnection',
  TOO_MANY: 'tooMany',
  TOO_MANY_REQUESTS: 'tooMany',
  ERR_FREQUENT: 'tooMany',
  NO_CHANGES: 'noChanges',
  ORDER_CHANGED: 'orderChanged',
  AT_DISABLED_SERVER: 'atServer',
  SERVER_DISABLES_AT: 'atServer',
  AT_DISABLED_CLIENT: 'atClient',
  CLIENT_DISABLES_AT: 'atClient',
  LONG_ONLY: 'longOnly',
  SHORT_ONLY: 'shortOnly',
  CLOSE_ONLY: 'closeOnly',
  PROHIBITED_BY_FIFO: 'fifo',
  FIFO_CLOSE: 'fifo',
  HEDGE_PROHIBITED: 'hedge',
  ERR_PERMISSIONS: 'permissions',
  GATEWAY_TIMEOUT: 'gatewayTimeout',
}

// MT5 终端的数字返回码（桥接写成「下单被拒绝 / Order rejected (#10027)」）→ 返回码名。
// The terminal's numeric retcodes (the bridge writes "… Order rejected (#10027)") → names.
const RETCODE_NAME: Record<number, string> = {
  10004: 'REQUOTE', 10006: 'REJECT', 10007: 'CANCEL', 10011: 'ERROR', 10012: 'TIMEOUT', 10013: 'INVALID',
  10014: 'INVALID_VOLUME', 10015: 'INVALID_PRICE', 10016: 'INVALID_STOPS', 10017: 'TRADE_DISABLED',
  10018: 'MARKET_CLOSED', 10019: 'NO_MONEY', 10020: 'PRICE_CHANGED', 10021: 'PRICE_OFF', 10022: 'INVALID_EXPIRATION',
  10023: 'ORDER_CHANGED', 10024: 'TOO_MANY_REQUESTS', 10025: 'NO_CHANGES', 10026: 'SERVER_DISABLES_AT',
  10027: 'CLIENT_DISABLES_AT', 10028: 'LOCKED', 10029: 'FROZEN', 10030: 'INVALID_FILL', 10031: 'CONNECTION',
  10032: 'ONLY_REAL', 10033: 'LIMIT_ORDERS', 10034: 'LIMIT_VOLUME', 10035: 'INVALID_ORDER', 10036: 'POSITION_CLOSED',
  10038: 'INVALID_CLOSE_VOLUME', 10039: 'CLOSE_ORDER_EXIST', 10040: 'LIMIT_POSITIONS', 10041: 'REJECT_CANCEL',
  10042: 'LONG_ONLY', 10043: 'SHORT_ONLY', 10044: 'CLOSE_ONLY', 10045: 'FIFO_CLOSE', 10046: 'HEDGE_PROHIBITED',
}

// 原话里的固定说法 → 原因（网关 Mt5Link / HttpServer、桥接 mt5_worker._reject_reason、后端
// gateway_execute / order_payload 写的那些）。按顺序匹配，先具体后笼统。
// Fixed wordings → reason (the gateway, the bridge's _reject_reason, the backend's own
// messages), matched in order, specific before generic.
const TEXT_WHY: [RegExp, Why][] = [
  [/未知接口[:：]?\s*\/trade\/pending/i, 'gwNoPending'],
  [/未知接口|网关暂不支持|does not support this operation/i, 'gwUnsupported'],
  [/暂时连不上|could not reach the trading gateway/i, 'gwDown'],
  [/网关两次未在时限内回话|timed out twice/i, 'gatewayTimeout'],
  [/gateway\s*响应超时|gateway timed out/i, 'gwNoReply'],
  [/长时间没有收到执行结果/, 'staleUnknown'],
  [/账号不存在或无法读取/, 'accountMissing'],
  [/找不到仓位|position not found/i, 'positionMissing'],
  [/找不到挂单/, 'pendingMissing'],
  [/取价失败/, 'noPrice'],
  [/保证金不足|资金不足|insufficient funds|not enough money/i, 'noMoney'],
  [/价格已变动|price changed|requote/i, 'priceChanged'],
  [/止损止盈无效|invalid stops/i, 'invalidStops'],
  [/手数无效|invalid volume/i, 'invalidVolume'],
  [/价格无效|价格不被接受|invalid price/i, 'invalidPrice'],
  [/休市|market closed/i, 'marketClosed'],
  [/禁止交易|trading disabled/i, 'tradeDisabled'],
  [/无可用报价|no quotes/i, 'noQuotes'],
  [/请求过于频繁|too many requests/i, 'tooMany'],
  [/成交模式不支持|unsupported fill/i, 'invalidFill'],
  [/与交易服务器断连|no connection/i, 'noConnection'],
  [/超出持仓\/挂单量限制|volume limit/i, 'limitVolume'],
  [/请求参数无效|invalid request/i, 'invalidRequest'],
  [/交易已被取消|order cancelled/i, 'cancelled'],
  [/position already closed/i, 'positionClosed'],
]
// 笼统的「被拒绝」放在数字返回码之后：「下单被拒绝 / Order rejected (#10027)」要先按 10027 说清楚。
// Generic "rejected" wordings come after the numeric retcode, so "(#10027)" is told first.
const REJECT_RE = /下单被拒绝|交易被拒绝|请求被拒绝|order rejected|request rejected/i

const CJK_RE = /[一-鿿]/
const CODE_RE = /\b(?:MT_RET_(?:REQUEST_)?|TRADE_RETCODE_)([A-Z_]+)\b|\b(GATEWAY_TIMEOUT)\b/
const RETCODE_RE = /#\s*(10\d{3})\b/

function whyOf(msg: string): Why | null {
  const m = CODE_RE.exec(msg)
  const code = m ? (m[1] ?? m[2]) : null
  if (code && CODE_WHY[code]) return CODE_WHY[code]
  for (const [re, why] of TEXT_WHY) if (re.test(msg)) return why
  const n = RETCODE_RE.exec(msg)
  const name = n ? RETCODE_NAME[Number(n[1])] : undefined
  if (name && CODE_WHY[name]) return CODE_WHY[name]
  return REJECT_RE.test(msg) ? 'rejected' : null
}

const REASON_MAX = 24
const clipReason = (s: string, n = REASON_MAX) => (s.length > n ? `${s.slice(0, n)}…` : s)
const trimPunct = (s: string) => s.replace(/^[\s,，.。;；:：、/]+|[\s,，.。;；:：、/]+$/g, '')

/** 认不出的原话里的中文：去掉「CODE: 」前缀、「 / English」那半、编号和英文词，半角标点换全角。
 *  The Chinese part of an unrecognised message, code prefix / English half / numbers / words removed. */
function zhPart(msg: string): string | null {
  let s = msg.split(' / ').find((x) => CJK_RE.test(x)) ?? ''
  s = s
    .replace(/^[\s:：]*(?:[A-Z][A-Z0-9_]*\s*[:：])?\s*/, '')
    .replace(/\(\s*#?\d+\s*\)|#\s*\d+|\d{4,}/g, '')
    .replace(/\([^()一-鿿]*\)/g, '')
    .replace(/[A-Za-z_][\w./-]*/g, '')
    .replace(/,/g, '，').replace(/;/g, '；').replace(/:/g, '：').replace(/\?/g, '？').replace(/!/g, '！')
    .replace(/\(/g, '（').replace(/\)/g, '）')
    .replace(/（[\s，；：]*）/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*([，。；：？！、（）])\s*/g, '$1')
    .replace(/([一-鿿])\s+(?=[一-鿿])/g, '$1')
  s = trimPunct(s)
  return CJK_RE.test(s) ? clipReason(s) : null
}

/** 认不出的原话里的英文：「中文 / English」取后半，纯英文去掉返回码和编号。
 *  The English part of an unrecognised message, without return codes or numbers. */
function enPart(msg: string): string | null {
  const halves = msg.split(' / ')
  let s = halves.length > 1 ? halves.slice(1).find((x) => !CJK_RE.test(x)) ?? '' : CJK_RE.test(msg) ? '' : msg
  s = s
    .replace(/^[\s:]*(?:[A-Z][A-Z0-9_]*\s*:)?\s*/, '')
    .replace(/\(\s*#?\d+\s*\)|#\s*\d+|\d{4,}/g, '')
    .replace(/\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b|\b[A-Z]{2,}\b/g, '')
    .replace(/\(\s*\)/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:])/g, '$1')
  s = trimPunct(s)
  return /[a-z]{3,}/i.test(s) ? lowerFirst(clipReason(s, 48)) : null
}

/**
 * 失败 / 结果未知的那句原因（已翻好、可以直接进句子）；不需要说原因的回 null。
 * The reason phrase for a failed / outcome-unknown instruction, ready for the sentence,
 * or null when none should be given.
 */
export function failReason(item: Pick<ActivityItem, 'status' | 'params'>, t: TFunction): string | null {
  if (item.status !== 'fail' && item.status !== 'unknown') return null
  const p = obj(item.params) ?? {}
  const note = str(p.note)
  if (note === 'timeout' || note === 'timeout_unknown' || note === 'user_cancelled' || note === 'gone' || p.gone === true) return null
  const msg = str(p.msg)
  if (!msg) return null
  const why = whyOf(msg)
  if (why) return t(`admin.log.why.${why}`)
  const generic = t(item.status === 'fail' ? 'admin.log.why.rejected' : 'admin.log.why.unknown')
  // 当前界面是中文（这句通用说法本身是中文）就取原话的中文，否则取英文
  // A Chinese UI (the generic phrase itself is Chinese) takes the Chinese part, otherwise the English
  return (CJK_RE.test(generic) ? zhPart(msg) : enPart(msg)) ?? generic
}

function whyPiece(c: Ctx): Piece {
  const r = failReason(c.item, c.t)
  return r ? c.t('admin.log.x.reason', { r }) : null
}

/** 到期时间的变化：「到期 2026-10-09 → 2026-11-09」或只有新值时「到期 2026-11-09」。
 *  Expiry change, or just "until X" when there is no old value. */
function expiryPiece(t: TFunction, oldIso: unknown, newIso: unknown): Piece {
  const a = str(oldIso)
  const b = str(newIso)
  if (a && a !== b) return t('admin.log.x.expiryChange', { a: bjDate(a), b: b ? bjDate(b) : none(t) })
  return b ? t('admin.log.x.until', { d: bjDate(b) }) : null
}

function roleLabel(t: TFunction, v: unknown): string {
  const s = str(v)
  return s ? lbl(t, `admin.log.v.role.${s}`, s) : none(t)
}

const personName = (p: ActivityPerson | P | null | undefined): string | null =>
  p ? str((p as P).nickname) ?? str((p as P).email) ?? str((p as P).id) : null

/** 通用的值 → 文字。布尔用「开 / 关」（设置项都是开关）或「是 / 否」；JSON 不进句子。
 *  Generic value → text. Booleans as on/off (settings are toggles) or yes/no; no JSON. */
function fmtVal(t: TFunction, v: unknown, bools: 'onoff' | 'yesno' = 'onoff'): string {
  if (v == null || v === '') return t('admin.log.v.empty')
  if (typeof v === 'boolean') return t(bools === 'onoff' ? (v ? 'admin.log.v.on' : 'admin.log.v.off') : (v ? 'admin.log.v.yes' : 'admin.log.v.no'))
  if (typeof v === 'number') return String(v)
  if (typeof v === 'string') {
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) return bjDateTime(v)
    if (UUID_RE.test(v.trim())) return t('admin.log.v.anId')
    return q(t, clip(v))
  }
  if (Array.isArray(v)) {
    if (v.length === 0) return t('admin.log.v.empty')
    const shown = v.slice(0, 5).map((x) => (typeof x === 'string' || typeof x === 'number' ? String(x) : t('admin.log.v.complex')))
    const s = shown.join(t('admin.log.list'))
    return v.length > 5 ? s + t('admin.log.x.andMore', { count: v.length - 5 }) : s
  }
  return t('admin.log.v.complex')
}

/** 「标签 旧 → 新」；任一侧是对象时只说「已修改」。/ "label old → new"; objects only say "changed". */
function changeText(t: TFunction, label: string, a: unknown, b: unknown, bools: 'onoff' | 'yesno' = 'onoff'): string {
  if (obj(a) || obj(b)) return t('admin.log.x.changed', { label })
  return t('admin.log.x.change', { label, a: fmtVal(t, a, bools), b: fmtVal(t, b, bools) })
}

/** 列太长就只列前 3 项再加「等 N 项」。/ Long lists show three items plus "and N more". */
function capItems(t: TFunction, items: string[], max = 3): string[] {
  if (items.length <= max) return items
  return [...items.slice(0, max - 1), t('admin.log.x.moreItems', { count: items.length - (max - 1) })]
}

// ---------- 会员相关的几段（admin.user_plan / user_edit / bulk_edit 共用）----------
// ---------- Membership pieces shared by user_plan / user_edit / bulk_edit ----------
function planPieces(t: TFunction, p: P): string[] {
  const out: string[] = []
  const plan = pairOf(p.plan)
  if (plan) out.push(t('admin.log.x.planChange', { a: str(plan[0]) ?? none(t), b: str(plan[1]) ?? none(t) }))
  const exp = pairOf(p.expires)
  if (exp) {
    const a = str(exp[0])
    const b = str(exp[1])
    out.push(t('admin.log.x.expiryChange', { a: a ? bjDate(a) : none(t), b: b ? bjDate(b) : none(t) }))
  }
  const note = pairOf(p.note)
  if (note) {
    const a = str(note[0])
    const b = str(note[1])
    if (!b) out.push(t('admin.log.x.noteCleared'))
    else if (!a) out.push(t('admin.log.x.noteSet', { b: q(t, clip(b)) }))
    else out.push(t('admin.log.x.noteChange', { a: q(t, clip(a)), b: q(t, clip(b)) }))
  }
  return out
}

// ---------- 交易相关 / trading ----------
function closeLike(c: Ctx, k: 'close' | 'ptp'): Part[] {
  const { t, p, item } = c
  const vol = num(p.vol)
  const pos = num(p.pos_vol)
  const remain = num(p.remain)
  const gone = p.gone === true || (item.tags ?? []).includes('gone')
  const note = noteSuffix(t, p.note)
  const px = num(p.px)
  const tail: Piece[] = [
    px != null ? t('admin.log.x.filled', { px: fmtPx(px, symDigits(p.sym, px)) }) : null,
    pnlPiece(t, p.pnl, p.pnl_pending),
    whyPiece(c),
  ]
  if (gone) return sentence(t, t(`admin.log.ev.${k}.gone`) + note, subj(t, p.sym, p.side, vol))
  if (p.partial === true) {
    let head = vol != null ? t(`admin.log.ev.${k}.partial`, { v: fmtLots(vol) }) : t(`admin.log.ev.${k}.partialNoVol`)
    if (pos != null) {
      head += remain != null
        ? t('admin.log.x.ofRemain', { pos: fmtLots(pos), remain: fmtLots(remain) })
        : t('admin.log.x.ofPos', { pos: fmtLots(pos) })
    }
    return sentence(t, head + note, subj(t, p.sym, p.side, null), tail)
  }
  return sentence(t, t(`admin.log.ev.${k}.full`) + note, subj(t, p.sym, p.side, vol), tail)
}

type SlOp = 'set' | 'move' | 'remove' | 'same' | 'changed'
function sltpLeg(t: TFunction, which: 'sl' | 'tp', op: unknown, v: number | null, prev: number | null, d: number): string {
  const f = (x: number) => fmtPx(x, d)
  const o = (str(op) ?? 'changed') as SlOp
  if (o === 'set' && v != null) return t(`admin.log.ev.sltp.set_${which}`, { v: f(v) })
  if (o === 'move' && v != null && prev != null) return t(`admin.log.ev.sltp.move_${which}`, { a: f(prev), b: f(v) })
  if (o === 'remove') return prev != null ? t(`admin.log.ev.sltp.remove_${which}`, { a: f(prev) }) : t(`admin.log.ev.sltp.removeNoPrev_${which}`)
  if (o === 'same') return t(`admin.log.ev.sltp.same_${which}`)
  return v != null ? t(`admin.log.ev.sltp.changed_${which}`, { v: f(v) }) : t(`admin.log.ev.sltp.cleared_${which}`)
}

function autoSlHead(c: Ctx): string {
  const { t, p } = c
  const sl = num(p.sl)
  const prev = num(p.prev_sl)
  const moves = num(p.moves) ?? 1
  const mode = str(p.mode)
  if (sl == null) return t('admin.log.ev.autosl.unknown')
  const d = symDigits(p.sym, sl, prev)
  const a = prev != null ? fmtPx(prev, d) : null
  const b = fmtPx(sl, d)
  if (moves > 1) {
    const base = mode === 'trail' ? 'trailN' : 'multi'
    return a ? t(`admin.log.ev.autosl.${base}`, { n: moves, a, b }) : t(`admin.log.ev.autosl.${base}To`, { n: moves, b })
  }
  if (mode === 'be') return t('admin.log.ev.autosl.be', { v: b }) + (a ? t('admin.log.x.was', { a }) : '')
  if (mode === 'restore') return t('admin.log.ev.autosl.restore', { v: b })
  if (mode === 'trail') return a ? t('admin.log.ev.autosl.trail', { a, b }) : t('admin.log.ev.autosl.trailTo', { b })
  return a ? t('admin.log.ev.autosl.move', { a, b }) : t('admin.log.ev.autosl.set', { b })
}

// 自动仓管设置项：后端存的是 API 的 camelCase（beTriggerR），契约例子里是 snake_case
// （be_trigger_r）——去掉下划线、转小写之后是同一个键，两种都认。
// Auto-manage fields arrive as the API's camelCase (beTriggerR) while the contract
// example uses snake_case (be_trigger_r); lower-cased without underscores they match.
const normField = (f: string) => f.replace(/_/g, '').toLowerCase()
function autoValue(key: string, v: unknown, t: TFunction): string {
  const n = num(v)
  if (n == null) return fmtVal(t, v)
  if (key === 'ptpfraction') return `${Math.round((n <= 1 ? n * 100 : n) * 10) / 10}%`
  if (key.endsWith('r')) return `${n}R`
  return String(n)
}

// ---------- 管理员设置类 / admin settings ----------
interface SettingChange { group: string | null; key: string | null; old: unknown; new: unknown; raw?: P }
function settingChanges(p: P, groupField = true): SettingChange[] {
  const list = arr(p.changes).map(obj).filter((x): x is P => !!x)
  const rows = list.length ? list : [p]
  return rows.map((r) => ({ group: groupField ? str(r.group) : null, key: str(r.key), old: r.old, new: r.new, raw: r }))
}

// 平台设置的分组（契约 admin.setting 的 group）。2026-09-19（cbe9377）之前，每个设置端点
// 整组只记一行 `setting:<group>`：旧值恒空、新值是整组 JSON。后端把它报成 group=null、
// key=<group>，与券商锁那组两段式的 `setting:<key>` 同形——不认出来，就会读成
// 「合作券商限制：pricing已修改」。认出来之后按组名显示，整组 JSON 拆成逐项。
// Platform-settings groups (the contract's admin.setting `group`). Before 2026-09-19
// (cbe9377) every settings endpoint logged the whole group as one `setting:<group>` row,
// old always empty and new the whole JSON. The backend reports it as group=null,
// key=<group> — the same shape as the broker lock's two-part `setting:<key>` — so unless
// it is recognised it reads as "Partner broker lock: pricing changed". Recognised, it gets
// the group's name and the JSON is split into one item per key.
export const SETTING_GROUPS: ReadonlySet<string> = new Set([
  'pricing', 'trial', 'email_gate', 'social', 'candle_history', 'strategy', 'strategy_costs', 'winrate', 'platform_strategies',
])

/**
 * admin.setting 的每一项，旧式整组行拆成逐键（旧值没记，按 null）。也认后端把它规整成
 * group=<group>、key=null 的写法，两种都是同一个意思。
 * admin.setting items with legacy whole-group rows split per key (the old value was never
 * logged, so it reads as null). Also accepts the normalised group=<group>, key=null form.
 */
function settingItems(p: P): SettingChange[] {
  const out: SettingChange[] = []
  for (const c of settingChanges(p)) {
    const group = c.group ?? (c.key && SETTING_GROUPS.has(c.key) ? c.key : null)
    const whole = c.group == null ? group != null : c.key == null
    if (!whole) {
      out.push(c)
      continue
    }
    const after = obj(c.new)
    // 策略介绍记的是 {count, ids}：不拆，句子里统一说「调整了列表」
    // platform_strategies logs {count, ids}: not split, the sentence says "list changed"
    if (group === 'platform_strategies' || !after) {
      out.push({ group, key: null, old: c.old, new: c.new })
      continue
    }
    const before = obj(c.old)
    for (const [k, v] of Object.entries(after)) out.push({ group, key: k, old: before ? before[k] ?? null : null, new: v })
  }
  return out
}

/** 推荐比赛：只说设了 / 换了 / 取消，有比赛名才带名字，绝不出 id。
 *  The featured competition: set / switched / cleared, with names when known, never ids. */
function featuredText(t: TFunction, c: SettingChange, label: string): string {
  const name = (side: 'old' | 'new') => {
    const n = str(c.raw?.[`${side}_name`])
    return n ? q(t, clip(n)) : null
  }
  if (c.new == null || c.new === '') return t('admin.log.x.featuredCleared')
  const b = name('new')
  if (c.old == null || c.old === '') return b ? t('admin.log.x.setTo', { label, v: b }) : t('admin.log.x.featuredSet')
  const a = name('old')
  if (a && b) return t('admin.log.x.change', { label, a, b })
  return b ? t('admin.log.x.setTo', { label, v: b }) : t('admin.log.x.featuredChanged')
}

function invitePieces(t: TFunction, action: string | null, changes: P[]): string[] {
  const out: string[] = []
  for (const c of changes) {
    const field = str(c.field) ?? ''
    const a = c.old
    const b = c.new
    const label = lbl(t, `admin.log.v.inviteField.${field}`, field)
    if (action === 'create') {
      // 新建时 changes 列的是「开着的选项」（old 恒 null）/ on create, changes list the options switched on
      if (field === 'isActive') { if (b === false) out.push(t('admin.log.v.inviteOpt.inactive')) }
      else if (field === 'grantsTrial') { if (b === true) out.push(t('admin.log.v.inviteOpt.trial')) }
      else if (field === 'channel') { if (str(b)) out.push(t('admin.log.x.channel', { v: str(b) })) }
      else if (field === 'label') { /* 名字已经在句子里 / the name is already in the sentence */ }
      else if (b != null && b !== false && b !== '') out.push(lbl(t, `admin.log.v.inviteOpt.${field}`, label))
      continue
    }
    if (field === 'label') out.push(t('admin.log.x.renamed', { a: str(a) ? q(t, str(a)!) : none(t), b: str(b) ? q(t, str(b)!) : none(t) }))
    else if (field === 'isActive') out.push(t(b ? 'admin.log.v.inviteOpt.activated' : 'admin.log.v.inviteOpt.deactivated'))
    else if (field === 'grantsTrial' || field === 'channel') out.push(changeText(t, label, a, b))
    else out.push(t('admin.log.x.changed', { label }))
  }
  return out
}

function compChange(t: TFunction, c: P): string | null {
  const field = str(c.field) ?? ''
  if (field === 'acknowledgeFlags') return null
  // 比赛表单的字段名是表单标签（英文首字母大写），放进句子中间时降成小写；中文不受影响
  // The competition form's field labels are title-cased in English; lower-case them mid-sentence
  const label = lowerFirst(lbl(t, `competition.admin.fields.${field}`, lbl(t, `admin.log.v.compField.${field}`, field)))
  const enumOf = (prefix: string) => (v: unknown) => (str(v) ? lbl(t, `${prefix}${str(v)}`, str(v)!) : t('admin.log.v.empty'))
  const fmt: Record<string, (v: unknown) => string> = {
    status: enumOf('competition.status.'),
    metric: enumOf('leaderboard.boards.'),
    enrollment: enumOf('competition.enrollment.'),
    track: enumOf('competition.track.'),
  }
  if (field === 'description' || field === 'prizeNote' || field === 'openAccountUrl') return t('admin.log.x.changed', { label })
  const f = fmt[field]
  if (f) return t('admin.log.x.change', { label, a: f(c.old), b: f(c.new) })
  return changeText(t, label, c.old, c.new)
}

const PARTICIPANT_ACTIONS = ['disqualify', 'requalify', 'hide_name', 'show_name', 'update']

const opsResult = (t: TFunction, r: string | null): string | null => {
  if (!r) return null
  if (/^failed/i.test(r)) return t('admin.log.v.opsResult.failed')
  const m = /^(\d+)\/(\d+)$/.exec(r)
  if (m) return t('admin.log.v.opsResult.ratio', { a: m[1], b: m[2] })
  const known = lbl(t, `admin.log.v.opsResult.${r}`, '')
  return known || null
}

// ---------- 每个 kind 一个渲染函数 / one renderer per kind ----------
const R: Record<ActivityKind, (c: Ctx) => Part[]> = {
  // ---- 账户 / account ----
  'user.register': ({ t, p }) => {
    const link = str(p.invite_label) ?? str(p.invite_code)
    const plan = str(p.trial_plan)
    const days = num(p.trial_days)
    return sentence(t, t(p.method === 'google' ? 'admin.log.ev.register.google' : 'admin.log.ev.register.email'), null, [
      link && t('admin.log.x.viaLink', { v: q(t, link) }),
      plan && (days != null ? t('admin.log.x.gotTrial', { plan, days }) : t('admin.log.x.gotTrialNoDays', { plan })),
    ])
  },
  'user.login': ({ t, p }) =>
    sentence(t, t(p.method === 'google' ? 'admin.log.ev.login.google' : 'admin.log.ev.login.password'), null, [
      p.new_source === true && t('admin.log.x.newSource'),
    ]),
  'user.email_verified': ({ t, p }) => [t(p.method === 'reset' ? 'admin.log.ev.emailVerified.reset' : 'admin.log.ev.emailVerified.link')],
  'user.password_reset_requested': ({ t }) => [t('admin.log.ev.pwResetRequested')],
  'user.password_reset': ({ t }) => [t('admin.log.ev.pwReset')],
  'user.password_changed': ({ t, p }) => [t(p.first_set === true ? 'admin.log.ev.pwChanged.first' : 'admin.log.ev.pwChanged.change')],
  'user.nickname': ({ t, p }) => {
    const a = str(p.old)
    const b = str(p.new)
    if (!b) return [t('admin.log.ev.nickname.cleared')]
    if (!a) return [t('admin.log.ev.nickname.set', { b: q(t, b) })]
    return [t('admin.log.ev.nickname.change', { a: q(t, a), b: q(t, b) })]
  },
  'user.phone_set': ({ t }) => [t('admin.log.ev.phoneSet')],
  'plan.trial_claim': ({ t, p }) => {
    const plan = str(p.plan) ?? 'PRO'
    const days = num(p.days)
    const head = days != null ? t('admin.log.ev.trialClaim', { plan, days }) : t('admin.log.ev.trialClaimNoDays', { plan })
    return sentence(t, head, null, [expiryPiece(t, null, p.expires_at)])
  },
  'plan.invite_trial': ({ t, p }) => {
    const plan = str(p.plan) ?? 'PRO'
    const days = num(p.days)
    const link = str(p.invite_label) ?? str(p.invite_code)
    const head = days != null ? t('admin.log.ev.inviteTrial', { plan, days }) : t('admin.log.ev.inviteTrialNoDays', { plan })
    return sentence(t, head, null, [link && t('admin.log.x.viaLink', { v: q(t, link) })])
  },
  'plan.payment': ({ t, p }) => {
    const a = str(p.old_plan)
    const b = str(p.new_plan)
    const head = a && b && a === b
      ? t('admin.log.ev.payment.renew', { plan: b })
      : t('admin.log.ev.payment.change', { a: a ?? none(t), b: b ?? none(t) })
    return sentence(t, head, null, [expiryPiece(t, p.old_expires, p.expires_at)])
  },
  'plan.refund': ({ t, p }) => {
    const a = str(p.old_plan)
    const b = str(p.new_plan)
    const head = a && b && a === b ? t('admin.log.ev.refund.time') : t('admin.log.ev.refund.change', { a: a ?? none(t), b: b ?? none(t) })
    return sentence(t, head, null, [expiryPiece(t, p.old_expires, p.new_expires)])
  },
  'plan.payment_issue': ({ t, p }) => {
    const field = str(p.field) ?? ''
    return [lbl(t, `admin.log.ev.payIssue.${field}`, t('admin.log.ev.payIssue.other'))]
  },
  'plan.auto_expire': ({ t, p }) => [t('admin.log.ev.autoExpire', { a: str(p.old_plan) ?? none(t), b: str(p.new_plan) ?? 'FREE' })],

  // ---- MT5 绑定 / MT5 binding ----
  'mt5.bind': ({ t, p }) => {
    const bits = [str(p.ch) && lbl(t, `admin.log.v.ch.${str(p.ch)}`, ''), p.demo === true ? t('admin.log.v.demo') : p.demo === false ? t('admin.log.v.live') : '']
      .filter(Boolean)
      .join(' · ')
    const head = t(p.revived === true ? 'admin.log.ev.bind.revived' : 'admin.log.ev.bind.new') + (bits ? t('admin.log.x.paren', { v: bits }) : '')
    return sentence(t, head, null, [balancePiece(t, p.bal)])
  },
  'mt5.reverify': ({ t }) => [t('admin.log.ev.reverify')],
  'mt5.unbind': ({ t, p }) => {
    const ch = str(p.ch) ? lbl(t, `admin.log.v.ch.${str(p.ch)}`, '') : ''
    return sentence(t, t('admin.log.ev.unbind') + (ch ? t('admin.log.x.paren', { v: ch }) : ''), null, [balancePiece(t, p.bal)])
  },
  'mt5.revoked': ({ t, p }) => [t(p.reason === 'password_changed' ? 'admin.log.ev.revoked.password' : 'admin.log.ev.revoked.other')],
  'user.api_token_reset': ({ t }) => [t('admin.log.ev.tokenReset')],

  // ---- 交易 / trading ----
  'trade.open': (c) => {
    const { t, p, item } = c
    const px = num(p.px)
    const sl = num(p.sl)
    const tp = num(p.tp)
    const d = symDigits(p.sym, px, sl, tp)
    const unprotected = p.note === 'sltp_failed' || (item.tags ?? []).includes('unprotected')
    return sentence(t, t('admin.log.ev.open') + srcSuffix(t, p.src) + noteSuffix(t, p.note), subj(t, p.sym, p.side, p.vol), [
      px != null && t('admin.log.x.filled', { px: fmtPx(px, d) }),
      sl != null && t('admin.log.x.sl', { v: fmtPx(sl, d) }),
      tp != null && t('admin.log.x.tp', { v: fmtPx(tp, d) }),
      unprotected && t('admin.log.x.sltpFailed'),
      whyPiece(c),
    ])
  },
  'pending.place': (c) => {
    const { t, p } = c
    const price = num(p.price)
    const sl = num(p.sl)
    const tp = num(p.tp)
    const d = symDigits(p.sym, price, sl, tp)
    const ptype = str(p.ptype) ? lbl(t, `admin.log.v.ptype.${str(p.ptype)}`, '') : ''
    const head = (ptype ? t('admin.log.ev.pending.placeTyped', { ptype }) : t('admin.log.ev.pending.place')) + srcSuffix(t, p.src) + noteSuffix(t, p.note)
    return sentence(t, head, subj(t, p.sym, ptype ? null : p.side, p.vol), [
      price != null && t('admin.log.x.trigger', { v: fmtPx(price, d) }),
      sl != null && t('admin.log.x.sl', { v: fmtPx(sl, d) }),
      tp != null && t('admin.log.x.tp', { v: fmtPx(tp, d) }),
      whyPiece(c),
    ])
  },
  'pending.modify': (c) => {
    const { t, p } = c
    const price = num(p.price)
    const sl = num(p.sl)
    const tp = num(p.tp)
    const d = symDigits(p.sym, price, sl, tp)
    // 只说动了的那几项（契约 pending.modify）：keep = 没传、保留券商现值，不提（不能说成「不设止损」）；
    // remove = 传了 0、清除；set = 新值。没有 op 又没有值的（不认识的形状）也不提，不瞎猜。
    // Only what changed (contract pending.modify): keep = not sent, the broker keeps its value —
    // omitted (never "no stop loss"); remove = sent as 0; set = the new value. An unknown shape
    // with neither an op nor a value is omitted rather than guessed.
    const leg = (which: 'sl' | 'tp', v: number | null, op: unknown) => {
      if (op === 'keep') return false
      if (op === 'remove') return t(`admin.log.ev.sltp.removeNoPrev_${which}`)
      return v != null && t(`admin.log.ev.sltp.changed_${which}`, { v: fmtPx(v, d) })
    }
    return sentence(t, t('admin.log.ev.pending.modify') + noteSuffix(t, p.note), subj(t, p.sym, null, null), [
      price != null && t('admin.log.x.triggerTo', { v: fmtPx(price, d) }),
      leg('sl', sl, p.sl_op),
      leg('tp', tp, p.tp_op),
      whyPiece(c),
    ])
  },
  'pending.cancel': (c) => {
    const { t, p } = c
    const price = num(p.price)
    const ptype = str(p.ptype) ? lbl(t, `admin.log.v.ptype.${str(p.ptype)}`, '') : ''
    const head = (ptype ? t('admin.log.ev.pending.cancelTyped', { ptype }) : t('admin.log.ev.pending.cancel')) + noteSuffix(t, p.note)
    return sentence(t, head, subj(t, p.sym, ptype ? null : p.side, p.vol), [
      price != null && t('admin.log.x.trigger', { v: fmtPx(price, symDigits(p.sym, price)) }),
      whyPiece(c),
    ])
  },
  'trade.close': (c) => closeLike(c, 'close'),
  'auto.partial_tp': (c) => closeLike(c, 'ptp'),
  'sltp.modify': (c) => {
    const { t, p } = c
    const sl = num(p.sl)
    const tp = num(p.tp)
    const psl = num(p.prev_sl)
    const ptp = num(p.prev_tp)
    const d = symDigits(p.sym, sl, tp, psl, ptp)
    const slSame = p.sl_op === 'same'
    const tpSame = p.tp_op === 'same'
    let head: string
    if (slSame && tpSame) head = t('admin.log.ev.sltp.none')
    else {
      // 变了的那一侧在前：「移动止盈 …，止损不变」比「止损不变，移动止盈 …」好读
      // The side that changed comes first; it reads better than leading with "unchanged"
      const legs = [
        { same: slSame, text: sltpLeg(t, 'sl', p.sl_op, sl, psl, d) },
        { same: tpSame, text: sltpLeg(t, 'tp', p.tp_op, tp, ptp, d) },
      ].sort((a, b) => Number(a.same) - Number(b.same))
      head = capFirst(legs.map((l) => l.text).join(t('admin.log.comma')))
    }
    return sentence(t, head + noteSuffix(t, p.note), subj(t, p.sym, p.side, p.pos_vol), [whyPiece(c)])
  },
  'auto.sl': (c) => sentence(c.t, autoSlHead(c) + noteSuffix(c.t, c.p.note), subj(c.t, c.p.sym, c.p.side, null), [whyPiece(c)]),
  'trade.other': (c) => sentence(c.t, c.t('admin.log.ev.otherTrade') + noteSuffix(c.t, c.p.note), subj(c.t, c.p.sym, null, c.p.vol), [whyPiece(c)]),
  'trade.close_all': ({ t, p }) => {
    const count = num(p.count)
    const head = count != null ? t('admin.log.ev.closeAll', { count }) : t('admin.log.ev.closeAllNoCount')
    const outcome = (['filled', 'failed', 'unknown', 'pending', 'cancelled', 'skipped'] as const)
      .map((k) => {
        const n = num(p[k])
        return n != null && n > 0 ? t(`admin.log.ev.closeAllPart.${k}`, { count: n }) : null
      })
    return sentence(t, head, null, [
      ...outcome,
      pnlPiece(t, p.pnl, null, 'admin.log.x.totalPnl'),
      p.pnl_pending === true && t('admin.log.x.somePnlPending'),
    ])
  },
  'trade.corrected': ({ t, p, item }) => {
    const at = str(p.at)
    const time = at ? (bjDayKey(at) === bjDayKey(item.ts) ? bjHm(at) : bjDateTime(at)) : '—'
    // 桥接超时作废的指令（note=timeout）在列表上是「已撤回 · 超时已自动取消」，不是「结果未知」
    // A bridge instruction voided on timeout (note=timeout) was shown as auto-cancelled, not unknown
    const was = q(
      t,
      p.was === 'CANCELLED'
        ? t('admin.log.status.cancelled')
        : p.note === 'timeout'
          ? t('admin.log.ev.correctedWasTimeout')
          : t('admin.log.status.unknown'),
    )
    const action = str(p.action) ? lbl(t, `orders.action.${str(p.action)}`, t('admin.log.v.actionFallback')) : t('admin.log.v.actionFallback')
    const px = num(p.px)
    return sentence(t, t('admin.log.ev.corrected', { time, action, was }), subj(t, p.sym, p.side, p.vol), [
      px != null && t('admin.log.x.filled', { px: fmtPx(px, symDigits(p.sym, px)) }),
    ])
  },
  'deal.close': ({ t, p }) => {
    const reason = str(p.reason) ?? 'OTHER'
    const k = num(p.leg_k)
    const n = num(p.leg_n)
    const head = lbl(t, `admin.log.v.reason.${reason}`, t('admin.log.v.reason.OTHER')) + (k != null && n != null && n > 1 ? t('admin.log.x.leg', { k, n }) : '')
    const px = num(p.px)
    const holders = arr(p.holders).map((h) => personName(obj(h))).filter((x): x is string => !!x)
    return sentence(t, head, subj(t, p.sym, p.side, p.vol), [
      px != null && t('admin.log.x.filled', { px: fmtPx(px, symDigits(p.sym, px)) }),
      pnlPiece(t, p.pnl, null),
      holders.length > 1 && t('admin.log.x.holders', { names: holders.join(t('admin.log.list')) }),
    ])
  },
  'deal.stopout_group': ({ t, p }) =>
    sentence(t, t('admin.log.ev.stopoutGroup', { count: num(p.count) ?? 0 }), null, [pnlPiece(t, p.pnl, null, 'admin.log.x.totalPnl')]),
  'auto.settings': ({ t, p }) => {
    const items = arr(p.changes)
      .map(obj)
      .filter((x): x is P => !!x)
      .map((c) => {
        const field = str(c.field) ?? ''
        const key = normField(field)
        const label = lbl(t, `admin.log.v.autoField.${key}`, field)
        if (typeof c.new === 'boolean') return t(c.new ? 'admin.log.x.turnedOn' : 'admin.log.x.turnedOff', { label })
        return t('admin.log.x.change', { label, a: autoValue(key, c.old, t), b: autoValue(key, c.new, t) })
      })
    return [items.length ? listed(t, 'admin.log.ev.autoSettings.head', items) : t('admin.log.ev.autoSettings.none')]
  },

  // ---- 管理员 / admin ----
  'admin.user_plan': ({ t, p }) => {
    const items = planPieces(t, p)
    return [items.length ? listed(t, 'admin.log.ev.userPlan.head', items) : t('admin.log.ev.userPlan.none')]
  },
  'admin.user_role': ({ t, p }) => [t('admin.log.ev.userRole', { a: roleLabel(t, p.old), b: roleLabel(t, p.new) })],
  'admin.user_attribution': ({ t, p }) => {
    const a = str(p.old_label) ?? str(p.old)
    const b = str(p.new_label) ?? str(p.new)
    if (!b) return [a ? t('admin.log.ev.attribution.clear', { a: q(t, a) }) : t('admin.log.ev.attribution.clearNoPrev')]
    if (!a) return [t('admin.log.ev.attribution.set', { b: q(t, b) })]
    return [t('admin.log.ev.attribution.change', { a: q(t, a), b: q(t, b) })]
  },
  'admin.user_edit': ({ t, p }) => {
    const items: string[] = []
    const role = pairOf(p.role)
    if (role) items.push(t('admin.log.x.roleChange', { a: roleLabel(t, role[0]), b: roleLabel(t, role[1]) }))
    items.push(...planPieces(t, p))
    const inv = pairOf(p.invite)
    if (inv) {
      const labels = pairOf(p.invite_label)
      const side = (i: 0 | 1) => {
        const v = str(labels?.[i]) ?? str(inv[i])
        return v ? q(t, v) : t('admin.log.v.noInvite')
      }
      items.push(t('admin.log.x.inviteChange', { a: side(0), b: side(1) }))
    }
    return [items.length ? listed(t, 'admin.log.ev.userEdit.head', items) : t('admin.log.ev.userEdit.none')]
  },
  'admin.user_disable': ({ t, p }) => {
    const r = str(p.reason)
    if (p.was_disabled === true) return [r ? t('admin.log.ev.disable.reason', { r: q(t, clip(r, 60)) }) : t('admin.log.ev.disable.reasonNone')]
    return [r ? t('admin.log.ev.disable.new', { r: q(t, clip(r, 60)) }) : t('admin.log.ev.disable.newNoReason')]
  },
  'admin.user_enable': ({ t, p }) => {
    const r = str(p.prev_reason)
    return [t('admin.log.ev.enable') + (r ? t('admin.log.x.prevReason', { r: q(t, clip(r, 60)) }) : '')]
  },
  'admin.verify_email': ({ t }) => [t('admin.log.ev.verifyEmail')],
  'admin.bulk_edit': ({ t, p, item }) => {
    const count = num(p.users_count) ?? item.users_count ?? item.children?.length ?? 0
    const children = item.children ?? []
    const inviteLabel = (code: string) => {
      for (const ch of children) {
        const cp = ch.params
        if (str(cp.new) === code && str(cp.new_label)) return str(cp.new_label)!
        const inv = pairOf(cp.invite)
        const labels = pairOf(cp.invite_label)
        if (inv && str(inv[1]) === code && labels && str(labels[1])) return str(labels[1])!
      }
      return code
    }
    const items = arr(p.changes)
      .map(obj)
      .filter((x): x is P => !!x)
      .map((c) => {
        const field = str(c.field) ?? ''
        const label = lbl(t, `admin.log.v.userField.${field}`, field)
        const v = c.new
        let val: string
        if (field === 'invite_code') val = str(v) ? q(t, inviteLabel(str(v)!)) : t('admin.log.v.noInvite')
        else if (field === 'role') val = roleLabel(t, v)
        else if (field === 'plan_expires_at') val = str(v) ? bjDate(str(v)) : t('admin.log.v.noExpiry')
        else if (field === 'plan_note') val = str(v) ? q(t, clip(str(v)!)) : t('admin.log.v.empty')
        else val = str(v) ?? fmtVal(t, v)
        return t('admin.log.x.setTo', { label, v: val })
      })
    return [items.length ? listed(t, 'admin.log.ev.bulkEdit.head', items, { count }) : t('admin.log.ev.bulkEdit.none', { count })]
  },
  'admin.setting': ({ t, p }) => {
    const changes = settingItems(p)
    const groups = [...new Set(changes.map((c) => c.group ?? ''))]
    // 策略介绍只记了 id 清单（一串 uuid），说「调整了列表」就够 / platform_strategies logs only id lists
    if (groups.length === 1 && groups[0] === 'platform_strategies') return [t('admin.log.ev.setting.platformStrategies')]
    const groupLabel = (g: string) => (g ? lbl(t, `admin.log.v.setGroup.${g}`, g) : t('admin.log.v.setGroup.broker'))
    const items = changes.map((c) => {
      // 整组一起存、又拆不开（值不是对象）：只能说「整组保存」/ a whole-group save that can't be split
      if (c.key == null) return t('admin.log.x.wholeGroup')
      const keyLabel = lbl(t, `admin.log.v.setKey.${c.key}`, c.key)
      const label = groups.length > 1 ? `${groupLabel(c.group ?? '')} · ${keyLabel}` : keyLabel
      // 旧值没记（旧式整组行）或原来就没有：只说改成了什么，不说「空 → X」
      // No old value (legacy whole-group rows, or never set): say what it became, not "empty → X"
      if (c.old == null && c.new != null && !obj(c.new)) return t('admin.log.x.setTo', { label, v: fmtVal(t, c.new) })
      return changeText(t, label, c.old, c.new)
    })
    const head = groups.length === 1 ? 'admin.log.ev.setting.head' : 'admin.log.ev.setting.headMulti'
    return [listed(t, head, capItems(t, items), { group: groupLabel(groups[0] ?? '') })]
  },
  'admin.gamification': ({ t, p }) => {
    const items = settingChanges(p, false).map((c) => {
      const k = c.key ?? '?'
      const label = lbl(t, `admin.log.v.gamKey.${k}`, k)
      if (k === 'featured_competition_id') return featuredText(t, c, label)
      return changeText(t, label, c.old, c.new)
    })
    return [listed(t, 'admin.log.ev.gamification.head', capItems(t, items))]
  },
  'admin.invite_link': ({ t, p }) => {
    const name = q(t, str(p.label) ?? str(p.code) ?? '?')
    const action = str(p.action)
    const changes = arr(p.changes).map(obj).filter((x): x is P => !!x)
    if (action === 'create') {
      const opts = invitePieces(t, action, changes)
      return [t('admin.log.ev.invite.create', { name }) + (opts.length ? t('admin.log.x.paren', { v: opts.join(t('admin.log.list')) }) : '')]
    }
    if (action === 'delete') {
      const mode = str(p.mode)
      return [t('admin.log.ev.invite.delete', { name }) + (mode === 'hard' || mode === 'soft' ? t(`admin.log.v.inviteDel.${mode}`) : '')]
    }
    if (action === 'update') {
      const items = invitePieces(t, action, changes)
      return [items.length ? listed(t, 'admin.log.ev.invite.update', items, { name }) : t('admin.log.ev.invite.updateNone', { name })]
    }
    return [t('admin.log.ev.invite.other', { name })]
  },
  'admin.agent_assign': ({ t, p }) => {
    const name = q(t, str(p.label) ?? str(p.code) ?? '?')
    const agent = personName(obj(p.agent))
    const old = personName(obj(p.old_agent))
    if (agent && old) return [t('admin.log.ev.agentAssign.change', { name, a: old, b: agent })]
    if (agent) return [t('admin.log.ev.agentAssign.assign', { name, b: agent })]
    if (old) return [t('admin.log.ev.agentAssign.unassign', { name, a: old })]
    return [t('admin.log.ev.agentAssign.other', { name })]
  },
  'agent.plan': ({ t, p }) => {
    const plan = str(p.plan)
    const days = num(p.days)
    const link = str(p.label) ?? str(p.code)
    let head: string
    if (days != null && days > 0) head = t('admin.log.ev.agentPlan.extend', { days, plan: plan ?? 'PRO' })
    else if (plan === 'FREE') head = t('admin.log.ev.agentPlan.downgrade')
    else head = t('admin.log.ev.agentPlan.change', { a: str(p.old_plan) ?? none(t), b: plan ?? none(t) })
    return sentence(t, head, null, [expiryPiece(t, p.old_expires, p.new_expires), link && t('admin.log.x.agentLink', { v: q(t, link) })])
  },
  'admin.competition': ({ t, p }) => {
    const name = str(p.name) ? q(t, str(p.name)!) : t('admin.log.v.deletedComp')
    const action = str(p.action)
    const changes = arr(p.changes).map(obj).filter((x): x is P => !!x)
    if (action === 'create') return [t('admin.log.ev.competition.create', { name })]
    if (action === 'delete') return [t('admin.log.ev.competition.delete', { name })]
    if (action === 'settle') {
      const ack = changes.some((c) => c.field === 'acknowledgeFlags' && c.new != null && c.new !== '')
      return [t('admin.log.ev.competition.settle', { name }) + (ack ? t('admin.log.x.ackFlags') : '')]
    }
    const items = changes.map((c) => compChange(t, c)).filter((x): x is string => !!x)
    return [items.length ? listed(t, 'admin.log.ev.competition.update', capItems(t, items, 4), { name }) : t('admin.log.ev.competition.updateNone', { name })]
  },
  'admin.competition_participant': ({ t, p }) => {
    const name = str(p.name) ? q(t, str(p.name)!) : t('admin.log.v.deletedComp')
    const raw = str(p.action)
    const action = raw && PARTICIPANT_ACTIONS.includes(raw) ? raw : 'update'
    const r = str(p.reason)
    return sentence(t, t(`admin.log.ev.participant.${action}`, { name }), null, [
      action === 'disqualify' && r && t('admin.log.x.reason', { r: q(t, clip(r, 60)) }),
    ])
  },
  'admin.announcement': ({ t, p }) => {
    const title = str(p.title) ? q(t, clip(str(p.title)!)) : t('admin.log.v.untitled')
    const action = str(p.action)
    if (action === 'create') return [t(p.published === true ? 'admin.log.ev.announcement.publish' : 'admin.log.ev.announcement.draft', { title })]
    if (action === 'delete') return [t('admin.log.ev.announcement.delete', { title })]
    if (p.was_published === false && p.published === true) return [t('admin.log.ev.announcement.publish', { title })]
    if (p.was_published === true && p.published === false) return [t('admin.log.ev.announcement.unpublish', { title })]
    return [t('admin.log.ev.announcement.update', { title })]
  },
  'admin.email': ({ t, p }) => {
    const subject = str(p.subject) ? q(t, clip(str(p.subject)!)) : t('admin.log.v.untitled')
    const action = str(p.action)
    const kind = str(p.mail_kind)
    const kindText = kind === 'marketing' || kind === 'notice' ? t('admin.log.x.paren', { v: t(`admin.log.v.mailKind.${kind}`) }) : ''
    if (action === 'cancel') return [t('admin.log.ev.email.cancel', { subject })]
    if (action === 'resume') return [t('admin.log.ev.email.resume', { subject })]
    const count = num(p.count)
    return [(count != null ? t('admin.log.ev.email.sendTo', { subject, count }) : t('admin.log.ev.email.send', { subject })) + kindText]
  },
  'admin.ops': ({ t, p }) => {
    const action = str(p.action)
    const target = str(p.target)
    let head: string
    if (action === 'restart-loop') head = t('admin.log.ev.ops.restartLoop', { name: q(t, target ? lbl(t, `admin.health.loopName.${target}`, target) : '?') })
    else if (action === 'refresh-competitions') head = t('admin.log.ev.ops.refreshCompetitions')
    else if (action === 'reconnect-gateway') head = t('admin.log.ev.ops.reconnectGateway')
    else head = t('admin.log.ev.ops.other')
    const result = opsResult(t, str(p.result))
    return sentence(t, head, null, [result && t('admin.log.x.result', { r: result })])
  },
  'admin.ticket': ({ t, p }) => {
    const subject = str(p.subject) ? q(t, clip(str(p.subject)!)) : t('admin.log.v.untitled')
    const changes = arr(p.changes).map(obj).filter((x): x is P => !!x)
    const rows = changes.length ? changes : str(p.field) ? [{ field: p.field, old: p.old, new: p.new } as P] : []
    const items = rows.map((c) => {
      const field = str(c.field) ?? ''
      if (field === 'reply') return t('admin.log.x.replied', { text: q(t, clip(str(c.new) ?? '', 40)) })
      const prefix = field === 'status' ? 'tickets.status.' : field === 'priority' ? 'tickets.priority.' : null
      const val = (v: unknown) => (str(v) ? (prefix ? lbl(t, `${prefix}${str(v)}`, str(v)!) : str(v)!) : null)
      const label = lbl(t, `admin.log.v.ticketField.${field}`, field)
      const a = val(c.old)
      const b = val(c.new) ?? t('admin.log.v.empty')
      return a ? t('admin.log.x.change', { label, a, b }) : t('admin.log.x.setTo', { label, v: b })
    })
    return [items.length ? listed(t, 'admin.log.ev.ticket.head', items, { subject }) : t('admin.log.ev.ticket.none', { subject })]
  },
  'admin.other': ({ t, p }) => {
    const changes = arr(p.changes).map(obj).filter((x): x is P => !!x)
    const rows = changes.length ? changes : [{ field: p.field, old: p.old, new: p.new } as P]
    // 兜底：字段名原样显示，绝不丢 / fallback: the raw field name is shown, never dropped
    const items = rows.map((c) => changeText(t, str(c.field) ?? '?', c.old, c.new, 'yesno'))
    return [listed(t, 'admin.log.ev.other.head', capItems(t, items))]
  },
}

function isKind(k: string): k is ActivityKind {
  return (ACTIVITY_KINDS as readonly string[]).includes(k)
}

/** 这个 kind 的通用说法（「交易指令：平仓」这类），渲染失败时与详情的「类型」行用。
 *  The kind's generic name, used when rendering fails and for the drawer's "type" line. */
export function kindName(kind: string, t: TFunction): string {
  return isKind(kind) ? t(`admin.log.kindName.${kind}`) : t('admin.log.ev.unknown')
}

// ---------- 详情抽屉「修改前 / 修改后」表 / the drawer's before / after table ----------
const USER_FIELDS = ['role', 'plan', 'plan_expires_at', 'plan_note', 'invite_code']
// 审计字段名不带前缀时（列表行的 params.changes 里只有键名），按 kind 找标签表。
// Bare field names (params.changes carry only the key) find their label table by kind.
const BARE_TABLE: Partial<Record<string, string>> = {
  'admin.setting': 'setKey',
  'admin.gamification': 'gamKey',
  'admin.invite_link': 'inviteField',
  'admin.ticket': 'ticketField',
}
const PLAN_VALUE_FIELDS = ['plan:trial_claim', 'plan:invite_trial', 'plan:payment', 'plan:refund', 'plan:auto_expire']

/**
 * 「项目」列：审计行的字段名（role、setting:pricing:pro_monthly_price、invite:ab12cd34、
 * ticket:<id>:status、自动仓管的 beTriggerR…）翻成与句子同一套的标签；sub 是 JSON 拆开后的键
 * （invite 的 isActive、停用的 reason…）。认不出的原样显示（绝不丢），原名在单元格的 title 里。
 * The "field" column: audit field names (role, setting:pricing:pro_monthly_price,
 * invite:ab12cd34, ticket:<id>:status, auto-manage's beTriggerR…) mapped to the same labels
 * the sentences use; `sub` is the key a JSON value was split on. Unknown names show
 * verbatim (never dropped); the raw name sits in the cell's title.
 */
export function changeFieldLabel(kind: string, field: string, sub: string | null, t: TFunction): string {
  const misc = (k: string) => lbl(t, `admin.log.v.field.${k}`, k)
  const inTable = (table: string, k: string) => lbl(t, `admin.log.v.${table}.${k}`, misc(k))
  const withSub = (base: string) => (sub == null ? base : `${base} · ${misc(sub)}`)
  const setting = (key: string) =>
    // 旧式整组行：拆开后的每一项就是该组的一个设置 / legacy whole-group row: each split key is one setting
    SETTING_GROUPS.has(key) ? (sub != null ? inTable('setKey', sub) : inTable('setGroup', key)) : withSub(inTable('setKey', key))
  const out = ((): string | null => {
    if (kind === 'auto.settings') return withSub(lbl(t, `admin.log.v.autoField.${normField(field)}`, field))
    if (USER_FIELDS.includes(field)) return withSub(lbl(t, `admin.log.v.userField.${field}`, field))
    const parts = field.split(':')
    const head = parts[0]
    if (parts.length === 1) {
      const table = BARE_TABLE[kind]
      if (kind === 'admin.setting') return setting(field)
      if (kind === 'admin.competition') return withSub(lbl(t, `competition.admin.fields.${field}`, inTable('compField', field)))
      return table ? withSub(inTable(table, field)) : null
    }
    if (head === 'setting') return parts.length === 2 ? setting(parts[1]) : withSub(inTable('setKey', parts.slice(2).join(':')))
    if (head === 'gamification') return withSub(inTable('gamKey', parts.slice(1).join(':')))
    if (head === 'invite' && parts.length === 2) return sub != null ? inTable('inviteField', sub) : kindName('admin.invite_link', t)
    if (head === 'invite' && parts[2] === 'agent') return misc('agent')
    if (head === 'agent' && parts.length === 3) return parts[2] === 'extend_days' ? misc('extend_days') : lbl(t, `admin.log.v.userField.${parts[2]}`, parts[2])
    if (head === 'ticket' && parts.length === 3) return inTable('ticketField', parts[2])
    if (head === 'competition' && parts[1] === 'participant' && parts.length === 4) return misc(parts[3])
    if (head === 'competition' && parts.length === 3 && parts[1] !== 'settle' && parts[2] !== 'create' && parts[2] !== 'delete') {
      return withSub(lbl(t, `competition.admin.fields.${parts[2]}`, inTable('compField', parts[2])))
    }
    if (PLAN_VALUE_FIELDS.includes(field)) return lbl(t, 'admin.log.v.userField.plan', field)
    if (['plan', 'account', 'ops', 'announcement', 'email', 'competition'].includes(head)) return sub != null ? misc(sub) : kindName(kind, t)
    return null
  })()
  // 认不出：原样显示 / unrecognised: shown verbatim
  if (out == null) return sub == null ? field : `${field} · ${sub}`
  // 英文标签是句中小写，表格里首字母大写；表里查不到、退回原名的（带 : _ 或驼峰）不动
  // English labels are mid-sentence lower case, capitalised for the table; names that fell
  // back to the raw key (with : or _, or camelCase) stay as they are
  return /[:_]|[a-z][A-Z]/.test(out) ? out : capFirst(out)
}

/**
 * 表格里能翻成人话的值（角色、自动仓管的 R 与百分比、工单状态 / 优先级）；翻不了的回 null，
 * 由抽屉按通用规则显示。
 * Values the table can put in words (roles, auto-manage R multiples and percentages, ticket
 * status / priority); anything else returns null and the drawer's generic rule applies.
 */
export function changeValueText(kind: string, field: string, v: unknown, t: TFunction): string | null {
  if (v == null || v === '') return null
  if (kind === 'auto.settings') {
    if (typeof v === 'boolean') return t(v ? 'admin.log.v.on' : 'admin.log.v.off')
    return num(v) != null ? autoValue(normField(field), v, t) : null
  }
  const s = str(v)
  if (!s) return null
  if (field === 'role') return roleLabel(t, s)
  const m = /^ticket:[^:]+:(status|priority)$/.exec(field) ?? (kind === 'admin.ticket' && (field === 'status' || field === 'priority') ? [field, field] : null)
  if (m) return lbl(t, `tickets.${m[1]}.${s}`, s)
  return null
}

/** 一行 → 一句话。认不出的 kind、或渲染时抛错（契约 §2.1：params 可能缺键、形状意外），
 *  都退回该 kind 的通用说法，而不是让整页崩掉。
 *  One row → one sentence. An unknown kind, or a renderer that throws on unexpected
 *  params (contract §2.1), falls back to the kind's generic name instead of breaking
 *  the page. */
export function renderEvent(item: ActivityItem, t: TFunction): Rendered {
  let parts: Part[]
  try {
    parts = isKind(item.kind) ? R[item.kind]({ t, p: obj(item.params) ?? {}, item }) : [t('admin.log.ev.unknown')]
  } catch {
    parts = [kindName(item.kind, t)]
  }
  return { parts, text: parts.map((x) => (typeof x === 'string' ? x : fmtPnl(x.pnl))).join('') }
}

// ---------- 句子旁边的小标签、谁操作 / chips beside the sentence, and the actor ----------
export type ChipTone = 'bad' | 'warn' | 'info' | 'muted'
export interface Chip {
  key: string
  label: string
  tone: ChipTone
}

const STATUS_TONE: Record<string, ChipTone> = { fail: 'bad', unknown: 'warn', pending: 'info', cancelled: 'muted' }
// partial / gone 已经写进句子，auto 在「谁操作」栏，不再重复成小标签
// partial / gone are in the sentence and auto is the actor column, so they get no chip
const TAG_TONE: Partial<Record<ActivityTag, ChipTone>> = {
  unprotected: 'bad', stopout: 'bad', revoked: 'warn', late: 'muted', backfill: 'muted', shared_login: 'muted',
}

/** 状态 + 标签 → 文字小标签（设计 §6：失败、结果未知、无止损、强平、授权失效、处理中、已撤回、补录…）。
 *  Status + tags → text chips (design §6). */
export function chipsFor(item: ActivityItem, t: TFunction): Chip[] {
  const out: Chip[] = []
  const st = STATUS_TONE[item.status]
  if (st) out.push({ key: `s:${item.status}`, label: t(`admin.log.status.${item.status}`), tone: st })
  for (const tag of item.tags ?? []) {
    const tone = TAG_TONE[tag]
    if (tone) out.push({ key: `t:${tag}`, label: t(`admin.log.tag.${tag}`), tone })
  }
  return out
}

/** 「谁操作」栏：本人 / 系统 / 自动仓管 / 券商（MT5）/ 管理员 X / 代理 X。/ The actor column. */
export function actorLabel(item: ActivityItem, t: TFunction): string {
  const a = item.actor
  if (a.type === 'admin' || a.type === 'agent') {
    const name = str(a.name) ?? str(a.email)
    return name ? t(`admin.log.actor.${a.type}`, { name }) : t(`admin.log.actor.${a.type}Anon`)
  }
  return lbl(t, `admin.log.actor.${a.type}`, a.type)
}
