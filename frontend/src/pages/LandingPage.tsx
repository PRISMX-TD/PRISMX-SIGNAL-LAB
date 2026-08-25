// Signal Lab 落地页 / landing page
//
// ════════════════════════════════════════════════════════════════════════════
// 第三版：3D 手机滚动叙事。
//
// 整页只有一个主角——一台 CSS 3D 手机（见 components/landing/PhoneStory.tsx），
// 钉在视口里，滚动条变成播放进度条，五幕演完「一笔真实交易的生命周期」：
// 信号列表 → 完整计划 → 一键下单 → 自动守夜 → 全量留痕。上一版的九个静态分区
// 中，Steps / Discipline / Ledger / Verdict 的内容职责被叙事四幕吸收，页面收缩为：
// 导航 + 叙事区（520vh）+ 定价 + FAQ + 收尾 CTA + 页脚。
//
// 保持不变的硬约束：全部文案走既有 i18n 键（无新增未翻译文案）；预渲染管线
// 不受影响（叙事区首幕在原始 HTML 中直接可见）；「颜料，不是光」的设计令牌
// 体系原样沿用。
//
// Third revision: the 3D phone scrolltelling page. One protagonist — a CSS-3D
// phone (components/landing/PhoneStory.tsx) stuck to the viewport while the
// scrollbar acts as a playhead over five scenes covering the life of one real
// trade: signal list → full plan → one-tap order → automatic guarding → the
// complete record. The previous version's Steps / Discipline / Ledger / Verdict
// sections had their content absorbed by the four story scenes, so the page
// contracts to: nav + story (520vh) + pricing + FAQ + closing CTA + footer.
//
// Unchanged hard constraints: every string uses existing i18n keys (nothing new
// and untranslated); the prerender pipeline is unaffected (scene 0 is visible
// in raw HTML); the pigment-not-glow token system carries over as-is.
// ════════════════════════════════════════════════════════════════════════════
import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { paymentApi, inviteApi, readRef } from '../api/client'
import { SUPPORT_EMAIL } from '../config/site'
import Logo from '../components/Logo'
import PublicLanguageToggle from '../components/PublicLanguageToggle'
import FaqSection from '../components/landing/FaqSection'
import MobileStickyCta from '../components/landing/MobileStickyCta'
import PhoneStory from '../components/landing/PhoneStory'
import MarketStory, { MarketOutro } from '../components/landing/MarketStory'
import LandingSpaceLayer from '../components/landing/LandingSpaceLayer'
import { usePublicLang } from '../seo/PublicShell'
import { localePath } from '../seo/meta'

type T = (k: string, opts?: Record<string, unknown>) => string

const SHELL = 'mx-auto w-full max-w-[1240px] px-5 sm:px-8'

/* ═══════════════ 滚动显现 / scroll reveal ═══════════════
   叙事区之外的静态分区（定价/收尾）仍用 IntersectionObserver 的一次性显现，
   与 GSAP 叙事区互不相干。/ Static sections below the story (pricing/closing)
   keep the one-shot IntersectionObserver reveal, fully independent of GSAP. */
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
      { threshold: 0.1, rootMargin: '0px 0px -6% 0px' }
    )
    el.querySelectorAll('.reveal').forEach((n) => io.observe(n))
    return () => io.disconnect()
  }, [])
  return ref
}

function Heading({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="reveal max-w-3xl">
      <h2 className="font-display-xl text-[clamp(1.75rem,3.6vw,2.5rem)] text-white">{title}</h2>
      {subtitle && <p className="mt-4 max-w-[52ch] text-[15px] leading-relaxed text-neutral-400">{subtitle}</p>}
    </div>
  )
}

