// App 问候卡（轻壳）/ in-app greeting card (light shell)
//
// 不在节日里、或本期问候已被关掉，就什么都不渲染也不加载；否则动态加载
// FestivalGreetingImpl.tsx。实现里高度从 0 展开入场，所以晚到不会让内容跳一下。
// Renders and loads nothing outside a festival or once this window's greeting
// was dismissed; otherwise loads FestivalGreetingImpl.tsx. The implementation
// already enters by growing from height 0, so arriving late causes no jump.
import { useFestivalOptional } from './FestivalProvider'
import { Deferred, lazyPart } from './lazyPart'

const Impl = lazyPart<object>((m) => m.FestivalGreeting)

export default function FestivalGreeting() {
  const f = useFestivalOptional()
  if (!f || !f.festival || !f.greetingOpen) return null
  return (
    <Deferred>
      <Impl />
    </Deferred>
  )
}
