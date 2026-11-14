// 横向可滚动的一排控件（.seg-tabs 分段控件）在右侧还有内容时打上 data-more，
// CSS 据此在右边缘加一段渐隐，提示「还能往左滑」。放得下时不加，不会白白遮掉最后一个按钮。
//
// 2026-11-15 起：泰语排行榜、越南语交易页的分段标签超出屏幕后是被静默截断的——
// .seg-tabs 本来就能横滑，只是没有任何提示，看起来像被切掉。
//
// Marks a horizontally scrollable row (the .seg-tabs segmented control) with
// data-more while there is more content to the right, and CSS fades the right
// edge as a "swipe for more" cue. Nothing is faded when everything fits.
// Since 2026-11-15: Thai leaderboard and Vietnamese trade-page tabs ran off the
// screen and looked cut off — .seg-tabs already scrolled, with no hint at all.
import { useCallback, useRef } from 'react'

// 返回回调 ref：控件可能晚于组件挂载才出现（例如成长页的页签要等数据），回调 ref 在元素
// 出现、消失时各调一次，不会漏挂。
// Returns a callback ref: the row may mount after the component does (the growth
// hub's tabs wait on data), and a callback ref fires whenever the element appears
// or goes away.
export function useOverflowHint<T extends HTMLElement>() {
  const cleanup = useRef<(() => void) | null>(null)
  return useCallback((el: T | null) => {
    cleanup.current?.()
    cleanup.current = null
    if (!el) return
    const update = () => {
      // 1px 容差：缩放后的小数像素会让 scrollWidth 比可见宽度多出不到 1px。
      // 1px tolerance: fractional pixels under zoom can leave scrollWidth a hair wider.
      const more = el.scrollLeft + el.clientWidth < el.scrollWidth - 1
      if (more) el.setAttribute('data-more', '')
      else el.removeAttribute('data-more')
    }
    update()
    el.addEventListener('scroll', update, { passive: true })
    // 观察容器和每个按钮：切语言只改按钮文字宽度，容器自己的尺寸可能不变。
    // Watch the row and each button: a language switch changes only the labels' widths.
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update)
    if (ro) {
      ro.observe(el)
      for (const child of Array.from(el.children)) ro.observe(child)
    }
    cleanup.current = () => {
      el.removeEventListener('scroll', update)
      ro?.disconnect()
    }
  }, [])
}
