// PRISMX Signal Lab 首页 — 极简 · 玻璃 · 景深
// Minimal, glass-morphic, depth-layered landing page
import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import Logo from '../components/Logo'
import LanguageToggle from '../components/LanguageToggle'
import FaqSection from '../components/landing/FaqSection'
import MobileStickyCta from '../components/landing/MobileStickyCta'

/* ──────────────── 细微 Canvas 粒子背景 ──────────────── */
function ParticleField() {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const c = canvasRef.current
    if (!c) return
    const ctx = c.getContext('2d')
    if (!ctx) return

    const dpr = Math.min(window.devicePixelRatio || 1, 1.5)
    let w = 0, h = 0
    const particles: { x: number; y: number; vx: number; vy: number; r: number; o: number }[] = []

    function resize() {
      const rect = c!.getBoundingClientRect()
      w = rect.width
      h = rect.height
      c!.width = w * dpr
      c!.height = h * dpr
      ctx!.scale(dpr, dpr)
    }

    function seed() {
      resize()
      particles.length = 0
      const count = Math.floor((w * h) / 18000)
      for (let i = 0; i < count; i++) {
        particles.push({
          x: Math.random() * w,
          y: Math.random() * h,
          vx: (Math.random() - 0.5) * 0.15,
          vy: (Math.random() - 0.5) * 0.15,
          r: Math.random() * 1.2 + 0.4,
          o: Math.random() * 0.35 + 0.1,
        })
      }
    }

    seed()
    window.addEventListener('resize', seed)

    let raf = 0
    function draw() {
      ctx!.clearRect(0, 0, w, h)
      for (const p of particles) {
        p.x += p.vx
        p.y += p.vy
        if (p.x < 0) p.x = w
        if (p.x > w) p.x = 0
        if (p.y < 0) p.y = h
        if (p.y > h) p.y = 0
        ctx!.beginPath()
        ctx!.arc(p.x, p.y, p.r, 0, Math.PI * 2)
        ctx!.fillStyle = `rgba(167,139,250,${p.o})`
        ctx!.fill()
      }
      raf = requestAnimationFrame(draw)
    }
    draw()

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', seed)
    }
  }, [])

  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-none fixed inset-0 z-0"
      aria-hidden
    />
  )
}

/* ──────────────── 滚动入场动画 Hook ──────────────── */
function useReveal() {
  const ref = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const obs = new IntersectionObserver(
      ([e]) => { if (e.isIntersecting) setVisible(true) },
      { threshold: 0.12, rootMargin: '0px 0px -40px 0px' },
    )
    obs.observe(el)
    return () => obs.disconnect()
  }, [])

  return { ref, visible }
}