/* ═══════════════ 导航 / navbar ═══════════════ */
function Navbar({ t, navigate }: { t: T; navigate: ReturnType<typeof useNavigate> }) {
  const sentinel = useRef<HTMLDivElement>(null)
  const [solid, setSolid] = useState(false)

  useEffect(() => {
    const el = sentinel.current
    if (!el) return
    const io = new IntersectionObserver(([e]) => setSolid(!e.isIntersecting), { threshold: 0 })
    io.observe(el)
    return () => io.disconnect()
  }, [])

  // 三条锚点：叙事区 / 定价 / FAQ。行业对照与判定规则的独立分区已并入叙事
  // 四幕，对应的锚点一起退役。
  // Three anchors: story / pricing / FAQ. The standalone comparison and verdict
  // sections merged into the story scenes, so their anchors retire with them.
  const links = [
    { h: '#showcase', k: 'navShowcase' },
    { h: '#verdict', k: 'wrEyebrow' },
    { h: '#pricing', k: 'navPricing' },
    { h: '#faq', k: 'navFaq' },
  ]

  return (
    <>
      <div ref={sentinel} className="absolute top-0 h-px w-full" aria-hidden />
      {/* pt-[env(safe-area-inset-top)]：header 固定在物理屏幕顶部，iOS 状态栏是
          透明的，不加这段会让 logo/导航被刘海或灵动岛盖住、点击被系统截获。
          pt-[env(safe-area-inset-top)]: the header pins to the physical screen
          top and iOS's status bar is transparent; without this the logo and nav
          sit under the notch/Dynamic Island and taps get swallowed. */}
      <header
        className={`fixed inset-x-0 top-0 z-50 pt-[env(safe-area-inset-top)] transition-colors duration-200 ${
          solid ? 'border-b border-white/[0.07] bg-ink-950/85 backdrop-blur-md' : 'border-b border-transparent'
        }`}
      >
        <div className={`${SHELL} flex h-16 items-center gap-8`}>
          <a href="#top" className="flex shrink-0 items-center gap-2.5">
            <Logo size={30} />
            <span className="font-display text-[15px] font-bold tracking-tight text-white">Signal Lab</span>
          </a>

          <nav className="hidden items-center gap-7 lg:flex">
            {links.map((l) => (
              <a key={l.h} href={l.h} className="text-[13px] text-neutral-400 transition-colors hover:text-white">
                {t(`landing.${l.k}`)}
              </a>
            ))}
          </nav>

          <div className="ml-auto flex shrink-0 items-center gap-3">
            <PublicLanguageToggle />
            <a
              href="/login"
              className="hidden text-[13px] text-neutral-400 transition-colors hover:text-white sm:block"
            >
              {t('landing.signIn')}
            </a>
            <button onClick={() => navigate('/login?mode=register')} className="btn btn-primary h-10 px-4 text-[13px] lg:h-9">
              {t('landing.getStarted')}
            </button>
          </div>
        </div>
      </header>
    </>
  )
}

/* ═══════════════ 定价 / pricing ═══════════════
   非对称：FREE 是 5 栏描边列，PRO 是 7 栏实色紫面。用面积和材质表达推荐
   关系，不贴「RECOMMENDED」药丸。
   Asymmetric: FREE is a 5-column outlined column, PRO a 7-column solid violet
   plane. Area and material state the recommendation; no RECOMMENDED pill. */
