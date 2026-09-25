// Logo 彩蛋（轻壳）/ logo ornament (light shell)
//
// Logo 全站十几处都在用，所以这里只放壳：不在节日里返回 null；在节日里动态加载
// LogoOrnamentImpl.tsx（heavy.ts 那个 chunk）。彩蛋是 Logo 里的绝对定位叠加层，晚到
// 一会儿不影响 Logo 本身。
// The logo is used in a dozen places, so only the shell lives here: null
// outside a festival; inside one, LogoOrnamentImpl.tsx is loaded (the heavy.ts
// chunk). The ornament is an absolutely positioned overlay inside the logo, so
// arriving a moment later leaves the logo itself untouched.
import { Deferred, lazyPart, useFestivalOn } from './lazyPart'

const Impl = lazyPart<object>((m) => m.LogoOrnament)

export default function LogoOrnament() {
  if (!useFestivalOn()) return null
  return (
    <Deferred>
      <Impl />
    </Deferred>
  )
}
