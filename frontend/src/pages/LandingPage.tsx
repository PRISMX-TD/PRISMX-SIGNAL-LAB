// PRISMX Signal Lab · Parallax Explosion · GSAP ScrollTrigger
import { useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import gsap from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import Logo from '../components/Logo'
import LanguageToggle from '../components/LanguageToggle'
import FaqSection from '../components/landing/FaqSection'
import MobileStickyCta from '../components/landing/MobileStickyCta'

gsap.registerPlugin(ScrollTrigger)

/* ═════════════════════════ 视差层组件 ═════════════════════════ */
function ParallaxLayer({ speed, className, children }: { speed: number; className?: string; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    gsap.to(el, {
      y: () => window.innerHeight * speed * 0.5,
      ease: 'none',
      scrollTrigger: { trigger: el.parentElement!, start: 'top bottom', end: 'bottom top', scrub: true },
    })
  }, [speed])
  return <div ref={ref} className={className}>{children}</div>
}

/* ═════════════════════════ 滚动浮动入场 ═════════════════════════ */
function Reveal({ children, className = '', delay = 0, from = 'bottom' }: { children: React.ReactNode; className?: string; delay?: number; from?: 'left' | 'right' | 'bottom' | 'scale' }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const dirs: Record<string, gsap.TweenVars> = {
      bottom: { y: 60, opacity: 0 },
      left: { x: -80, opacity: 0 },
      right: { x: 80, opacity: 0 },
      scale: { scale: 0.8, opacity: 0 },
    }
    gsap.fromTo(el, dirs[from] || dirs.bottom, {
      y: 0, x: 0, scale: 1, opacity: 1, duration: 0.9, delay, ease: 'power3.out',
      scrollTrigger: { trigger: el, start: 'top 85%', toggleActions: 'play none none none' },
    })
  }, [from, delay])
  return <div ref={ref} className={className}>{children}</div>
}

/* ═════════════════════════ 交互悬浮卡片 ═════════════════════════ */
function HoverCard({ children, glow = false }: { children: React.ReactNode; glow?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onMove = (e: MouseEvent) => {
      const r = el.getBoundingClientRect()
      const x = (e.clientX - r.left) / r.width - 0.5
      const y = (e.clientY - r.top) / r.height - 0.5
      gsap.to(el, { rotateY: x * 8, rotateX: -y * 8, scale: 1.03, duration: 0.4, ease: 'power2.out' })
      if (glow) el.style.boxShadow = `0 15px 40px rgba(139,92,246,${0.08 + Math.abs(x + y) * 0.06}), 0 0 2px rgba(139,92,246,0.1)`
    }
    const onLeave = () => {
      gsap.to(el, { rotateY: 0, rotateX: 0, scale: 1, duration: 0.5, ease: 'power2.out' })
      if (glow) el.style.boxShadow = ''
    }
    el.addEventListener('mousemove', onMove)
    el.addEventListener('mouseleave', onLeave)
    return () => { el.removeEventListener('mousemove', onMove); el.removeEventListener('mouseleave', onLeave) }
  }, [glow])
  return (
    <div ref={ref} className="rounded-2xl border border-white/[0.06] bg-[#0B0B12]/80 backdrop-blur-md p-6 transition-colors duration-300 hover:border-white/[0.12]" style={{ perspective: '800px', transformStyle: 'preserve-3d' }}>
      {children}
    </div>
  )
}

/* ═════════════════════════ 导航 ═════════════════════════ */
function Navbar({ t, navigate }: { t: (k: string) => string; navigate: ReturnType<typeof useNavigate> }) {
  const ref = useRef<HTMLElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onScroll = () => { if (el) el.style.borderBottom = window.scrollY > 30 ? '1px solid rgba(255,255,255,0.05)' : '1px solid transparent' }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])
  return (
    <header ref={ref} className="fixed inset-x-0 top-0 z-50 bg-black/60 backdrop-blur-2xl transition-colors border-b border-transparent">
      <div className="mx-auto flex h-14 max-w-[1200px] items-center gap-6 px-5">
        <a href="#" className="flex items-center gap-2.5"><Logo size={26} /><span className="text-sm font-semibold">PRISMX</span><span className="text-[10px] uppercase tracking-[0.2em] text-neutral-600">Signal Lab</span></a>
        <nav className="ml-2 hidden items-center gap-1 md:flex">
          {[{ h: '#showcase', k: 'navShowcase' }, { h: '#guard', k: 'navWinrate' }, { h: '#pricing', k: 'navPricing' }, { h: '#faq', k: 'navFaq' }].map(l => <a key={l.h} href={l.h} className="rounded-md px-3 py-2 text-[13px] text-neutral-500 transition-colors hover:text-white">{t(`landing.${l.k}`)}</a>)}
        </nav>
        <div className="ml-auto flex items-center gap-2"><LanguageToggle /><a href="/login" className="rounded-md px-3 py-2 text-[13px] text-neutral-500 transition-colors hover:text-white">{t('landing.signIn')}</a><button onClick={() => navigate('/login?mode=register')} className="rounded-lg bg-violet-500 px-4 py-2 text-[13px] font-semibold text-white transition-all hover:bg-violet-400 hover:scale-105">{t('landing.getStarted')}</button></div>
      </div>
    </header>
  )
}