function Pricing({ t, navigate }: { t: T; navigate: ReturnType<typeof useNavigate> }) {
  const ref = useReveal<HTMLElement>()
  const freeFeatures = ['prFreeF1', 'prFreeF2', 'prFreeF3', 'prFreeF4']
  const proFeatures = ['prProF1', 'prProF2', 'prProF3', 'prProF4', 'prProF5', 'prProF6', 'prProF7']

  // 价格取公开接口，与 /upgrade 页同源，避免落地页出现第二份会漂移的数字。
  // Price comes from the public endpoint shared with /upgrade so the landing
  // page never carries a second, drifting copy of the number.
  const [monthlyPrice, setMonthlyPrice] = useState<number | null>(null)
  // 免费试用是后台开关（/admin/trial），开着时定价区必须替它说话——这是整页
  // 最强的转化钩子，藏在登录后的升级页里等于没开。数据搭 plans 的顺风车，
  // 不多打一个请求；接口挂了就当没开（catch 静默），页面照常。
  // The free trial is an admin switch; when it's on, the pricing section must
  // say so — it is the strongest conversion hook on the page. The fact rides
  // on the plans call we already make.
  const [trial, setTrial] = useState<{ enabled: boolean; days: number } | null>(null)
  useEffect(() => {
    paymentApi
      .getPlans()
      .then((r) => {
        const monthly = r.plans.find((p) => p.days === 30)
        if (monthly) setMonthlyPrice(monthly.price_usd)
        if (r.trial?.enabled) setTrial(r.trial)
      })
      .catch(() => {})
  }, [])

  // 带 ref 进站且该链接开了送试用时，金条与 CTA 换成"直接开通"的说法。
  //
  // 只影响**文案选择**，绝不影响任何元素的出现或消失：金条出不出仍然只由全局
  // trial.enabled 决定。这样一来这个异步值无论何时返回、返回不返回，都不会造成
  // 布局跳动——落地页是预渲染静态页，一条会撑开卡片的迟到横幅在滚动中非常刺眼。
  //
  // 与 plans 那个请求并行，互不等待；任何一个挂了另一个照常。
  //
  // Switches the gold band and CTA to the "activated on signup" wording when
  // the stored ref grants a trial. Affects *copy only* — whether the band
  // renders at all still depends solely on the global trial switch, so this
  // async value can never cause layout shift no matter when (or whether) it
  // lands. Runs in parallel with the plans call; either can fail alone.
  const [inviteDays, setInviteDays] = useState<number | null>(null)
  useEffect(() => {
    const code = readRef()
    if (!code) return
    let alive = true
    inviteApi
      .getOffer(code)
      .then((r) => {
        if (alive && r.trialDays) setInviteDays(r.trialDays)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  return (
    <section ref={ref} id="pricing" className={`${SHELL} scroll-mt-24 py-20 sm:py-28`}>
      <Heading title={t('landing.prTitle')} subtitle={t('landing.prSubtitle')} />

      <div className="mt-14 grid grid-cols-1 gap-5 lg:grid-cols-12">
        {/* FREE */}
        <div className="reveal flex flex-col rounded-card border border-white/[0.09] p-7 lg:col-span-5">
          <div className="flex items-baseline justify-between gap-3">
            <span className="font-display text-[20px] font-bold text-white">{t('landing.prFreeName')}</span>
            <span className="text-[12px] text-neutral-500">{t('landing.prFreeTag')}</span>
          </div>
          <div className="num mt-5 text-[2.5rem] font-semibold leading-none text-white">$0</div>

          <ul className="mt-8 space-y-3.5 border-t border-white/[0.07] pt-7">
            {freeFeatures.map((k) => (
              <li key={k} className="text-[13px] leading-relaxed text-neutral-400">
                {t(`landing.${k}`)}
              </li>
            ))}
          </ul>

          <button
            onClick={() => navigate('/login?mode=register')}
            className="btn btn-ghost mt-auto h-11 w-full text-[13px]"
          >
            {t('landing.getStarted')}
          </button>
        </div>

        {/* PRO：实色紫面 / solid pigment plane */}
        <div className="reveal reveal-d1 flex flex-col rounded-card bg-prism-600 p-7 lg:col-span-7">
          {/* 试用横幅：贯穿卡顶的实色金条。第一版是价格下方的白药丸，反馈是
              「不明显」——它和卡内其它元素同宽同层级，扫视时不占任何优先级。
              横幅解决的正是这个：它改变卡片的**轮廓**（顶部多出一条色带），
              轮廓变化在滚动扫视里先于一切内文被看到。
              金色是全页唯一一处（既有 token --gold，语义就是限时/例外），
              近黑文字压上去 9.2:1；实色平涂，不发光。
              A solid gold band across the card top. The first attempt (a white
              pill below the price) failed because it lived at the same level as
              everything else; the band changes the card's silhouette, which is
              what scanning eyes pick up first. Gold is used nowhere else on the
              page. */}
          {trial && (
            <div className="-mx-7 -mt-7 mb-6 flex items-center justify-center gap-2 rounded-t-card bg-[#E0A83C] px-7 py-3 text-[14px] font-bold text-ink-950">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z" />
              </svg>
              {inviteDays
                ? t('landing.prTrialBadgeInvite', { days: inviteDays })
                : t('landing.prTrialBadge', { days: trial.days })}
            </div>
          )}
          <div className="flex items-baseline justify-between gap-3">
            <span className="font-display text-[20px] font-bold text-white">{t('landing.prProName')}</span>
            <span className="text-[12px] text-white/85">{t('landing.prProTag')}</span>
          </div>
          {/* 价格位是定价卡上眼睛落点的第一站——试用开着时它必须说 $0，
              而不是让 $49 继续当主角、旁边贴个补丁。原价降级成一行
              「之后 $N/月」：既诚实（试用后要付费）又把层级让出来。
              The price slot is where eyes land first on a pricing card; with
              the trial on it must read $0, with the real price demoted to a
              "then $N/mo" line — honest and hierarchically correct. */}
          {trial ? (
            <div className="mt-5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="num text-[2.5rem] font-semibold leading-none text-white">$0</span>
              <span className="text-[15px] font-bold text-white">{t('landing.prTrialFirstDays', { days: trial.days })}</span>
              {monthlyPrice != null && (
                <span className="text-[13px] text-white/70">{t('landing.prTrialThen', { price: monthlyPrice })}</span>
              )}
            </div>
          ) : (
            <div className="mt-5 flex items-baseline gap-2">
              <span className="num text-[2.5rem] font-semibold leading-none text-white">
                {monthlyPrice != null ? `$${monthlyPrice}` : '—'}
              </span>
              <span className="text-[13px] text-white/85">/{t('landing.prPerMonth')}</span>
            </div>
          )}

          <ul className="mt-8 grid gap-3.5 border-t border-white/25 pt-7 sm:grid-cols-2 sm:gap-x-8">
            {proFeatures.map((k) => (
              <li key={k} className="text-[13px] leading-relaxed text-white/85">
                {t(`landing.${k}`)}
              </li>
            ))}
          </ul>

          {/* PRO 面上的按钮必须白底紫字：紫底紫字不可读。/ White fill, violet
              label: the highest contrast available on this plane. */}
          <button
            onClick={() => navigate('/login?mode=register')}
            className="btn mt-8 h-11 w-full bg-white text-[13px] font-semibold text-prism-700 hover:bg-white/90"
          >
            {trial
              ? inviteDays
                ? t('landing.prTrialCtaInvite', { days: inviteDays })
                : t('landing.prTrialCta', { days: trial.days })
              : t('landing.prCta')}
          </button>
        </div>
      </div>

      <p className="reveal mt-6 text-[12px] leading-relaxed text-neutral-500">{t('landing.prNote')}</p>
    </section>
  )
}

/* ═══════════════ 收尾 CTA / closing CTA ═══════════════ */
function ClosingCta({ t, navigate }: { t: T; navigate: ReturnType<typeof useNavigate> }) {
  const ref = useReveal<HTMLElement>()
  return (
    <section ref={ref} className={`${SHELL} py-20 sm:py-28`}>
      <div className="rule-spectral reveal mb-12">
        <i />
      </div>
      <div className="reveal grid grid-cols-1 items-end gap-10 lg:grid-cols-12">
        <div className="lg:col-span-7">
          <h2 className="font-display-xl text-[clamp(2rem,4.4vw,3.25rem)] text-white">{t('landing.ctaTitle')}</h2>
          <p className="mt-5 max-w-[46ch] text-[15px] leading-relaxed text-neutral-400">{t('landing.ctaSubtitle')}</p>
        </div>
        <div className="lg:col-span-4 lg:col-start-9">
          <button
            onClick={() => navigate('/login?mode=register')}
            className="btn btn-primary h-12 w-full px-8 text-[15px]"
          >
            {t('landing.ctaButton')}
          </button>
          <p className="mt-3 text-[12px] text-neutral-500">{t('landing.ctaNote')}</p>
        </div>
      </div>
    </section>
  )
}

/* ═══════════════ 页脚 / footer ═══════════════ */
function Foot({ t }: { t: T }) {
  const lang = usePublicLang()
  const links = [
    { h: '#showcase', k: 'navShowcase' },
    { h: '#verdict', k: 'wrEyebrow' },
    { h: '#pricing', k: 'navPricing' },
    { h: '#faq', k: 'navFaq' },
  ]
  return (
    <footer className="border-t border-white/[0.07]">
      <div className={`${SHELL} grid grid-cols-2 gap-x-8 gap-y-10 py-14 md:grid-cols-12`}>
        <div className="col-span-2 md:col-span-4">
          <div className="flex items-center gap-2.5">
            <Logo size={28} />
            <span className="font-display text-[15px] font-bold tracking-tight text-white">Signal Lab</span>
          </div>
          <p className="mt-3 text-[12px] uppercase tracking-[0.14em] text-neutral-500">by PRISMX</p>
        </div>

        <nav className="md:col-span-3">
          <ul className="space-y-0.5">
            {links.map((l) => (
              <li key={l.h}>
                <a href={l.h} className="block py-2.5 text-[13px] text-neutral-400 transition-colors hover:text-white">
                  {t(`landing.${l.k}`)}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        {/* 条款与政策：<Link> 而不是 <a href>，SPA 内路由不触发整页刷新。
            Terms via <Link>, not <a href>: same-SPA routes, no full reload. */}
        <div className="md:col-span-2">
          <p className="text-[12px] uppercase tracking-[0.14em] text-neutral-500">{t('landing.footerLegal')}</p>
          <ul className="mt-2.5 space-y-0.5">
            {(['terms', 'privacy', 'risk'] as const).map((d) => (
              <li key={d}>
                <Link
                  to={localePath(lang, `/${d}`)}
                  className="block py-2.5 text-[13px] text-neutral-400 transition-colors hover:text-white"
                >
                  {t(`legal.${d}.title`)}
                </Link>
              </li>
            ))}
          </ul>
        </div>

        {/* 客服栏由 SUPPORT_EMAIL 控制，留空则整栏不渲染（见 config/site.ts）。
            Gated by SUPPORT_EMAIL; empty hides the column (see config/site.ts). */}
        {SUPPORT_EMAIL && (
          <div className="col-span-2 md:col-span-3">
            <p className="text-[12px] uppercase tracking-[0.14em] text-neutral-500">{t('landing.footerSupport')}</p>
            <p className="mt-4 text-[13px] leading-relaxed text-neutral-500">{t('landing.footerSupportBody')}</p>
            <a
              href={`mailto:${SUPPORT_EMAIL}`}
              className="mt-1 inline-block py-2 text-[13px] text-prism-400 underline underline-offset-4 transition-colors hover:text-prism-300"
            >
              {SUPPORT_EMAIL}
            </a>
          </div>
        )}
      </div>

      <div className={`${SHELL} border-t border-white/[0.07] py-8`}>
        <p className="max-w-[92ch] text-[12px] leading-relaxed text-neutral-500">{t('landing.footerRisk')}</p>
        <p className="mt-5 text-[12px] text-neutral-500">
          © {new Date().getFullYear()} PRISMX · {t('landing.footerRights')}
        </p>
      </div>
    </footer>
  )
}

/* ═══════════════ 页面 / page ═══════════════ */
export default function LandingPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()

  return (
    <div id="top" className="relative min-h-[100dvh] bg-ink-950 text-white">
      {/* 结构层：一个贯穿全页的 3D 空间，静态网格退居为它的基线。
          Structural layer: a 3D space spanning the whole page, with the static
          grid demoted to its baseline. */}
      <LandingSpaceLayer />

      <div className="relative z-10">
        <Navbar t={t} navigate={navigate} />
        <PhoneStory />
        <MarketStory />
        <MarketOutro />
        <Pricing t={t} navigate={navigate} />
        <FaqSection />
        <ClosingCta t={t} navigate={navigate} />
        <Foot t={t} />
        <MobileStickyCta />
      </div>
    </div>
  )
}
