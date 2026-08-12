// 第二幕：判定终端 / act II, the verdict terminal
//
// ════════════════════════════════════════════════════════════════════════════
// 第四版，也是概念上的最后一版。前三版的教训按顺序排开：
//   走廊（第一人称飞行）  → 读成杂物：要求观众边滚动边解码隐喻
//   图纸墙（极简线条 SVG）→ 可读但「平面」：贴在页面上的图，不是物
//   判决碑（3D 挤出浮雕）  → 仍然被否：三个抽象方案连续失败
//
// 规律已经清楚：**抽象几何在这个页面上不成立**。整页唯一被认可的视觉是那台
// 手机——因为它具体、可辨认、展示真实产品。所以判定幕改用产品自己的语言：
// 一块真实的行情终端面板，重演第一幕手机里那条 XAUUSD 信号（入场 3412.80 /
// 止损 3398.20 / 止盈 3445.60，同一组数字）在四种结局下如何被判定。蜡烛随
// 滚动一根根走出来，价格触线的瞬间：价位线整条闪色、判决章盖下——章上的字
// 就是产品里真实的判定文案（止盈触发 / 止损触发 · 记录保留）。
//
// 为什么这个能成立而前三个不能：K 线图不需要解码，交易者一眼认得；它与第一
// 幕的手机讲的是同一条信号，叙事连续；而且它就是注册后真正会用的界面——
// 「想注册」的冲动来自看见产品本身，不来自装饰。配色直接用产品令牌
// （--up #35c97a / --down #f04d63），与手机屏内的信号卡完全一致。
//
// Fourth concept and the conceptually final one. The pattern across three
// failures (corridor, blueprint wall, stone) is clear: abstract geometry does
// not land on this page. The only approved visual is the phone - concrete,
// recognisable, the real product. So the verdict act now speaks the product's
// own language: a real market terminal replaying the exact XAUUSD signal from
// act I under its four endings. Candles march out with scroll; at the touch
// the level flashes and a verdict stamp lands, carrying the product's real
// verdict copy. A candlestick chart needs no decoding, it continues act I's
// story, and it IS the interface you get after registering - the urge to sign
// up comes from seeing the product, not from decoration. Colours are the
// product tokens (--up / --down), identical to the signal card on the phone.
//
// 技术骨架不变：文字真实 DOM（i18n / 预渲染 / 爬虫），桌面 scrub（GSAP），
// 移动端与减少动态 steps（IO + CSS 过渡按 --ci 逐根级联）。全部几何是
// viewBox 坐标数学，可逐项核对。
// ════════════════════════════════════════════════════════════════════════════
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { CASES, P_ENTRY, P_SL, P_TP, type Candle } from './verdictData'

const BEATS = 5

/* ── 终端坐标系 / the terminal's coordinate system ──
   viewBox 1600×900，meet 模式（不裁切，构图固定）。面板占右侧 2/3，左下留给
   规则标题。价格→y 为线性映射，三条价位线的位置由真实价差决定（盈亏比
   1:2.26，所以止盈离入场远、止损近——图形本身就在展示这单的赔率）。
   A 1600 by 900 viewBox in meet mode (no cropping, fixed composition). The
   panel takes the right two thirds, lower left belongs to the rule headline.
   Price maps linearly to y, so the three levels sit where the real numbers put
   them: at 1:2.26 the target is far and the stop is near - the drawing itself
   displays the trade's odds. */
const PANEL = { x: 500, y: 100, w: 1060, h: 700 }
const PLOT = { x0: 560, x1: 1390, y0: 190, y1: 730 }
const P_TOP = 3452
const P_BOT = 3392
const py = (p: number) => Math.round((PLOT.y0 + ((P_TOP - p) / (P_TOP - P_BOT)) * (PLOT.y1 - PLOT.y0)) * 10) / 10
const cx = (i: number) => 590 + i * 33
const Y_TP = py(P_TP)
const Y_EN = py(P_ENTRY)
const Y_SL = py(P_SL)

const fmt = (p: number) => p.toFixed(2)

/* 单根蜡烛 / one candle */
function CandleG({ c, i }: { c: Candle; i: number }) {
  const up = c.c >= c.o
  const x = cx(i)
  const bodyTop = py(Math.max(c.o, c.c))
  const bodyH = Math.max(3, Math.abs(py(c.o) - py(c.c)))
  return (
    <g className="sc-candle" style={{ ['--ci' as string]: i }}>
      <line x1={x} x2={x} y1={py(c.h)} y2={py(c.l)} className={up ? 'cnd-up-s' : 'cnd-dn-s'} strokeWidth="2.5" />
      <rect x={x - 10} y={bodyTop} width="20" height={bodyH} rx="2" className={up ? 'cnd-up' : 'cnd-dn'} />
    </g>
  )
}

