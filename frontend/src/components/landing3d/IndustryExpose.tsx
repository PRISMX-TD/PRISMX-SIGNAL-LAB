// 行业解剖：信号群 7 大黑手法 → 燃烧卡片翻转揭露诚实镜像
// Industry expose: 7 dark tricks of signal groups → burning cards flip to reveal honest mirrors
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import gsap from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'

gsap.registerPlugin(ScrollTrigger)

interface Trick {
  dark: string
  mirror: string
}

function Card3D({ trick, index }: { trick: Trick; index: number }) {
  const cardRef = useRef<HTMLDivElement>(null)
  const [flipped, setFlipped] = useState(false)

  useEffect(() => {
    const el = cardRef.current
    if (!el) return

    const st = ScrollTrigger.create({
      trigger: el,
      start: 'top 78%',
      onEnter: () => {
        setFlipped(true)
        gsap.fromTo(
          el,
          { rotateY: 0, scale: 0.92, opacity: 0.5 },
          {
            rotateY: 180,
            scale: 1,
            opacity: 1,
            duration: 1.1,
            delay: index * 0.12,
            ease: 'power3.inOut',
          },
        )
      },
      once: true,
    })

    return () => st.kill()
  }, [index])

  return (
    <div
      ref={cardRef}
      className="group relative h-[180px] w-full"
      style={{ perspective: '1200px', transformStyle: 'preserve-3d' }}
    >
      {/* 烧焦粒子伪元素（通过 CSS 动画模拟燃烧）*/}
      <div className={`absolute -inset-4 z-0 transition-opacity duration-700 ${flipped ? 'opacity-100' : 'opacity-0'}`}>
        {[...Array(8)].map((_, i) => (
          <span
            key={i}
            className="absolute h-2 w-2 rounded-full bg-orange-500/70 animate-pulse"
            style={{
              left: `${20 + Math.random() * 60}%`,
              top: `${10 + Math.random() * 80}%`,
              animationDelay: `${i * 0.15}s`,
              animationDuration: `${1.5 + Math.random() * 2}s`,
            }}
          />
        ))}
      </div>

      {/* 卡片正面：黑手法 / front: dark trick */}
      <div
        className="absolute inset-0 z-10 rounded-card border border-white/10 bg-ink-800 p-5"
        style={{ backfaceVisibility: 'hidden' }}
      >
        <div className="mb-2 flex items-center gap-2">
          <span className="rounded-full bg-down/20 px-2 py-0.5 text-[10px] font-bold text-down">TRICK #{index + 1}</span>
        </div>
        <p className="text-sm leading-relaxed text-slate-300">{trick.dark}</p>
      </div>

      {/* 卡片背面：诚实镜像 / back: honest mirror */}
      <div
        className="absolute inset-0 z-10 rounded-card border border-prism-500/30 bg-ink-700 p-5"
        style={{ backfaceVisibility: 'hidden', transform: 'rotateY(180deg)' }}
      >
        <div className="mb-2 flex items-center gap-2">
          <span className="rounded-full bg-up/20 px-2 py-0.5 text-[10px] font-bold text-up">OUR WAY</span>
        </div>
        <p className="text-sm leading-relaxed text-slate-100">{trick.mirror}</p>
        <div className="mt-3 flex items-center gap-1.5 text-[10px] text-prism-300">
          <span className="h-1 w-1 rounded-full bg-prism-400" />
          PRISMX
        </div>
      </div>
    </div>
  )
}

export default function IndustryExpose() {
  const { t } = useTranslation()

  const tricks: Trick[] = [
    { dark: t('landing.expDark1'), mirror: t('landing.expMirror1') },
    { dark: t('landing.expDark2'), mirror: t('landing.expMirror2') },
    { dark: t('landing.expDark3'), mirror: t('landing.expMirror3') },
    { dark: t('landing.expDark4'), mirror: t('landing.expMirror4') },
    { dark: t('landing.expDark5'), mirror: t('landing.expMirror5') },
    { dark: t('landing.expDark6'), mirror: t('landing.expMirror6') },
    { dark: t('landing.expDark7'), mirror: t('landing.expMirror7') },
  ]

  return (
    <section id="compare" className="relative mx-auto max-w-7xl scroll-mt-20 px-4 py-20 sm:px-6">
      {/* 背景柔光 / glow */}
      <div className="pointer-events-none absolute -top-40 left-1/2 h-[500px] w-[500px] -translate-x-1/2 rounded-full bg-prism-600/8 blur-[150px]" />

      <div className="reveal mb-16 text-center">
        <span className="eyebrow">{t('landing.expEyebrow')}</span>
        <h2 className="mt-3 font-display text-3xl font-bold text-slate-50 sm:text-4xl">
          {t('landing.expTitle')}
        </h2>
        <p className="mx-auto mt-3 max-w-xl text-slate-400">{t('landing.expSubtitle')}</p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {tricks.map((trick, i) => (
          <Card3D key={i} trick={trick} index={i} />
        ))}
        {/* 第 7 张卡片独占一行居中 / 7th card centered */}
        <div className="sm:col-span-2 lg:col-span-3 xl:col-span-4 flex justify-center">
          <div className="w-full max-w-sm">
            <Card3D trick={tricks[6]} index={6} />
          </div>
        </div>
      </div>

      <p className="mt-10 text-center text-xs text-slate-500">{t('landing.expNote')}</p>
    </section>
  )
}
