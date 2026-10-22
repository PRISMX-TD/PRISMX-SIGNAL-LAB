import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, useTransition, type ReactNode } from 'react'
import { createBrowserHistory, type BrowserHistory } from '@remix-run/router'
import { Router } from 'react-router-dom'

// BrowserRouter 的等价物，多做一件事：把「路由切换还没完成」暴露出来。
//
// 为什么需要：原来用 BrowserRouter + v7_startTransition，切到还没下载的懒页面时，
// React 把旧页面原样留在屏幕上，直到新页面的 chunk（和按需语言包）到齐。页面区的
// Suspense 早已挂着内容，transition 不会退回它的占位——于是那条进度条从来不出现。
// 大陆拉 Vercel 慢的时候，用户点了导航或按钮，几秒内屏幕纹丝不动，看上去就是
// 「点了没反应、卡住了」，于是再点、再点。
//
// 这里自己用 useTransition 包路由状态，isPending 交给 NavPendingBar 画顶部进度条。
// 行为与 BrowserRouter（v7_startTransition）一致：同一个 history 实现、同样在
// transition 里更新 location，只是多拿到了 isPending。
//
// Equivalent to BrowserRouter with v7_startTransition, except it exposes "a navigation
// is still in flight". With the stock router, switching to a not-yet-downloaded lazy page
// kept the old page on screen until the chunk (and the on-demand locale bundle) arrived;
// the page-level Suspense already had content, so the transition never fell back to its
// placeholder and nothing moved. On a slow mainland→Vercel link a tap looked like it did
// nothing at all, so people tapped again. Same history implementation, same transition
// semantics — we just keep isPending and draw a top bar from it.

const NavPendingContext = createContext(false)

export function useNavPending(): boolean {
  return useContext(NavPendingContext)
}

export function NavPendingRouter({ children }: { children: ReactNode }) {
  const historyRef = useRef<BrowserHistory>()
  if (!historyRef.current) historyRef.current = createBrowserHistory({ v5Compat: true })
  const history = historyRef.current
  const [state, setState] = useState({ action: history.action, location: history.location })
  const [isPending, startTransition] = useTransition()
  useLayoutEffect(
    () => history.listen(({ action, location }) => startTransition(() => setState({ action, location }))),
    [history],
  )
  return (
    <NavPendingContext.Provider value={isPending}>
      {/* v7_relativeSplatPath：见 App.tsx 原注释，唯一的 splat 是 path="*" 跳绝对路径，行为不变。
          v7_relativeSplatPath: the only splat route navigates to an absolute path; no change. */}
      <Router
        location={state.location}
        navigationType={state.action}
        navigator={history}
        future={{ v7_relativeSplatPath: true }}
      >
        {children}
      </Router>
    </NavPendingContext.Provider>
  )
}

// 顶部细进度条。延迟 150ms 才出现：chunk 已在缓存里的切换（绝大多数，含 App 内）
// 不闪；慢的那次立刻有「在走」的反馈。pointer-events-none，绝不挡点击。
// Thin top bar. Shows after 150ms so cached switches (most of them, and all of them in
// the app) never flash it; a slow one gets feedback right away. Never intercepts taps.
export function NavPendingBar() {
  const pending = useNavPending()
  const [show, setShow] = useState(false)
  useEffect(() => {
    if (!pending) {
      setShow(false)
      return
    }
    const t = window.setTimeout(() => setShow(true), 150)
    return () => window.clearTimeout(t)
  }, [pending])
  if (!show) return null
  return (
    <div
      role="progressbar"
      aria-busy="true"
      className="pointer-events-none fixed inset-x-0 z-[9999] h-0.5 overflow-hidden bg-prism-500/15"
      style={{ top: 'env(safe-area-inset-top, 0px)' }}
    >
      <div className="h-full w-1/3 animate-shimmer bg-prism-400" />
    </div>
  )
}
