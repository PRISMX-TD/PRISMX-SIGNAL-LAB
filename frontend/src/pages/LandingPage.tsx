// 未登录主页 / Public landing page
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import Logo from '../components/Logo'
import LanguageToggle from '../components/LanguageToggle'
import AuroraBackground from '../components/AuroraBackground'

// 功能图标 / inline feature icons
function Icon({ name }: { name: string }) {
  const common = 'h-6 w-6'
  switch (name) {
    case 'engine':
      return (
        <svg className={common} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M3 17l5-5 4 4 8-9" /><path d="M3 21h18" /></svg>
      )
    case 'bolt':
      return (
        <svg className={common} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z" /></svg>
      )
    case 'receipt':
      return (
        <svg className={common} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M5 3v18l2-1 2 1 2-1 2 1 2-1 2 1V3l-2 1-2-1-2 1-2-1-2 1-2-1z" /><path d="M9 8h6M9 12h6" /></svg>
      )
    case 'layers':
      return (
        <svg className={common} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2l9 5-9 5-9-5 9-5z" /><path d="M3 12l9 5 9-5M3 17l9 5 9-5" /></svg>
      )
    case 'shield':
      return (
        <svg className={common} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2l8 3v6c0 5-3.5 8.5-8 11-4.5-2.5-8-6-8-11V5l8-3z" /><path d="M9 12l2 2 4-4" /></svg>
      )
    case 'gauge':
      return (
        <svg className={common} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M12 13l4-4" /><path d="M3 18a9 9 0 1 1 18 0" /></svg>
      )
    default:
      return null
  }
}

