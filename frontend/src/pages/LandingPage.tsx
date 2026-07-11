// 全新 3D 首页：棱镜叙事 → 行业解剖 → 信号管线 → 纪律引擎 → 双门定价
// New 3D landing: Prism Hero → Industry Expose → Signal Pipeline → Discipline Engine → Two Doors
import { Suspense } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import Logo from '../components/Logo'
import LanguageToggle from '../components/LanguageToggle'
import AuroraBackground from '../components/AuroraBackground'
import FaqSection from '../components/landing/FaqSection'
import MobileStickyCta from '../components/landing/MobileStickyCta'

/* ── 3D 组件（Canvas 内部用 Suspense 处理异步加载，Three.js 不阻塞首屏）── */
import PrismHero from '../components/landing3d/PrismHero'
import IndustryExpose from '../components/landing3d/IndustryExpose'
import SignalPipeline from '../components/landing3d/SignalPipeline'
import DisciplineEngine from '../components/landing3d/DisciplineEngine'
import TwoDoors from '../components/landing3d/TwoDoors'

export default function LandingPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()

  const steps = [
    { title: 'step1Title', desc: 'step1Desc' },
    { title: 'step2Title', desc: 'step2Desc' },
    { title: 'step3Title', desc: 'step3Desc' },
  ]

  return (
    <div className="relative min-h-screen overflow-x-clip bg-ink-950">
      <AuroraBackground />

      {/* 顶部导航 */}
      <header className="sticky top-0 z-40 border-b border-white/10 bg-ink-950/60 backdrop-blur-xl">
        <div className="mx-auto flex max-w-7xl items-center gap-4 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-2.5">
            <Logo size={32} />
            <div className="leading-tight">
              <div className="font-display text-base font-bold tracking-wider text-slate-100">PRISMX</div>
              <div className="text-[10px] uppercase tracking-[0.2em] text-prism-400">Signal Lab</div>
            </div>
          </div>

          <nav className="ml-6 hidden items-center gap-1 md:flex">
            <a href="#compare" className="rounded-lg px-3 py-2 text-sm text-slate-400 transition hover:text-slate-100">{t('landing.navCompare')}</a>
            <a href="#pipeline" className="rounded-lg px-3 py-2 text-sm text-slate-400 transition hover:text-slate-100">{t('landing.navShowcase')}</a>
            <a href="#discipline" className="rounded-lg px-3 py-2 text-sm text-slate-400 transition hover:text-slate-100">{t('landing.navWinrate')}</a>
            <a href="#pricing" className="rounded-lg px-3 py-2 text-sm text-slate-400 transition hover:text-slate-100">{t('landing.navPricing')}</a>
            <a href="#faq" className="rounded-lg px-3 py-2 text-sm text-slate-400 transition hover:text-slate-100">{t('landing.navFaq')}</a>
          </nav>

          <div className="ml-auto flex items-center gap-3">
            <LanguageToggle />
            <button onClick={() => navigate('/login')} className="rounded-lg border border-white/15 px-4 py-1.5 text-sm text-slate-300 transition hover:border-white/30 hover:text-white">
              {t('landing.signIn')}
            </button>
            <button onClick={() => navigate('/login?mode=register')} className="hidden rounded-lg bg-neon-gradient px-4 py-1.5 text-sm font-bold text-white transition hover:shadow-prism sm:inline-flex">
              {t('landing.getStarted')}
            </button>
          </div>
        </div>
      </header>

      {/* 第一幕：3D 棱镜 Hero */}
      <PrismHero />

      {/* 信任指标条 / trust bar */}
      <section className="mx-auto max-w-7xl px-4 py-10 sm:px-6">
        <div className="grid grid-cols-3 gap-4">
          {[
            { v: '0', k: 'stat1' },
            { v: '24/7', k: 'stat2' },
            { v: '100%', k: 'stat3' },
          ].map((s) => (
            <div key={s.k} className="glass px-3 py-5 text-center">
              <div className="font-display text-2xl font-bold text-slate-50 sm:text-3xl">{s.v}</div>
              <div className="mt-1 text-xs text-slate-400">{t(`landing.${s.k}`)}</div>
            </div>
          ))}
        </div>
        <p className="mt-8 text-center text-xs uppercase tracking-[0.25em] text-slate-600">{t('landing.statFootnote')}</p>
      </section>

      {/* 第二幕：行业解剖 */}
      <IndustryExpose />

      {/* 第三幕：信号管线 */}
      <Suspense fallback={<div className="h-[580px] animate-pulse bg-ink-900/50 rounded-card mx-auto max-w-7xl" />}>
        <SignalPipeline />
      </Suspense>

      {/* 第四幕：纪律引擎 */}
      <Suspense fallback={<div className="h-[580px] animate-pulse bg-ink-900/50 rounded-card mx-auto max-w-7xl" />}>
        <DisciplineEngine />
      </Suspense>

      {/* 第五幕：双门定价 */}
      <Suspense fallback={<div className="h-[580px] animate-pulse bg-ink-900/50 rounded-card mx-auto max-w-7xl" />}>
        <TwoDoors />
      </Suspense>

      {/* 三步接入 / getting started */}
      <section id="how" className="mx-auto max-w-7xl scroll-mt-20 px-4 py-20 sm:px-6">
        <div className="reveal mb-12 text-center">
          <span className="eyebrow">{t('landing.howEyebrow')}</span>
          <h2 className="mt-3 font-display text-3xl font-bold text-slate-50 sm:text-4xl">{t('landing.howTitle')}</h2>
          <p className="mx-auto mt-3 max-w-xl text-slate-400">{t('landing.howSubtitle')}</p>
        </div>
        <div className="grid grid-cols-1 gap-5 md:grid-cols-3">
          {steps.map((s, i) => (
            <div key={s.title} className={`reveal ${i === 1 ? 'reveal-d1' : i === 2 ? 'reveal-d2' : ''} glass relative p-6`}>
              <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-neon-gradient font-display text-xl font-bold text-white shadow-prism">
                {i + 1}
              </div>
              <h3 className="mb-2 font-display text-lg font-semibold text-slate-100">{t(`landing.${s.title}`)}</h3>
              <p className="text-sm leading-relaxed text-slate-400">{t(`landing.${s.desc}`)}</p>
            </div>
          ))}
        </div>
      </section>

      {/* FAQ */}
      <FaqSection />

      {/* 底部 CTA */}
      <section className="mx-auto max-w-7xl px-4 py-20 sm:px-6">
        <div className="reveal glass relative overflow-hidden px-6 py-14 text-center sm:px-12 rounded-card">
          <div className="pointer-events-none absolute -right-20 -top-20 h-64 w-64 rounded-full bg-prism-600/30 blur-[100px]" />
          <div className="pointer-events-none absolute -bottom-20 -left-20 h-64 w-64 rounded-full bg-prism-700/20 blur-[100px]" />
          <h2 className="relative font-display text-3xl font-bold text-slate-50 sm:text-4xl">{t('landing.ctaTitle')}</h2>
          <p className="relative mx-auto mt-3 max-w-lg text-slate-400">{t('landing.ctaSubtitle')}</p>
          <button onClick={() => navigate('/login?mode=register')} className="relative mt-8 rounded-full bg-neon-gradient px-8 py-3.5 text-base font-bold text-white shadow-prism transition-all hover:shadow-prism-lg hover:scale-105">
            {t('landing.ctaButton')}
          </button>
          <p className="relative mt-3 text-xs text-slate-500">{t('landing.ctaNote')}</p>
        </div>
      </section>

      {/* 页脚 */}
      <footer className="border-t border-white/10 bg-ink-950/60 backdrop-blur-xl">
        <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
          <div className="flex flex-col items-center justify-between gap-4 sm:flex-row">
            <div className="flex items-center gap-2.5">
              <Logo size={26} />
              <span className="font-display text-sm font-bold tracking-wider text-slate-200">PRISMX Signal Lab</span>
            </div>
            <p className="text-xs text-slate-500">© {new Date().getFullYear()} PRISMX. {t('landing.footerRights')}</p>
          </div>
          <p className="mt-4 text-center text-[11px] leading-relaxed text-slate-600 sm:text-left">{t('landing.footerRisk')}</p>
        </div>
      </footer>

      <MobileStickyCta />
    </div>
  )
}
