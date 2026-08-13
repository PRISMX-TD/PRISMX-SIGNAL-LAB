// 移动端吸底 CTA：滚出首屏后出现，仅在小屏显示
// Mobile sticky bottom CTA: appears once the hero has scrolled away, mobile only
//
// 触发方式从 window scroll 事件换成 IntersectionObserver 哨兵。原来的写法在整页
// 滚动期间每一帧都要跑一次回调、读一次 window.scrollY 并调用 setState——为了一个
// 布尔值付出连续的强制同步布局与 React 重渲染。哨兵版本只在越过边界的那一刻回调
// 两次（进入、离开），其余时间零开销。
// 阈值同时从「滚动 560px」改成「hero 哨兵离开视口」：写死的像素值在不同机型的
// 视口高度下对应的是完全不同的滚动位置，而实际要表达的意思一直是「首屏已经过去」。
//
// The trigger moved from a window scroll event to an IntersectionObserver
// sentinel. The old version ran a callback, read window.scrollY and called
// setState on every frame of every scroll — continuous forced synchronous layout
// plus React re-renders, all for one boolean. The sentinel fires twice in total
// (on entering and leaving) and costs nothing in between.
// The threshold also changed from "scrolled 560px" to "the hero sentinel left the
// viewport": a hardcoded pixel value maps to completely different scroll positions
// across device viewport heights, while the intent was always "the hero is past".
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'

export default function MobileStickyCta() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [visible, setVisible] = useState(false)
  const sentinel = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = sentinel.current
    if (!el) return
    const io = new IntersectionObserver(([e]) => setVisible(!e.isIntersecting), { threshold: 0 })
    io.observe(el)
    return () => io.disconnect()
  }, [])

  return (
    <>
      {/* 哨兵挂在页面顶部往下 80vh 处，等价于「首屏看完了」。
          The sentinel sits 80vh down the page, i.e. "the first screen is done". */}
      <div ref={sentinel} className="pointer-events-none absolute top-[80vh] h-px w-full" aria-hidden />

      {visible && (
        /* 实色条 + 顶部发丝线，不是浮在内容上的圆角玻璃卡。吸底条的职责是常驻可点，
           半透明只会让它下面的表格数字透上来干扰按钮文字。
           A solid bar with a hairline top edge, not a floating rounded glass card.
           A sticky bar's job is to stay tappable, and translucency just lets the
           table figures underneath bleed into the button label. */
        <div className="fixed inset-x-0 bottom-0 z-40 border-t border-white/[0.09] bg-ink-950/95 p-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] backdrop-blur-md sm:hidden">
          <button
            onClick={() => navigate('/login?mode=register')}
            className="btn btn-primary h-11 w-full text-[13px]"
          >
            {t('landing.ctaButton')}
          </button>
        </div>
      )}
    </>
  )
}
