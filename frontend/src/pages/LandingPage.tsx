// Signal Lab · 3D 棱镜主页 / 3D prism landing page
// Hero 采用可交互 WebGL 玻璃棱镜场景（PrismScene）；其余分区走极简暗黑 +
// 克制的滚动显现，保留全部原有 i18n 文案键，不新增未翻译文案。
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { paymentApi } from '../api/client'
import Logo from '../components/Logo'
import LanguageToggle from '../components/LanguageToggle'
import FaqSection from '../components/landing/FaqSection'
import MobileStickyCta from '../components/landing/MobileStickyCta'

// 3D 场景按需加载，避免拖慢首屏 TTI / lazy-load the 3D canvas
const PrismScene = lazy(() => import('../components/landing/PrismScene'))

type T = (k: string) => string

/* ═══════════════ 滚动显现 Hook / scroll reveal ═══════════════ */
function useReveal<T extends HTMLElement = HTMLDivElement>() {
  const ref = useRef<T>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add('in')
            io.unobserve(e.target)
          }
        })
      },
      { threshold: 0.12, rootMargin: '0px 0px -8% 0px' }
    )
    el.querySelectorAll('.reveal').forEach((n) => io.observe(n))
    return () => io.disconnect()
  }, [])
  return ref
}

/* ═══════════════ 小节眉题 / section eyebrow ═══════════════ */
function SectionHead({ eyebrow, title, subtitle, className = '' }: { eyebrow: string; title: string; subtitle?: string; className?: string }) {
  return (
    <div className={`reveal mx-auto max-w-2xl text-center ${className}`}>
      <span className="eyebrow">{eyebrow}</span>
      <h2 className="mt-4 font-display text-[clamp(1.9rem,4vw,3rem)] font-bold leading-[1.1] tracking-[-0.02em] text-white">{title}</h2>
      {subtitle && <p className="mx-auto mt-4 max-w-xl text-[15px] leading-relaxed text-neutral-400">{subtitle}</p>}
    </div>
  )
}

/* ═══════════════ 导航 / navbar ═══════════════ */
function Navbar({ t, navigate }: { t: T; navigate: ReturnType<typeof useNavigate> }) {
  const ref = useRef<HTMLElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onScroll = () => {
      const on = window.scrollY > 24
      el.style.background = on ? 'rgba(5,3,12,0.72)' : 'transparent'
      el.style.borderBottomColor = on ? 'rgba(255,255,255,0.06)' : 'transparent'
    }
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])
  const links = [
    { h: '#showcase', k: 'navShowcase' },
    { h: '#guard', k: 'navWinrate' },
    { h: '#pricing', k: 'navPricing' },
    { h: '#faq', k: 'navFaq' },
  ]
  return (
    <header ref={ref} className="fixed inset-x-0 top-0 z-50 border-b border-transparent backdrop-blur-xl transition-colors duration-300">
      <div className="mx-auto flex h-16 max-w-[1180px] items-center gap-6 px-5">
        <a href="#" className="flex items-center gap-2.5">
          <Logo size={26} />
          <span className="text-sm font-semibold tracking-tight">Signal Lab</span>
          <span className="hidden text-[10px] font-medium uppercase tracking-[0.12em] text-neutral-500 sm:inline">by PRISMX</span>
        </a>
        <nav className="ml-2 hidden items-center gap-1 md:flex">
          {links.map((l) => (
            <a key={l.h} href={l.h} className="rounded-lg px-3 py-2 text-[13px] text-neutral-400 transition-colors hover:text-white">
              {t(`landing.${l.k}`)}
            </a>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <LanguageToggle />
          <a href="/login" className="hidden rounded-lg px-3 py-2 text-[13px] text-neutral-400 transition-colors hover:text-white sm:block">
            {t('landing.signIn')}
          </a>
          <button
            onClick={() => navigate('/login?mode=register')}
            className="rounded-xl border border-white/10 bg-white/[0.06] px-4 py-2 text-[13px] font-semibold text-white backdrop-blur transition-all hover:border-violet-400/40 hover:bg-violet-500/15"
          >
            {t('landing.getStarted')}
          </button>
        </div>
      </div>
    </header>
  )
}

/* ═══════════════ Hero（3D 棱镜）/ hero with 3D prism ═══════════════ */
function Hero({ t, navigate }: { t: T; navigate: ReturnType<typeof useNavigate> }) {
  return (
    <section className="relative flex min-h-[100svh] items-center justify-center overflow-hidden">
      {/* 背景极光流体由页面根统一渲染，这里只在文字区做柔和径向压暗，且不在边缘形成硬边 */}
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_50%_at_50%_45%,rgba(5,3,12,0.5)_0%,transparent_75%)]" />

      <div className="relative z-10 mx-auto w-full max-w-3xl px-5 pt-24 text-center">
        <div className="animate-fade-in-up mb-8 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-4 py-1.5 backdrop-blur">
          <span className="h-1.5 w-1.5 rounded-full bg-violet-400 animate-pulse" />
          <span className="text-[11px] tracking-wide text-neutral-300">{t('landing.badge')}</span>
        </div>

        <h1 className="font-display flex flex-col text-[clamp(3.6rem,11vw,5.8rem)] font-bold leading-[1.05] tracking-[-0.035em]">
          <span className="block -translate-x-[0.15em] bg-gradient-to-b from-white via-white to-neutral-500 bg-clip-text text-transparent sm:-translate-x-[1.2em]">{t('landing.heroTitle1')}</span>
          <span className="mt-1 block translate-x-[0.15em] bg-gradient-to-r from-violet-400 via-fuchsia-400 to-cyan-300 bg-clip-text text-transparent [filter:drop-shadow(0_0_24px_rgba(167,139,250,0.35))] sm:translate-x-[1.2em]">{t('landing.heroTitle2')}</span>
        </h1>

        <p className="mx-auto mt-7 max-w-xl text-[15px] leading-relaxed text-neutral-400 sm:text-base">{t('landing.heroSubtitle')}</p>

        <div className="mt-10 flex justify-center">
          <button
            onClick={() => navigate('/login?mode=register')}
            className="btn btn-primary group relative h-11 w-auto overflow-hidden px-6 text-[14px] sm:h-12 sm:px-8 sm:text-[15px]"
          >
            <span className="relative z-10">{t('landing.ctaPrimary')}</span>
            <span className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/25 to-transparent transition-transform duration-700 group-hover:translate-x-full" />
          </button>
        </div>
      </div>

      {/* 向下滚动提示 / scroll cue */}
      <div className="pointer-events-none absolute bottom-8 left-1/2 z-10 hidden -translate-x-1/2 flex-col items-center gap-2 lg:flex">
        <span className="text-[10px] uppercase tracking-[0.3em] text-neutral-600">Scroll</span>
        <span className="h-8 w-px animate-pulse bg-gradient-to-b from-violet-400/60 to-transparent" />
      </div>
    </section>
  )
}

