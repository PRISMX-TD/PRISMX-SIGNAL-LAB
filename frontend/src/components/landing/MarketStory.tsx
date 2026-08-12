// 第二幕：判定走廊 / act II, the verdict corridor
//
// 这一幕的 3D 不在本文件里——它属于 LandingSpace.ts 那个贯穿全页的世界，本文件
// 只负责两件事：给那台相机一段可滚动的行程，以及在行程上按拍子放出四条规则的
// 文字。分工的理由是可退化性：WebGL 起不来、用户开了减少动态、或者搜索引擎抓
// 原始 HTML 时，这四条规则依然是四段完整可读的正文，一个字不少。3D 是它们的
// 背景，不是它们的载体。
//
// 文案全部复用既有的 wr* 键（上一版被砍掉的「判定规则」分区留下的），因此这一
// 幕没有引入任何一句未翻译的新文案，反而把当时丢掉的一段实质内容接了回来。
//
// The 3D for this act does not live here - it belongs to the page-wide world in
// LandingSpace.ts. This file only supplies a scrollable run for that camera and
// beats out the four rules along it. The split is about graceful degradation: if
// WebGL fails, if reduced-motion is on, or if a crawler reads the raw HTML, the
// four rules are still four complete paragraphs. The 3D is their backdrop, never
// their carrier.
//
// Every string reuses the existing wr* keys left behind by the verdict section
// that the previous revision cut, so this act adds no untranslated copy and in
// fact restores substantive content that had been lost.
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'

const BEATS = 5

export default function MarketStory() {
  const { t } = useTranslation()
  const root = useRef<HTMLElement>(null)
  const [active, setActive] = useState(0)

  /* 判幕与叙事区的 steps 模式同构：视口中线附近一条窄带，任一时刻恰好一个哨兵
     命中。这里不需要第二套机制——本幕没有 GSAP，相机由 LandingSpace 自己按滚动
     位置算，文字由 CSS 过渡完成，两者各自独立、不用同步。
     Scene detection mirrors the story's steps mode: a thin band at the viewport
     midline where exactly one sentinel matches. No second mechanism is needed -
     this act has no GSAP at all, the camera derives its own position from scroll
     inside LandingSpace and the type is handled by CSS transitions, so there is
     nothing to keep in sync. */
  useEffect(() => {
    const el = root.current
    if (!el) return
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) setActive(Number((e.target as HTMLElement).dataset.step))
        })
      },
      { rootMargin: '-46% 0px -46% 0px', threshold: 0 }
    )
    el.querySelectorAll('.story-step').forEach((s) => io.observe(s))
    return () => io.disconnect()
  }, [])

  const rules = [1, 2, 3, 4] as const

  return (
    <section ref={root} id="verdict" className="story-root mkt-section">
      <div className="mkt-stage">
        {/* 拍 0：标题。「我们的胜率是行情判的」这句话与身后那条走廊是同一个
            论点的两种说法——一句是主张，一条是证据。
            Beat 0. "The market scores our win rate" and the corridor behind it are
            the same argument stated twice: once as a claim, once as evidence. */}
        <div className={`story-panel panel-l ${active === 0 ? 'on' : ''}`} data-panel="mkt0">
          <div className="panel-inner">
            <p className="text-[11.5px] uppercase tracking-[0.16em] text-prism-400">{t('landing.wrEyebrow')}</p>
            <h2 className="mt-4 font-display-xl text-[clamp(1.9rem,4.8vw,2.9rem)] text-white">
              {t('landing.wrTitle')}
            </h2>
            <p className="mt-4 max-w-[46ch] text-[13.5px] leading-relaxed text-neutral-400 sm:text-[14.5px]">
              {t('landing.wrSubtitle')}
            </p>
          </div>
        </div>

        {/* 拍 1-4：四条规则。序号用等宽体，与走廊里第几段一一对应。
            Beats 1-4, one rule each. The numeral is monospaced and matches the
            corridor segment you are flying through. */}
        {rules.map((n, i) => (
          <div
            key={n}
            className={`story-panel panel-l ${active === i + 1 ? 'on' : ''}`}
            data-panel={`mkt${n}`}
          >
            <div className="panel-inner">
              <p className="num text-[12px] tracking-[0.2em] text-neutral-500">
                {String(n).padStart(2, '0')} / 04
              </p>
              <h3 className="mt-4 max-w-[20ch] font-display-xl text-[clamp(1.45rem,3.4vw,2.05rem)] leading-tight text-white">
                {t(`landing.wrRule${n}`)}
              </h3>
              <p className="mt-4 max-w-[42ch] text-[13.5px] leading-relaxed text-neutral-400 sm:text-[14px]">
                {t(`landing.wrRule${n}Note`)}
              </p>
            </div>
          </div>
        ))}

        <div className="story-ticks" aria-hidden>
          {Array.from({ length: BEATS }, (_, i) => (
            <span
              key={i}
              className={`js-tick transition-colors duration-300 ${active === i ? 'bg-prism-500' : 'bg-white/15'}`}
            />
          ))}
        </div>
      </div>

      {Array.from({ length: BEATS }, (_, i) => (
        <div key={i} className="story-step" data-step={i} style={{ top: `${i * 20}%` }} aria-hidden />
      ))}
    </section>
  )
}

/* 出走廊后的落点：相机在这里拔升脱离，页面同时交回一段安静的常规排版。
   一路飞完四条规则之后需要一个「停」，而不是直接接上定价。
   Where the flight lands: the camera pulls up and out here while the page hands
   back to ordinary, quiet typography. Four rules at speed need a stop before
   pricing, not a cut. */
export function MarketOutro() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  return (
    <section className="mx-auto w-full max-w-[1240px] px-5 pb-4 pt-16 sm:px-8 sm:pt-24">
      <div className="rule-spectral mb-10">
        <i />
      </div>
      <div className="grid grid-cols-1 items-end gap-8 lg:grid-cols-12">
        <p className="max-w-[62ch] text-[14px] leading-relaxed text-neutral-400 lg:col-span-7">
          {t('landing.wrNote')}
        </p>
        <div className="lg:col-span-4 lg:col-start-9">
          <button
            onClick={() => navigate('/login?mode=register')}
            className="btn btn-ghost h-11 w-full text-[14px]"
          >
            {t('landing.wrCta')}
          </button>
        </div>
      </div>
    </section>
  )
}