/* 价位标签 / a level chip on the right edge */
function LevelChip({ y, cls, label, price }: { y: number; cls: string; label: string; price: string }) {
  return (
    <g>
      <rect x="1398" y={y - 21} width="154" height="42" rx="8" className={`chip-${cls}`} />
      <text x="1412" y={y + 6} className={`chip-t-${cls}`} fontSize="16">
        {label}
      </text>
      <text x="1540" y={y + 6} textAnchor="end" className={`tnum chip-t-${cls}`} fontSize="17">
        {price}
      </text>
    </g>
  )
}

export default function MarketStory() {
  const { t } = useTranslation()
  const root = useRef<HTMLElement>(null)
  const [mode, setMode] = useState<'steps' | 'scrub'>('steps')
  const [active, setActive] = useState(0)
  /* 窄屏把 viewBox 收紧到面板本身，少浪费一圈留白。preserveAspectRatio 恒为
     meet：构图永不被裁切，这一幕的可信度就在「每个元素都在它该在的位置」。
     Narrow viewports tighten the viewBox to the panel itself. meet always: the
     composition is never cropped - this act's credibility lives in every
     element being exactly where it belongs. */
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

  /* ── steps 模式：IO 判拍 / steps: IO picks the beat ── */
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
          /* 蜡烛只做透明度，绝不加变换。GSAP 对 SVG 子元素按 viewBox 坐标烘焙
             变换原点补偿，而 CSS 的 transform-box: fill-box 让浏览器按元素自身
             包围盒解释同一个原点——两套坐标系打架，每根蜡烛被平移了不同距离，
             实测整组蜡烛飘出绘图区、压在表头上。位置必须由标注坐标唯一决定。
             Candles animate opacity ONLY, never transforms. GSAP bakes SVG
             transform-origin compensation in viewBox coordinates while CSS
             transform-box: fill-box makes the browser resolve that origin
             against each element's own bounds - two coordinate systems fighting,
             every candle translated by a different amount. Measured: the whole
             series drifted out of the plot onto the header. Authored coordinates
             must be the single source of position. */
          gsap.set(`${scene(n)} .sc-candle`, { autoAlpha: 0 })
          gsap.set(`${scene(n)} .sc-band`, { autoAlpha: 0 })
          gsap.set(`${scene(n)} .sc-stamp`, { autoAlpha: 0, scale: 0.6, transformOrigin: '50% 50%' })
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

        /* 0-6 标题停留；终端面板整程缓慢转正——唯一的姿态动作。
           Title hold; the panel slowly squares up, its only pose move. */
        tl.to({}, { duration: 6 })
        tl.to(pan('mkt0'), { autoAlpha: 0, y: -20, duration: 3 }, 6)
        tl.fromTo('.mkt-wall', { rotateY: -7, scale: 1.05 }, { rotateY: -2, scale: 1, ease: 'none', duration: 94 }, 6)

        /* 每拍 18 单位：蜡烛逐根走出（stagger 摊满 8 单位），最后一根触线，
           价位线闪色、判决章落下。行情自己走完，规则自己应验。
           Eighteen units per beat: candles march one by one across eight units,
           the last one touches, the level flashes, the stamp lands. The market
           plays itself out and the rule comes true on its own. */
        const beat = (n: number, at: number) => {
          tl.to(scene(n), { autoAlpha: 1, duration: 2 }, at)
          tl.fromTo(pan(`mkt${n}`), { autoAlpha: 0, y: 24 }, { autoAlpha: 1, y: 0, duration: 3 }, at + 1)
          tl.fromTo(
            `${scene(n)} .sc-candle`,
            { autoAlpha: 0 },
            { autoAlpha: 1, duration: 0.9, stagger: 7 / 24, ease: 'power1.out' },
            at + 1
          )
          tl.to(`${scene(n)} .sc-band`, { autoAlpha: 1, duration: 1.1 }, at + 9.3)
          tl.to(`${scene(n)} .sc-stamp`, { autoAlpha: 1, scale: 1, duration: 1.4, ease: 'back.out(1.6)' }, at + 9.5)
          if (n < 4) {
            tl.to(scene(n), { autoAlpha: 0, duration: 2.5 }, at + 15.5)
            tl.to(pan(`mkt${n}`), { autoAlpha: 0, y: -20, duration: 2.5 }, at + 15.5)
          }
        }
        beat(1, 10)
        beat(2, 28)
        beat(3, 46)
        beat(4, 64)
        tl.to({}, { duration: 21 })
      }, el)

      cleanup = () => ctx.revert()
    })()

    return () => {
      disposed = true
      cleanup?.()
    }
  }, [mode])

  const rules = [1, 2, 3, 4] as const
  const voidCase = CASES[3]
  const voidLast = voidCase.candles[voidCase.candles.length - 1]
  const yGhost = py(voidLast.c)
  const xGhost = cx(voidCase.candles.length - 1) + 26

  /* 各判例的触线记号与判决章 / touch markers and verdict stamps per case */
  const lastIdx = 23
  const xTouch = cx(lastIdx)

  return (
    <section
      ref={root}
      id="verdict"
      className={`story-root mkt-section ${mode === 'scrub' ? 'is-scrub' : ''}`}
    >
      <div className="mkt-stage">
        {/* ── 判定终端 / the verdict terminal ── */}
        <div className="mkt-wall" aria-hidden>
          <svg
            viewBox={narrow ? '480 90 1100 720' : '0 0 1600 900'}
            preserveAspectRatio="xMidYMid meet"
          >
            {/* 面板底座 + 表头：这就是产品的终端语言（同 /charts 页）。
                The panel and its header: the product's own terminal language. */}
            <g className="mkt-base">
              <rect x={PANEL.x} y={PANEL.y} width={PANEL.w} height={PANEL.h} rx="18" className="term-bg" />
              <text x="540" y="150" fontSize="30" fontWeight="700" fill="#EDEDF0">
                XAUUSD
              </text>
              <rect x="700" y="118" width="86" height="42" rx="10" className="chip-up" />
              <text x="743" y="145" textAnchor="middle" fontSize="19" fontWeight="700" className="chip-t-up">
                {t('landing.scrBuy')}
              </text>
              <text x="1540" y="130" textAnchor="end" fontSize="15" fill="#84848E">
                {t('landing.scrRr')}
              </text>
              <text x="1540" y="158" textAnchor="end" fontSize="24" fontWeight="700" className="tnum chip-t-up">
                1:2.26
              </text>
              <line x1="520" y1="176" x2="1540" y2="176" stroke="#ffffff" strokeOpacity="0.08" strokeWidth="1" />

              {/* 稀疏网格 / sparse gridlines */}
              {[300, 400, 500, 600, 700].map((gy) => (
                <line key={gy} x1={PLOT.x0} y1={gy} x2={PLOT.x1} y2={gy} stroke="#ffffff" strokeOpacity="0.04" strokeWidth="1" />
              ))}

              {/* 三条价位线：位置由真实价差决定 / the three levels at their real prices */}
              <line x1={PLOT.x0} y1={Y_TP} x2={PLOT.x1} y2={Y_TP} className="lvl-up" strokeWidth="1.5" strokeDasharray="8 7" />
              <line x1={PLOT.x0} y1={Y_EN} x2={PLOT.x1} y2={Y_EN} stroke="#8B8B95" strokeOpacity="0.5" strokeWidth="1" />
              <line x1={PLOT.x0} y1={Y_SL} x2={PLOT.x1} y2={Y_SL} className="lvl-dn" strokeWidth="1.5" strokeDasharray="8 7" />
              <LevelChip y={Y_TP} cls="up" label={t('landing.scrTp')} price={fmt(P_TP)} />
              <LevelChip y={Y_EN} cls="en" label={t('landing.scrEntry')} price={fmt(P_ENTRY)} />
              <LevelChip y={Y_SL} cls="dn" label={t('landing.scrSl')} price={fmt(P_SL)} />

              {/* 信号起点 / where the signal fires */}
              <rect x={cx(0) - 7} y={Y_EN - 7} width="14" height="14" rx="3" fill="#8B6CFF" />
              <text x={cx(0) + 16} y={Y_EN + 34} fontSize="16" fill="#84848E">
                {t('landing.wrSignalFired')}
              </text>
            </g>

            {/* 判例一：影线刺穿止盈，记为赢 / case 1: the wick takes TP, a win */}
            <g data-scene="1" className={`mkt-scene ${active === 1 ? 'sc-on' : ''}`}>
              <rect className="sc-band bnd-up" x={PLOT.x0} y={Y_TP - 8} width={PLOT.x1 - PLOT.x0} height="16" rx="3" />
              {CASES[0].candles.map((c, i) => (
                <CandleG key={i} c={c} i={i} />
              ))}
              <circle className="sc-stamp" cx={xTouch} cy={py(P_TP + 0.7)} r="8" fill="#35c97a" />
              <g transform="rotate(-8 1060 390)">
                <g className="sc-stamp">
                  <rect x="880" y="340" width="360" height="100" rx="14" className="st-win" />
                  <text x="1060" y="405" textAnchor="middle" fontSize="42" fontWeight="800" className="st-win-t">
                    {t('landing.scrWin')}
                  </text>
                </g>
              </g>
            </g>

            {/* 判例二：先碰止损，记为输 / case 2: SL first, a loss */}
            <g data-scene="2" className={`mkt-scene ${active === 2 ? 'sc-on' : ''}`}>
              <rect className="sc-band bnd-dn" x={PLOT.x0} y={Y_SL - 8} width={PLOT.x1 - PLOT.x0} height="16" rx="3" />
              {CASES[1].candles.map((c, i) => (
                <CandleG key={i} c={c} i={i} />
              ))}
              <circle className="sc-stamp" cx={xTouch} cy={py(P_SL - 0.6)} r="8" fill="#f04d63" />
              <g transform="rotate(-8 1010 540)">
                <g className="sc-stamp">
                  <rect x="740" y="490" width="540" height="100" rx="14" className="st-loss" />
                  <text x="1010" y="553" textAnchor="middle" fontSize="34" fontWeight="800" className="st-loss-t">
                    {t('landing.scrLoss')}
                  </text>
                </g>
              </g>
            </g>

            {/* 判例三：一根 K 线两头都碰，保守记为输
                Case 3: one bar takes both sides; conservatively a loss. */}
            <g data-scene="3" className={`mkt-scene ${active === 3 ? 'sc-on' : ''}`}>
              <rect className="sc-band bnd-up" x={PLOT.x0} y={Y_TP - 8} width={PLOT.x1 - PLOT.x0} height="16" rx="3" />
              <rect className="sc-band bnd-dn" x={PLOT.x0} y={Y_SL - 8} width={PLOT.x1 - PLOT.x0} height="16" rx="3" />
              {CASES[2].candles.map((c, i) => (
                <CandleG key={i} c={c} i={i} />
              ))}
              <circle className="sc-stamp" cx={xTouch} cy={py(P_TP + 0.8)} r="8" fill="#35c97a" />
              <circle className="sc-stamp" cx={xTouch} cy={py(P_SL - 0.9)} r="8" fill="#f04d63" />
              <g transform="rotate(-8 1010 540)">
                <g className="sc-stamp">
                  <rect x="740" y="490" width="540" height="100" rx="14" className="st-loss" />
                  <text x="1010" y="553" textAnchor="middle" fontSize="34" fontWeight="800" className="st-loss-t">
                    {t('landing.scrLoss')}
                  </text>
                </g>
              </g>
            </g>

            {/* 判例四：数据中断，行情走到一半戛然而止 / case 4: the feed dies mid-run */}
            <g data-scene="4" className={`mkt-scene ${active === 4 ? 'sc-on' : ''}`}>
              {CASES[3].candles.map((c, i) => (
                <CandleG key={i} c={c} i={i} />
              ))}
              <g className="sc-stamp">
                <line x1={xGhost} y1={yGhost} x2={PLOT.x1 - 10} y2={yGhost} stroke="#71717a" strokeWidth="2" strokeDasharray="10 12" />
                <rect x={xGhost - 13} y={yGhost - 13} width="26" height="26" rx="4" fill="none" stroke="#71717a" strokeWidth="2" />
              </g>
            </g>
          </svg>
        </div>

        {/* ── 文字：拍 0 立论，拍 1-4 一拍一条规则 / beat 0 states the claim,
            beats 1-4 take one rule each ── */}
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

/* 判定看完的落点：正是「进去看实时胜率」的时刻——wrNote 把话挑明（注册可见
   两套互不粉饰的数据），CTA 直接接住。整页转化诉求最强的位置。
   Where you land after the verdicts: the moment for "see the live win rate".
   wrNote says it plainly and the CTA catches it - the page's strongest
   conversion moment. */
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
