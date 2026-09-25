// 节日小装饰（轻壳）/ festival decorations (light shells)
//
// 这里只有壳：不在节日窗口里直接返回 null、不发请求；在节日里才经 lazyPart 动态加载
// FestivalDecorImpl.tsx（连同插画、粒子、festival.css，都在 heavy.ts 那一个 chunk 里）。
// 导出名与参数和原来完全一样，宿主页面不用改。每个挂件本来就是宿主里的绝对定位叠加层，
// Suspense 不产生 DOM，晚到一会儿不影响宿主布局。
// Shells only: outside a festival window they return null and fetch nothing;
// inside one they load FestivalDecorImpl.tsx through lazyPart (with the art,
// particles and festival.css, all in the heavy.ts chunk). Export names and
// props are unchanged, so host pages need no edits. Each decoration is already
// an absolutely positioned overlay in its host and Suspense adds no DOM, so
// arriving a moment later never shifts the host's layout.
import { memo } from 'react'
import { Deferred, lazyPart, useFestivalOn } from './lazyPart'

export type TopperKind = 'button' | 'avatar' | 'mini' | 'card'

const TopperImpl = lazyPart<{ kind: TopperKind; hang?: boolean }>((m) => m.FestivalTopper)
const CornerImpl = lazyPart<{ side?: 'l' | 'r' }>((m) => m.FestivalCorner)
const GroundImpl = lazyPart<{ sit?: boolean }>((m) => m.FestivalGround)
const GarlandImpl = lazyPart<object>((m) => m.FestivalGarland)
const AmbientImpl = lazyPart<object>((m) => m.FestivalAmbient)
const EmptyMiniImpl = lazyPart<object>((m) => m.FestivalEmptyMini)
const BurstImpl = lazyPart<object>((m) => m.FestivalBurst)

function FestivalTopperShell(props: { kind: TopperKind; hang?: boolean }) {
  if (!useFestivalOn()) return null
  return (
    <Deferred>
      <TopperImpl {...props} />
    </Deferred>
  )
}
export const FestivalTopper = memo(FestivalTopperShell)

export function FestivalCorner(props: { side?: 'l' | 'r' }) {
  if (!useFestivalOn()) return null
  return (
    <Deferred>
      <CornerImpl {...props} />
    </Deferred>
  )
}

export function FestivalGround(props: { sit?: boolean }) {
  if (!useFestivalOn()) return null
  return (
    <Deferred>
      <GroundImpl {...props} />
    </Deferred>
  )
}

export function FestivalGarland() {
  if (!useFestivalOn()) return null
  return (
    <Deferred>
      <GarlandImpl />
    </Deferred>
  )
}

export function FestivalAmbient() {
  if (!useFestivalOn()) return null
  return (
    <Deferred>
      <AmbientImpl />
    </Deferred>
  )
}

export function FestivalEmptyMini() {
  if (!useFestivalOn()) return null
  return (
    <Deferred>
      <EmptyMiniImpl />
    </Deferred>
  )
}

export function FestivalBurst() {
  if (!useFestivalOn()) return null
  return (
    <Deferred>
      <BurstImpl />
    </Deferred>
  )
}
