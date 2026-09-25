// 落地页问候条 / landing ribbon
//
// 重的实现：页面用的是轻壳 FestivalRibbon.tsx，节日窗口内才经 heavy.ts 动态加载这里。
// Heavy implementation: pages use the light shell FestivalRibbon.tsx, which loads this
// module (via heavy.ts) only inside a festival window.
//
// 顶栏最上方的一条细横幅：节日小图标 + 问候 + 关闭。底边是节日三色的光谱线，
// 和导航里那条品牌光谱线是同一个图形语言。
// A slim strip above the landing nav: festival icon, greeting, close. Its
// bottom edge is the spectral rule in festival colours — the same graphic
// language as the brand's own spectral rule.
import { useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useFestivalOptional } from './FestivalProvider'
import { icon } from './art'
import { loadGsap } from './motion'
import SvgArt from './SvgArt'
import './festival.css'

export default function FestivalRibbon() {
  const { t } = useTranslation()
  const f = useFestivalOptional()
  const ref = useRef<HTMLDivElement>(null)
  const key = f ? f.festival : null
  const html = useMemo(() => (key ? icon(key) : ''), [key])
  const show = !!f && !!key && f.greetingOpen

  useEffect(() => {
    const el = ref.current
    if (!show || !el || !f || f.reducedMotion) return
    let kill: (() => void) | null = null
    let alive = true
    loadGsap().then((gsap) => {
      if (!alive) return
      const tl = gsap.timeline({ delay: 0.3 })
      tl.from(el, { height: 0, duration: 0.5, ease: 'power3.out', clearProps: 'height' })
        .from(el.querySelectorAll('.fa-ribbon-row > *'), { y: 8, opacity: 0, duration: 0.5, stagger: 0.06, ease: 'power3.out' }, 0.15)
        .from(el.querySelector('.fa-rule'), { scaleX: 0, transformOrigin: '50% 50%', duration: 0.9, ease: 'expo.out' }, 0.2)
      kill = () => tl.kill()
    })
    return () => {
      alive = false
      if (kill) kill()
    }
  }, [show, key, f && f.replay, f && f.reducedMotion])

  if (!show || !f || !key) return null

  const close = () => {
    const el = ref.current
    if (!el || f.reducedMotion) return f.dismissGreeting()
    loadGsap().then((gsap) => {
      gsap.to(el, { height: 0, opacity: 0, duration: 0.35, ease: 'power3.inOut', onComplete: () => f.dismissGreeting() })
    })
  }

  return (
    <div ref={ref} className="fa-ribbon" style={{ overflow: 'hidden' }}>
      <div className="fa-ribbon-row">
        <SvgArt html={html} surface="icon" artKey={key} reduced={f.reducedMotion} replay={f.replay} />
        <b>{t(`festival.greeting.${key}`)}</b>
        {key === 'newyear' && <span className="fa-ribbon-sub">{t('festival.newYearSub', { year: f.newYear })}</span>}
        <button type="button" className="fa-ribbon-close" onClick={close} aria-label={t('festival.close')}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>
      <span className="fa-rule">
        <i />
      </span>
    </div>
  )
}