/* ═════════════════════════ Hero 视差层 ═════════════════════════ */
function Hero({ t, navigate }: { t: (k: string) => string; navigate: ReturnType<typeof useNavigate> }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const titleRef = useRef<HTMLHeadingElement>(null)
  const subRef = useRef<HTMLParagraphElement>(null)
  const ctaRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const tl = gsap.timeline({ defaults: { ease: 'power3.out' } })
    tl.fromTo(titleRef.current, { y: 80, opacity: 0 }, { y: 0, opacity: 1, duration: 1 })
      .fromTo(subRef.current, { y: 40, opacity: 0 }, { y: 0, opacity: 1, duration: 0.8 }, '-=0.5')
      .fromTo(ctaRef.current, { y: 30, opacity: 0 }, { y: 0, opacity: 1, duration: 0.7 }, '-=0.4')
  }, [])

  return (
    <section ref={containerRef} className="relative flex min-h-[100vh] flex-col items-center justify-center overflow-hidden px-5 text-center" style={{ perspective: '1200px' }}>
      {/* Layer 1: 深空背景 (最慢) */}
      <ParallaxLayer speed={-0.15} className="absolute inset-0">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_70%_50%_at_50%_30%,#1a1040_0%,transparent_55%)] opacity-40" />
        <div className="absolute inset-0" style={{ backgroundImage: 'radial-gradient(1px 1px at 20% 30%, rgba(255,255,255,0.15), transparent), radial-gradient(1px 1px at 50% 70%, rgba(255,255,255,0.1), transparent), radial-gradient(1.5px 1.5px at 80% 20%, rgba(255,255,255,0.12), transparent), radial-gradient(1px 1px at 40% 60%, rgba(255,255,255,0.08), transparent), radial-gradient(1px 1px at 70% 80%, rgba(255,255,255,0.1), transparent)' }} />
      </ParallaxLayer>

      {/* Layer 2: 浮动的光球 (中速) */}
      <ParallaxLayer speed={-0.3} className="absolute inset-0 pointer-events-none">
        <div className="absolute left-[10%] top-[20%] h-[300px] w-[300px] rounded-full bg-violet-600/15 blur-[100px] animate-[float_8s_ease-in-out_infinite]" />
        <div className="absolute right-[5%] top-[50%] h-[250px] w-[250px] rounded-full bg-cyan-500/10 blur-[80px] animate-[float_10s_ease-in-out_infinite_2s]" />
        <div className="absolute left-[50%] bottom-[10%] h-[200px] w-[200px] rounded-full bg-fuchsia-500/8 blur-[90px] animate-[float_12s_ease-in-out_infinite_4s]" />
      </ParallaxLayer>

      {/* Layer 3: 几何线条 (稍快) */}
      <ParallaxLayer speed={-0.45} className="absolute inset-0 pointer-events-none opacity-20">
        <div className="absolute left-[5%] top-[15%] h-[1px] w-[200px] rotate-12 bg-gradient-to-r from-transparent via-violet-400 to-transparent" />
        <div className="absolute right-[10%] top-[35%] h-[1px] w-[160px] -rotate-6 bg-gradient-to-r from-transparent via-cyan-400 to-transparent" />
        <div className="absolute left-[20%] bottom-[25%] h-[1px] w-[180px] rotate-3 bg-gradient-to-r from-transparent via-violet-300 to-transparent" />
      </ParallaxLayer>

      {/* Layer 4: 文字内容 (正常速度, 在最前) */}
      <div className="relative z-10">
        <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-4 py-1.5 backdrop-blur">
          <span className="h-1.5 w-1.5 rounded-full bg-violet-400 animate-pulse" />
          <span className="text-[11px] text-neutral-400">{t('landing.badge')}</span>
        </div>

        <h1 ref={titleRef} className="mx-auto max-w-4xl font-display text-5xl font-black leading-[1.06] tracking-[-0.03em] sm:text-6xl md:text-7xl lg:text-8xl">
          <span className="bg-gradient-to-b from-white via-white to-neutral-400 bg-clip-text text-transparent">{t('landing.heroTitle1')}</span>
          <br />
          <span className="bg-gradient-to-r from-violet-300 via-violet-400 to-cyan-300 bg-clip-text text-transparent">{t('landing.heroTitle2')}</span>
        </h1>

        <p ref={subRef} className="mx-auto mt-6 max-w-xl text-base leading-relaxed text-neutral-400 sm:text-lg">{t('landing.heroSubtitle')}</p>

        <div ref={ctaRef} className="mt-10 flex flex-col items-center gap-3 sm:flex-row sm:justify-center">
          <button onClick={() => navigate('/login?mode=register')} className="group relative overflow-hidden rounded-xl bg-violet-500 px-8 py-3.5 text-[15px] font-bold text-white transition-all hover:bg-violet-400 hover:scale-105 hover:shadow-[0_0_40px_rgba(139,92,246,0.35)]">
            <span className="relative z-10">{t('landing.ctaPrimary')}</span>
            <div className="absolute inset-0 -translate-x-full group-hover:translate-x-0 transition-transform duration-500 bg-gradient-to-r from-transparent via-white/10 to-transparent" />
          </button>
          <a href="#showcase" className="text-[14px] text-neutral-500 underline-offset-4 transition hover:text-neutral-300 hover:underline">{t('landing.ctaSecondary')}</a>
        </div>
        <p className="mt-4 text-[13px] text-neutral-600">{t('landing.heroNote')}</p>
      </div>
    </section>
  )
}

