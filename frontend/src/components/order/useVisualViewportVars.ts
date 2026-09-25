// 把可视视口（visualViewport）的高度与顶部偏移写成元素上的 CSS 变量 --vvh / --vvt。
//
// 为什么需要：底部下单弹窗原来是 `max-height: 92vh`。vh 在手机上指的是「布局视口」，
// 软键盘弹出时它不变——iOS Safari 尤其如此，键盘直接盖住弹窗下半截，滑动确认条和
// 止损止盈输入框都在键盘底下。可视视口才是键盘之外真正看得见的那一块。
// 与 viewport 的 interactive-widget=resizes-content 兼容：那个设置生效的浏览器（安卓
// Chrome）会连布局视口一起缩，此时 visualViewport.height 与布局视口相等、offsetTop 为
// 0，变量写进去的值和不写一样，不会重复扣掉键盘高度。
// 直接改 style、不走 setState：键盘动画期间 resize 一帧一次，重渲染整个弹窗不值得。
//
// Writes the visual viewport's height and top offset onto an element as the CSS
// variables --vvh / --vvt. The bottom order sheet used `max-height: 92vh`, and vh
// is the *layout* viewport, which doesn't shrink when the soft keyboard opens (iOS
// Safari in particular), so the keyboard covered the lower half of the sheet — the
// slider and the SL/TP inputs included. Compatible with the viewport's
// interactive-widget=resizes-content: where that applies (Android Chrome) the
// layout viewport shrinks too, visualViewport.height equals it and offsetTop is 0,
// so the variables change nothing and the keyboard is never subtracted twice.
// Mutates style directly instead of setState: resize fires every frame during the
// keyboard animation and re-rendering the whole sheet for it isn't worth it.
import { useEffect, type RefObject } from 'react'

export function useVisualViewportVars(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = ref.current
    const vv = typeof window !== 'undefined' ? window.visualViewport : null
    if (!el || !vv) return
    let raf = 0
    const apply = () => {
      raf = 0
      el.style.setProperty('--vvh', `${Math.round(vv.height)}px`)
      el.style.setProperty('--vvt', `${Math.round(vv.offsetTop)}px`)
    }
    const schedule = () => {
      if (!raf) raf = window.requestAnimationFrame(apply)
    }
    apply()
    vv.addEventListener('resize', schedule)
    vv.addEventListener('scroll', schedule)
    return () => {
      vv.removeEventListener('resize', schedule)
      vv.removeEventListener('scroll', schedule)
      if (raf) window.cancelAnimationFrame(raf)
    }
  }, [ref])
}
