// Signal Lab 落地页 / landing page
//
// ════════════════════════════════════════════════════════════════════════════
// 这一版相对上一版的结构性改动，以及每条改动的理由：
//
// 1. 删掉 WebGL 3D 棱镜场景（PrismScene）与整页极光背景。
//    · 首屏体积：three + @react-three/fiber 是这个包里最大的两个依赖，而它们
//      只服务于一张背景图。移除后落地页不再加载 three.js，LCP 直接受益。
//    · 视觉：发光的 3D 玻璃体 + 漂浮光球是 LLM 生成页面最容易被一眼认出的背景。
//    · 依据：极光存在的唯一目的是给半透明玻璃卡「垫」出可透的内容；卡片材质
//      已改成实色面，这个依据本身没有了。
//
// 2. 布局家族去重。上一版有连续四个分区都是「三等分玻璃卡」（Stats / Showcase /
//    Guard / Truths），第三次出现时读者就知道这是按模板批量生成的。现在九个分区
//    用了九种不同的构成：分栏英雄 / 发丝线数据带 / 时间轴导轨 / 整幅实色紫面 /
//    双栏对照账 / 竖脊规则列表 / 非对称定价 / 手风琴 / 排版式收尾。
//
// 3. 眉题（uppercase + 宽字距的小标签）从「每分区一条」降到全页两条。
//    这是模板节奏最明显的来源。
//
// 4. 清掉一组被反复点名的签名：渐变裁切标题、脉冲小圆点徽章、底部「Scroll」
//    提示、01/02/03 编号、「RECOMMENDED」药丸、按钮扫光、卡片外发光。
//
// 5. 导航的滚动监听从 window scroll 事件换成 IntersectionObserver 哨兵。
//    scroll 事件每帧触发且不做批处理，为了一个「顶栏是否变色」的布尔值付出
//    整页滚动期间的持续回调，是纯粹的浪费。
//
// 6. 启用了 i18n 里一直存在但从未渲染的内容（cmp* 行业对照、wr* 判定规则）。
//    上一版把 expDark/expMirror 里的七条只取了三条塞进卡片；那批文案本来就是
//    成对的对照结构，做成双栏账本比塞进卡片贴切得多。
//
// Structural changes in this revision and the reason for each:
//
// 1. The WebGL prism scene and full-page aurora backdrop are gone. three +
//    @react-three/fiber were the two largest dependencies in the bundle and
//    served one background image; the landing page no longer loads three.js at
//    all. A glowing 3D glass solid over drifting orbs is also the most instantly
//    recognisable background of LLM-generated pages — and the aurora's only
//    purpose was to give translucent glass cards something to show through,
//    which disappeared when the card material became opaque.
//
// 2. Layout families de-duplicated. The previous version ran four consecutive
//    "three equal glass cards" sections; by the third the page reads as template
//    output. The nine sections now use nine different compositions.
//
// 3. Eyebrows (small uppercase wide-tracked labels) dropped from one per section
//    to two on the entire page — the clearest source of templated rhythm.
//
// 4. Removed: gradient-clipped headlines, the pulsing-dot badge, the bottom
//    "Scroll" cue, 01/02/03 numbering, the RECOMMENDED pill, button sheen
//    sweeps, and card outer glows.
//
// 5. The nav's scroll listener became an IntersectionObserver sentinel. A scroll
//    event fires every frame without batching; paying that for one boolean is
//    waste.
//
// 6. Content that existed in i18n but was never rendered is now used (cmp*
//    industry comparison, wr* verdict rules). The expDark/expMirror strings are
//    written as paired opposites, so a two-column ledger fits them far better
//    than the three cards that showed only three of the seven.
// ════════════════════════════════════════════════════════════════════════════
import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { paymentApi } from '../api/client'
import { SUPPORT_EMAIL } from '../config/site'
import Logo from '../components/Logo'
import PublicLanguageToggle from '../components/PublicLanguageToggle'
import FaqSection from '../components/landing/FaqSection'
import MobileStickyCta from '../components/landing/MobileStickyCta'
import { usePublicLang } from '../seo/PublicShell'
import { localePath } from '../seo/meta'

type T = (k: string) => string

