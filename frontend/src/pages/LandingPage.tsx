// 未登录主页 / Public landing page
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import Logo from '../components/Logo'
import LanguageToggle from '../components/LanguageToggle'
import AuroraBackground from '../components/AuroraBackground'
import HeroDemoCard from '../components/landing/HeroDemoCard'
import ComparisonSection from '../components/landing/ComparisonSection'
import PhoneShowcase from '../components/landing/PhoneShowcase'
import PricingSection from '../components/landing/PricingSection'
import WinRateRuleCard from '../components/landing/WinRateRuleCard'
import FaqSection from '../components/landing/FaqSection'
import MobileStickyCta from '../components/landing/MobileStickyCta'
import useReveal from '../components/landing/useReveal'

// 功能图标 / inline feature icons
function Icon({ name }: { name: string }) {
  const common = 'h-6 w-6'
  switch (name) {
    case 'gauge':
      return (
        <svg className={common} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M12 13l4-4" /><path d="M3 18a9 9 0 1 1 18 0" /></svg>
      )
    case 'bolt':
      return (
        <svg className={common} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z" /></svg>
      )
    case 'receipt':
      return (
        <svg className={common} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M5 3v18l2-1 2 1 2-1 2 1 2-1 2 1V3l-2 1-2-1-2 1-2-1-2 1-2-1z" /><path d="M9 8h6M9 12h6" /></svg>
      )
    default:
      return null
  }
}

