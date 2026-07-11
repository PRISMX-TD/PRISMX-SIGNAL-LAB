// PRISMX Signal Lab · Vercel Mesh × Raycast Glass × Linear Precision
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import Logo from '../components/Logo'
import LanguageToggle from '../components/LanguageToggle'
import FaqSection from '../components/landing/FaqSection'
import MobileStickyCta from '../components/landing/MobileStickyCta'

/* ═════════════════════════ 滚动渐现 ═════════════════════════ */
function Re({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const [v, setV] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const o = new IntersectionObserver(([e]) => { if (e.isIntersecting) setV(true) }, { threshold: 0.1, rootMargin: '0px 0px -40px 0px' })
    o.observe(el)
    return () => o.disconnect()
  }, [])
  return (
    <div ref={ref} className={`transition-all duration-700 ease-out ${v ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-6'} ${className}`}>
      {children}
    </div>
  )
}

/* ═════════════════════════ 导航 ═════════════════════════ */
function Navbar({ t, navigate }: { t: (k: string) => string; navigate: ReturnType<typeof useNavigate> }) {
  const [scrolled, setScrolled] = useState(false)
  useEffect(() => {
    const h = () => setScrolled(window.scrollY > 20)
    window.addEventListener('scroll', h, { passive: true })
    return () => window.removeEventListener('scroll', h)
  }, [])

  const links = [
    { href: '#truth', key: 'navCompare' },
    { href: '#flow', key: 'navShowcase' },
    { href: '#guard', key: 'navWinrate' },
    { href: '#pricing', key: 'navPricing' },
    { href: '#faq', key: 'navFaq' },
  ]

  return (
    <header className={`fixed inset-x-0 top-0 z-50 transition-colors duration-300 ${scrolled ? 'border-b border-white/[0.06] bg-black/70 backdrop-blur-xl' : ''}`}>
      <div className="mx-auto flex h-14 max-w-[1200px] items-center gap-6 px-5">
        <a href="#" className="flex items-center gap-2.5">
          <Logo size={26} />
          <span className="text-sm font-semibold tracking-wide text-[#F5F5F5]">PRISMX</span>
          <span className="text-[10px] font-medium uppercase tracking-[0.18em] text-[#5E5E5E]">Signal Lab</span>
        </a>
        <nav className="ml-2 hidden items-center gap-0.5 md:flex">
          {links.map((l) => (
            <a key={l.href} href={l.href} className="rounded-md px-3 py-2 text-[13px] text-[#8B8B8B] transition-colors hover:text-[#F5F5F5]">{t(`landing.${l.key}`)}</a>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <LanguageToggle />
          <button onClick={() => navigate('/login')} className="rounded-md px-3 py-2 text-[13px] text-[#8B8B8B] transition-colors hover:text-[#F5F5F5]">{t('landing.signIn')}</button>
          <button onClick={() => navigate('/login?mode=register')} className="rounded-lg bg-white px-4 py-2 text-[13px] font-semibold text-black transition-all hover:scale-[1.03] hover:bg-[#E8E8E8]">{t('landing.getStarted')}</button>
        </div>
      </div>
    </header>
  )
}

/* ═════════════════════════ Footer ═════════════════════════ */
function Footer({ t }: { t: (k: string) => string }) {
  return (
    <footer className="border-t border-white/[0.05] px-5 py-8">
      <div className="mx-auto flex max-w-[1200px] flex-col items-center gap-4 sm:flex-row sm:justify-between">
        <div className="flex items-center gap-2">
          <Logo size={20} />
          <span className="text-[13px] text-[#8B8B8B]">PRISMX Signal Lab</span>
        </div>
        <p className="text-[12px] text-[#5E5E5E]">© {new Date().getFullYear()} PRISMX. {t('landing.footerRights')}</p>
      </div>
      <p className="mx-auto mt-4 max-w-[1200px] text-center text-[11px] leading-relaxed text-[#3E3E3E] sm:text-left">{t('landing.footerRisk')}</p>
    </footer>
  )
}

/* ═════════════════════════ 数据 ═════════════════════════ */
const STATS = [
  { k: 'stat1', v: '0' },
  { k: 'stat2', v: '24/7' },
  { k: 'stat3', v: '100%' },
]

const TRUTHS = [
  ['expDark1', 'expMirror1'], ['expDark2', 'expMirror2'], ['expDark3', 'expMirror3'],
  ['expDark4', 'expMirror4'], ['expDark5', 'expMirror5'], ['expDark6', 'expMirror6'], ['expDark7', 'expMirror7'],
]

const FLOW = [
  { i: '01', t: 'plStep1Title', d: 'plStep1Desc' },
  { i: '02', t: 'plStep2Title', d: 'plStep2Desc' },
  { i: '03', t: 'plStep3Title', d: 'plStep3Desc' },
]

const GUARD = [
  { i: '01', t: 'dc1Title', d: 'dc1', acc: 'border-l-[#EF4444]/60' },
  { i: '02', t: 'dc2Title', d: 'dc2', acc: 'border-l-[#A78BFA]/60' },
  { i: '03', t: 'dc3Title', d: 'dc3', acc: 'border-l-[#22C55E]/60' },
]

const HOW = [
  { t: 'step1Title', d: 'step1Desc' },
  { t: 'step2Title', d: 'step2Desc' },
  { t: 'step3Title', d: 'step3Desc' },
]

/* ═════════════════════════ 卡片组件 ═════════════════════════ */
function Card({ children, className = '', acc = '' }: { children: React.ReactNode; className?: string; acc?: string }) {
  return (
    <div className={`rounded-xl border border-white/[0.07] bg-white/[0.03] p-6 transition-all duration-200 hover:border-white/[0.13] hover:bg-white/[0.05] hover:shadow-[0_0_30px_rgba(167,139,250,0.06)] ${acc} ${className}`}>
      {children}
    </div>
  )
}

/* ═════════════════════════ 主页 ═════════════════════════ */
export default function LandingPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()

  return (
    <div className="min-h-screen bg-[#000000] text-[#F5F5F5]">
      <Navbar t={t} navigate={navigate} />

      {/* ═══════════ HERO · Vercel Mesh 渐变 ═══════════ */}
      <section className="relative flex min-h-[93vh] flex-col items-center justify-center overflow-hidden px-5 pt-16 text-center">
        {/* 渐变 Mesh */}
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute inset-0 bg-[radial-gradient(ellipse_80%_60%_at_50%_30%,rgba(59,47,158,0.25)_0%,transparent_55%)]" />
          <div className="absolute inset-0 bg-[radial-gradient(ellipse_50%_50%_at_65%_45%,rgba(147,51,234,0.15)_0%,transparent_60%)]" />
          <div className="absolute inset-0 bg-[radial-gradient(ellipse_40%_40%_at_35%_55%,rgba(8,145,178,0.12)_0%,transparent_55%)]" />
          {/* 缓慢漂移的浮层 */}
          <div className="absolute inset-0 animate-drift opacity-30" style={{ background: 'radial-gradient(ellipse 60% 40% at 40% 35%, rgba(167,139,250,0.2), transparent 70%)' }} />
          <div className="absolute inset-0 animate-drift-slow opacity-20" style={{ background: 'radial-gradient(ellipse 50% 35% at 60% 50%, rgba(8,145,178,0.15), transparent 70%)' }} />
        </div>

        {/* 内容 */}
        <Re className="relative z-10 mb-5">
          <span className="inline-flex items-center gap-2 rounded-full border border-white/[0.08] bg-white/[0.04] px-4 py-1.5 text-[11px] font-medium uppercase tracking-[0.15em] text-[#8B8B8B] backdrop-blur">
            <span className="h-1.5 w-1.5 rounded-full bg-[#A78BFA] animate-pulse" />
            {t('landing.badge')}
          </span>
        </Re>

        <Re className="relative z-10">
          <h1 className="mx-auto max-w-4xl font-display text-5xl font-semibold leading-[1.06] tracking-[-0.02em] sm:text-6xl md:text-7xl">
            {t('landing.heroTitle1')}
            <br />
            <span className="text-[#A78BFA]">{t('landing.heroTitle2')}</span>
          </h1>
        </Re>

        <Re className="relative z-10 mt-6 max-w-xl">
          <p className="text-[15px] leading-relaxed text-[#8B8B8B] sm:text-base">{t('landing.heroSubtitle')}</p>
        </Re>

        <Re className="relative z-10 mt-10 flex flex-col items-center gap-3 sm:flex-row">
          <button onClick={() => navigate('/login?mode=register')} className="rounded-xl bg-white px-8 py-3.5 text-[15px] font-semibold text-black transition-all hover:scale-[1.04] hover:bg-[#E8E8E8]">{t('landing.ctaPrimary')}</button>
          <a href="#truth" className="text-[14px] text-[#5E5E5E] underline-offset-4 transition hover:text-[#8B8B8B] hover:underline">{t('landing.ctaSecondary')}</a>
        </Re>

        <Re className="relative z-10 mt-5">
          <p className="text-[13px] text-[#5E5E5E]">{t('landing.heroNote')}</p>
        </Re>
      </section>

      {/* ═══════════ Stats ═══════════ */}
      <section className="mx-auto max-w-[1200px] px-5 pb-24">
        <div className="grid grid-cols-3 gap-4">
          {STATS.map((s) => (
            <Re key={s.k}>
              <Card>
                <div className="text-3xl font-bold sm:text-4xl">
                  {s.v}
                  {s.k === 'stat3' && <span className="text-[#A78BFA]">%</span>}
                </div>
                <div className="mt-1.5 text-[13px] text-[#8B8B8B]">{t(`landing.${s.k}`)}</div>
              </Card>
            </Re>
          ))}
        </div>
        <p className="mt-6 text-center text-[11px] uppercase tracking-[0.2em] text-[#3E3E3E]">{t('landing.statFootnote')}</p>
      </section>

      {/* ═══════════ Truths ═══════════ */}
      <section id="truth" className="mx-auto max-w-[1200px] scroll-mt-20 px-5 pb-24">
        <Re className="mb-14 text-center">
          <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#A78BFA]">{t('landing.expEyebrow')}</p>
          <h2 className="mt-3 font-display text-3xl font-semibold tracking-[-0.02em] sm:text-4xl">{t('landing.expTitle')}</h2>
          <p className="mt-3 text-sm text-[#8B8B8B]">{t('landing.expSubtitle')}</p>
        </Re>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {TRUTHS.slice(0, 6).map(([d, m], i) => (
            <Re key={i}>
              <Card>
                <div className="mb-3 flex items-center gap-2">
                  <span className="rounded bg-[#EF4444]/10 px-2 py-0.5 text-[10px] font-semibold text-[#EF4444]">TRICK #{i + 1}</span>
                </div>
                <p className="text-[13px] leading-relaxed text-[#8B8B8B]">{t(`landing.${d}`)}</p>
                <div className="my-3 h-px bg-white/[0.06]" />
                <p className="text-[13px] leading-relaxed">{t(`landing.${m}`)}</p>
              </Card>
            </Re>
          ))}
        </div>

        <Re className="mt-3 flex justify-center">
          <Card className="w-full max-w-md">
            <div className="mb-3 flex items-center gap-2">
              <span className="rounded bg-[#EF4444]/10 px-2 py-0.5 text-[10px] font-semibold text-[#EF4444]">TRICK #7</span>
            </div>
            <p className="text-[13px] leading-relaxed text-[#8B8B8B]">{t(`landing.${TRUTHS[6][0]}`)}</p>
            <div className="my-3 h-px bg-white/[0.06]" />
            <p className="text-[13px] leading-relaxed">{t(`landing.${TRUTHS[6][1]}`)}</p>
          </Card>
        </Re>

        <p className="mt-8 text-center text-[12px] text-[#5E5E5E]">{t('landing.expNote')}</p>
      </section>

      {/* ═══════════ Flow ═══════════ */}
      <section id="flow" className="mx-auto max-w-[800px] scroll-mt-20 px-5 pb-24">
        <Re className="mb-14 text-center">
          <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#A78BFA]">{t('landing.plEyebrow')}</p>
          <h2 className="mt-3 font-display text-3xl font-semibold tracking-[-0.02em] sm:text-4xl">{t('landing.plTitle')}</h2>
        </Re>

        <div className="relative">
          {/* 中线 */}
          <div className="absolute left-5 top-0 hidden h-full w-px bg-white/[0.05] sm:block" />
          {FLOW.map((s) => (
            <Re key={s.i} className="mb-5">
              <div className="flex gap-5 sm:gap-6">
                <div className="relative z-10 flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg border border-white/[0.08] bg-[#000] text-sm font-mono text-[#A78BFA]">{s.i}</div>
                <Card className="flex-1">
                  <h3 className="font-semibold">{t(`landing.${s.t}`)}</h3>
                  <p className="mt-1 text-[14px] leading-relaxed text-[#8B8B8B]">{t(`landing.${s.d}`)}</p>
                </Card>
              </div>
            </Re>
          ))}
          <Re>
            <div className="mt-8 text-center">
              <p className="text-sm text-[#8B8B8B]">{t('landing.plFootnote')}</p>
              <p className="mt-2 font-mono text-lg font-semibold text-[#A78BFA]">{t('landing.plCounter')}</p>
            </div>
          </Re>
        </div>
      </section>

      {/* ═══════════ Guard ═══════════ */}
      <section id="guard" className="mx-auto max-w-[1200px] scroll-mt-20 px-5 pb-24">
        <Re className="mb-14 text-center">
          <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#A78BFA]">{t('landing.deEyebrow')}</p>
          <h2 className="mt-3 font-display text-3xl font-semibold tracking-[-0.02em] sm:text-4xl">{t('landing.deTitle')}</h2>
          <p className="mt-3 text-sm text-[#8B8B8B]">{t('landing.deSubtitle')}</p>
        </Re>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          {GUARD.map((g) => (
            <Re key={g.i}>
              <Card acc={`border-l-2 ${g.acc}`}>
                <div className="mb-3 font-mono text-2xl font-light text-white/5">{g.i}</div>
                <h3 className="font-semibold">{t(`landing.${g.t}`)}</h3>
                <p className="mt-2 text-[14px] leading-relaxed text-[#8B8B8B]">{t(`landing.${g.d}`)}</p>
              </Card>
            </Re>
          ))}
        </div>
      </section>

      {/* ═══════════ Pricing ═══════════ */}
      <section id="pricing" className="mx-auto max-w-[900px] scroll-mt-20 px-5 pb-24">
        <Re className="mb-14 text-center">
          <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#A78BFA]">{t('landing.tdEyebrow')}</p>
          <h2 className="mt-3 font-display text-3xl font-semibold tracking-[-0.02em] sm:text-4xl">{t('landing.tdTitle')}</h2>
        </Re>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Re>
            <Card className="text-center !p-8">
              <p className="text-[11px] font-medium uppercase tracking-wider text-[#5E5E5E]">{t('landing.tdDoorA')}</p>
              <div className="mt-3 font-display text-5xl font-semibold">$49</div>
              <p className="mt-1 text-sm text-[#8B8B8B]">{t('landing.tdPerMonth')}</p>
              <p className="mt-4 text-[14px] leading-relaxed text-[#8B8B8B]">{t('landing.tdDoorADesc')}</p>
              <button onClick={() => navigate('/login?mode=register')} className="mt-6 w-full rounded-xl border border-white/[0.10] py-2.5 text-[14px] font-medium transition-all hover:border-white/[0.20] hover:bg-white/[0.04]">{t('landing.getStarted')}</button>
            </Card>
          </Re>

          <Re>
            <Card className="relative text-center !p-8 ring-1 ring-[#A78BFA]/30">
              <div className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-[#A78BFA] px-3 py-0.5 text-[10px] font-bold uppercase tracking-wider text-white">RECOMMENDED</div>
              <p className="text-[11px] font-medium uppercase tracking-wider text-[#5E5E5E]">{t('landing.tdDoorB')}</p>
              <div className="mt-3 font-display text-5xl font-semibold">$500</div>
              <p className="mt-1 text-sm text-[#8B8B8B]">{t('landing.tdDeposit')}</p>
              <p className="mt-4 text-[14px] leading-relaxed text-[#8B8B8B]">{t('landing.tdDoorBDesc')}</p>
              <button onClick={() => navigate('/login?mode=register')} className="mt-6 w-full rounded-xl bg-[#A78BFA] py-2.5 text-[14px] font-semibold text-white transition-all hover:bg-[#9B6DF0]">{t('landing.getStarted')}</button>
            </Card>
          </Re>
        </div>

        <Re>
          <p className="mt-5 text-center text-[13px] text-[#5E5E5E]">{t('landing.tdFootnote')}</p>
        </Re>
      </section>

      {/* ═══════════ How ═══════════ */}
      <section className="mx-auto max-w-[1200px] px-5 pb-24">
        <Re className="mb-14 text-center">
          <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#A78BFA]">{t('landing.howEyebrow')}</p>
          <h2 className="mt-3 font-display text-3xl font-semibold tracking-[-0.02em] sm:text-4xl">{t('landing.howTitle')}</h2>
        </Re>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          {HOW.map((h, i) => (
            <Re key={h.t}>
              <Card>
                <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-lg border border-white/[0.08] font-mono text-sm text-[#A78BFA]">{i + 1}</div>
                <h3 className="font-semibold">{t(`landing.${h.t}`)}</h3>
                <p className="mt-2 text-[14px] leading-relaxed text-[#8B8B8B]">{t(`landing.${h.d}`)}</p>
              </Card>
            </Re>
          ))}
        </div>
      </section>

      {/* ═══════════ FAQ ═══════════ */}
      <FaqSection />

      {/* ═══════════ CTA ═══════════ */}
      <section className="mx-auto max-w-[1200px] px-5 pb-24">
        <Re>
          <div className="rounded-2xl border border-white/[0.07] bg-white/[0.03] px-8 py-16 text-center sm:px-16">
            <h2 className="font-display text-3xl font-semibold tracking-[-0.02em] sm:text-4xl">{t('landing.ctaTitle')}</h2>
            <p className="mx-auto mt-3 max-w-md text-[#8B8B8B]">{t('landing.ctaSubtitle')}</p>
            <button onClick={() => navigate('/login?mode=register')} className="mt-8 rounded-xl bg-white px-8 py-3.5 text-[15px] font-semibold text-black transition-all hover:scale-[1.04] hover:bg-[#E8E8E8]">{t('landing.ctaButton')}</button>
            <p className="mt-3 text-[13px] text-[#5E5E5E]">{t('landing.ctaNote')}</p>
          </div>
        </Re>
      </section>

      <Footer t={t} />
      <MobileStickyCta />
    </div>
  )
}
