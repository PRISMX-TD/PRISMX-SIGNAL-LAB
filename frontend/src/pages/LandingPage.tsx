// PRISMX Signal Lab · Product-forward · Inspired by Stripe + Robinhood 2024
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import Logo from '../components/Logo'
import LanguageToggle from '../components/LanguageToggle'
import FaqSection from '../components/landing/FaqSection'
import MobileStickyCta from '../components/landing/MobileStickyCta'

/* ── 滚动渐现 ── */
function Re({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const [v, setV] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const o = new IntersectionObserver(([e]) => { if (e.isIntersecting) setV(true) }, { threshold: 0.1, rootMargin: '0px 0px -30px 0px' })
    o.observe(el)
    return () => o.disconnect()
  }, [])
  return <div ref={ref} className={`transition-all duration-700 ${v ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'} ${className}`}>{children}</div>
}

/* ── 导航 ── */
function Navbar({ t, navigate }: { t: (k: string) => string; navigate: ReturnType<typeof useNavigate> }) {
  const [s, setS] = useState(false)
  useEffect(() => { const h = () => setS(window.scrollY > 20); window.addEventListener('scroll', h, { passive: true }); return () => window.removeEventListener('scroll', h) }, [])
  return (
    <header className={`fixed inset-x-0 top-0 z-50 transition-all duration-300 ${s ? 'border-b border-white/[0.05] bg-[#07080D]/80 backdrop-blur-2xl' : ''}`}>
      <div className="mx-auto flex h-14 max-w-[1200px] items-center gap-6 px-5">
        <a href="#" className="flex items-center gap-2.5"><Logo size={26} /><span className="text-sm font-semibold tracking-wide">PRISMX</span><span className="text-[10px] uppercase tracking-[0.18em] text-neutral-600">Signal Lab</span></a>
        <nav className="ml-2 hidden items-center gap-1 md:flex">
          {[{ h: '#product', k: 'navShowcase' }, { h: '#guard', k: 'navWinrate' }, { h: '#pricing', k: 'navPricing' }, { h: '#faq', k: 'navFaq' }].map(l => <a key={l.h} href={l.h} className="rounded-md px-3 py-2 text-[13px] text-neutral-500 transition-colors hover:text-white">{t(`landing.${l.k}`)}</a>)}
        </nav>
        <div className="ml-auto flex items-center gap-2"><LanguageToggle /><button onClick={() => navigate('/login')} className="rounded-md px-3 py-2 text-[13px] text-neutral-500 transition-colors hover:text-white">{t('landing.signIn')}</button><button onClick={() => navigate('/login?mode=register')} className="rounded-lg bg-white px-4 py-2 text-[13px] font-semibold text-black transition-all hover:scale-[1.03]">{t('landing.getStarted')}</button></div>
      </div>
    </header>
  )
}

/* ── Footer ── */
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

/* ── 模拟信号卡片（产品预览） ── */
function SignalCardMockup({ symbol, direction, entry, sl, tp, rr, accent = false }: { symbol: string; direction: string; entry: string; sl: string; tp: string; rr: string; accent?: boolean }) {
  const dirColor = direction === 'BUY' ? 'text-emerald-400' : 'text-red-400'
  const dirBg = direction === 'BUY' ? 'bg-emerald-400/10' : 'bg-red-400/10'
  return (
    <div className={`rounded-xl border px-4 py-3.5 backdrop-blur transition-all duration-300 hover:scale-[1.02] ${accent ? 'border-violet-500/30 bg-violet-500/[0.04]' : 'border-white/[0.05] bg-white/[0.02]'}`}>
      <div className="flex items-center justify-between mb-2.5">
        <span className="font-mono text-[11px] font-semibold tracking-wider text-white/80">{symbol}</span>
        <span className={`rounded px-1.5 py-0.5 font-mono text-[10px] font-bold ${dirColor} ${dirBg}`}>{direction}</span>
      </div>
      <div className="grid grid-cols-4 gap-2 text-center">
        <div><div className="text-[10px] text-neutral-600">ENTRY</div><div className="mt-0.5 font-mono text-[13px] font-medium">{entry}</div></div>
        <div><div className="text-[10px] text-neutral-600">SL</div><div className="mt-0.5 font-mono text-[13px] font-medium text-red-400">{sl}</div></div>
        <div><div className="text-[10px] text-neutral-600">TP</div><div className="mt-0.5 font-mono text-[13px] font-medium text-emerald-400">{tp}</div></div>
        <div><div className="text-[10px] text-neutral-600">R:R</div><div className="mt-0.5 font-mono text-[13px] font-medium text-violet-400">{rr}</div></div>
      </div>
    </div>
  )
}