const SHELL = 'mx-auto w-full max-w-[1240px] px-5 sm:px-8'

/* ═══════════════ 滚动显现 / scroll reveal ═══════════════
   IntersectionObserver 而不是滚动事件：只在元素跨越阈值时回调一次，之后立刻
   取消观察。整页滚动期间没有任何 JS 在跑。
   IntersectionObserver rather than a scroll handler: one callback as an element
   crosses the threshold, then it unobserves itself. No JS runs while scrolling. */
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

/* ═══════════════ 分区标题 / section heading ═══════════════
   eyebrow 是可选参数且默认不传。上一版这个组件强制要求 eyebrow，于是每个分区
   都长出一条——组件签名本身在制造模板感。
   The eyebrow is optional and defaults to absent. The previous version required
   it, so every section grew one: the component signature itself was manufacturing
   the templated rhythm. */
function Heading({
  title,
  subtitle,
  eyebrow,
  align = 'left',
  tone = 'dark',
}: {
  title: string
  subtitle?: string
  eyebrow?: string
  align?: 'left' | 'center'
  tone?: 'dark' | 'uv'
}) {
  const center = align === 'center'
  return (
    <div className={`reveal ${center ? 'mx-auto max-w-2xl text-center' : 'max-w-3xl'}`}>
      {eyebrow && <span className="eyebrow mb-4 block">{eyebrow}</span>}
      <h2
        className={`font-display-xl text-[clamp(1.75rem,3.6vw,2.75rem)] ${
          tone === 'uv' ? 'text-white' : 'text-white'
        }`}
      >
        {title}
      </h2>
      {subtitle && (
        <p
          className={`mt-4 max-w-[52ch] text-[15px] leading-relaxed ${
            center ? 'mx-auto' : ''
          } ${tone === 'uv' ? 'text-white/85' : 'text-neutral-400'}`}
        >
          {subtitle}
        </p>
      )}
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

  // 四条主锚点。英文标签比中文长，五条在 lg（1024px）宽度下配合右侧语言切换 +
  // 登录 + 注册按钮会挤成两行，而桌面端两行导航是明确的布局故障。
  // Four anchors. English labels run longer than Chinese, and five of them plus
  // the language toggle, sign-in and register button on the right wrap to two
  // lines at lg (1024px) — a two-line desktop nav is a layout failure.
  const links = [
    { h: '#showcase', k: 'navShowcase' },
    { h: '#compare', k: 'navCompare' },
    { h: '#pricing', k: 'navPricing' },
    { h: '#faq', k: 'navFaq' },
  ]

  return (
    <>
      <div ref={sentinel} className="absolute top-0 h-px w-full" aria-hidden />
      {/* pt-[env(safe-area-inset-top)]：header 固定在物理屏幕顶部，iOS 状态栏是
          透明的（apple-mobile-web-app-status-bar-style: black-translucent），
          不加这段会让 logo/导航被刘海或灵动岛盖住、点击被系统截获。
          pt-[env(safe-area-inset-top)]: the header is pinned to the physical
          screen top and iOS's status bar is transparent, so without this the
          logo and nav sit under the notch/Dynamic Island and taps get swallowed. */}
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
              <a
                key={l.h}
                href={l.h}
                className="text-[13.5px] text-neutral-400 transition-colors hover:text-white"
              >
                {t(`landing.${l.k}`)}
              </a>
            ))}
          </nav>

          <div className="ml-auto flex shrink-0 items-center gap-3">
            <PublicLanguageToggle />
            <a
              href="/login"
              className="hidden text-[13.5px] text-neutral-400 transition-colors hover:text-white sm:block"
            >
              {t('landing.signIn')}
            </a>
            <button onClick={() => navigate('/login?mode=register')} className="btn btn-primary h-9 px-4 text-[13.5px]">
              {t('landing.getStarted')}
            </button>
          </div>
        </div>
      </header>
    </>
  )
}