/* ═════════════════════════ Stats ═════════════════════════ */
function Stats({ t }: { t: (k: string) => string }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    gsap.fromTo('.stat-card', { y: 60, opacity: 0, scale: 0.9 }, { y: 0, opacity: 1, scale: 1, duration: 0.8, stagger: 0.12, ease: 'back.out(1.5)', scrollTrigger: { trigger: el, start: 'top 80%' } })
  }, [])
  return (
    <section ref={ref} className="mx-auto max-w-[1200px] px-5 pb-24">
      <div className="grid grid-cols-3 gap-4">
        {[{ k: 'stat1', v: '0' }, { k: 'stat2', v: '24/7' }, { k: 'stat3', v: '100%' }].map(s => (
          <div key={s.k} className="stat-card rounded-2xl border border-white/[0.06] bg-white/[0.02] px-5 py-7 text-center backdrop-blur">
            <div className="text-3xl font-black sm:text-4xl">{s.v}</div>
            <div className="mt-1.5 text-[13px] text-neutral-500">{t(`landing.${s.k}`)}</div>
          </div>
        ))}
      </div>
    </section>
  )
}

/* ═════════════════════════ 产品轮播展示区（Sticky Pin） ═════════════════════════ */
function Showcase({ t }: { t: (k: string) => string }) {
  const sectionRef = useRef<HTMLDivElement>(null)
  const cardRefs = useRef<(HTMLDivElement | null)[]>([])

  useEffect(() => {
    const section = sectionRef.current
    if (!section) return
    const cards = cardRefs.current.filter(Boolean) as HTMLDivElement[]

    cards.forEach((card, i) => {
      gsap.fromTo(card, { opacity: 0, x: i % 2 === 0 ? -100 : 100, rotateY: i % 2 === 0 ? 15 : -15 }, {
        opacity: 1, x: 0, rotateY: 0, duration: 1, ease: 'power3.out',
        scrollTrigger: { trigger: card, start: 'top 75%', toggleActions: 'play none none none' },
      })
    })
  }, [])

  const steps = [
    { n: '01', title: 'plStep1Title', desc: 'plStep1Desc', icon: '⚡' },
    { n: '02', title: 'plStep2Title', desc: 'plStep2Desc', icon: '→' },
    { n: '03', title: 'plStep3Title', desc: 'plStep3Desc', icon: '✓' },
  ]

  return (
    <section ref={sectionRef} id="showcase" className="mx-auto max-w-[900px] scroll-mt-20 px-5 pb-24">
      <Reveal className="mb-16 text-center" from="scale">
        <p className="text-[11px] font-medium uppercase tracking-[0.2em] text-violet-400">{t('landing.plEyebrow')}</p>
        <h2 className="mt-3 font-display text-3xl font-black tracking-[-0.02em] sm:text-4xl">{t('landing.plTitle')}</h2>
      </Reveal>

      <div className="relative space-y-6">
        <div className="absolute left-7 top-0 hidden h-full w-px bg-gradient-to-b from-violet-500/50 via-transparent to-violet-500/50 sm:block" />
        {steps.map((s, i) => (
          <div key={s.n} ref={el => { cardRefs.current[i] = el }} className="flex gap-5 sm:gap-8">
            <div className="relative z-10 flex h-14 w-14 flex-shrink-0 items-center justify-center rounded-2xl border border-white/[0.08] bg-black text-xl backdrop-blur shadow-[0_0_20px_rgba(139,92,246,0.15)]">{s.icon}</div>
            <HoverCard>
              <span className="font-mono text-[10px] font-bold text-violet-500">{s.n}</span>
              <h3 className="mt-2 text-lg font-bold">{t(`landing.${s.title}`)}</h3>
              <p className="mt-1.5 text-[14px] leading-relaxed text-neutral-400">{t(`landing.${s.desc}`)}</p>
            </HoverCard>
          </div>
        ))}
      </div>

      <Reveal className="mt-10 text-center" from="scale">
        <p className="text-sm text-neutral-500">{t('landing.plFootnote')}</p>
        <p className="mt-2 font-mono text-lg font-bold text-violet-400">{t('landing.plCounter')}</p>
      </Reveal>
    </section>
  )
}

