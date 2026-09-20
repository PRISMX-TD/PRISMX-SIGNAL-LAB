// 响应式分支钩子 / media-query hook.
//
// 只在「手机和桌面要渲染不同 DOM」时用（如订单页手机版的账户抬头 + 仓位行 vs
// 桌面版的账号药丸 + 账本条 + 仓位卡）。纯样式差异仍然走 CSS 媒体查询，别为了
// 改个间距上这个钩子。断点与 tailwind 的 md（768px）对齐，和 orders.css 里
// 那段 max-width:767px 是同一条线。
// Use only when phone and desktop need different DOM (the orders page renders an
// account masthead + position rows on phones, pills + ledger + cards on desktop).
// Pure styling differences stay in CSS media queries. The breakpoint matches
// tailwind's md (768px) and the max-width:767px block in orders.css.
import { useEffect, useState } from 'react'
import { onMediaQuery } from './onMediaQuery'

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(query).matches
      : false,
  )
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia(query)
    const sync = () => setMatches(mq.matches)
    sync()
    // change 事件在 DevTools / 浏览器面板的设备模拟下不一定触发（本地验证时踩到：
    // 视口切到 375px、matches 已是 true，事件却没来），resize 兜底再读一次。
    // The change event doesn't always fire under DevTools / pane device emulation
    // (seen locally: viewport at 375px, matches already true, no event). Re-read on
    // resize as a fallback.
    // 订阅走 onMediaQuery 而不是直接 addEventListener：MediaQueryList 直到
    // Safari 14 才是 EventTarget，而构建下限包含 safari12（见 vite.config.ts）。
    // 在 iOS 12/13 上 `mq.addEventListener` 是 undefined，这一行直接抛 TypeError，
    // React 把它冒到 ErrorBoundary——唯一的消费方是订单页的手机/桌面分支，表现
    // 就是那批机器一打开 /orders 就是错误页。onMediaQuery 会在缺 EventTarget 时
    // 退回老的 addListener/removeListener，两个都没有时不订阅但绝不抛。
    // Subscribe via onMediaQuery rather than addEventListener directly:
    // MediaQueryList only became an EventTarget in Safari 14, while the build
    // floor includes safari12 (see vite.config.ts). On iOS 12/13
    // `mq.addEventListener` is undefined and this line throws a TypeError that
    // React bubbles to the ErrorBoundary — and the sole consumer is the orders
    // page's phone/desktop split, so those devices got an error page the moment
    // they opened /orders. onMediaQuery falls back to the legacy
    // addListener/removeListener pair, and subscribes to nothing (never throws)
    // when neither exists.
    const offMq = onMediaQuery(mq, sync)
    window.addEventListener('resize', sync)
    return () => {
      offMq()
      window.removeEventListener('resize', sync)
    }
  }, [query])
  return matches
}

export function useIsPhone(): boolean {
  return useMediaQuery('(max-width: 767px)')
}