/* ═══════════════ 信号卡示例 / sample signal card ═══════════════
   用产品自己的组件语汇（.glass / .chip / .num / 语义涨跌色）搭出一张真实比例的
   信号卡，数据取自 i18n 的 scr* 示例键，并在卡下方明确标注「示例界面 · 非实时
   数据」（landing.shCaption）。
   这不是用 div 画出来的假截图：它复用的是 App 内同一套令牌与原语，尺寸、字号、
   间距、颜色都与登录后看到的一致，改动 design token 时它会跟着一起变。选择这个
   而不是塞一张风景图，是因为交易产品的第一屏该展示产品本身。
   A real-proportion signal card built from the product's own vocabulary (.glass /
   .chip / .num / the semantic up-down colours), populated from the scr* sample
   keys in i18n and labelled "sample interface, not live data" underneath.
   This is not a div-drawn fake screenshot: it reuses the same tokens and
   primitives as the app, so its sizing, type, spacing and colour match what a
   logged-in user sees and it follows any future token change. It is here instead
   of stock photography because a trading product's first screen should show the
   product. */
function SignalPreview({ t }: { t: T }) {
  const rows = [
    { k: 'scrEntry', v: '3 412.80', tone: 'text-white' },
    { k: 'scrSl', v: '3 398.20', tone: 'text-down' },
    { k: 'scrTp', v: '3 445.60', tone: 'text-up' },
  ]
  return (
    <div className="reveal reveal-d1">
      <div className="glass p-5 sm:p-6">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-baseline gap-2.5">
            <span className="font-display text-lg font-bold text-white">XAUUSD</span>
            <span className="text-[12px] text-neutral-500">{t('landing.scrGold')}</span>
          </div>
          <span className="chip chip-buy">{t('landing.scrBuy')}</span>
        </div>

        <div className="mt-5 grid grid-cols-3 gap-px overflow-hidden rounded-inner border border-white/[0.07] bg-white/[0.07]">
          {rows.map((r) => (
            <div key={r.k} className="bg-ink-850 px-3 py-3.5">
              <div className="text-[10.5px] uppercase tracking-[0.1em] text-neutral-500">{t(`landing.${r.k}`)}</div>
              <div className={`num mt-1.5 text-[15px] font-semibold ${r.tone}`}>{r.v}</div>
            </div>
          ))}
        </div>

        <div className="mt-4 flex items-center justify-between border-t border-white/[0.07] pt-4">
          <div className="flex items-baseline gap-2">
            <span className="text-[11.5px] text-neutral-500">{t('landing.scrRr')}</span>
            <span className="num text-[15px] font-semibold text-white">1 : 2.26</span>
          </div>
          <span className="num text-[11.5px] text-neutral-500">{t('landing.scrTtl')}</span>
        </div>
      </div>

      {/* 示例声明放在卡片外的正下方，而不是压在卡片上做成叠加标签：叠在图上的
          小标签是被反复点名的装饰模式，而这条声明是合规信息，必须清晰可读。
          The disclaimer sits below the card rather than as an overlaid pill on
          top of it: labels pinned onto imagery are a flagged decorative pattern,
          and this particular line is a compliance statement that has to stay
          plainly legible. */}
      <p className="mt-3 text-[11.5px] text-neutral-500">{t('landing.shCaption')}</p>
    </div>
  )
}

/* ═══════════════ Hero ═══════════════
   分栏构成，不居中。左侧承载信息层级（标题 → 说明 → 行动），右侧承载产品实体。
   文本元素严格四件：标题、说明、主 CTA、次级链接——没有徽章药丸，没有 CTA 下方
   的小字尾注，没有底部滚动提示。
   Split composition, not centred. The left column carries the hierarchy
   (headline → explanation → action) and the right carries the product itself.
   Exactly four text elements: headline, subtext, primary CTA, secondary link —
   no badge pill, no micro-tagline under the CTAs, no scroll cue. */
