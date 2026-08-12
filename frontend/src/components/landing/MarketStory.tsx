// 第二幕：判决墙 / act II, the verdict wall
//
// ════════════════════════════════════════════════════════════════════════════
// 为什么从「飞行」改成「墙」
//
// 上一版把四条判定规则做成一条 3D 走廊，相机以第一人称飞进去。用户的截图给出
// 了裁决：画面读成「几个灰盒子从奇怪的角度掠过」。根因不是参数，是概念——
// 「穿过价格通道」要求观众边滚动边解码隐喻，解码失败就只剩混乱；而且飞行镜头
// 的自由度多到无法在无头环境里核对。
//
// 判决墙把同一个论点换成一次可以正面观看的展示：一面全出血的行情图，三条
// 水平线贯穿整个视口——止盈、入场、止损。滚动驱动的不是相机，是**时间**：
// 每一拍画出一段真实形状的价格线，价格碰到哪条线，那条线整条闪成实色，判决
// 印章盖在触点上。四拍 = 四条规则，每一拍都是同一句话的演示：输赢由行情判定，
// 谁都改不了。这正是这一幕要卖的东西——可验证，所以才值得注册。
//
// 构图全部是 viewBox 里的坐标数学，每个元素的位置在代码里就能核对；文字仍然
// 是真实 DOM（i18n 免费、预渲染直出、爬虫可读）。滚动行为与叙事区同构：桌面
// scrub（GSAP 时间线），移动端 / 减少动态 steps（IO 判拍 + CSS 过渡）。
//
// Act II changed from a flight to a wall. The corridor flythrough failed by
// concept, not by parameter: it demanded the viewer decode a metaphor while
// scrolling, and its camera had too many degrees of freedom to verify blind.
// The wall states the same argument as something you face: a full-bleed chart,
// three horizontal lines across the whole viewport - take-profit, entry,
// stop-loss. Scroll drives TIME, not a camera: each beat draws one price path,
// and whichever line the price touches flashes solid across the full width
// while a verdict stamp lands on the touch point. Four beats, four rules, each
// demonstrating the same sentence: the market does the scoring and nobody can
// edit it. Which is exactly what makes registering worth it.
//
// The composition is coordinate math inside a viewBox, verifiable line by line;
// the type stays real DOM (free i18n, prerendered, crawlable). Runtime modes
// mirror the story section: desktop scrub via GSAP, steps elsewhere.
//
// 桌面端若空间层起来了（html.space-on），这面 SVG 墙让位给 LandingSpace 里的
// 3D 判决碑——同一份数据立成一块有厚度、站在网格大地上的碑，本文件的墙退为
// WebGL 不可用 / 减少动态 / 真机时的后备。文字面板与节奏两层共用，不变。
// On desktop, once the space layer is up (html.space-on) this SVG wall yields to
// the 3D verdict stone in LandingSpace: the same data raised as a slab with real
// thickness standing on the grid floor. The wall remains the fallback for
// no-WebGL, reduced-motion and real devices. Text panels and pacing are shared.
// ════════════════════════════════════════════════════════════════════════════
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import {
  CASE_BOTH,
  CASE_LOSS,
  CASE_VOID,
  CASE_WIN,
  EN_Y,
  SL_Y,
  TP_Y,
  VOID_END_Y,
  X0,
  XT,
  type Pt,
} from './verdictData'

const BEATS = 5

/* ── 墙面坐标系 / the wall's coordinate system ──
   四个判例的路径数据在 verdictData.ts，与 3D 判决碑共用同一份（见该文件头注）。
   这里只负责把点列转成 SVG path。viewBox 1600×900：三条线的高度让底部留出
   29% 给文字；路径起点 x=340 在最方的常见屏（5:4 slice 裁到 x≈237）下也可见。
   The four cases live in verdictData.ts, shared with the 3D verdict stone (see
   that file's header). This file only turns point lists into SVG paths. In the
   1600 by 900 viewBox the lines leave the bottom 29% for type, and the path
   start at x=340 survives even a 5:4 slice crop (which reaches x=237). */
const toD = (p: Pt[]) => 'M' + p.map(([x, y]) => `${Math.round(x)} ${Math.round(y)}`).join(' L ')
const D_WIN = toD(CASE_WIN)
const D_LOSS = toD(CASE_LOSS)
const D_BOTH = toD(CASE_BOTH)
const D_VOID = toD(CASE_VOID)

const V_TP = '#8B6CFF' // prism-400：#5A22EE 的亮度只有 66/255，作为落点太弱
const V_SL = '#A1A1AA'
const V_INK = '#EDEDF0'
const V_DIM = '#71717A'