/* ── 产品面板 Mockup（hero 右侧） ── */
function ProductPanel() {
  return (
    <div className="w-full max-w-[420px] animate-fadein">
      <div className="rounded-2xl border border-white/[0.06] bg-[#0D0E14]/70 backdrop-blur-xl p-4">
        {/* 顶部栏 */}
        <div className="flex items-center gap-2 mb-4 pb-3 border-b border-white/[0.04]">
          <div className="flex gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-red-400/60" /><span className="h-2.5 w-2.5 rounded-full bg-amber-400/60" /><span className="h-2.5 w-2.5 rounded-full bg-emerald-400/60" /></div>
          <span className="ml-2 font-mono text-[10px] text-neutral-600">PRISMX · Signal Panel</span>
          <span className="ml-auto flex h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
        </div>
        {/* 账户摘要 */}
        <div className="flex items-center justify-between mb-3 px-1">
          <div><div className="text-[9px] uppercase tracking-wider text-neutral-600">Account</div><div className="font-mono text-xs font-medium mt-1">MT5 · Demo</div></div>
          <div className="text-right"><div className="text-[9px] uppercase tracking-wider text-neutral-600">Balance</div><div className="font-mono text-xs font-medium mt-1 text-emerald-400">$10,000.00</div></div>
        </div>
        {/* 信号列表 */}
        <div className="flex flex-col gap-2.5">
          <SignalCardMockup symbol="XAUUSD" direction="BUY" entry="2,340.60" sl="2,320.80" tp="2,368.80" rr="1:2.2" accent />
          <SignalCardMockup symbol="EURUSD" direction="SELL" entry="1.0852" sl="1.0890" tp="1.0785" rr="1:1.8" />
        </div>
        {/* 底部按钮 */}
        <div className="mt-3 flex gap-2">
          <div className="flex-1 rounded-lg border border-white/[0.06] py-1.5 text-center text-[10px] font-medium text-neutral-500">SEND TO MT5</div>
          <div className="flex-1 rounded-lg bg-violet-500/20 border border-violet-500/30 py-1.5 text-center text-[10px] font-medium text-violet-300">SENT ✓</div>
        </div>
      </div>
    </div>
  )
}

/* ── 流水线步骤卡 ── */
function StepCard({ n, t: title, d }: { n: string; t: string; d: string }) {
  return (
    <div className="rounded-xl border border-white/[0.05] bg-white/[0.01] p-5 transition-all duration-300 hover:border-white/[0.1]">
      <span className="font-mono text-[10px] font-semibold text-neutral-700">{n}</span>
      <h3 className="mt-2 text-sm font-semibold">{title}</h3>
      <p className="mt-1 text-[13px] leading-relaxed text-neutral-500">{d}</p>
    </div>
  )
}