/* ═══════════════ Stats / 三条价值主张 ═══════════════ */
function Stats({ t }: { t: T }) {
  const ref = useReveal<HTMLDivElement>()
  const items = [
    { k: 'stat1', v: '0', label: 'CUSTODY' },
    { k: 'stat2', v: '24/7', label: 'ENGINE' },
    { k: 'stat3', v: '100%', label: 'RECORDED' },
  ]
  return (
    <section ref={ref} className="mx-auto max-w-[1180px] px-4 py-14 sm:px-5 sm:py-20">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {items.map((s, i) => (
          <div key={s.k} className={`reveal reveal-d${i} glass-card group overflow-hidden p-6 sm:p-7`}>
            <div className="pointer-events-none absolute -right-6 -top-6 h-24 w-24 rounded-full bg-violet-500/10 blur-2xl transition-opacity duration-500 group-hover:opacity-100 opacity-40" />
            <div className="flex items-baseline gap-3">
              <span className="num font-display text-4xl font-bold tracking-tight text-white sm:text-5xl">{s.v}</span>
              <span className="text-[10px] uppercase tracking-[0.25em] text-violet-400/80">{s.label}</span>
            </div>
            <p className="mt-3 text-[13.5px] leading-relaxed text-neutral-400">{t(`landing.${s.k}`)}</p>
          </div>
        ))}
      </div>
      <p className="reveal mt-6 text-center text-[12.5px] text-neutral-600">{t('landing.statFootnote')}</p>
    </section>
  )
}

