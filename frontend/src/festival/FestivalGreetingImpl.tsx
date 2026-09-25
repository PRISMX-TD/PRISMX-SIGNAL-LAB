// App 问候卡 / in-app greeting card
//
// 重的实现：页面用的是轻壳 FestivalGreeting.tsx，节日窗口内才经 heavy.ts 动态加载这里。
// Heavy implementation: pages use the light shell FestivalGreeting.tsx, which loads this
// module (via heavy.ts) only inside a festival window.
//
// 放在内容区最上方、路由切换容器之外：换页时它不重播入场，只在第一次出现时
// 滑入。关掉时高度收起，下面的内容平滑上移，而不是一下子跳上去。
// Sits at the top of the content area, outside the per-route wrapper, so it
// does not replay on navigation — it slides in once. Closing collapses its
// height so the content below glides up instead of jumping.
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useFestival } from './FestivalProvider'
import { icon } from './art'
import { loadGsap } from './motion'
import SvgArt from './SvgArt'
import './festival.css'

export default function FestivalGreeting() {
  const { t } = useTranslation()
  const f = useFestival()
  const wrap = useRef<HTMLDivElement>(null)
  const [closing, setClosing] = useState(false)
  const key = f.festival
  const html = useMemo(() => (key ? icon(key) : ''), [key])
  const show = !!key && f.greetingOpen

  // 入场：从上方 12px、透明，高度从 0 展开。/ entrance: drop 12px, fade, height from 0
  useEffect(() => {
    const el = wrap.current
    if (!show || !el) return
    setClosing(false)
    if (f.reducedMotion) return
    let kill: (() => void) | null = null
    let alive = true
    el.style.opacity = '0'
    loadGsap().then((gsap) => {
      if (!alive) return
      el.style.opacity = ''
      const tl = gsap.timeline()
      tl.from(el, { height: 0, marginBottom: 0, duration: 0.55, ease: 'power3.out', clearProps: 'height,marginBottom' })
        .from(el.querySelector('.fa-greet-card'), { y: -12, opacity: 0, duration: 0.6, ease: 'power3.out' }, 0.08)
      kill = () => tl.kill()
    })
    return () => {
      alive = false
      el.style.opacity = ''
      if (kill) kill()
    }
  }, [show, key, f.replay, f.reducedMotion])

  if (!show) return null

  const close = () => {
    const el = wrap.current
    if (!el || f.reducedMotion) {
      f.dismissGreeting()
      return
    }
    setClosing(true)
    loadGsap().then((gsap) => {
      gsap
        .timeline({ onComplete: () => f.dismissGreeting() })
        .to(el.querySelector('.fa-greet-card'), { opacity: 0, scale: 0.98, y: -6, duration: 0.22, ease: 'power2.in' })
        .to(el, { height: 0, marginBottom: 0, duration: 0.38, ease: 'power3.inOut' }, 0.12)
    })
  }

  return (
    <div ref={wrap} className="fa-greet" style={{ overflow: 'hidden' }}>
      <div className="fa-greet-card" role="status">
        <SvgArt html={html} surface="icon" artKey={key} reduced={f.reducedMotion} replay={f.replay} />
        <div className="min-w-0">
          <span className="fa-greet-t">{t(`festival.greeting.${key}`)}</span>
          <span className="fa-greet-d">
            {t('festival.greetHintA')}
            <Link to="/account#festival">{t('festival.greetHintLink')}</Link>
            {t('festival.greetHintB')}
          </span>
        </div>
        <button type="button" className="fa-greet-close" onClick={close} disabled={closing} aria-label={t('festival.close')}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>
    </div>
  )
}
