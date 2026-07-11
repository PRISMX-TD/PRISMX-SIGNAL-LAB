// PRISMX Signal Lab · 纯黑底 · 高对比 · 极简专业
import { useEffect, useState, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import Logo from '../components/Logo'
import LanguageToggle from '../components/LanguageToggle'
import FaqSection from '../components/landing/FaqSection'
import MobileStickyCta from '../components/landing/MobileStickyCta'

/* ── 滚动渐现 ── */
function useInView(threshold = 0.15) {
  const ref = useRef<HTMLDivElement>(null)
  const [inView, setInView] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const o = new IntersectionObserver(([e]) => { if (e.isIntersecting) setInView(true) }, { threshold, rootMargin: '0px 0px -30px 0px' })
    o.observe(el)
    return () => o.disconnect()
  }, [threshold])
  return { ref, inView }
}

function Reveal({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  const { ref, inView } = useInView()
  return (
    <div ref={ref} className={`transition-all duration-700 ease-out ${inView ? 'translate-y-0 opacity-100' : 'translate-y-6 opacity-0'} ${className}`}>
      {children}
    </div>
  )
}

/* ── 业务数据（后续接 API） ── */
const STATS = [
  { label: 'stat1', value: '0', suffix: '' },
  { label: 'stat2', value: '24/7', suffix: '' },
  { label: 'stat3', value: '100', suffix: '%' },
]

const PIPELINE_STEPS = [
  { i: '01', title: 'plStep1Title', desc: 'plStep1Desc' },
  { i: '02', title: 'plStep2Title', desc: 'plStep2Desc' },
  { i: '03', title: 'plStep3Title', desc: 'plStep3Desc' },
]

const GUARD = [
  { i: '01', title: 'dc1Title', desc: 'dc1', accent: 'border-red-500/50' },
  { i: '02', title: 'dc2Title', desc: 'dc2', accent: 'border-purple-500/50' },
  { i: '03', title: 'dc3Title', desc: 'dc3', accent: 'border-emerald-500/50' },
]

const HOW = [
  { title: 'step1Title', desc: 'step1Desc' },
  { title: 'step2Title', desc: 'step2Desc' },
  { title: 'step3Title', desc: 'step3Desc' },
]

const TRUTHS = [
  { dark: 'expDark1', mirror: 'expMirror1' },
  { dark: 'expDark2', mirror: 'expMirror2' },
  { dark: 'expDark3', mirror: 'expMirror3' },
  { dark: 'expDark4', mirror: 'expMirror4' },
  { dark: 'expDark5', mirror: 'expMirror5' },
  { dark: 'expDark6', mirror: 'expMirror6' },
  { dark: 'expDark7', mirror: 'expMirror7' },
]

/* ── 导航 ── */
function Navbar({ t, navigate }: { t: (k: string) => string; navigate: ReturnType<typeof useNavigate> }) {
  const [scrolled, setScrolled] = useState(false)
  useEffect(() => {
    const h = () => setScrolled(window.scrollY > 40)
    window.addEventListener('scroll', h, { passive: true })
    return () => window.removeEventListener('scroll', h)
  }, [])

  const links = [
    { href: '#compare', key: 'navCompare' },
    { href: '#flow', key: 'navShowcase' },
    { href: '#discipline', key: 'navWinrate' },
    { href: '#pricing', key: 'navPricing' },
    { href: '#faq', key: 'navFaq' },
  ]

  return (
    <header className={`fixed inset-x-0 top-0 z-50 transition-colors ${scrolled ? 'border-b border-white/[0.06] bg-black/70 backdrop-blur-xl' : ''}`}>
      <div className="mx-auto flex h-14 max-w-[1200px] items-center gap-6 px-5">
        <a href="#" className="flex items-center gap-2.5">
          <Logo size={28} />
          <span className="text-sm font-semibold tracking-wider text-white">PRISMX</span>
          <span className="text-[10px] text-neutral-600">SIGNAL LAB</span>
        </a>
        <nav className="ml-2 hidden items-center gap-1 md:flex">
          {links.map((l) => (
            <a key={l.href} href={l.href} className="rounded-md px-3 py-2 text-[13px] text-neutral-400 transition-colors hover:text-white">{t(`landing.${l.key}`)}</a>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <LanguageToggle />
          <button onClick={() => navigate('/login')} className="rounded-md px-3 py-2 text-[13px] text-neutral-400 transition-colors hover:text-white">{t('landing.signIn')}</button>
          <button onClick={() => navigate('/login?mode=register')} className="rounded-md bg-white px-4 py-2 text-[13px] font-semibold text-black transition-all hover:bg-neutral-200">{t('landing.getStarted')}</button>
        </div>
      </div>
    </header>
  )
}

/* ── Footer ── */
function Footer({ t }: { t: (k: string) => string }) {
  return (
    <footer className="border-t border-white/[0.05] px-5 py-8">
      <div className="mx-auto flex max-w-[1200px] flex-col items-center gap-4 sm:flex-row sm:justify-between">
        <div className="flex items-center gap-2">
          <Logo size={20} />
          <span className="text-[13px] font-medium text-neutral-400">PRISMX Signal Lab</span>
        </div>
        <p className="text-[12px] text-neutral-600">© {new Date().getFullYear()} PRISMX. {t('landing.footerRights')}</p>
      </div>
      <p className="mx-auto mt-4 max-w-[1200px] text-center text-[11px] leading-relaxed text-neutral-700 sm:text-left">{t('landing.footerRisk')}</p>
    </footer>
  )
}

/* ── 主页 ── */
export default function LandingPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()

  return (
    <div className="min-h-screen bg-black text-white">
      <Navbar t={t} navigate={navigate} />

      {/* ═══ Hero ═══ */}
      <section className="flex min-h-[95vh] flex-col items-center justify-center px-5 pt-16 text-center">
        <Reveal>
          <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-white/[0.08] bg-white/[0.02] px-4 py-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-purple-400" />
            <span className="text-[11px] text-neutral-400">{t('landing.badge')}</span>
          </div>
        </Reveal>

        <Reveal>
          <h1 className="mx-auto max-w-3xl text-5xl font-bold leading-[1.05] tracking-tight sm:text-6xl md:text-7xl">
            {t('landing.heroTitle1')}
            <br />
            <span className="text-purple-400">{t('landing.heroTitle2')}</span>
          </h1>
        </Reveal>

        <Reveal>
          <p className="mt-6 max-w-xl text-base leading-relaxed text-neutral-400 sm:text-lg">{t('landing.heroSubtitle')}</p>
        </Reveal>

        <Reveal>
          <div className="mt-10 flex flex-col items-center gap-3 sm:flex-row">
            <button onClick={() => navigate('/login?mode=register')} className="rounded-lg bg-white px-8 py-3 text-[15px] font-semibold text-black transition-all hover:bg-neutral-200">{t('landing.ctaPrimary')}</button>
            <a href="#compare" className="text-[14px] text-neutral-500 underline-offset-4 transition hover:text-neutral-300 hover:underline">{t('landing.ctaSecondary')}</a>
          </div>
        </Reveal>

        <Reveal>
          <p className="mt-5 text-[13px] text-neutral-600">{t('landing.heroNote')}</p>
        </Reveal>
      </section>

      {/* ═══ Stats ═══ */}
      <section className="mx-auto max-w-[1200px] px-5 pb-24">
        <div className="grid grid-cols-3 gap-4">
          {STATS.map((s) => (
            <Reveal key={s.label}>
              <div className="rounded-xl border border-white/[0.06] bg-white/[0.01] px-5 py-8 text-center">
                <div className="text-3xl font-bold sm:text-4xl">{s.value}<span className="text-purple-400">{s.suffix}</span></div>
                <div className="mt-2 text-[13px] text-neutral-500">{t(`landing.${s.label}`)}</div>
              </div>
            </Reveal>
          ))}
        </div>
        <p className="mt-6 text-center text-[11px] uppercase tracking-[0.2em] text-neutral-700">{t('landing.statFootnote')}</p>
      </section>

      {/* ═══ Truths ═══ */}
      <section id="compare" className="mx-auto max-w-[1200px] scroll-mt-20 px-5 pb-24">
        <Reveal className="mb-14 text-center">
          <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-purple-400">{t('landing.expEyebrow')}</p>
          <h2 className="mt-3 text-3xl font-bold sm:text-4xl">{t('landing.expTitle')}</h2>
          <p className="mt-3 text-sm text-neutral-500">{t('landing.expSubtitle')}</p>
        </Reveal>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {TRUTHS.slice(0, 6).map((item, i) => (
            <Reveal key={i}>
              <div className="group rounded-xl border border-white/[0.06] bg-white/[0.01] p-5 transition-colors hover:border-white/[0.12]">
                <div className="mb-3 flex items-center gap-2">
                  <span className="rounded bg-red-500/10 px-2 py-0.5 text-[10px] font-semibold text-red-400">TRICK #{i + 1}</span>
                </div>
                <p className="text-[13px] leading-relaxed text-neutral-400">{t(`landing.${item.dark}`)}</p>
                <div className="my-3 h-px bg-white/[0.06]" />
                <p className="text-[13px] leading-relaxed text-neutral-200">{t(`landing.${item.mirror}`)}</p>
              </div>
            </Reveal>
          ))}
        </div>

        <Reveal className="mt-3 flex justify-center">
          <div className="w-full max-w-md rounded-xl border border-white/[0.06] bg-white/[0.01] p-5 transition-colors hover:border-white/[0.12]">
            <div className="mb-3 flex items-center gap-2">
              <span className="rounded bg-red-500/10 px-2 py-0.5 text-[10px] font-semibold text-red-400">TRICK #7</span>
            </div>
            <p className="text-[13px] leading-relaxed text-neutral-400">{t(`landing.${TRUTHS[6].dark}`)}</p>
            <div className="my-3 h-px bg-white/[0.06]" />
            <p className="text-[13px] leading-relaxed text-neutral-200">{t(`landing.${TRUTHS[6].mirror}`)}</p>
          </div>
        </Reveal>

        <p className="mt-8 text-center text-[12px] text-neutral-600">{t('landing.expNote')}</p>
      </section>

      {/* ═══ Pipeline ═══ */}
      <section id="flow" className="mx-auto max-w-[800px] scroll-mt-20 px-5 pb-24">
        <Reveal className="mb-14 text-center">
          <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-purple-400">{t('landing.plEyebrow')}</p>
          <h2 className="mt-3 text-3xl font-bold sm:text-4xl">{t('landing.plTitle')}</h2>
        </Reveal>

        {PIPELINE_STEPS.map((s) => (
          <Reveal key={s.i} className="mb-5">
            <div className="flex gap-5 rounded-xl border border-white/[0.06] bg-white/[0.01] p-6">
              <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg border border-white/[0.08] text-sm font-mono text-purple-400">{s.i}</div>
              <div>
                <h3 className="font-semibold">{t(`landing.${s.title}`)}</h3>
                <p className="mt-1 text-[14px] leading-relaxed text-neutral-400">{t(`landing.${s.desc}`)}</p>
              </div>
            </div>
          </Reveal>
        ))}

        <Reveal>
          <div className="mt-8 text-center">
            <p className="text-sm text-neutral-500">{t('landing.plFootnote')}</p>
            <p className="mt-2 font-mono text-lg font-bold text-purple-400">{t('landing.plCounter')}</p>
          </div>
        </Reveal>
      </section>

      {/* ═══ Discipline ═══ */}
      <section id="discipline" className="mx-auto max-w-[1200px] scroll-mt-20 px-5 pb-24">
        <Reveal className="mb-14 text-center">
          <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-purple-400">{t('landing.deEyebrow')}</p>
          <h2 className="mt-3 text-3xl font-bold sm:text-4xl">{t('landing.deTitle')}</h2>
          <p className="mt-3 text-sm text-neutral-500">{t('landing.deSubtitle')}</p>
        </Reveal>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          {GUARD.map((g) => (
            <Reveal key={g.i}>
              <div className={`rounded-xl border border-white/[0.06] bg-white/[0.01] p-6 transition-colors hover:border-white/[0.12] border-l-2 ${g.accent}`}>
                <div className="mb-3 font-mono text-2xl font-light text-white/10">{g.i}</div>
                <h3 className="font-semibold">{t(`landing.${g.title}`)}</h3>
                <p className="mt-2 text-[14px] leading-relaxed text-neutral-400">{t(`landing.${g.desc}`)}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </section>

      {/* ═══ Pricing ═══ */}
      <section id="pricing" className="mx-auto max-w-[900px] scroll-mt-20 px-5 pb-24">
        <Reveal className="mb-14 text-center">
          <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-purple-400">{t('landing.tdEyebrow')}</p>
          <h2 className="mt-3 text-3xl font-bold sm:text-4xl">{t('landing.tdTitle')}</h2>
        </Reveal>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {/* Door A */}
          <Reveal>
            <div className="rounded-xl border border-white/[0.06] bg-white/[0.01] p-8 text-center transition-colors hover:border-white/[0.12]">
              <p className="text-[11px] font-medium uppercase tracking-wider text-neutral-500">{t('landing.tdDoorA')}</p>
              <div className="mt-3 text-5xl font-bold">$49</div>
              <p className="mt-1 text-sm text-neutral-500">{t('landing.tdPerMonth')}</p>
              <p className="mt-4 text-[14px] leading-relaxed text-neutral-400">{t('landing.tdDoorADesc')}</p>
              <button onClick={() => navigate('/login?mode=register')} className="mt-6 w-full rounded-lg border border-white/[0.12] py-2.5 text-[14px] font-medium text-white transition-colors hover:bg-white/[0.04]">{t('landing.getStarted')}</button>
            </div>
          </Reveal>

          {/* Door B */}
          <Reveal>
            <div className="relative rounded-xl border border-purple-500/30 bg-purple-500/[0.03] p-8 text-center transition-colors hover:border-purple-500/50">
              <div className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-purple-500 px-3 py-0.5 text-[10px] font-bold uppercase tracking-wider text-white">RECOMMENDED</div>
              <p className="text-[11px] font-medium uppercase tracking-wider text-neutral-500">{t('landing.tdDoorB')}</p>
              <div className="mt-3 text-5xl font-bold">$500</div>
              <p className="mt-1 text-sm text-neutral-500">{t('landing.tdDeposit')}</p>
              <p className="mt-4 text-[14px] leading-relaxed text-neutral-400">{t('landing.tdDoorBDesc')}</p>
              <button onClick={() => navigate('/login?mode=register')} className="mt-6 w-full rounded-lg bg-purple-500 py-2.5 text-[14px] font-semibold text-white transition-colors hover:bg-purple-400">{t('landing.getStarted')}</button>
            </div>
          </Reveal>
        </div>

        <Reveal>
          <p className="mt-5 text-center text-[13px] text-neutral-600">{t('landing.tdFootnote')}</p>
        </Reveal>
      </section>

      {/* ═══ How ═══ */}
      <section className="mx-auto max-w-[1200px] px-5 pb-24">
        <Reveal className="mb-14 text-center">
          <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-purple-400">{t('landing.howEyebrow')}</p>
          <h2 className="mt-3 text-3xl font-bold sm:text-4xl">{t('landing.howTitle')}</h2>
        </Reveal>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          {HOW.map((h, i) => (
            <Reveal key={h.title}>
              <div className="rounded-xl border border-white/[0.06] bg-white/[0.01] p-6 transition-colors hover:border-white/[0.12]">
                <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-lg border border-white/[0.08] text-sm font-mono text-purple-400">{i + 1}</div>
                <h3 className="font-semibold">{t(`landing.${h.title}`)}</h3>
                <p className="mt-2 text-[14px] leading-relaxed text-neutral-400">{t(`landing.${h.desc}`)}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </section>

      {/* ═══ FAQ ═══ */}
      <FaqSection />

      {/* ═══ CTA ═══ */}
      <section className="mx-auto max-w-[1200px] px-5 pb-24">
        <Reveal>
          <div className="rounded-2xl border border-white/[0.06] bg-white/[0.01] px-8 py-16 text-center sm:px-16">
            <h2 className="text-3xl font-bold sm:text-4xl">{t('landing.ctaTitle')}</h2>
            <p className="mx-auto mt-3 max-w-md text-neutral-400">{t('landing.ctaSubtitle')}</p>
            <button onClick={() => navigate('/login?mode=register')} className="mt-8 rounded-lg bg-white px-8 py-3 text-[15px] font-semibold text-black transition-all hover:bg-neutral-200">{t('landing.ctaButton')}</button>
            <p className="mt-3 text-[13px] text-neutral-600">{t('landing.ctaNote')}</p>
          </div>
        </Reveal>
      </section>

      <Footer t={t} />
      <MobileStickyCta />
    </div>
  )
}