/* ═════════════════════════ 三项哨兵 ═════════════════════════ */
function Guard({ t }: { t: (k: string) => string }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    gsap.fromTo('.guard-card', { y: 80, opacity: 0 }, { y: 0, opacity: 1, duration: 0.8, stagger: 0.15, ease: 'back.out(1.4)', scrollTrigger: { trigger: ref.current, start: 'top 78%' } })
  }, [])
  return (
    <section ref={ref} id="guard" className="mx-auto max-w-[1200px] scroll-mt-20 px-5 pb-24">
      <Reveal className="mb-16 text-center" from="scale">
        <p className="text-[11px] font-medium uppercase tracking-[0.2em] text-violet-400">{t('landing.deEyebrow')}</p>
        <h2 className="mt-3 font-display text-3xl font-black tracking-[-0.02em] sm:text-4xl">{t('landing.deTitle')}</h2>
        <p className="mt-3 text-sm text-neutral-500">{t('landing.deSubtitle')}</p>
      </Reveal>

      <div className="grid grid-cols-1 gap-5 md:grid-cols-3">
        {[
          { n: '01', t: 'dc1Title', d: 'dc1', acc: 'border-l-red-500', l: '#EF4444' },
          { n: '02', t: 'dc2Title', d: 'dc2', acc: 'border-l-violet-500', l: '#8B5CF6' },
          { n: '03', t: 'dc3Title', d: 'dc3', acc: 'border-l-emerald-500', l: '#22C55E' },
        ].map(g => (
          <div key={g.n} className="guard-card">
            <HoverCard glow>
              <div className={`border-l-2 ${g.acc} pl-4`}>
                <div className="font-mono text-2xl font-black text-white/5">{g.n}</div>
                <h3 className="mt-2 text-lg font-bold">{t(`landing.${g.t}`)}</h3>
                <p className="mt-2 text-[14px] leading-relaxed text-neutral-400">{t(`landing.${g.d}`)}</p>
              </div>
            </HoverCard>
          </div>
        ))}
      </div>
    </section>
  )
}

