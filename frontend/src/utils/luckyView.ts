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

/** 「我的奖品」：谢谢参与和「已抽完未中奖」都不算中奖 / "My prizes": neither "thanks" nor a sold-out miss is a win. */
export const wonDraws = (draws: LuckyDraw[]): LuckyDraw[] => draws.filter((d) => d.prize.kind !== 'none' && !d.soldOut)

/** 结果弹框标题用的文案键 / The i18n key (and params) for the result modal's title. */
export function resultKey(draw: Pick<LuckyDraw, 'prize' | 'soldOut'>): { key: string; params?: Record<string, unknown> } {
  if (draw.soldOut) return { key: 'lucky.result.soldOut' }
  switch (draw.prize.kind) {
    case 'none': return { key: 'lucky.result.none' }
    case 'retry': return { key: 'lucky.result.retry' }
    case 'pro_days': return { key: 'lucky.result.proDays', params: { n: draw.prize.proDays } }
    default: return { key: 'lucky.result.custom', params: { name: draw.prize.name } }
  }
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