export default function LandingPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  useReveal()

  const extras = [
    { icon: 'gauge', title: 'ex1Title', desc: 'ex1Desc' },
    { icon: 'bolt', title: 'ex2Title', desc: 'ex2Desc' },
    { icon: 'receipt', title: 'ex3Title', desc: 'ex3Desc' },
  ]

  const steps = [
    { title: 'step1Title', desc: 'step1Desc' },
    { title: 'step2Title', desc: 'step2Desc' },
    { title: 'step3Title', desc: 'step3Desc' },
  ]

  return (
    // overflow-x 必须用 clip：hidden 会把本容器变成 sticky 的锚定滚动容器，
    // 导致顶栏与手机样机的 position: sticky 全部失效（与 body 同款陷阱）
    <div className="relative min-h-screen overflow-x-clip">
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
            <a href="#compare" className="rounded-lg px-3 py-2 text-sm text-slate-400 transition hover:text-slate-100">{t('landing.navCompare')}</a>
            <a href="#showcase" className="rounded-lg px-3 py-2 text-sm text-slate-400 transition hover:text-slate-100">{t('landing.navShowcase')}</a>
            <a href="#winrate" className="rounded-lg px-3 py-2 text-sm text-slate-400 transition hover:text-slate-100">{t('landing.navWinrate')}</a>
            <a href="#pricing" className="rounded-lg px-3 py-2 text-sm text-slate-400 transition hover:text-slate-100">{t('landing.navPricing')}</a>
            <a href="#faq" className="rounded-lg px-3 py-2 text-sm text-slate-400 transition hover:text-slate-100">{t('landing.navFaq')}</a>
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
      <section className="relative mx-auto max-w-7xl px-4 pb-16 pt-16 sm:px-6 sm:pt-24">
        <div className="grid items-center gap-10 lg:grid-cols-[1.1fr_0.9fr]">
          <div className="text-center lg:text-left">
            <div className="mx-auto inline-flex animate-fade-in-up lg:mx-0">
              <span className="chip animate-glow-pulse">
                <span className="h-1.5 w-1.5 rounded-full bg-prism-400 animate-breathe" />
                {t('landing.badge')}
              </span>
            </div>

            <h1 className="mx-auto mt-6 max-w-2xl animate-fade-in-up font-display text-4xl font-black leading-tight tracking-tight text-slate-50 sm:text-6xl lg:mx-0">
              {t('landing.heroTitle1')}{' '}
              <span className="neon-text animate-gradient-x">{t('landing.heroTitle2')}</span>
            </h1>

            <p className="mx-auto mt-6 max-w-2xl animate-fade-in-up text-base leading-relaxed text-slate-400 sm:text-lg lg:mx-0">
              {t('landing.heroSubtitle')}
            </p>

            <div className="mt-9 flex animate-fade-in-up flex-col items-center justify-center gap-3 sm:flex-row lg:justify-start">
              <button onClick={() => navigate('/login?mode=register')} className="btn-primary w-full px-7 py-3 text-base sm:w-auto">
                {t('landing.ctaPrimary')}
              </button>
              <a href="#winrate" className="btn-ghost w-full px-7 py-3 text-base sm:w-auto">
                {t('landing.ctaSecondary')}
              </a>
            </div>

            <p className="mt-3 animate-fade-in-up text-xs text-slate-500">{t('landing.heroNote')}</p>
          </div>

          <div className="hidden sm:block">
            <HeroDemoCard />
          </div>
        </div>

        {/* 数据指标：真实事实而非营销数字 / stat strip: real facts, no made-up marketing numbers */}
        <div className="mx-auto mt-14 grid max-w-2xl grid-cols-3 gap-4 lg:mx-0 lg:max-w-none">
          {[
            { v: '0', k: 'stat1' },
            { v: '24/7', k: 'stat2' },
            { v: '100%', k: 'stat3' },
          ].map((s) => (
            <div key={s.k} className="glass px-3 py-5">
              <div className="font-display text-2xl font-bold text-slate-50 sm:text-3xl">{s.v}</div>
              <div className="mt-1 text-xs text-slate-400">{t(`landing.${s.k}`)}</div>
            </div>
          ))}
        </div>

        <p className="mt-10 text-center text-xs uppercase tracking-[0.25em] text-slate-600 lg:text-left">{t('landing.statFootnote')}</p>
      </section>

      {/* 移动端补位示例卡 / mobile fallback demo card */}
      <section className="mx-auto max-w-7xl px-4 sm:hidden">
        <HeroDemoCard />
      </section>

      {/* 信号群对比区 / signal-group comparison */}
      <ComparisonSection />

      {/* 3D 手机滚动叙事 / 3D phone scrollytelling */}
      <PhoneShowcase />

      {/* 细节兜底 / defensive details */}
      <section className="mx-auto max-w-7xl px-4 py-20 sm:px-6">
        <div className="reveal mb-12 text-center">
          <span className="eyebrow">{t('landing.exEyebrow')}</span>
          <h2 className="mt-3 font-display text-3xl font-bold text-slate-50 sm:text-4xl">{t('landing.exTitle')}</h2>
        </div>
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-3">
          {extras.map((f, i) => (
            <div key={f.title} className={`reveal ${i === 1 ? 'reveal-d1' : i === 2 ? 'reveal-d2' : ''} glass-neon group p-6`}>
              <div className="mb-4 inline-flex h-12 w-12 items-center justify-center rounded-inner border border-prism-500/30 bg-prism-600/15 text-prism-300 transition group-hover:text-prism-200 group-hover:shadow-prism">
                <Icon name={f.icon} />
              </div>
              <h3 className="mb-2 font-display text-lg font-semibold text-slate-100">{t(`landing.${f.title}`)}</h3>
              <p className="text-sm leading-relaxed text-slate-400">{t(`landing.${f.desc}`)}</p>
            </div>
          ))}
        </div>
      </section>

      {/* 透明胜率区 / win rate */}
      <section id="winrate" className="mx-auto max-w-7xl scroll-mt-20 px-4 py-20 sm:px-6">
        <div className="reveal mb-12 text-center">
          <span className="eyebrow">{t('landing.wrEyebrow')}</span>
          <h2 className="mt-3 font-display text-3xl font-bold text-slate-50 sm:text-4xl">{t('landing.wrTitle')}</h2>
          <p className="mx-auto mt-3 max-w-xl text-slate-400">{t('landing.wrSubtitle')}</p>
        </div>

        <div className="grid items-start gap-8 lg:grid-cols-2">
          <div className="reveal">
            <div className="space-y-1">
              {(['wrRule1', 'wrRule2', 'wrRule3', 'wrRule4'] as const).map((key) => {
                const mark =
                  key === 'wrRule1' ? { glyph: '✓', color: 'var(--up)' }
                  : key === 'wrRule2' ? { glyph: '✗', color: 'var(--down)' }
                  : key === 'wrRule3' ? { glyph: '⚠', color: 'var(--gold)' }
                  : { glyph: '—', color: '#64748b' }
                return (
                  <div key={key} className="flex items-start gap-3 py-2">
                    <span className="mt-0.5 shrink-0 text-sm font-bold" style={{ color: mark.color }}>
                      {mark.glyph}
                    </span>
                    <div>
                      <p className="text-sm text-slate-300">{t(`landing.${key}`)}</p>
                      <p className="mt-0.5 text-xs text-slate-500">{t(`landing.${key}Note`)}</p>
                    </div>
                  </div>
                )
              })}
            </div>
            <p className="mt-6 text-xs text-slate-500">{t('landing.wrNote')}</p>
            <button onClick={() => navigate('/login?mode=register')} className="btn-primary mt-6 px-7 py-3 text-base">
              {t('landing.wrCta')}
            </button>
          </div>

          <div className="reveal reveal-d1">
            <WinRateRuleCard />
          </div>
        </div>
      </section>

      {/* 定价 / pricing */}
      <PricingSection />

      {/* 运作方式 / how it works */}
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
              {i < steps.length - 1 && (
                <div className="absolute right-[-10px] top-1/2 hidden h-px w-5 bg-prism-500/40 md:block" />
              )}
            </div>
          ))}
        </div>
      </section>

      {/* 常见问题 / FAQ */}
      <FaqSection />

      {/* 行动召唤 / CTA */}
      <section className="mx-auto max-w-7xl px-4 py-20 sm:px-6">
        <div className="reveal glass relative overflow-hidden px-6 py-14 text-center sm:px-12">
          <div className="pointer-events-none absolute -right-20 -top-20 h-64 w-64 rounded-full bg-prism-600/30 blur-[100px]" />
          <div className="pointer-events-none absolute -bottom-20 -left-20 h-64 w-64 rounded-full bg-prism-700/20 blur-[100px]" />
          <h2 className="relative font-display text-3xl font-bold text-slate-50 sm:text-4xl">{t('landing.ctaTitle')}</h2>
          <p className="relative mx-auto mt-3 max-w-lg text-slate-400">{t('landing.ctaSubtitle')}</p>
          <button onClick={() => navigate('/login?mode=register')} className="btn-primary relative mt-8 px-8 py-3 text-base">
            {t('landing.ctaButton')}
          </button>
          <p className="relative mt-3 text-xs text-slate-500">{t('landing.ctaNote')}</p>
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

      <MobileStickyCta />
    </div>
  )
}
