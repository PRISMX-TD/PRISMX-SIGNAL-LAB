// 轻壳的公共件 / shared bits for the light festival shells
//
// 轻壳只做两件事：① 取 FestivalProvider 的判定——不在节日里就什么都不渲染，也不加载；
// ② 在节日里用 React.lazy 挂上重实现，外面包一层自己的 <Suspense fallback={null}>，
// 加载期间只是「装饰晚到一会儿」，绝不会把外层路由的 Suspense 顶成整页加载态。
// 重包拉不下来（断网、发版后旧哈希）就当没有节日：装饰缺席，页面照常，不进 ErrorBoundary。
// 预渲染（SSR）不挂 FestivalProvider，所以轻壳在服务端一律返回 null，lazy 从不触发。
// A shell does two things: (1) read FestivalProvider's verdict — outside a
// festival it renders and loads nothing; (2) inside one, mount the heavy
// implementation through React.lazy wrapped in its own <Suspense fallback={null}>,
// so loading only means the decoration arrives a moment later and never pushes
// the route-level Suspense into a full-page loading state. If the chunk cannot
// be fetched (offline, stale hash after a deploy) it behaves as if there were
// no festival: the decoration is absent, the page is fine, no ErrorBoundary.
// Prerendering (SSR) mounts no FestivalProvider, so every shell returns null on
// the server and lazy() never fires.
import { Suspense, lazy, type ComponentType, type ReactNode } from 'react'
import { useFestivalOptional } from './FestivalProvider'
import { loadFestivalHeavy, type FestivalHeavy } from './load'

// pick 返回的可能是 memo() 包过的组件（不是 ComponentType），所以按 unknown 取再断言。
// pick may return a memo()-wrapped component, which is not a ComponentType, hence unknown + assertion.
export function lazyPart<P extends object>(
  pick: (m: FestivalHeavy) => unknown,
  fallback: ComponentType<P> = () => null
) {
  return lazyFrom<P>(() => loadFestivalHeavy().then(pick), fallback)
}

export function lazyFrom<P extends object>(load: () => Promise<unknown>, fallback: ComponentType<P> = () => null) {
  return lazy<ComponentType<P>>(() =>
    load().then(
      (c) => ({ default: c as ComponentType<P> }),
      () => ({ default: fallback })
    )
  )
}

export function useFestivalOn(): boolean {
  const f = useFestivalOptional()
  return !!(f && f.festival)
}

export function Deferred({ children, fallback = null }: { children: ReactNode; fallback?: ReactNode }) {
  return <Suspense fallback={fallback}>{children}</Suspense>
}