export default function MarketStory() {
  const { t } = useTranslation()
  const root = useRef<HTMLElement>(null)
  const [mode, setMode] = useState<'steps' | 'scrub'>('steps')
  const [active, setActive] = useState(0)
  /* 窄屏用 meet（完整可见、加非缩放描边保持线宽），宽屏用 slice（全出血）。
     preserveAspectRatio 不是 CSS 属性，只能由 React 切换。
     Narrow viewports use meet (fully visible, non-scaling strokes keep their
     width); wide ones use slice (full bleed). preserveAspectRatio is not a CSS
     property, so React has to switch it. */
  const [narrow, setNarrow] = useState(false)

  useEffect(() => {
    const desk = window.matchMedia('(min-width: 1024px)')
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)')
    const apply = () => {
      setMode(desk.matches && !reduce.matches ? 'scrub' : 'steps')
      setNarrow(!desk.matches)
    }
    apply()
    desk.addEventListener('change', apply)
    reduce.addEventListener('change', apply)
    return () => {
      desk.removeEventListener('change', apply)
      reduce.removeEventListener('change', apply)
    }
  }, [])

  /* ── steps 模式：IO 判拍，CSS 过渡画线 / steps: IO picks the beat ── */
  useEffect(() => {
    if (mode !== 'steps' || !root.current) return
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) setActive(Number((e.target as HTMLElement).dataset.step))
        })
      },
      { rootMargin: '-46% 0px -46% 0px', threshold: 0 }
    )
    root.current.querySelectorAll('.story-step').forEach((s) => io.observe(s))
    return () => io.disconnect()
  }, [mode])

  /* ── scrub 模式：GSAP 时间线 / scrub: the GSAP timeline ── */
  useEffect(() => {
    if (mode !== 'scrub' || !root.current) return
    let disposed = false
    let cleanup: (() => void) | undefined

    ;(async () => {
      const [{ gsap }, { ScrollTrigger }] = await Promise.all([import('gsap'), import('gsap/ScrollTrigger')])
      if (disposed || !root.current) return
      gsap.registerPlugin(ScrollTrigger)
      const el = root.current

      const ctx = gsap.context(() => {
        const scene = (n: number) => `[data-scene="${n}"]`
        const pan = (id: string) => `[data-panel="${id}"]`

        gsap.set(pan('mkt0'), { autoAlpha: 1, y: 0 })
        ;[1, 2, 3, 4].forEach((n) => {
          gsap.set(pan(`mkt${n}`), { autoAlpha: 0, y: 24 })
          gsap.set(scene(n), { autoAlpha: 0 })
          gsap.set(`${scene(n)} .sc-path`, { strokeDashoffset: 1 })
          gsap.set(`${scene(n)} .sc-band`, { autoAlpha: 0 })
          gsap.set(`${scene(n)} .sc-stamp`, { autoAlpha: 0, scale: 0.5, transformOrigin: 'center' })
        })

        let lastScene = -1
        const tl = gsap.timeline({
          defaults: { ease: 'power2.out' },
          scrollTrigger: {
            trigger: el,
            start: 'top top',
            end: 'bottom bottom',
            scrub: 0.6,
            invalidateOnRefresh: true,
            onUpdate: (st) => {
              const p = st.progress * 100
              const sc = p < 10 ? 0 : p < 28 ? 1 : p < 46 ? 2 : p < 64 ? 3 : 4
              if (sc !== lastScene) {
                lastScene = sc
                setActive(sc)
              }
            },
          },
        })

        /* 0-6 标题停留；整个行程里墙极缓慢地转正——唯一的姿态动作。
           Title hold, then the wall very slowly squares up: its only pose move. */
        tl.to({}, { duration: 6 })
        tl.to(pan('mkt0'), { autoAlpha: 0, y: -20, duration: 3 }, 6)
        tl.fromTo('.mkt-wall', { rotateY: -7, scale: 1.05 }, { rotateY: -2, scale: 1, ease: 'none', duration: 94 }, 6)

        /* 每拍 18 单位：进场 2、画线 8、判决 2、停留 3、退场 3。判决那一下是
           这一幕的全部戏剧：线走到头，整条价位线闪成实色，章落下。
           Eighteen units per beat: enter 2, draw 8, verdict 2, hold 3, exit 3.
           The verdict IS the drama: the path arrives, the whole level flashes
           solid, the stamp lands. */
        const beat = (n: number, at: number) => {
          tl.to(scene(n), { autoAlpha: 1, duration: 2 }, at)
          tl.fromTo(pan(`mkt${n}`), { autoAlpha: 0, y: 24 }, { autoAlpha: 1, y: 0, duration: 3 }, at + 1)
          tl.to(`${scene(n)} .sc-path`, { strokeDashoffset: 0, ease: 'none', duration: 8 }, at + 1)
          tl.to(`${scene(n)} .sc-band`, { autoAlpha: 1, duration: 1.2 }, at + 9.2)
          tl.to(`${scene(n)} .sc-stamp`, { autoAlpha: 1, scale: 1, duration: 1.5 }, at + 9.4)
          if (n < 4) {
            tl.to(scene(n), { autoAlpha: 0, duration: 2.5 }, at + 15.5)
            tl.to(pan(`mkt${n}`), { autoAlpha: 0, y: -20, duration: 2.5 }, at + 15.5)
          }
        }
        beat(1, 10)
        beat(2, 28)
        beat(3, 46)
        beat(4, 64)
        /* 最后一拍不退场：出画面时墙上留着「不计入」的判例，接住下面的
           wrNote + CTA。/ The last beat stays on the wall, handing off to the
           outro's note and CTA below. */
        tl.to({}, { duration: 100 - 79 })
      }, el)

      cleanup = () => ctx.revert()
    })()

    return () => {
      disposed = true
      cleanup?.()
    }
  }, [mode])

  const rules = [1, 2, 3, 4] as const

  return (
    <section
      ref={root}
      id="verdict"
      className={`story-root mkt-section ${mode === 'scrub' ? 'is-scrub' : ''}`}
    >
      <div className="mkt-stage">
        {/* ── 判决墙 / the wall ── */}
        <div className="mkt-wall" aria-hidden>
          <svg
            viewBox="0 0 1600 900"
            preserveAspectRatio={narrow ? 'xMidYMid meet' : 'xMidYMid slice'}
          >
            {/* 常驻层：三条价位线 + 信号起点。这是「法庭」本身，四个判例轮流
                上庭。/ The permanent layer: three levels and the signal origin.
                This is the courtroom; the four cases take turns on the stand. */}
            <g className="mkt-base">
              <line x1="0" y1={TP_Y} x2="1600" y2={TP_Y} stroke={V_TP} strokeOpacity="0.6" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
              <line x1="0" y1={EN_Y} x2="1600" y2={EN_Y} stroke="#3F3F46" strokeWidth="1" vectorEffect="non-scaling-stroke" />
              <line x1="0" y1={SL_Y} x2="1600" y2={SL_Y} stroke={V_DIM} strokeOpacity="0.55" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
              <text className="sc-label" x="1584" y={TP_Y - 14} textAnchor="end" fill={V_TP}>{t('landing.scrTp')}</text>
              <text className="sc-label" x="1584" y={EN_Y - 14} textAnchor="end" fill="#84848E">{t('landing.scrEntry')}</text>
              <text className="sc-label" x="1584" y={SL_Y - 14} textAnchor="end" fill={V_DIM}>{t('landing.scrSl')}</text>
              <line x1={X0} y1={TP_Y} x2={X0} y2={SL_Y} stroke="#2A2A31" strokeWidth="1" vectorEffect="non-scaling-stroke" />
              <rect x={X0 - 6} y={EN_Y - 6} width="12" height="12" fill={V_TP} />
              <text className="sc-label" x={X0 + 18} y={EN_Y + 40} fill="#84848E">{t('landing.wrSignalFired')}</text>
            </g>

            {/* 判例一：先碰止盈，记为赢 / case 1: take-profit first, a win */}
            <g data-scene="1" className={`mkt-scene ${active === 1 ? 'sc-on' : ''}`}>
              <rect className="sc-band" x="0" y={TP_Y - 6} width="1600" height="12" fill={V_TP} />
              <path className="sc-path" d={D_WIN} pathLength={1} stroke={V_INK} vectorEffect="non-scaling-stroke" />
              <rect className="sc-stamp" x={XT - 16} y={TP_Y - 16} width="32" height="32" fill={V_TP} />
            </g>

            {/* 判例二：先碰止损，记为输 / case 2: stop-loss first, a loss */}
            <g data-scene="2" className={`mkt-scene ${active === 2 ? 'sc-on' : ''}`}>
              <rect className="sc-band" x="0" y={SL_Y - 6} width="1600" height="12" fill={V_DIM} />
              <path className="sc-path" d={D_LOSS} pathLength={1} stroke={V_INK} vectorEffect="non-scaling-stroke" />
              <rect className="sc-stamp" x={XT - 16} y={SL_Y - 16} width="32" height="32" fill={V_SL} />
            </g>

            {/* 判例三：两头都碰，保守记为输 / case 3: both touched, scored a loss */}
            <g data-scene="3" className={`mkt-scene ${active === 3 ? 'sc-on' : ''}`}>
              <rect className="sc-band" x="0" y={TP_Y - 6} width="1600" height="12" fill={V_TP} />
              <rect className="sc-band" x="0" y={SL_Y - 6} width="1600" height="12" fill={V_DIM} />
              <path className="sc-path" d={D_BOTH} pathLength={1} stroke={V_INK} vectorEffect="non-scaling-stroke" />
              <circle className="sc-stamp" cx="1198" cy={SL_Y} r="8" fill={V_INK} />
              <circle className="sc-stamp" cx="1232" cy={TP_Y} r="8" fill={V_INK} />
              <rect className="sc-stamp" x={XT - 16} y={430 - 16} width="32" height="32" fill={V_SL} />
            </g>

            {/* 判例四：数据中断，不计入 / case 4: the outage, excluded */}
            <g data-scene="4" className={`mkt-scene ${active === 4 ? 'sc-on' : ''}`}>
              <path className="sc-path" d={D_VOID} pathLength={1} stroke={V_INK} vectorEffect="non-scaling-stroke" />
              <line className="sc-ghost" x1="780" y1={VOID_END_Y} x2={XT} y2={VOID_END_Y} stroke={V_DIM} strokeDasharray="10 14" strokeWidth="2" vectorEffect="non-scaling-stroke" />
              <rect className="sc-stamp sc-stamp-void" x={780 - 15} y={VOID_END_Y - 15} width="30" height="30" fill="none" stroke={V_DIM} strokeWidth="2" vectorEffect="non-scaling-stroke" />
            </g>
          </svg>
        </div>

        {/* ── 文字：拍 0 立论，拍 1-4 一拍一条规则 ──
            规则本身就是标题，尺寸提到整幕最大——墙演示，字宣判。
            Beat 0 states the claim; beats 1-4 take one rule each. The rule IS
            the headline at the act's largest size: the wall demonstrates, the
            type pronounces. */}
        <div className={`story-panel panel-l ${active === 0 ? 'on' : ''}`} data-panel="mkt0">
          <div className="panel-inner">
            <p className="text-[11.5px] uppercase tracking-[0.16em] text-prism-400">{t('landing.wrEyebrow')}</p>
            <h2 className="mt-4 max-w-[16ch] font-display-xl text-[clamp(1.9rem,4.8vw,3.1rem)] text-white">
              {t('landing.wrTitle')}
            </h2>
            <p className="mt-4 max-w-[46ch] text-[13.5px] leading-relaxed text-neutral-400 sm:text-[14.5px]">
              {t('landing.wrSubtitle')}
            </p>
          </div>
        </div>
        {rules.map((n, i) => (
          <div
            key={n}
            className={`story-panel panel-l ${active === i + 1 ? 'on' : ''}`}
            data-panel={`mkt${n}`}
          >
            <div className="panel-inner">
              <h3 className="max-w-[16ch] font-display-xl text-[clamp(1.7rem,3.6vw,2.9rem)] leading-[1.12] text-white">
                {t(`landing.wrRule${n}`)}
              </h3>
              <p className="mt-4 max-w-[44ch] text-[13.5px] leading-relaxed text-neutral-400 sm:text-[14.5px]">
                {t(`landing.wrRule${n}Note`)}
              </p>
            </div>
          </div>
        ))}

        <div className="story-ticks" aria-hidden>
          {Array.from({ length: BEATS }, (_, i) => (
            <span
              key={i}
              className={`js-tick transition-colors duration-300 ${active === i ? 'bg-prism-500' : 'bg-white/15'}`}
            />
          ))}
        </div>
      </div>

      {Array.from({ length: BEATS }, (_, i) => (
        <div key={i} className="story-step" data-step={i} style={{ top: `${i * 20}%` }} aria-hidden />
      ))}
    </section>
  )
}

