// 轮盘页（v2 多期）的纯逻辑：哪些期能画转盘、默认选哪一期、记住上次选的期、抽完后改券数、
// 「我的奖品」该列哪些、结果弹框用哪句。放在 .ts 里是因为仓库没有 DOM 测试环境。
// 没有可显示的期 = 关闭：关闭时页面仍要把「我的奖品」和结果弹框画出来（已中奖品的领取没有系统期限，
// 期结束后用户还要能填领奖信息 / 开工单）。
// Pure logic for the lucky page (v2, several rounds): which rounds can show a wheel, which one is
// selected by default, remembering the last pick, updating ticket counts after a spin, which draws
// "My prizes" lists and which sentence the result modal uses. Kept in .ts (no DOM test env).
// No showable round = closed; the page still renders "My prizes" and the result modal while closed,
// because there is no system claim deadline and a winner must be able to claim after the round ends.
import type { LuckyDraw, LuckyRoundState, LuckyState } from '../api/luckyTypes'

/** 能画转盘的期（未开始只显示倒计时）/ Rounds that get a wheel (upcoming ones only count down). */
export const openRounds = (state: LuckyState): LuckyRoundState[] =>
  state.rounds.filter((r) => r.round.phase === 'upcoming' || r.round.phase === 'active')

export const isWheelClosed = (state: LuckyState): boolean => openRounds(state).length === 0

/**
 * 选中哪一期：上次选的还在就用它；否则优先「进行中且有券」，再「进行中」，最后第一期。
 * Which round to show: the remembered one if it is still listed; otherwise an active round with
 * tickets, then any active round, then the first one.
 */
export function pickRound(rounds: LuckyRoundState[], preferred: string | null | undefined): LuckyRoundState | null {
  if (!rounds.length) return null
  return rounds.find((r) => r.round.id === preferred)
    ?? rounds.find((r) => r.round.phase === 'active' && r.tickets.unused > 0)
    ?? rounds.find((r) => r.round.phase === 'active')
    ?? rounds[0]
}

/** 抽完后把那一期的未用券数换成后端给的 ticketsLeft / Apply the backend's ticketsLeft to that round. */
export function withTicketsLeft(state: LuckyState, roundId: string, left: number): LuckyState {
  return {
    ...state,
    rounds: state.rounds.map((r) => (r.round.id === roundId ? { ...r, tickets: { ...r.tickets, unused: left } } : r)),
  }
}

/**
 * 「我的奖品」：谢谢参与、「已抽完未中奖」都不算；「再来一次」只是退回一张券（票夹里能看到），也不列。
 * "My prizes": neither "thanks" nor a sold-out miss counts, and "spin again" only refunds a ticket (shown in
 * the wallet), so it is left out too.
 */
export const wonDraws = (draws: LuckyDraw[]): LuckyDraw[] =>
  draws.filter((d) => d.prize.kind !== 'none' && d.prize.kind !== 'retry' && !d.soldOut)

// 结果揭晓卡的文案：中奖（实物 / PRO）、再来一次、没中（谢谢参与 / 已抽完）三种语气。
// 实物奖品的大标题直接用奖品名（管理员填的，不翻译）；其余走文案键。
// The reveal card's copy in three tones: a win (custom / PRO), spin again, or a miss ("thanks" or a
// sold-out slot). A custom prize's headline is the prize name itself (admin-written, untranslated).
export type RevealTone = 'win' | 'retry' | 'miss'
export interface RevealCopy {
  tone: RevealTone
  eyebrowKey?: string
  titleKey?: string
  titleText?: string
  subKey?: string
  params?: Record<string, unknown>
}

export function revealCopy(draw: Pick<LuckyDraw, 'prize' | 'soldOut'>): RevealCopy {
  if (draw.soldOut) return { tone: 'miss', titleKey: 'lucky.reveal.missTitle', subKey: 'lucky.reveal.soldOut' }
  switch (draw.prize.kind) {
    case 'none': return { tone: 'miss', titleKey: 'lucky.reveal.missTitle', subKey: 'lucky.reveal.none', params: { name: draw.prize.name } }
    case 'retry': return { tone: 'retry', titleKey: 'lucky.reveal.retryTitle', subKey: 'lucky.reveal.retry' }
    case 'pro_days':
      return { tone: 'win', eyebrowKey: 'lucky.reveal.won', titleKey: 'lucky.reveal.proTitle', subKey: 'lucky.reveal.proSub', params: { n: draw.prize.proDays } }
    default: return { tone: 'win', eyebrowKey: 'lucky.reveal.won', titleText: draw.prize.name }
  }
}

/**
 * 转盘下面那句鼓励的话。连着没中时三句轮换，不重复同一句；绝不暗示「越抽越容易中」。
 * The encouraging line under the wheel. Consecutive misses rotate through three lines so the same one
 * never repeats twice in a row; nothing ever implies the odds improve with more spins.
 */
export type Outcome = RevealTone | null
export function cheerKey(s: {
  phase: 'upcoming' | 'active' | 'ended'; spinning: boolean; unused: number; hadTickets: boolean
  last: Outcome; missStreak: number
}): string {
  if (s.phase !== 'active') return 'lucky.cheer.upcoming'
  if (s.spinning) return 'lucky.cheer.spinning'
  if (s.unused <= 0) {
    if (s.last === 'win') return 'lucky.cheer.winOut'
    return s.hadTickets ? 'lucky.cheer.out' : 'lucky.cheer.none'
  }
  if (s.last === 'win') return 'lucky.cheer.win'
  if (s.last === 'retry') return 'lucky.cheer.retry'
  if (s.last === 'miss') return `lucky.cheer.miss${((Math.max(1, s.missStreak) - 1) % 3) + 1}`
  return 'lucky.cheer.ready'
}

// 记住上次选的期：localStorage 在隐私模式 / 被禁用时会抛错，读写都包 try/catch，失败就当没记住。
// Remember the last picked round. localStorage can throw (private mode / blocked), so every access is
// wrapped and a failure simply means "nothing remembered".
export const LAST_ROUND_KEY = 'prismx.lucky.round'
type KV = Pick<Storage, 'getItem' | 'setItem'>
const defaultStore = (): KV | null => (typeof window !== 'undefined' ? window.localStorage : null)

export function readLastRound(store: () => KV | null = defaultStore): string | null {
  try { return store()?.getItem(LAST_ROUND_KEY) ?? null } catch { return null }
}

export function writeLastRound(id: string, store: () => KV | null = defaultStore): void {
  try { store()?.setItem(LAST_ROUND_KEY, id) } catch { /* 存不了就算了 / best effort */ }
}