/* ═════════════════════════ 7 Truths ═════════════════════════ */
function Truths({ t }: { t: (k: string) => string }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    gsap.fromTo('.truth-card', { y: 60, opacity: 0, rotateX: 5 }, { y: 0, opacity: 1, rotateX: 0, duration: 0.7, stagger: 0.06, ease: 'power2.out', scrollTrigger: { trigger: ref.current, start: 'top 78%' } })
  }, [])
  return (
    <section ref={ref} className="mx-auto max-w-[1200px] scroll-mt-20 px-5 pb-24">
      <Reveal className="mb-16 text-center" from="scale">
        <p className="text-[11px] font-medium uppercase tracking-[0.2em] text-violet-400">{t('landing.expEyebrow')}</p>
        <h2 className="mt-3 font-display text-3xl font-black tracking-[-0.02em] sm:text-4xl">{t('landing.expTitle')}</h2>
      </Reveal>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {[
          ['expDark1', 'expMirror1'], ['expDark2', 'expMirror2'], ['expDark3', 'expMirror3'],
          ['expDark4', 'expMirror4'], ['expDark5', 'expMirror5'], ['expDark6', 'expMirror6'],
        ].map(([d, m], i) => (
          <div key={i} className="truth-card">
            <HoverCard>
              <span className="rounded-md bg-red-500/10 px-2 py-0.5 text-[10px] font-bold text-red-400">TRICK #{i + 1}</span>
              <p className="mt-3 text-[13px] leading-relaxed text-neutral-400">{t(`landing.${d}`)}</p>
              <div className="my-3 h-px bg-gradient-to-r from-violet-500/30 to-transparent" />
              <p className="text-[13px] leading-relaxed">{t(`landing.${m}`)}</p>
            </HoverCard>
          </div>
        ))}
      </div>

      <Reveal className="mt-4 flex justify-center" from="scale">
        <div className="w-full max-w-md">
          <HoverCard>
            <span className="rounded-md bg-red-500/10 px-2 py-0.5 text-[10px] font-bold text-red-400">TRICK #7</span>
            <p className="mt-3 text-[13px] leading-relaxed text-neutral-400">{t('landing.expDark7')}</p>
            <div className="my-3 h-px bg-gradient-to-r from-violet-500/30 to-transparent" />
            <p className="text-[13px] leading-relaxed">{t('landing.expMirror7')}</p>
          </HoverCard>
        </div>
      </Reveal>
    </section>
  )
}

/* ═════════════════════════ Pricing ═════════════════════════ */
function Pricing({ t, navigate }: { t: (k: string) => string; navigate: ReturnType<typeof useNavigate> }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    gsap.fromTo('.price-card', { y: 80, opacity: 0 }, { y: 0, opacity: 1, duration: 0.9, stagger: 0.2, ease: 'back.out(1.3)', scrollTrigger: { trigger: ref.current, start: 'top 78%' } })
  }, [])
  return (
    <section ref={ref} id="pricing" className="mx-auto max-w-[900px] scroll-mt-20 px-5 pb-24">
      <Reveal className="mb-16 text-center" from="scale">
        <p className="text-[11px] font-medium uppercase tracking-[0.2em] text-violet-400">{t('landing.tdEyebrow')}</p>
        <h2 className="mt-3 font-display text-3xl font-black tracking-[-0.02em] sm:text-4xl">{t('landing.tdTitle')}</h2>
      </Reveal>

      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
        <div className="price-card">
          <HoverCard>
            <div className="text-center py-2">
              <p className="text-[11px] uppercase tracking-wider text-neutral-500">{t('landing.tdDoorA')}</p>
              <div className="mt-3 font-display text-5xl font-black">$49</div>
              <p className="mt-1 text-sm text-neutral-500">{t('landing.tdPerMonth')}</p>
              <p className="mt-4 text-[14px] leading-relaxed text-neutral-400">{t('landing.tdDoorADesc')}</p>
              <button onClick={() => navigate('/login?mode=register')} className="mt-6 w-full rounded-xl border border-white/[0.08] py-2.5 text-[14px] font-semibold text-white transition-all hover:border-violet-500/30 hover:bg-violet-500/10">{t('landing.getStarted')}</button>
            </div>
          </HoverCard>
        </div>

        <div className="price-card">
          <HoverCard glow>
            <div className="relative text-center py-2">
              <div className="absolute -top-5 left-1/2 -translate-x-1/2 rounded-full bg-violet-500 px-4 py-0.5 text-[10px] font-black uppercase tracking-wider text-white shadow-[0_0_20px_rgba(139,92,246,0.4)]">RECOMMENDED</div>
              <p className="text-[11px] uppercase tracking-wider text-neutral-500">{t('landing.tdDoorB')}</p>
              <div className="mt-3 font-display text-5xl font-black">$500</div>
              <p className="mt-1 text-sm text-neutral-500">{t('landing.tdDeposit')}</p>
              <p className="mt-4 text-[14px] leading-relaxed text-neutral-400">{t('landing.tdDoorBDesc')}</p>
              <button onClick={() => navigate('/login?mode=register')} className="mt-6 w-full rounded-xl bg-violet-500 py-2.5 text-[14px] font-bold text-white transition-all hover:bg-violet-400 hover:shadow-[0_0_30px_rgba(139,92,246,0.4)]">{t('landing.getStarted')}</button>
            </div>
          </HoverCard>
        </div>
      </div>

      <Reveal className="mt-6 text-center" from="scale">
        <p className="text-[13px] text-neutral-600">{t('landing.tdFootnote')}</p>
      </Reveal>
    </section>
  )
}

