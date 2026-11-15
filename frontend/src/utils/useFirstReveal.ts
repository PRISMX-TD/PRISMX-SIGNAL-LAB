// 列表「只在第一次出现时」错峰进场 / first-reveal gate for list enter animations.
//
// 列表行的进场动画（淡入 + 小位移 + 错峰）只该在数据第一次出现时播一次。之后都不该
// 再播：轮询带来的新行、翻页、筛选、切回这个 tab 时组件重新挂载。否则用户每点一次都要
// 等一段动画才能读到内容，高频页面上这就是「慢」。
//
// 用法：const reveal = useFirstReveal(ready, 'orders-slips')
//   · ready：数据是否已经到了（骨架屏阶段传 false）。
//   · sessionKey（可选）：同一个 key 在这次打开 App 期间只播一次，切走再切回来不再播。
//     不传时每次挂载播一次（适合后台分区、弹窗这类每次打开都是新内容的地方）。
//   · 返回 true 期间给行加进场 class；ready 之后 600ms 变成 false，此后新插入的行
//     不带 class，直接出现。600ms 覆盖最长一段错峰（5 × 30ms + 240ms = 390ms）并留
//     余量，所以摘掉 class 时动画早已播完，不会跳。
//
// List rows should stagger in once, when the data first appears, and never again:
// not for polled-in rows, page flips, filters, or the component remounting when the
// user returns to the tab. Otherwise every tap waits on an animation before the
// content is readable, which on high-frequency screens reads as slowness.
//   · ready: whether the data has arrived (false while a skeleton shows).
//   · sessionKey (optional): play at most once per app session for this key, so
//     leaving and coming back does not replay. Without it every mount plays once
//     (right for admin sections or dialogs where each open is fresh content).
//   · Returns true while rows should carry the enter class; it turns false 600ms
//     after ready, so rows inserted later appear at once. 600ms covers the longest
//     stagger (5 × 30ms + 240ms = 390ms) with margin, so dropping the class never
//     cuts an animation short.
import { useEffect, useState } from 'react'

const playedThisSession = new Set<string>()

export const FIRST_REVEAL_WINDOW_MS = 600

export function useFirstReveal(ready: boolean, sessionKey?: string): boolean {
  const [on, setOn] = useState(() => !(sessionKey && playedThisSession.has(sessionKey)))
  useEffect(() => {
    if (!ready || !on) return
    if (sessionKey) playedThisSession.add(sessionKey)
    const id = window.setTimeout(() => setOn(false), FIRST_REVEAL_WINDOW_MS)
    return () => window.clearTimeout(id)
  }, [ready, on, sessionKey])
  return on
}