function Hero({ t, navigate }: { t: T; navigate: ReturnType<typeof useNavigate> }) {
  const ref = useReveal<HTMLElement>()
  return (
    <section
      ref={ref}
      id="top"
      className={`${SHELL} grid min-h-[100dvh] grid-cols-1 items-center gap-14 pb-20 pt-[calc(6rem+env(safe-area-inset-top))] lg:grid-cols-12 lg:gap-12`}
    >
      <div className="lg:col-span-7">
        {/* 强调用同一支字体的颜色变化，不用渐变裁切、不用第二支字体。
            Emphasis via colour within one family — no gradient clip, no second face.

            字号上限定在 3.9rem 而不是更大，是按**英文**标题定的，不是按中文。
            中文标题「情绪归零 / 只剩纪律」每行四个字，多大都是两行；英文的
            "Only discipline left" 有 19 个字符，在 76px 的扩展字宽下一行需要约
            750px，而这一栏只有 666px——实测会折成两行，整个标题变四行。
            标题超过两行永远是字号错误，不是文案太长。上限压到 3.9rem 之后两种
            语言都是两行。
            The size ceiling is 3.9rem rather than something larger because it is
            set by the *English* headline, not the Chinese one. The Chinese
            headline is four glyphs per line and stays at two lines at any size;
            "Only discipline left" is 19 characters and needs roughly 750px on one
            line at 76px expanded, while this column is 666px — measured, it wrapped
            and turned the headline into four lines. A headline past two lines is
            always a size error, never a copy-length one. At a 3.9rem ceiling both
            languages hold two lines. */}
        <h1 className="font-display-xl text-[clamp(2.5rem,5.6vw,3.9rem)]">
          <span className="block text-white">{t('landing.heroTitle1')}</span>
          <span className="mt-1 block text-prism-400">{t('landing.heroTitle2')}</span>
        </h1>

        <p className="mt-7 max-w-[48ch] text-[15px] leading-relaxed text-neutral-400 sm:text-[16px]">
          {t('landing.heroSubtitle')}
        </p>

        <div className="mt-9 flex flex-wrap items-center gap-x-7 gap-y-4">
          <button
            onClick={() => navigate('/login?mode=register')}
            className="btn btn-primary h-12 px-7 text-[15px]"
          >
            {t('landing.ctaPrimary')}
          </button>
          <a
            href="#verdict"
            className="text-[14px] text-neutral-400 underline decoration-white/20 underline-offset-[6px] transition-colors hover:text-white hover:decoration-white/60"
          >
            {t('landing.ctaSecondary')}
          </a>
        </div>
      </div>

      <div className="lg:col-span-5">
        <SignalPreview t={t} />
      </div>
    </section>
  )
}

/* ═══════════════ 数据带 / fact band ═══════════════
   全宽发丝线分隔的横向带，不是卡片。三项事实用竖线分栏——卡片会给这三行文字
   多余的「容器」层级，而它们并不需要独立的高度。
   A full-width hairline-divided band rather than cards. Three facts split by
   vertical rules: cards would grant these three lines a container hierarchy they
   do not need. */
function FactBand({ t }: { t: T }) {
  const ref = useReveal<HTMLElement>()
  const items = [
    { v: '0', k: 'stat1' },
    { v: '24/7', k: 'stat2' },
    { v: '100%', k: 'stat3' },
  ]
  return (
    <section ref={ref} className="border-y border-white/[0.07]">
      <div className={`${SHELL} grid grid-cols-1 divide-y divide-white/[0.07] sm:grid-cols-3 sm:divide-x sm:divide-y-0`}>
        {items.map((s, i) => (
          <div key={s.k} className={`reveal reveal-d${i} px-0 py-8 sm:px-8 sm:py-11 sm:first:pl-0 sm:last:pr-0`}>
            <div className="font-display-xl text-[2.5rem] leading-none text-prism-400 sm:text-[3rem]">{s.v}</div>
            <p className="mt-4 max-w-[30ch] text-[13.5px] leading-relaxed text-neutral-400">{t(`landing.${s.k}`)}</p>
          </div>
        ))}
      </div>
      <div className={`${SHELL} border-t border-white/[0.07] py-4`}>
        <p className="text-[12px] text-neutral-500">{t('landing.statFootnote')}</p>
      </div>
    </section>
  )
}

/* ═══════════════ 三步流程 / how it works ═══════════════
   时间轴导轨：一条贯穿的发丝线，三步挂在线下方，列宽非等分（1.15 / 1 / 1）。
   与「三张等宽卡片」的区别不只是外观——导轨表达了这三步有先后顺序，卡片表达的
   是三个并列选项，后者与内容不符。
   A timeline rail: one continuous hairline with three steps hanging beneath it at
   unequal column widths (1.15 / 1 / 1). The difference from three equal cards is
   not only visual — a rail states that the steps are sequential, whereas cards
   state that they are parallel alternatives, which contradicts the content. */