/* ── 主页 ── */
export default function LandingPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()

  return (
    <div className="min-h-screen bg-[#07080D] text-white selection:bg-violet-500/30">
      <Navbar t={t} navigate={navigate} />

      {/* ═══ HERO: 左边文字 + 右边产品面板 ═══ */}
      <section className="relative mx-auto flex min-h-[92vh] max-w-[1200px] flex-col items-center justify-center gap-10 px-5 pt-16 lg:flex-row lg:gap-16">
        {/* 背景柔光 */}
        <div className="pointer-events-none absolute inset-0 overflow-hidden">
          <div className="absolute right-[-10%] top-[10%] h-[600px] w-[600px] rounded-full bg-violet-600/[0.06] blur-[120px]" />
          <div className="absolute left-[-5%] bottom-[15%] h-[400px] w-[400px] rounded-full bg-cyan-500/[0.04] blur-[100px]" />
        </div>

        {/* 左：文字 */}
        <Re className="relative z-10 flex flex-col items-start max-w-lg lg:items-start">
          <span className="inline-flex items-center gap-2 rounded-full border border-white/[0.08] bg-white/[0.03] px-3.5 py-1.5 text-[11px] text-neutral-400 mb-6">
            <span className="h-1.5 w-1.5 rounded-full bg-violet-400" />
            {t('landing.badge')}
          </span>
          <h1 className="font-display text-4xl font-bold leading-[1.08] tracking-[-0.02em] sm:text-5xl lg:text-6xl">
            {t('landing.heroTitle1')}
            <br />
            <span className="text-violet-400">{t('landing.heroTitle2')}</span>
          </h1>
          <p className="mt-5 text-[15px] leading-relaxed text-neutral-400 sm:text-base max-w-md">{t('landing.heroSubtitle')}</p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <button onClick={() => navigate('/login?mode=register')} className="rounded-xl bg-white px-7 py-3 text-[15px] font-semibold text-black transition-all hover:scale-[1.03] hover:bg-neutral-100">{t('landing.ctaPrimary')}</button>
            <a href="#product" className="text-[14px] text-neutral-600 underline-offset-4 transition hover:text-neutral-400 hover:underline">{t('landing.ctaSecondary')}</a>
          </div>
          <p className="mt-4 text-[13px] text-neutral-700">{t('landing.heroNote')}</p>
        </Re>

        {/* 右：产品面板 */}
        <Re className="relative z-10">
          <ProductPanel />
        </Re>
      </section>

      {/* ═══ 信任指标 ═══ */}
      <section className="mx-auto max-w-[1200px] px-5 pb-20">
        <div className="grid grid-cols-3 gap-4">
          {[{ k: 'stat1', v: '0' }, { k: 'stat2', v: '24/7' }, { k: 'stat3', v: '100', s: '%' }].map(s => (
            <Re key={s.k}>
              <div className="rounded-xl border border-white/[0.05] bg-white/[0.01] px-5 py-6 text-center">
                <div className="text-3xl font-bold">{s.v}{s.s && <span className="text-violet-400">{s.s}</span>}</div>
                <div className="mt-1 text-[13px] text-neutral-500">{t(`landing.${s.k}`)}</div>
              </div>
            </Re>
          ))}
        </div>
        <p className="mt-5 text-center text-[10px] uppercase tracking-[0.2em] text-neutral-800">{t('landing.statFootnote')}</p>
      </section>

      {/* ═══ 产品展示区 ═══ */}
      <section id="product" className="mx-auto max-w-[1200px] scroll-mt-20 px-5 pb-24">
        <Re className="mb-14 text-center">
          <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-violet-400">{t('landing.plEyebrow')}</p>
          <h2 className="mt-3 font-display text-3xl font-bold tracking-[-0.02em] sm:text-4xl">{t('landing.plTitle')}</h2>
          <p className="mt-3 max-w-lg mx-auto text-sm text-neutral-500">{t('landing.expSubtitle')}</p>
        </Re>

        {/* 三步骤 */}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          {[
            { n: '01', t: 'plStep1Title', d: 'plStep1Desc' },
            { n: '02', t: 'plStep2Title', d: 'plStep2Desc' },
            { n: '03', t: 'plStep3Title', d: 'plStep3Desc' },
          ].map(s => <Re key={s.n}><StepCard n={s.n} t={t(`landing.${s.t}`)} d={t(`landing.${s.d}`)} /></Re>)}
        </div>

        <Re className="mt-10 text-center">
          <p className="text-sm text-neutral-500">{t('landing.plFootnote')}</p>
          <p className="mt-2 font-mono text-lg font-semibold text-violet-400">{t('landing.plCounter')}</p>
        </Re>
      </section>

      {/* ═══ 哨兵三柱 ═══ */}
      <section id="guard" className="mx-auto max-w-[1200px] scroll-mt-20 px-5 pb-24">
        <Re className="mb-14 text-center">
          <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-violet-400">{t('landing.deEyebrow')}</p>
          <h2 className="mt-3 font-display text-3xl font-bold tracking-[-0.02em] sm:text-4xl">{t('landing.deTitle')}</h2>
          <p className="mt-3 text-sm text-neutral-500">{t('landing.deSubtitle')}</p>
        </Re>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          {[
            { i: '01', t: 'dc1Title', d: 'dc1', a: 'border-l-red-500/60' },
            { i: '02', t: 'dc2Title', d: 'dc2', a: 'border-l-violet-500/60' },
            { i: '03', t: 'dc3Title', d: 'dc3', a: 'border-l-emerald-500/60' },
          ].map(g => (
            <Re key={g.i}>
              <div className={`rounded-xl border border-white/[0.05] bg-white/[0.01] p-6 border-l-2 ${g.a} transition-all duration-300 hover:border-white/[0.1]`}>
                <div className="mb-3 font-mono text-2xl font-light text-white/5">{g.i}</div>
                <h3 className="font-semibold">{t(`landing.${g.t}`)}</h3>
                <p className="mt-2 text-[14px] leading-relaxed text-neutral-500">{t(`landing.${g.d}`)}</p>
              </div>
            </Re>
          ))}
        </div>
      </section>

      {/* ═══ 7 truths ═══ */}
      <section id="truth" className="mx-auto max-w-[1200px] scroll-mt-20 px-5 pb-24">
        <Re className="mb-14 text-center">
          <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-violet-400">{t('landing.expEyebrow')}</p>
          <h2 className="mt-3 font-display text-3xl font-bold tracking-[-0.02em] sm:text-4xl">{t('landing.expTitle')}</h2>
        </Re>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {[
            ['expDark1', 'expMirror1'], ['expDark2', 'expMirror2'], ['expDark3', 'expMirror3'],
            ['expDark4', 'expMirror4'], ['expDark5', 'expMirror5'], ['expDark6', 'expMirror6'],
          ].map(([d, m], i) => (
            <Re key={i}>
              <div className="group rounded-xl border border-white/[0.05] bg-white/[0.01] p-5 transition-all duration-300 hover:border-white/[0.1]">
                <span className="rounded bg-red-400/10 px-2 py-0.5 text-[10px] font-semibold text-red-400">#{i + 1}</span>
                <p className="mt-2.5 text-[13px] leading-relaxed text-neutral-400">{t(`landing.${d}`)}</p>
                <div className="my-3 h-px bg-white/[0.04]" />
                <p className="text-[13px] leading-relaxed text-neutral-200">{t(`landing.${m}`)}</p>
              </div>
            </Re>
          ))}
        </div>
        <Re className="mt-3 flex justify-center">
          <div className="w-full max-w-md rounded-xl border border-white/[0.05] bg-white/[0.01] p-5 transition-all hover:border-white/[0.1]">
            <span className="rounded bg-red-400/10 px-2 py-0.5 text-[10px] font-semibold text-red-400">#7</span>
            <p className="mt-2.5 text-[13px] leading-relaxed text-neutral-400">{t('landing.expDark7')}</p>
            <div className="my-3 h-px bg-white/[0.04]" />
            <p className="text-[13px] leading-relaxed text-neutral-200">{t('landing.expMirror7')}</p>
          </div>
        </Re>
        <p className="mt-8 text-center text-[12px] text-neutral-700">{t('landing.expNote')}</p>
      </section>

      {/* ═══ 定价 ═══ */}
      <section id="pricing" className="mx-auto max-w-[900px] scroll-mt-20 px-5 pb-24">
        <Re className="mb-14 text-center">
          <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-violet-400">{t('landing.tdEyebrow')}</p>
          <h2 className="mt-3 font-display text-3xl font-bold tracking-[-0.02em] sm:text-4xl">{t('landing.tdTitle')}</h2>
        </Re>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Re>
            <div className="rounded-xl border border-white/[0.05] bg-white/[0.01] p-8 text-center transition-all hover:border-white/[0.1]">
              <p className="text-[11px] uppercase tracking-wider text-neutral-600">{t('landing.tdDoorA')}</p>
              <div className="mt-3 font-display text-5xl font-bold">$49</div>
              <p className="mt-1 text-sm text-neutral-500">{t('landing.tdPerMonth')}</p>
              <p className="mt-4 text-[14px] leading-relaxed text-neutral-500">{t('landing.tdDoorADesc')}</p>
              <button onClick={() => navigate('/login?mode=register')} className="mt-6 w-full rounded-xl border border-white/[0.08] py-2.5 text-[14px] font-medium transition-all hover:border-white/[0.15] hover:bg-white/[0.03]">{t('landing.getStarted')}</button>
            </div>
          </Re>

          <Re>
            <div className="relative rounded-xl border border-violet-500/30 bg-white/[0.02] p-8 text-center transition-all hover:border-violet-500/50">
              <div className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-violet-500 px-3 py-0.5 text-[10px] font-bold uppercase tracking-wider text-white">RECOMMENDED</div>
              <p className="text-[11px] uppercase tracking-wider text-neutral-600">{t('landing.tdDoorB')}</p>
              <div className="mt-3 font-display text-5xl font-bold">$500</div>
              <p className="mt-1 text-sm text-neutral-500">{t('landing.tdDeposit')}</p>
              <p className="mt-4 text-[14px] leading-relaxed text-neutral-500">{t('landing.tdDoorBDesc')}</p>
              <button onClick={() => navigate('/login?mode=register')} className="mt-6 w-full rounded-xl bg-violet-500 py-2.5 text-[14px] font-semibold text-white transition-all hover:bg-violet-400">{t('landing.getStarted')}</button>
            </div>
          </Re>
        </div>
        <Re><p className="mt-5 text-center text-[13px] text-neutral-700">{t('landing.tdFootnote')}</p></Re>
      </section>

      {/* ═══ 三步开始 ═══ */}
      <section className="mx-auto max-w-[1200px] px-5 pb-24">
        <Re className="mb-14 text-center">
          <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-violet-400">{t('landing.howEyebrow')}</p>
          <h2 className="mt-3 font-display text-3xl font-bold tracking-[-0.02em] sm:text-4xl">{t('landing.howTitle')}</h2>
        </Re>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          {[{ t: 'step1Title', d: 'step1Desc' }, { t: 'step2Title', d: 'step2Desc' }, { t: 'step3Title', d: 'step3Desc' }].map((h, i) => (
            <Re key={h.t}>
              <StepCard n={`0${i + 1}`} t={t(`landing.${h.t}`)} d={t(`landing.${h.d}`)} />
            </Re>
          ))}
        </div>
      </section>

      {/* ═══ FAQ ═══ */}
      <FaqSection />

      {/* ═══ CTA ═══ */}
      <section className="mx-auto max-w-[1200px] px-5 pb-24">
        <Re>
          <div className="rounded-2xl border border-white/[0.05] bg-white/[0.01] px-8 py-16 text-center sm:px-16">
            <h2 className="font-display text-3xl font-bold tracking-[-0.02em] sm:text-4xl">{t('landing.ctaTitle')}</h2>
            <p className="mx-auto mt-3 max-w-md text-neutral-500">{t('landing.ctaSubtitle')}</p>
            <button onClick={() => navigate('/login?mode=register')} className="mt-8 rounded-xl bg-white px-8 py-3.5 text-[15px] font-semibold text-black transition-all hover:scale-[1.03] hover:bg-neutral-100">{t('landing.ctaButton')}</button>
            <p className="mt-3 text-[13px] text-neutral-700">{t('landing.ctaNote')}</p>
          </div>
        </Re>
      </section>

      <Foot t={t} />
      <MobileStickyCta />
    </div>
  )
}