/* 出庭后的落点：判决看完，正好是「进去看实时胜率」的时刻——wrNote 把话挑明
   （注册能看到两套互不粉饰的数据），CTA 直接接住。这一段是整页转化诉求最强
   的位置，字号也按这个权重给。
   Where you land after the verdicts: exactly the moment for "see the live win
   rate". wrNote says it plainly (register and see two unpolished ledgers) and
   the CTA catches it. This is the page's strongest conversion moment and the
   type is sized to that weight. */
export function MarketOutro() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  return (
    <section className="mx-auto w-full max-w-[1240px] px-5 pb-4 pt-16 sm:px-8 sm:pt-24">
      <div className="rule-spectral mb-12">
        <i />
      </div>
      <div className="grid grid-cols-1 items-center gap-10 lg:grid-cols-12">
        <p className="max-w-[38ch] text-[clamp(1.25rem,2.4vw,1.85rem)] font-medium leading-snug text-neutral-200 lg:col-span-7">
          {t('landing.wrNote')}
        </p>
        <div className="lg:col-span-4 lg:col-start-9">
          <button
            onClick={() => navigate('/login?mode=register')}
            className="btn btn-primary h-14 w-full px-8 text-[15px]"
          >
            {t('landing.wrCta')}
          </button>
        </div>
      </div>
    </section>
  )
}
