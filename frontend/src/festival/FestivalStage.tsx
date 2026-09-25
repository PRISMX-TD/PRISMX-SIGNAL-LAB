// 落地页节日布景（轻壳）/ landing festival set dressing (light shell)
//
// 布景实现（FestivalStageImpl.tsx，七十多 KB 源码 + 粒子 + 插画）只有落地页用，单独一个
// chunk：不在节日里不加载；在节日里动态加载。布景本身就是等锚点量完才入场的叠加层，
// 晚到一会儿不影响首屏。
// The set implementation (FestivalStageImpl.tsx, 70+ KB of source plus
// particles and artwork) is used only by the landing page and has its own
// chunk: not loaded outside a festival, loaded on demand inside one. The set is
// an overlay that already waits for its anchors to be measured before entering,
// so arriving a moment later does not affect the first screen.
import { Deferred, lazyFrom, useFestivalOn } from './lazyPart'

export type { Variant } from './FestivalStageImpl'

const load = () => import('./FestivalStageImpl')
const StageImpl = lazyFrom<{ scene: number }>(() => load().then((m) => m.default))
const FinaleImpl = lazyFrom<object>(() => load().then((m) => m.FestivalFinale))

export default function FestivalStage(props: { scene: number }) {
  if (!useFestivalOn()) return null
  return (
    <Deferred>
      <StageImpl {...props} />
    </Deferred>
  )
}

export function FestivalFinale() {
  if (!useFestivalOn()) return null
  return (
    <Deferred>
      <FinaleImpl />
    </Deferred>
  )
}
