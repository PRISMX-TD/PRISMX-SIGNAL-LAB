// 落地页问候条（轻壳）/ landing ribbon (light shell)
//
// 与 FestivalGreeting 同理：没有节日或已关掉就不加载；否则动态加载 FestivalRibbonImpl.tsx
// （它自己从高度 0 展开入场）。
// Same as FestivalGreeting: nothing is loaded without a festival or once
// dismissed; otherwise FestivalRibbonImpl.tsx loads (it enters from height 0).
import { useFestivalOptional } from './FestivalProvider'
import { Deferred, lazyPart } from './lazyPart'

const Impl = lazyPart<object>((m) => m.FestivalRibbon)

export default function FestivalRibbon() {
  const f = useFestivalOptional()
  if (!f || !f.festival || !f.greetingOpen) return null
  return (
    <Deferred>
      <Impl />
    </Deferred>
  )
}
