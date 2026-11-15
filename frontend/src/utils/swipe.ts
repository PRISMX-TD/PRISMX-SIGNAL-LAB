// 左右滑动「算不算数」：横向位移达到 distance；或短而快的一甩——至少 flickMin，且整段的平均
// 速度超过 flickVelocity（px/ms）。横向必须大于竖向，否则是在滚页面。仪表盘趋势轮播
// （SignalHero）与成就陈列台（PedestalStage）共用，各自传阈值。
// Whether a sideways swipe counts: travel reaches `distance`, or a short fast flick of
// at least `flickMin` whose average speed beats `flickVelocity` (px/ms). Horizontal must
// beat vertical, otherwise it is a page scroll. Shared by the dashboard trend carousel
// (SignalHero) and the achievements pedestal (PedestalStage), each with its own numbers.
export interface SwipeRule {
  distance: number
  flickMin: number
  flickVelocity: number
}

export function swipeCommits(dx: number, dy: number, dt: number, rule: SwipeRule): boolean {
  const ax = Math.abs(dx)
  if (ax <= Math.abs(dy)) return false
  if (ax >= rule.distance) return true
  return ax >= rule.flickMin && dt > 0 && ax / dt > rule.flickVelocity
}