export default function LandingPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()

  const features = [
    { icon: 'engine', title: 'f1Title', desc: 'f1Desc' },
    { icon: 'bolt', title: 'f2Title', desc: 'f2Desc' },
    { icon: 'receipt', title: 'f3Title', desc: 'f3Desc' },
    { icon: 'layers', title: 'f4Title', desc: 'f4Desc' },
    { icon: 'gauge', title: 'f5Title', desc: 'f5Desc' },
    { icon: 'shield', title: 'f6Title', desc: 'f6Desc' },
  ]

  const steps = [
    { title: 'step1Title', desc: 'step1Desc' },
    { title: 'step2Title', desc: 'step2Desc' },
    { title: 'step3Title', desc: 'step3Desc' },
  ]

  return (
    <div className="relative min-h-screen overflow-x-hidden">
      <AuroraBackground />

      {/* 顶部导航 / top nav */}
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
            <a href="#features" className="rounded-lg px-3 py-2 text-sm text-slate-400 transition hover:text-slate-100">{t('landing.navFeatures')}</a>
            <a href="#how" className="rounded-lg px-3 py-2 text-sm text-slate-400 transition hover:text-slate-100">{t('landing.navHow')}</a>
          </nav>

          <div className="ml-auto flex items-center gap-3">
            <LanguageToggle />
            <button onClick={() => navigate('/login')} className="btn-ghost px-4 py-1.5 text-sm">
              {t('landing.signIn')}
            </button>
            <button onClick={() => navigate('/login?mode=register')} className="btn-primary hidden px-4 py-1.5 text-sm sm:inline-flex">
              {t('landing.getStarted')}
            </button>
          </div>
        </div>
      </header>

      {/* 英雄区 / hero */}
      <section className="relative mx-auto max-w-7xl px-4 pb-16 pt-20 text-center sm:px-6 sm:pt-28">
        <div className="mx-auto inline-flex animate-fade-in-up">
          <span className="chip animate-glow-pulse">
            <span className="h-1.5 w-1.5 rounded-full bg-neon-cyan animate-breathe" />
            {t('landing.badge')}
          </span>
        </div>

        <h1 className="mx-auto mt-6 max-w-4xl animate-fade-in-up font-display text-4xl font-black leading-tight tracking-tight text-slate-50 sm:text-6xl">
          {t('landing.heroTitle1')}{' '}
          <span className="neon-text animate-gradient-x">{t('landing.heroTitle2')}</span>
        </h1>

        <p className="mx-auto mt-6 max-w-2xl animate-fade-in-up text-base leading-relaxed text-slate-400 sm:text-lg">
          {t('landing.heroSubtitle')}
        </p>

        <div className="mt-9 flex animate-fade-in-up flex-col items-center justify-center gap-3 sm:flex-row">
          <button onClick={() => navigate('/login?mode=register')} className="btn-primary w-full px-7 py-3 text-base sm:w-auto">
            {t('landing.ctaPrimary')}
          </button>
          <a href="#features" className="btn-ghost w-full px-7 py-3 text-base sm:w-auto">
            {t('landing.ctaSecondary')}
          </a>
        </div>

        {/* 数据指标 / stat strip */}
        <div className="mx-auto mt-14 grid max-w-2xl grid-cols-3 gap-4">
          {[
            { v: '24/7', k: 'statSignals' },
            { v: '<200', k: 'statLatency' },
            { v: '99.9%', k: 'statUptime' },
          ].map((s) => (
            <div key={s.k} className="glass px-3 py-5">
              <div className="font-display text-2xl font-bold text-slate-50 sm:text-3xl">{s.v}</div>
              <div className="mt-1 text-xs text-slate-400">{t(`landing.${s.k}`)}</div>
            </div>
          ))}
        </div>

        <p className="mt-10 text-xs uppercase tracking-[0.25em] text-slate-600">{t('landing.trustedBy')}</p>
      </section>

      {/* 功能区 / features */}
      <section id="features" className="mx-auto max-w-7xl scroll-mt-20 px-4 py-20 sm:px-6">
        <div className="mb-12 text-center">
          <h2 className="font-display text-3xl font-bold text-slate-50 sm:text-4xl">{t('landing.featuresTitle')}</h2>
          <p className="mx-auto mt-3 max-w-xl text-slate-400">{t('landing.featuresSubtitle')}</p>
        </div>
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {features.map((f) => (
            <div key={f.title} className="glass-neon group p-6">
              <div className="mb-4 inline-flex h-12 w-12 items-center justify-center rounded-xl border border-prism-500/30 bg-prism-600/15 text-prism-300 transition group-hover:text-neon-cyan group-hover:shadow-neon-cyan">
                <Icon name={f.icon} />
              </div>
              <h3 className="mb-2 font-display text-lg font-semibold text-slate-100">{t(`landing.${f.title}`)}</h3>
              <p className="text-sm leading-relaxed text-slate-400">{t(`landing.${f.desc}`)}</p>
            </div>
          ))}
        </div>
      </section>

      {/* 运作方式 / how it works */}
      <section id="how" className="mx-auto max-w-7xl scroll-mt-20 px-4 py-20 sm:px-6">
        <div className="mb-12 text-center">
          <h2 className="font-display text-3xl font-bold text-slate-50 sm:text-4xl">{t('landing.howTitle')}</h2>
          <p className="mx-auto mt-3 max-w-xl text-slate-400">{t('landing.howSubtitle')}</p>
        </div>
        <div className="grid grid-cols-1 gap-5 md:grid-cols-3">
          {steps.map((s, i) => (
            <div key={s.title} className="glass relative p-6">
              <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-neon-gradient font-display text-xl font-bold text-white shadow-prism">
                {i + 1}
              </div>
              <h3 className="mb-2 font-display text-lg font-semibold text-slate-100">{t(`landing.${s.title}`)}</h3>
              <p className="text-sm leading-relaxed text-slate-400">{t(`landing.${s.desc}`)}</p>
              {i < steps.length - 1 && (
                <div className="absolute right-[-10px] top-1/2 hidden h-px w-5 bg-prism-500/40 md:block" />
              )}
            </div>
          ))}
        </div>
      </section>

      {/* 行动召唤 / CTA */}
      <section className="mx-auto max-w-7xl px-4 py-20 sm:px-6">
        <div className="glass relative overflow-hidden px-6 py-14 text-center sm:px-12">
          <div className="pointer-events-none absolute -right-20 -top-20 h-64 w-64 rounded-full bg-prism-600/30 blur-[100px]" />
          <div className="pointer-events-none absolute -bottom-20 -left-20 h-64 w-64 rounded-full bg-neon-cyan/20 blur-[100px]" />
          <h2 className="relative font-display text-3xl font-bold text-slate-50 sm:text-4xl">{t('landing.ctaTitle')}</h2>
          <p className="relative mx-auto mt-3 max-w-lg text-slate-400">{t('landing.ctaSubtitle')}</p>
          <button onClick={() => navigate('/login?mode=register')} className="btn-primary relative mt-8 px-8 py-3 text-base">
            {t('landing.ctaButton')}
          </button>
        </div>
      </section>

      {/* 页脚 / footer */}
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
    </div>
  )
}