/* ═══════════════ Showcase / 三步流程 ═══════════════ */
function Showcase({ t }: { t: T }) {
  const ref = useReveal<HTMLDivElement>()
  const steps = [
    { n: '01', title: 'step1Title', desc: 'step1Desc' },
    { n: '02', title: 'step2Title', desc: 'step2Desc' },
    { n: '03', title: 'step3Title', desc: 'step3Desc' },
  ]
  return (
    <section ref={ref} id="showcase" className="mx-auto max-w-[1180px] scroll-mt-24 px-4 py-14 sm:px-5 sm:py-20">
      <SectionHead eyebrow={t('landing.howEyebrow')} title={t('landing.howTitle')} subtitle={t('landing.howSubtitle')} />
      <div className="mt-10 grid grid-cols-1 gap-4 sm:mt-14 sm:grid-cols-3 sm:gap-5">
        {steps.map((s, i) => (
          <div key={s.n} className={`reveal reveal-d${i} glass-card p-6 sm:p-7`}>
            <span className="font-display text-5xl font-bold text-white/15">{s.n}</span>
            <h3 className="mt-2 text-lg font-bold text-white">{t(`landing.${s.title}`)}</h3>
            <p className="mt-2.5 text-[14px] leading-relaxed text-neutral-400">{t(`landing.${s.desc}`)}</p>
          </div>
        ))}
      </div>
      <p className="reveal num mt-10 text-center font-mono text-lg font-bold text-violet-300">{t('landing.plCounter')}</p>
    </section>
  )
}

/* ═══════════════ Guard / 三个哨兵数字 ═══════════════ */
function Guard({ t }: { t: T }) {
  const ref = useReveal<HTMLDivElement>()
  const cards = [
    { n: '01', tk: 'dc1Title', dk: 'dc1', accent: 'from-rose-500/40', bar: 'bg-rose-400' },
    { n: '02', tk: 'dc2Title', dk: 'dc2', accent: 'from-violet-500/40', bar: 'bg-violet-400' },
    { n: '03', tk: 'dc3Title', dk: 'dc3', accent: 'from-emerald-500/40', bar: 'bg-emerald-400' },
  ]
  return (
    <section ref={ref} id="guard" className="mx-auto max-w-[1180px] scroll-mt-24 px-4 py-14 sm:px-5 sm:py-20">
      <SectionHead eyebrow={t('landing.deEyebrow')} title={t('landing.deTitle')} subtitle={t('landing.deSubtitle')} />
      <div className="mt-10 grid grid-cols-1 gap-4 sm:mt-14 sm:gap-5 md:grid-cols-3">
        {cards.map((g, i) => (
          <div key={g.n} className={`reveal reveal-d${i} glass-card group overflow-hidden p-6 sm:p-7`}>
            <div className={`absolute inset-x-0 top-0 h-px bg-gradient-to-r ${g.accent} to-transparent`} />
            <div className="flex items-center gap-3">
              <span className={`h-8 w-1 rounded-full ${g.bar}`} />
              <span className="font-mono text-2xl font-bold text-white/20">{g.n}</span>
            </div>
            <h3 className="mt-4 text-lg font-bold text-white">{t(`landing.${g.tk}`)}</h3>
            <p className="mt-2.5 text-[14px] leading-relaxed text-neutral-400">{t(`landing.${g.dk}`)}</p>
          </div>
        ))}
      </div>
    </section>
  )
}

/* ═══════════════ Truths / 信号群不说的 7 件事 ═══════════════ */
function Truths({ t }: { t: T }) {
  const ref = useReveal<HTMLDivElement>()
  const items = [1, 2, 4].map((n) => ({ d: `expDark${n}`, m: `expMirror${n}`, n }))
  return (
    <section ref={ref} className="mx-auto max-w-[1180px] scroll-mt-24 px-4 py-14 sm:px-5 sm:py-20">
      <SectionHead eyebrow={t('landing.expEyebrow')} title={t('landing.expTitle')} subtitle={t('landing.expSubtitle')} />
      <div className="mt-10 grid grid-cols-1 gap-4 sm:mt-14 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((it, i) => (
          <div key={it.n} className={`reveal reveal-d${i % 3} glass-card flex flex-col p-6`}>
            <span className="inline-flex w-fit items-center gap-1.5 rounded-md bg-rose-500/10 px-2 py-0.5 text-[10px] font-bold tracking-wide text-rose-400">
              TRICK #{i + 1}
            </span>
            <p className="mt-3 text-[13px] leading-relaxed text-neutral-500 line-through decoration-rose-500/40">{t(`landing.${it.d}`)}</p>
            <div className="my-3 h-px bg-gradient-to-r from-violet-500/25 to-transparent" />
            <p className="text-[13.5px] leading-relaxed text-neutral-200">{t(`landing.${it.m}`)}</p>
          </div>
        ))}
      </div>
    </section>
  )
}

