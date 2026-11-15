// 弹层打开期间锁住页面滚动。锁 <html> 而不是 <body>：layer-base.css 给 html 设了
// overflow-x: clip，html 的 overflow 不是 visible，body 的 overflow 就不会传播给视口——
// 真正滚动的是视口。给 body 设 overflow: hidden 会把它（height: 100%）变成一个从顶部开始
// 的滚动容器，页面当场跳回顶部；锁 html 则停在原位。引用计数：嵌套的弹层各锁一次，最后一个
// 关闭时才还原原来的行内值。
//
// Locks page scrolling while a sheet is open. It locks <html>, not <body>: layer-base.css
// gives html overflow-x: clip, so html's overflow is not visible and body's overflow is
// not propagated to the viewport, which is what actually scrolls. overflow: hidden on
// body would turn it (height: 100%) into a scroller starting at the top and the page
// would jump there; locking html keeps the position. Reference-counted: nested sheets
// each lock once and the original inline value returns when the last one closes.
import { useEffect } from 'react'

interface Lockable { style: { overflow: string } }

let count = 0
let saved = ''
let lockedRoot: Lockable | null = null

export function lockScroll(root: Lockable = document.documentElement): () => void {
  if (count === 0) {
    lockedRoot = root
    saved = root.style.overflow
    root.style.overflow = 'hidden'
  }
  count += 1
  let released = false
  return () => {
    if (released) return
    released = true
    count -= 1
    if (count === 0 && lockedRoot) {
      lockedRoot.style.overflow = saved
      lockedRoot = null
    }
  }
}

export function useScrollLock(active: boolean): void {
  useEffect(() => {
    if (!active) return
    return lockScroll()
  }, [active])
}