/* ═════════════════════════ Footer ═════════════════════════ */
function Foot({ t }: { t: (k: string) => string }) {
  return (
    <footer className="border-t border-white/[0.04] px-5 py-8">
      <div className="mx-auto flex max-w-[1200px] flex-col items-center gap-4 sm:flex-row sm:justify-between">
        <div className="flex items-center gap-2"><Logo size={18} /><span className="text-[13px] text-neutral-500">PRISMX Signal Lab</span></div>
        <p className="text-[12px] text-neutral-700">&copy; {new Date().getFullYear()} PRISMX. {t('landing.footerRights')}</p>
      </div>
      <p className="mx-auto mt-4 max-w-[1200px] text-center text-[11px] leading-relaxed text-neutral-800 sm:text-left">{t('landing.footerRisk')}</p>
    </footer>
  )
}

/* ═════════════════════════ 主页 ═════════════════════════ */
export default function LandingPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()

  useEffect(() => { ScrollTrigger.refresh() }, [])

  return (
    <div className="min-h-screen bg-black text-white">
      <Navbar t={t} navigate={navigate} />

      <Hero t={t} navigate={navigate} />
      <Stats t={t} />
      <Showcase t={t} />
      <Guard t={t} />
      <Truths t={t} />
      <Pricing t={t} navigate={navigate} />

      {/* Steps */}
      <section className="mx-auto max-w-[1200px] px-5 pb-24">
        <Reveal className="mb-16 text-center" from="scale">
          <p className="text-[11px] font-medium uppercase tracking-[0.2em] text-violet-400">{t('landing.howEyebrow')}</p>
          <h2 className="mt-3 font-display text-3xl font-black tracking-[-0.02em] sm:text-4xl">{t('landing.howTitle')}</h2>
        </Reveal>
        <div className="grid grid-cols-1 gap-5 md:grid-cols-3">
          {[{ t: 'step1Title', d: 'step1Desc' }, { t: 'step2Title', d: 'step2Desc' }, { t: 'step3Title', d: 'step3Desc' }].map((h, i) => (
            <Reveal key={h.t} delay={i * 0.12} from={i === 0 ? 'left' : i === 1 ? 'bottom' : 'right'}>
              <HoverCard>
                <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-xl border border-white/[0.08] font-mono text-sm font-bold text-violet-400">{i + 1}</div>
                <h3 className="font-bold">{t(`landing.${h.t}`)}</h3>
                <p className="mt-2 text-[14px] leading-relaxed text-neutral-400">{t(`landing.${h.d}`)}</p>
              </HoverCard>
            </Reveal>
          ))}
        </div>
      </section>

      <FaqSection />

      {/* CTA */}
      <section className="mx-auto max-w-[1200px] px-5 pb-24">
        <Reveal from="scale">
          <div className="relative overflow-hidden rounded-3xl border border-white/[0.06] bg-[#0B0B12]/80 backdrop-blur-md px-8 py-16 text-center sm:px-16">
            <div className="pointer-events-none absolute -inset-1 bg-gradient-to-r from-violet-500/10 via-transparent to-cyan-500/10 blur-xl" />
            <h2 className="relative font-display text-3xl font-black tracking-[-0.02em] sm:text-4xl">{t('landing.ctaTitle')}</h2>
            <p className="relative mx-auto mt-3 max-w-md text-neutral-400">{t('landing.ctaSubtitle')}</p>
            <button onClick={() => navigate('/login?mode=register')} className="relative mt-8 group overflow-hidden rounded-xl bg-violet-500 px-8 py-3.5 text-[15px] font-bold text-white transition-all hover:bg-violet-400 hover:scale-105 hover:shadow-[0_0_40px_rgba(139,92,246,0.35)]">
              <span className="relative z-10">{t('landing.ctaButton')}</span>
              <div className="absolute inset-0 -translate-x-full group-hover:translate-x-0 transition-transform duration-500 bg-gradient-to-r from-transparent via-white/10 to-transparent" />
            </button>
            <p className="relative mt-3 text-[13px] text-neutral-600">{t('landing.ctaNote')}</p>
          </div>
        </Reveal>
      </section>

      <Foot t={t} />
      <MobileStickyCta />
    </div>
  )
}
