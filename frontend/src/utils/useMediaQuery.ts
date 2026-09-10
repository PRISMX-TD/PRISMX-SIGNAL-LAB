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
    mq.addEventListener('change', sync)
    window.addEventListener('resize', sync)
    return () => {
      mq.removeEventListener('change', sync)
      window.removeEventListener('resize', sync)
    }
  }, [query])
  return matches
}

export function useIsPhone(): boolean {
  return useMediaQuery('(max-width: 767px)')
}