/* ═══════════════ Pricing / 两个用户等级 ═══════════════ */
function Pricing({ t, navigate }: { t: T; navigate: ReturnType<typeof useNavigate> }) {
  const ref = useReveal<HTMLDivElement>()
  const freeFeatures = ['prFreeF1', 'prFreeF2', 'prFreeF3', 'prFreeF4']
  const proFeatures = ['prProF1', 'prProF2', 'prProF3', 'prProF4', 'prProF5', 'prProF6', 'prProF7']

  // 落地页此前定价卡只有功能列表、没有具体数字——主打"透明"的产品却把价格
  // 本身藏起来，得注册登录才看到，略显自相矛盾。GET /api/payments/plans 本来
  // 就是公开接口（未登录已在用它算 /upgrade 页价格），落地页直接复用同一份
  // 数据源，不会和升级页的数字对不上。
  // The pricing cards used to show only feature lists with no numbers at all —
  // a product built on "transparency" hiding its own price behind a signup
  // felt contradictory. GET /api/payments/plans is already public (unauthenticated
  // callers use it to price the /upgrade page), so the landing page reuses the
  // exact same source instead of risking a second, drifting set of numbers.
  const [monthlyPrice, setMonthlyPrice] = useState<number | null>(null)
  useEffect(() => {
    paymentApi.getPlans()
      .then((r) => {
        const monthly = r.plans.find((p) => p.days === 30)
        if (monthly) setMonthlyPrice(monthly.price_usd)
      })
      .catch(() => {})
  }, [])

  return (
    <section ref={ref} id="pricing" className="mx-auto max-w-[960px] scroll-mt-24 px-4 py-14 sm:px-5 sm:py-20">
      <SectionHead eyebrow={t('landing.tdEyebrow')} title={t('landing.tdTitle')} subtitle={t('landing.prSubtitle')} />
      <div className="mt-10 grid grid-cols-1 gap-5 sm:mt-14 sm:grid-cols-2">
        {/* FREE 等级 */}
        <div className="reveal glass-card flex flex-col p-6 sm:p-8">
          <div className="flex items-baseline justify-between">
            <span className="font-display text-2xl font-bold text-white">{t('landing.prFreeName')}</span>
            <span className="text-[11px] uppercase tracking-[0.18em] text-neutral-500">{t('landing.prFreeTag')}</span>
          </div>
          <div className="mt-3 flex items-baseline gap-1">
            <span className="font-display text-4xl font-black text-white">$0</span>
          </div>
          <p className="mt-2 text-sm text-neutral-500">{t('landing.badge')}</p>
          <ul className="mt-7 space-y-3">
            {freeFeatures.map((k) => (
              <li key={k} className="flex gap-2.5 text-[13.5px] leading-relaxed text-neutral-400">
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-neutral-500" />
                {t(`landing.${k}`)}
              </li>
            ))}
          </ul>
          <button onClick={() => navigate('/login?mode=register')} className="mt-auto w-full rounded-xl border border-white/10 py-3 text-[14px] font-semibold text-white transition-all hover:border-violet-400/40 hover:bg-violet-500/10">
            {t('landing.getStarted')}
          </button>
        </div>
        {/* PRO 等级 */}
        <div className="reveal reveal-d1 relative flex flex-col rounded-2xl border border-violet-500/30 bg-gradient-to-b from-violet-500/[0.08] to-white/[0.01] p-6 shadow-[0_0_60px_-15px_rgba(139,92,246,0.4)] sm:p-8">
          <div className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-violet-500 px-4 py-1 text-[10px] font-bold uppercase tracking-wider text-white shadow-[0_0_20px_rgba(139,92,246,0.5)]">
            RECOMMENDED
          </div>
          <div className="flex items-baseline justify-between">
            <span className="font-display text-2xl font-bold text-white">{t('landing.prProName')}</span>
            <span className="text-[11px] uppercase tracking-[0.18em] text-violet-300">{t('landing.prProTag')}</span>
          </div>
          <div className="mt-3 flex items-baseline gap-1.5">
            <span className="font-display text-4xl font-black text-white">
              {monthlyPrice != null ? `$${monthlyPrice}` : '—'}
            </span>
            <span className="text-sm text-neutral-400">/{t('landing.prPerMonth')}</span>
          </div>

          <ul className="mt-7 space-y-3">
            {proFeatures.map((k) => (
              <li key={k} className="flex gap-2.5 text-[13.5px] leading-relaxed text-neutral-200">
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-violet-400 shadow-[0_0_8px_currentColor]" />
                {t(`landing.${k}`)}
              </li>
            ))}
          </ul>
          <button onClick={() => navigate('/login?mode=register')} className="btn btn-primary mt-auto h-12 w-full text-[14px]">
            {t('landing.prCta')}
          </button>
        </div>
      </div>
      <p className="reveal mt-6 text-center text-[12.5px] text-neutral-600">{t('landing.prNote')}</p>
    </section>
  )
}

