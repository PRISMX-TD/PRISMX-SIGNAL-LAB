// 轮盘页该画转盘还是「暂未开放」。开关没开 / 没有期 / 期已结束都算关闭：关闭时页面仍要把
// 「我的奖品」和结果弹框画出来（已中奖品的领取没有系统期限，期结束后用户还要能填领奖信息 / 开工单）。
// Whether the lucky page draws the wheel or the "not open" card. Switch off / no round / round ended
// all count as closed; the page still renders "My prizes" and the result modal while closed, because
// there is no system claim deadline and a winner must be able to claim after the round ends.
import type { LuckyState } from '../api/luckyTypes'

export function isWheelClosed(state: Pick<LuckyState, 'visible' | 'round'>): boolean {
  const phase = state.round?.phase
  return !state.visible || !state.round || phase === 'none' || phase === 'ended'
}