function Reveal({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  const { ref, visible } = useReveal()
  return (
    <div
      ref={ref}
      className={`transition-all duration-800 ease-out ${
        visible ? 'translate-y-0 opacity-100' : 'translate-y-8 opacity-0'
      } ${className}`}
    >
      {children}
    </div>
  )
}

/* ──────────────── 玻璃卡片基础 ──────────────── */
function GlassCard({
  children,
  className = '',
  hover = true,
}: {
  children: React.ReactNode
  className?: string
  hover?: boolean
}) {
  return (
    <div
      className={`rounded-2xl border border-white/10 bg-white/[0.03] backdrop-blur-md px-6 py-6 transition-all duration-400 ${
        hover ? 'hover:border-white/20 hover:bg-white/[0.05]' : ''
      } ${className}`}
      style={{ perspective: '800px', transformStyle: 'preserve-3d' }}
      onMouseMove={(e) => {
        if (!hover) return
        const rect = e.currentTarget.getBoundingClientRect()
        const x = ((e.clientX - rect.left) / rect.width - 0.5) * 4
        const y = -((e.clientY - rect.top) / rect.height - 0.5) * 4
        e.currentTarget.style.transform = `rotateX(${y}deg) rotateY(${x}deg)`
      }}
      onMouseLeave={(e) => {
        if (!hover) return
        e.currentTarget.style.transform = 'rotateX(0deg) rotateY(0deg)'
      }}
    >
      {children}
    </div>
  )
}

/* ──────────────── 主页 ──────────────── */
export default function LandingPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [scrolled, setScrolled] = useState(false)

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 80)
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  const sevenTruths = [
    { dark: 'expDark1', mirror: 'expMirror1' },
    { dark: 'expDark2', mirror: 'expMirror2' },
    { dark: 'expDark3', mirror: 'expMirror3' },
    { dark: 'expDark4', mirror: 'expMirror4' },
    { dark: 'expDark5', mirror: 'expMirror5' },
    { dark: 'expDark6', mirror: 'expMirror6' },
    { dark: 'expDark7', mirror: 'expMirror7' },
  ]

  const disciplineCards = [
    { i: '01', title: '止损锁定', tKey: 'dc1', accent: 'border-l-down/60' },
    { i: '02', title: '自动保本', tKey: 'dc2', accent: 'border-l-prism-500/60' },
    { i: '03', title: '追踪止损', tKey: 'dc3', accent: 'border-l-up/60' },
  ]

  return (
    <div className="relative min-h-screen overflow-x-clip bg-[#06050F] text-slate-200">
      <ParticleField />

      {/* ─── 导航 ─── */}
      <header
        className={`sticky top-0 z-40 transition-all duration-400 ${
          scrolled
            ? 'border-b border-white/[0.06] bg-[#06050F]/70 backdrop-blur-xl'
            : 'border-transparent'
        }`}
      >
        <div className="mx-auto flex max-w-7xl items-center gap-4 px-5 py-3.5">
          <div className="flex items-center gap-2.5">
            <Logo size={30} />
            <div className="leading-none">
              <div className="font-display text-sm font-bold tracking-[0.15em] text-white">PRISMX</div>
              <div className="text-[9px] uppercase tracking-[0.25em] text-prism-400">Signal Lab</div>
            </div>
          </div>

          <nav className="ml-6 hidden items-center gap-1 lg:flex">
            {[
              { id: 'compare', key: 'navCompare' },
              { id: 'flow', key: 'navShowcase' },
              { id: 'discipline', key: 'navWinrate' },
              { id: 'pricing', key: 'navPricing' },
              { id: 'faq', key: 'navFaq' },
            ].map((item) => (
              <a
                key={item.id}
                href={`#${item.id}`}
                className="rounded-lg px-3 py-2 text-[13px] text-slate-500 transition-colors hover:text-slate-200"
              >
                {t(`landing.${item.key}`)}
              </a>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-2.5">
            <LanguageToggle />
            <button
              onClick={() => navigate('/login')}
              className="rounded-lg px-4 py-2 text-[13px] text-slate-400 transition hover:text-white"
            >
              {t('landing.signIn')}
            </button>
            <button
              onClick={() => navigate('/login?mode=register')}
              className="rounded-full bg-white px-5 py-2 text-[13px] font-semibold text-black transition-all hover:scale-105 hover:shadow-[0_0_32px_rgba(255,255,255,0.12)]"
            >
              {t('landing.getStarted')}
            </button>
          </div>
        </div>
      </header>

      {/* ─── 第 1 幕：Hero ─── */}
      <section className="relative flex min-h-[92vh] flex-col items-center justify-center px-5 pb-20 pt-32 text-center">
        {/* 棱镜折射光斑 */}
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center overflow-hidden">
          <div className="h-[520px] w-[520px] animate-[float_12s_ease-in-out_infinite] rounded-full bg-gradient-to-br from-white/6 via-prism-500/8 to-transparent blur-[80px]" />
          <div
            className="absolute h-[300px] w-[300px] animate-[float_16s_ease-in-out_infinite_reverse] rounded-full bg-gradient-to-tr from-cyan-400/5 via-purple-500/6 to-transparent blur-[60px]"
            style={{ marginTop: '-100px' }}
          />
        </div>

        <Reveal className="relative z-10 mb-5">
          <span className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-4 py-1.5 text-[11px] uppercase tracking-[0.2em] text-prism-300 backdrop-blur">
            <span className="h-1.5 w-1.5 rounded-full bg-prism-400 animate-breathe" />
            {t('landing.badge')}
          </span>
        </Reveal>

        <Reveal className="relative z-10">
          <h1 className="mx-auto max-w-4xl font-display text-5xl font-black leading-[1.08] tracking-tight text-white sm:text-6xl md:text-7xl">
            {t('landing.heroTitle1')}{' '}
            <span className="bg-gradient-to-r from-white via-prism-300 to-cyan-300 bg-clip-text text-transparent">
              {t('landing.heroTitle2')}
            </span>
          </h1>
        </Reveal>

        <Reveal className="relative z-10 mt-8 max-w-2xl">
          <p className="text-base leading-relaxed text-slate-400 sm:text-lg">
            {t('landing.heroSubtitle')}
          </p>
        </Reveal>

        <Reveal className="relative z-10 mt-10 flex flex-col items-center gap-4 sm:flex-row">
          <button
            onClick={() => navigate('/login?mode=register')}
            className="rounded-full bg-white px-8 py-3.5 text-base font-semibold text-black transition-all hover:scale-105 hover:shadow-[0_0_36px_rgba(255,255,255,0.15)]"
          >
            {t('landing.ctaPrimary')}
          </button>
          <a
            href="#compare"
            className="text-sm text-slate-500 underline-offset-4 transition hover:text-slate-300 hover:underline"
          >
            {t('landing.ctaSecondary')}
          </a>
        </Reveal>

        <Reveal className="relative z-10 mt-6">
          <p className="text-[13px] text-slate-600">{t('landing.heroNote')}</p>
        </Reveal>
      </section>

      {/* ─── 信任指标 ─── */}
      <section className="mx-auto max-w-7xl px-5 pb-20">
        <div className="grid grid-cols-3 gap-3 sm:gap-5">
          {[
            { v: '0', k: 'stat1' },
            { v: '24/7', k: 'stat2' },
            { v: '100%', k: 'stat3' },
          ].map((s) => (
            <Reveal key={s.k}>
              <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] px-4 py-6 text-center backdrop-blur sm:py-8">
                <div className="font-display text-3xl font-bold text-white sm:text-4xl">{s.v}</div>
                <div className="mt-2 text-[12px] text-slate-500 sm:text-sm">{t(`landing.${s.k}`)}</div>
              </div>
            </Reveal>
          ))}
        </div>
        <p className="mt-6 text-center text-[10px] uppercase tracking-[0.25em] text-slate-700">
          {t('landing.statFootnote')}
        </p>
      </section>

      {/* ─── 第 2 幕：行业解剖 ─── */}
      <section id="compare" className="mx-auto max-w-7xl scroll-mt-20 px-5 pb-20">
        <Reveal className="mb-14 text-center">
          <span className="text-[11px] uppercase tracking-[0.2em] text-prism-400">
            {t('landing.expEyebrow')}
          </span>
          <h2 className="mt-3 font-display text-3xl font-bold text-white sm:text-4xl">
            {t('landing.expTitle')}
          </h2>
          <p className="mx-auto mt-3 max-w-lg text-sm text-slate-500">
            {t('landing.expSubtitle')}
          </p>
        </Reveal>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {sevenTruths.slice(0, 6).map((item, i) => (
            <Reveal key={i}>
              <GlassCard>
                <div className="mb-3 flex items-center gap-2">
                  <span className="rounded-md bg-red-500/10 px-2 py-0.5 text-[10px] font-semibold text-red-400/80">
                    TRICK
                  </span>
                  <span className="text-[10px] text-slate-600">#{i + 1}</span>
                </div>
                <p className="text-[13px] leading-relaxed text-slate-400">
                  {t(`landing.${item.dark}`)}
                </p>
                <div className="mt-3 h-px bg-gradient-to-r from-prism-500/30 to-transparent" />
                <p className="mt-3 text-[13px] leading-relaxed text-slate-200">
                  {t(`landing.${item.mirror}`)}
                </p>
              </GlassCard>
            </Reveal>
          ))}
        </div>
        <Reveal className="mt-4 flex justify-center">
          <GlassCard className="w-full max-w-md">
            <div className="mb-3 flex items-center gap-2">
              <span className="rounded-md bg-red-500/10 px-2 py-0.5 text-[10px] font-semibold text-red-400/80">
                TRICK
              </span>
              <span className="text-[10px] text-slate-600">#7</span>
            </div>
            <p className="text-[13px] leading-relaxed text-slate-400">
              {t(`landing.${sevenTruths[6].dark}`)}
            </p>
            <div className="mt-3 h-px bg-gradient-to-r from-prism-500/30 to-transparent" />
            <p className="mt-3 text-[13px] leading-relaxed text-slate-200">
              {t(`landing.${sevenTruths[6].mirror}`)}
            </p>
          </GlassCard>
        </Reveal>

        <p className="mt-8 text-center text-[11px] text-slate-600">{t('landing.expNote')}</p>
      </section>

      {/* ─── 第 3 幕：信号流水线 ─── */}
      <section id="flow" className="mx-auto max-w-7xl scroll-mt-20 px-5 pb-20">
        <Reveal className="mb-14 text-center">
          <span className="text-[11px] uppercase tracking-[0.2em] text-prism-400">
            {t('landing.plEyebrow')}
          </span>
          <h2 className="mt-3 font-display text-3xl font-bold text-white sm:text-4xl">
            {t('landing.plTitle')}
          </h2>
        </Reveal>

        <div className="relative mx-auto max-w-3xl">
          {/* 连接线 */}
          <div className="absolute left-1/2 top-0 hidden h-full w-px bg-gradient-to-b from-prism-500/20 via-transparent to-prism-500/20 sm:block" />

          {[
            { step: '01', label: 'plStep1Title', desc: 'plStep1Desc', icon: '⚡' },
            { step: '02', label: 'plStep2Title', desc: 'plStep2Desc', icon: '→' },
            { step: '03', label: 'plStep3Title', desc: 'plStep3Desc', icon: '✓' },
          ].map((s) => (
            <Reveal key={s.step}>
              <div className="mb-6 flex gap-5 sm:gap-8">
                <div className="relative z-10 flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/[0.03] backdrop-blur font-mono text-lg text-prism-300">
                  {s.icon}
                </div>
                <GlassCard className="flex-1" hover={false}>
                  <div className="mb-1 font-mono text-[10px] text-prism-500">{s.step}</div>
                  <h3 className="font-semibold text-white">{t(`landing.${s.label}`)}</h3>
                  <p className="mt-1 text-[13px] leading-relaxed text-slate-500">
                    {t(`landing.${s.desc}`)}
                  </p>
                </GlassCard>
              </div>
            </Reveal>
          ))}

          {/* 底部：公开账本 */}
          <Reveal>
            <div className="mt-8 text-center">
              <p className="text-sm text-slate-500">{t('landing.plFootnote')}</p>
              <p className="mt-2 font-mono text-lg font-bold text-prism-300">
                {t('landing.plCounter')}
              </p>
            </div>
          </Reveal>
        </div>
      </section>

      {/* ─── 第 4 幕：纪律引擎 ─── */}
      <section id="discipline" className="mx-auto max-w-7xl scroll-mt-20 px-5 pb-20">
        <Reveal className="mb-14 text-center">
          <span className="text-[11px] uppercase tracking-[0.2em] text-prism-400">
            {t('landing.deEyebrow')}
          </span>
          <h2 className="mt-3 font-display text-3xl font-bold text-white sm:text-4xl">
            {t('landing.deTitle')}
          </h2>
          <p className="mx-auto mt-3 max-w-lg text-sm text-slate-500">
            {t('landing.deSubtitle')}
          </p>
        </Reveal>

        <div className="grid grid-cols-1 gap-5 md:grid-cols-3">
          {disciplineCards.map((c) => (
            <Reveal key={c.i}>
              <GlassCard className={`border-l-2 ${c.accent}`}>
                <div className="mb-3 font-mono text-2xl font-light text-white/20">{c.i}</div>
                <h3 className="font-semibold text-white">{c.title}</h3>
                <p className="mt-2 text-[13px] leading-relaxed text-slate-500">
                  {t(`landing.${c.tKey}`)}
                </p>
              </GlassCard>
            </Reveal>
          ))}
        </div>
      </section>

      {/* ─── 第 5 幕：双门定价 ─── */}
      <section id="pricing" className="mx-auto max-w-7xl scroll-mt-20 px-5 pb-20">
        <Reveal className="mb-14 text-center">
          <span className="text-[11px] uppercase tracking-[0.2em] text-prism-400">
            {t('landing.tdEyebrow')}
          </span>
          <h2 className="mt-3 font-display text-3xl font-bold text-white sm:text-4xl">
            {t('landing.tdTitle')}
          </h2>
        </Reveal>

        <div className="mx-auto grid max-w-2xl grid-cols-1 gap-5 sm:grid-cols-2">
          {/* 门 A */}
          <Reveal>
            <GlassCard className="text-center">
              <div className="text-[11px] uppercase tracking-[0.15em] text-slate-500">
                {t('landing.tdDoorA')}
              </div>
              <div className="mt-3 font-display text-4xl font-bold text-white">$49</div>
              <div className="text-[13px] text-slate-500">{t('landing.tdPerMonth')}</div>
              <p className="mt-3 text-[13px] leading-relaxed text-slate-500">
                {t('landing.tdDoorADesc')}
              </p>
              <button
                onClick={() => navigate('/login?mode=register')}
                className="mt-5 w-full rounded-full border border-white/15 py-2.5 text-[13px] font-medium text-white transition hover:border-white/30"
              >
                {t('landing.getStarted')}
              </button>
            </GlassCard>
          </Reveal>

          {/* 门 B */}
          <Reveal>
            <GlassCard className="relative text-center ring-1 ring-prism-500/20">
              <div className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-prism-500 px-4 py-0.5 text-[10px] font-bold uppercase tracking-wider text-white">
                PRO
              </div>
              <div className="text-[11px] uppercase tracking-[0.15em] text-slate-500">
                {t('landing.tdDoorB')}
              </div>
              <div className="mt-3 font-display text-4xl font-bold text-white">$500</div>
              <div className="text-[13px] text-slate-500">{t('landing.tdDeposit')}</div>
              <p className="mt-3 text-[13px] leading-relaxed text-slate-500">
                {t('landing.tdDoorBDesc')}
              </p>
              <button
                onClick={() => navigate('/login?mode=register')}
                className="mt-5 w-full rounded-full bg-prism-500 py-2.5 text-[13px] font-semibold text-white transition hover:bg-prism-400"
              >
                {t('landing.getStarted')}
              </button>
            </GlassCard>
          </Reveal>
        </div>

        <Reveal>
          <p className="mt-6 text-center text-[13px] text-slate-600">{t('landing.tdFootnote')}</p>
        </Reveal>
      </section>

      {/* ─── 三步开始 ─── */}
      <section id="how" className="mx-auto max-w-7xl scroll-mt-20 px-5 pb-20">
        <Reveal className="mb-12 text-center">
          <span className="text-[11px] uppercase tracking-[0.2em] text-prism-400">
            {t('landing.howEyebrow')}
          </span>
          <h2 className="mt-3 font-display text-3xl font-bold text-white sm:text-4xl">
            {t('landing.howTitle')}
          </h2>
        </Reveal>
        <div className="grid grid-cols-1 gap-5 md:grid-cols-3">
          {[
            { title: 'step1Title', desc: 'step1Desc' },
            { title: 'step2Title', desc: 'step2Desc' },
            { title: 'step3Title', desc: 'step3Desc' },
          ].map((s, i) => (
            <Reveal key={s.title}>
              <GlassCard>
                <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-full bg-white/[0.06] font-mono text-sm text-prism-300">
                  {i + 1}
                </div>
                <h3 className="font-semibold text-white">{t(`landing.${s.title}`)}</h3>
                <p className="mt-2 text-[13px] leading-relaxed text-slate-500">
                  {t(`landing.${s.desc}`)}
                </p>
              </GlassCard>
            </Reveal>
          ))}
        </div>
      </section>

      {/* ─── FAQ ─── */}
      <FaqSection />

      {/* ─── 底部 CTA ─── */}
      <section className="mx-auto max-w-7xl px-5 pb-24">
        <Reveal>
          <div className="relative overflow-hidden rounded-3xl border border-white/[0.06] bg-white/[0.02] backdrop-blur px-8 py-16 text-center sm:px-16">
            <div className="pointer-events-none absolute -right-20 -top-20 h-56 w-56 rounded-full bg-prism-500/15 blur-[80px]" />
            <div className="pointer-events-none absolute -bottom-20 -left-20 h-56 w-56 rounded-full bg-cyan-400/10 blur-[80px]" />
            <h2 className="relative font-display text-3xl font-bold text-white sm:text-4xl">
              {t('landing.ctaTitle')}
            </h2>
            <p className="relative mx-auto mt-3 max-w-md text-slate-500">
              {t('landing.ctaSubtitle')}
            </p>
            <button
              onClick={() => navigate('/login?mode=register')}
              className="relative mt-8 rounded-full bg-white px-8 py-3.5 text-base font-semibold text-black transition-all hover:scale-105 hover:shadow-[0_0_36px_rgba(255,255,255,0.15)]"
            >
              {t('landing.ctaButton')}
            </button>
            <p className="relative mt-3 text-[13px] text-slate-600">{t('landing.ctaNote')}</p>
          </div>
        </Reveal>
      </section>

      {/* ─── 页脚 ─── */}
      <footer className="border-t border-white/[0.04]">
        <div className="mx-auto max-w-7xl px-5 py-8">
          <div className="flex flex-col items-center justify-between gap-4 sm:flex-row">
            <div className="flex items-center gap-2.5">
              <Logo size={24} />
              <span className="font-display text-[13px] font-bold tracking-wider text-slate-300">
                PRISMX Signal Lab
              </span>
            </div>
            <p className="text-[11px] text-slate-600">
              &copy; {new Date().getFullYear()} PRISMX. {t('landing.footerRights')}
            </p>
          </div>
          <p className="mt-4 text-center text-[11px] leading-relaxed text-slate-700 sm:text-left">
            {t('landing.footerRisk')}
          </p>
        </div>
      </footer>

      <MobileStickyCta />
    </div>
  )
}