/* ═══════════════ Final CTA ═══════════════ */
function FinalCta({ t, navigate }: { t: T; navigate: ReturnType<typeof useNavigate> }) {
  const ref = useReveal<HTMLDivElement>()
  return (
    <section ref={ref} className="mx-auto max-w-[1180px] px-4 pb-16 pt-8 sm:px-5 sm:pb-24 sm:pt-10">
      <div className="reveal relative overflow-hidden rounded-3xl border border-white/[0.08] bg-gradient-to-b from-violet-500/[0.06] to-white/[0.01] px-6 py-12 text-center sm:px-16 sm:py-16">
        <div className="pointer-events-none absolute left-1/2 top-0 h-64 w-64 -translate-x-1/2 -translate-y-1/2 rounded-full bg-violet-500/20 blur-[100px]" />
        <h2 className="relative font-display text-[clamp(1.9rem,4vw,3rem)] font-bold tracking-[-0.02em] text-white">{t('landing.ctaTitle')}</h2>
        <p className="relative mx-auto mt-4 max-w-md text-[15px] leading-relaxed text-neutral-400">{t('landing.ctaSubtitle')}</p>
        <button onClick={() => navigate('/login?mode=register')} className="btn btn-primary group relative mt-9 h-12 overflow-hidden px-9 text-[15px]">
          <span className="relative z-10">{t('landing.ctaButton')}</span>
          <span className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/25 to-transparent transition-transform duration-700 group-hover:translate-x-full" />
        </button>
        <p className="relative mt-4 text-[12.5px] text-neutral-600">{t('landing.ctaNote')}</p>
      </div>
    </section>
  )
}

/* ═══════════════ Footer ═══════════════ */
function Foot({ t }: { t: T }) {
  const links = [
    { h: '#showcase', k: 'navShowcase' },
    { h: '#guard', k: 'navWinrate' },
    { h: '#pricing', k: 'navPricing' },
    { h: '#faq', k: 'navFaq' },
  ]
  return (
    <footer className="border-t border-white/[0.06] px-4 py-12 sm:px-5 sm:py-14">
      <div className="mx-auto flex max-w-[1180px] flex-col items-center text-center">
        {/* 品牌 / brand */}
        <div className="flex items-center gap-2.5">
          <Logo size={24} />
          <span className="text-base font-semibold tracking-tight">Signal Lab</span>
          <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-neutral-500">by PRISMX</span>
        </div>

        {/* 导航链接 / nav links */}
        <nav className="mt-6 flex flex-wrap justify-center gap-x-7 gap-y-3">
          {links.map((l) => (
            <a key={l.h} href={l.h} className="text-[13px] text-neutral-400 transition-colors hover:text-white">
              {t(`landing.${l.k}`)}
            </a>
          ))}
        </nav>

        {/* 版权 / copyright */}
        <p className="mt-8 text-[12px] text-neutral-600">© {new Date().getFullYear()} PRISMX · {t('landing.footerRights')}</p>

        {/* 风险提示 / risk disclaimer */}
        <p className="mt-6 max-w-3xl border-t border-white/[0.05] pt-6 text-[11.5px] leading-relaxed text-neutral-600">{t('landing.footerRisk')}</p>
      </div>
    </footer>
  )
}

/* ═══════════════ 主页 / page ═══════════════ */
export default function LandingPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  return (
    <div className="relative min-h-screen bg-[#05030c] text-white">
      {/* 整页固定极光流体背景 / page-wide fixed aurora backdrop */}
      <div className="pointer-events-none fixed inset-0 z-0">
        <Suspense fallback={null}>
          <PrismScene />
        </Suspense>
        {/* 整体压暗，保证下方各分区文字可读 / global dim for legibility */}
        <div className="absolute inset-0 bg-[#05030c]/45" />
      </div>

      {/* 内容层 / content layer above the backdrop */}
      <div className="relative z-10">
        <Navbar t={t} navigate={navigate} />
        <Hero t={t} navigate={navigate} />
        <Stats t={t} />
        <Showcase t={t} />
        <Guard t={t} />
        <Truths t={t} />
        <Pricing t={t} navigate={navigate} />
        <FaqSection />
        <FinalCta t={t} navigate={navigate} />
        <Foot t={t} />
        <MobileStickyCta />
      </div>
    </div>
  )
}
