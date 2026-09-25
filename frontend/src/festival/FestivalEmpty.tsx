// 空状态插画（轻壳）/ empty-state illustration (light shell)
//
// 不在节日里就只是原来那句文案；在节日里动态加载 FestivalEmptyImpl.tsx，加载期间
// （以及重包拉不下来时）照样显示原句，信息一个字不少。
// Outside a festival this is just the original line; inside one it loads
// FestivalEmptyImpl.tsx, and while loading (or if the chunk cannot be fetched)
// the original line still shows, so no information is ever missing.
import { Deferred, lazyPart, useFestivalOn } from './lazyPart'

function Plain({ fallback }: { fallback: string }) {
  return <>{fallback}</>
}

const Impl = lazyPart<{ fallback: string }>((m) => m.FestivalEmpty, Plain)

export default function FestivalEmpty({ fallback }: { fallback: string }) {
  if (!useFestivalOn()) return <>{fallback}</>
  return (
    <Deferred fallback={fallback}>
      <Impl fallback={fallback} />
    </Deferred>
  )
}