function Steps({ t }: { t: T }) {
  const ref = useReveal<HTMLElement>()
  const steps = [
    { tk: 'step1Title', dk: 'step1Desc' },
    { tk: 'step2Title', dk: 'step2Desc' },
    { tk: 'step3Title', dk: 'step3Desc' },
  ]
  return (
    <section ref={ref} id="showcase" className={`${SHELL} scroll-mt-24 py-20 sm:py-28`}>
      <Heading eyebrow={t('landing.howEyebrow')} title={t('landing.howTitle')} subtitle={t('landing.howSubtitle')} />

      <div className="relative mt-14">
        {/* 导轨本体。md 以下隐藏——窄屏是纵向堆叠，一条横线没有意义。
            The rail itself, hidden below md where the layout stacks vertically
            and a horizontal line would mean nothing. */}
        <div className="absolute left-0 right-0 top-[7px] hidden h-px bg-white/[0.09] md:block" />
        <div className="grid grid-cols-1 gap-12 md:grid-cols-[1.15fr_1fr_1fr] md:gap-10">
          {steps.map((s, i) => (
            <div key={s.tk} className={`reveal reveal-d${i} relative md:pr-8`}>
              {/* 挂在导轨上的方块标记。用方形而不是圆点：圆点在这套系统里被限定
                  为「实时状态」语义（见 EAStatusBadge / 行情表），不该被借去做装饰。
                  A square marker sitting on the rail. Square rather than a dot:
                  dots are reserved for live-status semantics in this system (see
                  EAStatusBadge and the quotes table) and must not be borrowed for
                  decoration. */}
              <span className="mb-6 block h-[15px] w-[15px] bg-prism-600 md:mb-8" />
              <h3 className="font-display text-[17px] font-bold text-white">{t(`landing.${s.tk}`)}</h3>
              <p className="mt-3 text-[14px] leading-relaxed text-neutral-400">{t(`landing.${s.dk}`)}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

/* ═══════════════ 纪律引擎：整幅实色紫面 / discipline: full-bleed pigment plane ═══════════════
   全页唯一一处大面积品牌色。这是「颜料而非光」最直接的表达：一整块平涂的紫，
   白字压上去（对比度 8.4:1），没有渐变、没有光晕、没有模糊。
   注意这不违反「整页主题锁定」——页面仍然是同一套深色主题，这里是同一主题内的
   品牌色区块，不是切换到另一种明暗模式。
   The page's only large field of brand colour, and the most direct statement of
   pigment-over-glow: one flat violet plane with white type on it (8.4:1), no
   gradient, no halo, no blur.
   This does not break the page's theme lock — the page remains one dark theme and
   this is a brand-colour block within it, not a switch to another light mode. */
function Discipline({ t }: { t: T }) {
  const ref = useReveal<HTMLElement>()
  const pillars = [
    { tk: 'dc1Title', dk: 'dc1' },
    { tk: 'dc2Title', dk: 'dc2' },
    { tk: 'dc3Title', dk: 'dc3' },
  ]
  return (
    <section ref={ref} id="guard" className="scroll-mt-24 bg-prism-600">
      <div className={`${SHELL} grid grid-cols-1 gap-12 py-20 sm:py-28 lg:grid-cols-12 lg:gap-8`}>
        <div className="lg:col-span-5">
          <Heading tone="uv" title={t('landing.deTitle')} subtitle={t('landing.deSubtitle')} />
        </div>
        <div className="lg:col-span-6 lg:col-start-7">
          <div className="divide-y divide-white/25 border-y border-white/25">
            {pillars.map((p, i) => (
              <div key={p.tk} className={`reveal reveal-d${i} py-6`}>
                <h3 className="font-display text-[17px] font-bold text-white">{t(`landing.${p.tk}`)}</h3>
                <p className="mt-2.5 max-w-[46ch] text-[14px] leading-relaxed text-white/85">{t(`landing.${p.dk}`)}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}

/* ═══════════════ 行业对照账 / industry ledger ═══════════════
   双栏账本：左列是行业惯用手法，右列是对应的产品做法，逐条成对。
   这批文案（expDark1..7 / expMirror1..7）本来就是成对写的，上一版只取了三条塞进
   卡片，等于把「对照」这个结构丢了。账本形式把结构还回去，同时它与页面上任何
   其它分区都不重样。
   每行只有一条上边框（不是上下都描）——长列表逐行上下描边是最偷懒的排版。
   A two-column ledger: industry practice on the left, the product's counterpart on
   the right, paired row by row. The expDark1..7 / expMirror1..7 strings were
   written as pairs, and the previous version dropped that structure by picking
   three of them and putting each in a card. The ledger restores it, and it shares
   no layout family with any other section on the page.
   Each row carries one top border, not a top and a bottom: hairlines above and
   below every row of a long list is the laziest available layout. */
function Ledger({ t }: { t: T }) {
  const ref = useReveal<HTMLElement>()
  const pairs = [1, 2, 3, 4, 5].map((n) => ({ n, d: `expDark${n}`, m: `expMirror${n}` }))
  return (
    <section ref={ref} id="compare" className={`${SHELL} scroll-mt-24 py-20 sm:py-28`}>
      <Heading title={t('landing.expTitle')} subtitle={t('landing.expSubtitle')} />

      <div className="mt-14">
        <div className="hidden grid-cols-2 gap-10 pb-3 md:grid">
          <span className="text-[12px] font-medium text-neutral-500">{t('landing.cmpThem')}</span>
          <span className="text-[12px] font-medium text-prism-400">{t('landing.cmpUs')}</span>
        </div>

        {pairs.map((p, i) => (
          <div
            key={p.n}
            className={`reveal reveal-d${i % 3} grid grid-cols-1 gap-3 border-t border-white/[0.07] py-6 md:grid-cols-2 md:gap-10`}
          >
            <p className="text-[14px] leading-relaxed text-neutral-500 line-through decoration-neutral-700">
              {t(`landing.${p.d}`)}
            </p>
            <p className="text-[14.5px] leading-relaxed text-neutral-200">{t(`landing.${p.m}`)}</p>
          </div>
        ))}

        <p className="reveal border-t border-white/[0.07] pt-6 text-[12.5px] leading-relaxed text-neutral-500">
          {t('landing.expNote')}
        </p>
      </div>
    </section>
  )
}

/* ═══════════════ 判定规则：竖脊列表 / verdict rules on a vertical spine ═══════════════
   一条竖直发丝线串起四条判定规则。规则本身是大字，注解是小字，两者用尺寸而不是
   容器区分——这四条内容是一套连续的规则，装进四张卡片会把它们读成四个独立特性。
   A vertical hairline threading four verdict rules. The rule is set large and its
   note small, separated by size rather than by containers: these four items are
   one continuous ruleset, and four cards would read them as four separate features. */
function Verdict({ t }: { t: T }) {
  const ref = useReveal<HTMLElement>()
  const rules = [1, 2, 3, 4].map((n) => ({ n, r: `wrRule${n}`, note: `wrRule${n}Note` }))
  return (
    <section ref={ref} id="verdict" className={`${SHELL} scroll-mt-24 py-20 sm:py-28`}>
      <div className="grid grid-cols-1 gap-14 lg:grid-cols-12 lg:gap-8">
        <div className="lg:col-span-5">
          <Heading eyebrow={t('landing.wrEyebrow')} title={t('landing.wrTitle')} subtitle={t('landing.wrSubtitle')} />
        </div>

        <div className="lg:col-span-6 lg:col-start-7">
          <ol className="relative border-l border-white/[0.09] pl-7">
            {rules.map((r, i) => (
              <li key={r.n} className={`reveal reveal-d${i % 3} relative pb-9 last:pb-0`}>
                <span className="absolute -left-[calc(1.75rem+4px)] top-[7px] h-[9px] w-[9px] bg-prism-500" />
                <p className="text-[15px] font-medium leading-snug text-white">{t(`landing.${r.r}`)}</p>
                <p className="mt-2 max-w-[44ch] text-[13px] leading-relaxed text-neutral-500">
                  {t(`landing.${r.note}`)}
                </p>
              </li>
            ))}
          </ol>
          <p className="reveal mt-8 max-w-[48ch] text-[13px] leading-relaxed text-neutral-500">{t('landing.wrNote')}</p>
        </div>
      </div>
    </section>
  )
}

/* ═══════════════ 定价 / pricing ═══════════════
   非对称：FREE 是 5 栏的轻量描边列，PRO 是 7 栏的实色紫面。
   用面积和材质表达推荐关系，而不是在卡片上贴一枚「RECOMMENDED」药丸——那枚药丸
   是最常见的模板签名，而且它把「哪个更好」这件事说了两遍。
   Asymmetric: FREE is a 5-column outlined light column, PRO a 7-column solid
   violet plane. The recommendation is expressed through area and material rather
   than a RECOMMENDED pill stuck on the card — that pill is a stock template
   signature, and it states "this one is better" a second time redundantly. */
function Pricing({ t, navigate }: { t: T; navigate: ReturnType<typeof useNavigate> }) {
  const ref = useReveal<HTMLElement>()
  const freeFeatures = ['prFreeF1', 'prFreeF2', 'prFreeF3', 'prFreeF4']
  const proFeatures = ['prProF1', 'prProF2', 'prProF3', 'prProF4', 'prProF5', 'prProF6', 'prProF7']

  // 价格取公开接口，与 /upgrade 页同源，避免落地页出现第二份会漂移的数字。
  // Price comes from the public endpoint shared with /upgrade so the landing page
  // never carries a second, drifting copy of the number.
  const [monthlyPrice, setMonthlyPrice] = useState<number | null>(null)
  useEffect(() => {
    paymentApi
      .getPlans()
      .then((r) => {
        const monthly = r.plans.find((p) => p.days === 30)
        if (monthly) setMonthlyPrice(monthly.price_usd)
      })
      .catch(() => {})
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
              <li key={k} className="text-[13.5px] leading-relaxed text-neutral-400">
                {t(`landing.${k}`)}
              </li>
            ))}
          </ul>

          <button
            onClick={() => navigate('/login?mode=register')}
            className="btn btn-ghost mt-auto h-11 w-full text-[14px]"
          >
            {t('landing.getStarted')}
          </button>
        </div>

        {/* PRO：实色紫面 / solid pigment plane */}
        <div className="reveal reveal-d1 flex flex-col rounded-card bg-prism-600 p-7 lg:col-span-7">
          <div className="flex items-baseline justify-between gap-3">
            <span className="font-display text-[20px] font-bold text-white">{t('landing.prProName')}</span>
            <span className="text-[12px] text-white/85">{t('landing.prProTag')}</span>
          </div>
          <div className="mt-5 flex items-baseline gap-2">
            <span className="num text-[2.5rem] font-semibold leading-none text-white">
              {monthlyPrice != null ? `$${monthlyPrice}` : '—'}
            </span>
            <span className="text-[14px] text-white/85">/{t('landing.prPerMonth')}</span>
          </div>

          <ul className="mt-8 grid gap-3.5 border-t border-white/25 pt-7 sm:grid-cols-2 sm:gap-x-8">
            {proFeatures.map((k) => (
              <li key={k} className="text-[13.5px] leading-relaxed text-white/85">
                {t(`landing.${k}`)}
              </li>
            ))}
          </ul>

          {/* PRO 面上的按钮必须是白底紫字：紫底紫字不可读，白底描边按钮在实色紫上
              对比度最高。/ The button on the PRO plane is white-on-violet inverted:
              violet on violet is unreadable, and a solid white fill gives the
              highest contrast available on this field. */}
          <button
            onClick={() => navigate('/login?mode=register')}
            className="btn mt-8 h-11 w-full bg-white text-[14px] font-semibold text-prism-700 hover:bg-white/90"
          >
            {t('landing.prCta')}
          </button>
        </div>
      </div>

      <p className="reveal mt-6 text-[12.5px] leading-relaxed text-neutral-500">{t('landing.prNote')}</p>
    </section>
  )
}

/* ═══════════════ 收尾 CTA / closing CTA ═══════════════
   排版承担全部重量：一条光谱线（全站签名图形）+ 大标题 + 单个按钮。
   上一版是一个带紫色 100px 模糊光斑的圆角大盒子——那个光斑正是这次要清掉的东西。
   Typography carries the whole weight: one spectral rule (the system's signature
   graphic), a large headline, one button. The previous version was a rounded box
   containing a 100px violet blur blob, which is precisely what this pass removes. */
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
    { h: '#guard', k: 'navWinrate' },
    { h: '#compare', k: 'navCompare' },
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
          <p className="mt-3 text-[11.5px] uppercase tracking-[0.14em] text-neutral-500">by PRISMX</p>
        </div>

        <nav className="md:col-span-3">
          <ul className="space-y-2.5">
            {links.map((l) => (
              <li key={l.h}>
                <a href={l.h} className="text-[13px] text-neutral-400 transition-colors hover:text-white">
                  {t(`landing.${l.k}`)}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        {/* 条款与政策：用 <Link> 而不是 <a href>——这三页是同一个 SPA 内的路由，
            用 <a> 会触发整页刷新，白屏一次再把整个 bundle 重新下一遍。
            Terms and policies via <Link>, not <a href>: these are routes inside the
            same SPA and an <a> forces a full reload — a white flash plus a
            re-download of the entire bundle. */}
        <div className="md:col-span-2">
          <p className="text-[11.5px] uppercase tracking-[0.14em] text-neutral-500">{t('landing.footerLegal')}</p>
          <ul className="mt-4 space-y-2.5">
            {(['terms', 'privacy', 'risk'] as const).map((d) => (
              <li key={d}>
                <Link
                  to={localePath(lang, `/${d}`)}
                  className="text-[13px] text-neutral-400 transition-colors hover:text-white"
                >
                  {t(`legal.${d}.title`)}
                </Link>
              </li>
            ))}
          </ul>
        </div>

        {/* 客服栏由 SUPPORT_EMAIL 控制，留空则整栏不渲染（见 config/site.ts）。
            Gated by SUPPORT_EMAIL; empty hides the whole column (see config/site.ts). */}
        {SUPPORT_EMAIL && (
          <div className="col-span-2 md:col-span-3">
            <p className="text-[11.5px] uppercase tracking-[0.14em] text-neutral-500">{t('landing.footerSupport')}</p>
            <p className="mt-4 text-[13px] leading-relaxed text-neutral-500">{t('landing.footerSupportBody')}</p>
            <a
              href={`mailto:${SUPPORT_EMAIL}`}
              className="mt-2 inline-block text-[13px] text-prism-400 underline underline-offset-4 transition-colors hover:text-prism-300"
            >
              {SUPPORT_EMAIL}
            </a>
          </div>
        )}
      </div>

      <div className={`${SHELL} border-t border-white/[0.07] py-8`}>
        <p className="max-w-[92ch] text-[11.5px] leading-relaxed text-neutral-500">{t('landing.footerRisk')}</p>
        <p className="mt-5 text-[11.5px] text-neutral-500">
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
    <div className="relative min-h-[100dvh] bg-ink-950 text-white">
      {/* 静态结构层：极低对比网格 + 顶端光谱线。零动画、零模糊、零重绘。
          Static structural layer: a very low-contrast grid plus the spectral rule
          at the top edge. No animation, no blur, no repaint. */}
      <div className="pointer-events-none fixed inset-0 z-0" aria-hidden>
        <div className="absolute inset-0 bg-prism-grid bg-[size:46px_46px]" />
        <div className="absolute inset-x-0 top-0 h-48 bg-gradient-to-b from-ink-950 to-transparent" />
        <div className="absolute inset-x-0 bottom-0 h-48 bg-gradient-to-t from-ink-950 to-transparent" />
      </div>

      <div className="relative z-10">
        <Navbar t={t} navigate={navigate} />
        <Hero t={t} navigate={navigate} />
        <FactBand t={t} />
        <Steps t={t} />
        <Discipline t={t} />
        <Ledger t={t} />
        <Verdict t={t} />
        <Pricing t={t} navigate={navigate} />
        <FaqSection />
        <ClosingCta t={t} navigate={navigate} />
        <Foot t={t} />
        <MobileStickyCta />
      </div>
    </div>
  )
}
