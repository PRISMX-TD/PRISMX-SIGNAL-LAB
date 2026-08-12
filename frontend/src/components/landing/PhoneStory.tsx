// 3D 手机滚动叙事 / phone scrolltelling
//
// 整页只有一个主角：一台 CSS 3D 手机，钉在视口（position: sticky，不用 GSAP
// pin——sticky 没有 pin-spacer 的布局副作用，更稳）。滚动条变成播放进度条，
// 五幕按「一笔真实交易的生命周期」推进：
//   幕0 Hero（信号列表）→ 幕1 完整计划 → 幕2 一键下单 → 幕3 自动守夜 → 幕4 全量留痕
//
// 两种运行模式（见 index.css 的说明）：
// · scrub：桌面 ≥1024px 且未开减少动态。GSAP ScrollTrigger 把一条时间线绑到
//   叙事区滚动进度上，驱动机身姿态 / 屏幕交叉淡化 / 下单滑块 / 止损线爬升；
//   另有鼠标跟随倾斜（quickTo，不进 React 渲染循环）。
// · steps：移动端或 reduced-motion。IntersectionObserver 判定当前幕，CSS 过渡
//   完成一切——没有 pin、没有 scrub、没有倾斜。
//
// GSAP 用动态 import：预渲染管线（Node 里 renderToString 会执行本模块）绝不能
// 在模块顶层碰 ScrollTrigger；动态 import 只在浏览器 effect 里发生，顺带把
// gsap 分进独立 chunk，不进首屏关键路径。
//
// One protagonist on the whole page: a CSS-3D phone stuck to the viewport
// (position: sticky, not GSAP pin — sticky has none of pin-spacer's layout side
// effects). The scrollbar becomes a playhead over five scenes that follow the
// life of one real trade: signal list → full plan → one-tap order → automatic
// guarding → the complete record.
//
// Two runtime modes (documented in index.css): scrub (desktop ≥1024px, no
// reduced-motion) where a GSAP ScrollTrigger timeline drives pose, screen
// crossfades, the order knob and the climbing SL line, plus pointer tilt via
// quickTo outside the React render loop; and steps (mobile / reduced-motion)
// where an IntersectionObserver picks the scene and CSS transitions do the rest.
//
// GSAP is imported dynamically: the prerender pipeline executes this module in
// Node via renderToString, so ScrollTrigger must never be touched at module
// scope. The dynamic import happens only in a browser effect, and it also
// splits gsap into its own chunk off the critical path.
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { PhoneChrome, ScreenSignals, ScreenPlan, ScreenOrder, ScreenGuard, ScreenRecord } from './PhoneScreens'
import { createPhoneGL, type PhoneGLHandle } from './PhoneGL'

type T = (k: string) => string

const SCENES = 5

// 各幕对应的底部 Tab：信号三幕（列表/计划/下单弹层都发生在信号面板）、守夜幕
// 亮仪表盘、留痕幕亮订单回执。激活 Tab 的移动本身就是「App 在被使用」的叙事。
// Active bottom tab per scene: the first three happen inside the signal panel
// (the order sheet overlays it), guarding lights the dashboard, the record
// lights order receipts. The moving highlight narrates an app in use.
const TAB_BY_SCENE = ['signals', 'signals', 'signals', 'dashboard', 'orders'] as const

export default function PhoneStory() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const root = useRef<HTMLElement>(null)

  // SSR/预渲染默认 steps：HTML 里首幕直接可见（LCP 与无 JS 场景都依赖这一点），
  // 挂载后再按真实媒体条件升级到 scrub。
  // Default to steps for SSR/prerender so scene 0 is visible in raw HTML (LCP
  // and no-JS both depend on it); upgrade to scrub after mount if media allows.
  const [mode, setMode] = useState<'steps' | 'scrub'>('steps')
  const [active, setActive] = useState(0)

  useEffect(() => {
    const desk = window.matchMedia('(min-width: 1024px)')
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)')
    const apply = () => setMode(desk.matches && !reduce.matches ? 'scrub' : 'steps')
    apply()
    desk.addEventListener('change', apply)
    reduce.addEventListener('change', apply)
    return () => {
      desk.removeEventListener('change', apply)
      reduce.removeEventListener('change', apply)
    }
  }, [])

  /* ── steps 模式：IO 判幕 / steps mode: IO picks the scene ── */
  useEffect(() => {
    if (mode !== 'steps' || !root.current) return
    const steps = root.current.querySelectorAll('.story-step')
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) setActive(Number((e.target as HTMLElement).dataset.step))
        })
      },
      // 只认视口中线附近的一小条：任一时刻恰好一个哨兵命中，不会双亮。
      // A thin band around the viewport midline: exactly one sentinel matches
      // at any moment, so two scenes can never be lit at once.
      { rootMargin: '-46% 0px -46% 0px', threshold: 0 }
    )
    steps.forEach((s) => io.observe(s))
    return () => io.disconnect()
  }, [mode])

  /* ── scrub 模式：GSAP 时间线 / scrub mode: the GSAP timeline ── */
  useEffect(() => {
    if (mode !== 'scrub' || !root.current) return
    let disposed = false
    let cleanup: (() => void) | undefined

    ;(async () => {
      const [{ gsap }, { ScrollTrigger }] = await Promise.all([import('gsap'), import('gsap/ScrollTrigger')])
      if (disposed || !root.current) return
      gsap.registerPlugin(ScrollTrigger)

      const el = root.current
      const q = (sel: string) => el.querySelector(sel) as HTMLElement | null
      const pose = q('.js-pose')
      const tilt = q('.js-tilt')
      const stage = q('.story-stage')
      if (!pose || !tilt || !stage) return

      /* ── WebGL 机身：能起就起，起不来就沿用 CSS 手机 ──
         两条路径共用下面这一条时间线：时间线只改姿态代理对象 PZ 的数值，由每帧
         的 applyPose 决定把它写进 three 的相机空间还是写成 CSS transform。这样
         剧本、节奏、所有屏幕内动效都只有一份，不存在两套需要同步的实现。
         WebGL body when it can start, CSS phone when it cannot. Both paths share
         the single timeline below: the timeline only mutates the pose proxy PZ,
         and the per-frame applyPose decides whether that lands in three's camera
         space or as a CSS transform. One script, one set of beats, one
         implementation of every in-screen effect - nothing to keep in sync. */
      const screenHost = q('.dev-screen')
      let gl: PhoneGLHandle | null = null
      if (screenHost) {
        try {
          gl = await createPhoneGL({ container: stage, screenEl: screenHost })
        } catch {
          gl = null
        }
      }
      if (disposed) {
        gl?.dispose()
        return
      }
      if (gl) el.classList.add('gl-on')

      /* 姿态代理：时间线动的是这些纯数值，不是 DOM。
         The pose proxy: the timeline animates these plain numbers, not the DOM. */
      const PZ = { xvw: 19, rotY: -22, rotX: 6, scale: 1 }
      const TZ = { rx: 0, ry: 0 }
      const applyPose = () => {
        if (gl) {
          gl.setPose({
            xPx: (PZ.xvw / 100) * stage.clientWidth,
            rotYdeg: PZ.rotY + TZ.ry,
            rotXdeg: PZ.rotX + TZ.rx,
            scale: PZ.scale,
          })
        } else {
          pose.style.transform = `translateX(${PZ.xvw}vw) rotateY(${PZ.rotY}deg) rotateX(${PZ.rotX}deg) scale(${PZ.scale})`
          tilt.style.transform = `rotateX(${TZ.rx}deg) rotateY(${TZ.ry}deg)`
        }
      }
      gsap.ticker.add(applyPose)

      const onResize = () => gl?.resize()
      window.addEventListener('resize', onResize)

      const ctx = gsap.context(() => {
        const scr = (n: number) => `[data-scr="${n}"]`
        const pan = (id: string) => `[data-panel="${id}"]`

        /* 初始状态：GSAP 从这一刻起拥有全部值（覆盖 .on 类规则）。
           Initial state: from here GSAP owns every value, overriding .on rules. */
        gsap.set(scr(0), { autoAlpha: 1, y: 0 })
        ;[1, 2, 3, 4].forEach((n) => gsap.set(scr(n), { autoAlpha: 0, y: 18 }))
        gsap.set(pan('hero'), { autoAlpha: 1, y: 0 })
        ;['1', '2', '3', '4'].forEach((id) => gsap.set(pan(id), { autoAlpha: 0, y: 24 }))
        gsap.set('.js-filled', { autoAlpha: 0 })
        gsap.set('.js-fill', { scaleX: 0 })
        gsap.set('.js-be', { autoAlpha: 0 })
        gsap.set('.js-rec', { autoAlpha: 0, y: 12 })
        /* 面光初始落位：与 hero 姿态（rotY -22°）相称，光带偏左。
           Face light resting position matching the hero pose (rotY -22°). */
        gsap.set('.js-facelight', { xPercent: -26 })

        /* 反光脉冲：转场时环境光扫过屏幕。这是反射，不是发光。
           Sheen pulse: ambient light sweeping the screen at a transition.
           A reflection, not an emission. */
        /* 峰值从 0.4 收到 0.16、基线从 0.1 收到 0.06。0.4 的白色渐变盖在屏幕内容
           上是 4 倍的亮度跃变，肉眼读到的不是「环境光扫过」而是「屏幕闪了一下」，
           而它恰好只在转场时发生，与「有时候会闪烁」的描述完全吻合。
           机身现在已由 WebGL 按环境贴图实算反射，屏幕上这层手绘反光的职责只剩
           「玻璃盖板本身也该有一点点反射」，该收到几乎察觉不到的强度。
           Peak pulled from 0.4 to 0.16 and the resting value from 0.1 to 0.06. A
           white gradient at 0.4 over the screen content is a fourfold brightness
           jump that reads as the screen blinking rather than as ambient light
           passing over it - and it fires only at transitions, which matches the
           report of occasional flicker exactly. Now that the body's reflections
           are computed from a real environment map in WebGL, this hand-drawn
           sheen only has to say "the cover glass reflects a little too", which
           belongs at a barely perceptible level. */
        const sheenPulse = (tl: gsap.core.Timeline, at: number) => {
          tl.to('.js-sheen', { opacity: 0.16, duration: 2, ease: 'power1.in' }, at)
          tl.to('.js-sheen', { opacity: 0.06, duration: 2.5, ease: 'power1.out' }, at + 2)
        }
        /* 屏幕交叉淡化 / screen crossfade */
        const swapScreen = (tl: gsap.core.Timeline, from: number, to: number, at: number) => {
          tl.to(scr(from), { autoAlpha: 0, y: -14, duration: 3 }, at)
          tl.fromTo(scr(to), { autoAlpha: 0, y: 18 }, { autoAlpha: 1, y: 0, duration: 3 }, at + 2)
        }
        const panelOut = (tl: gsap.core.Timeline, id: string, at: number) => {
          tl.to(pan(id), { autoAlpha: 0, y: -20, duration: 3 }, at)
        }
        const panelIn = (tl: gsap.core.Timeline, id: string, at: number) => {
          tl.fromTo(pan(id), { autoAlpha: 0, y: 24 }, { autoAlpha: 1, y: 0, duration: 4 }, at)
        }

        /* 主时间线：100 个单位映射到 420vh 的滚动行程（520vh 减一屏）。
           每幕的窗口在下面的注释里标出。
           Master timeline: 100 units mapped onto 420vh of travel (520vh minus
           one viewport). Scene windows are noted inline. */
        /* onUpdate 只负责喂右缘的幕计数刻度：进度换算成幕号，值变了才 setState
           （一次完整滚动最多 5 次重渲染，不是每帧）。视觉本身完全由时间线驱动。
           onUpdate only feeds the edge tick counter: progress maps to a scene
           index and setState fires only on change (at most 5 re-renders per
           full scroll, not per frame). The visuals themselves stay purely
           timeline-driven. */
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
              const p100 = st.progress * 100
              const scene = p100 < 13 ? 0 : p100 < 31 ? 1 : p100 < 49 ? 2 : p100 < 67 ? 3 : 4
              if (scene !== lastScene) {
                lastScene = scene
                setActive(scene)
              }
            },
          },
        })

        /* 0–10 Hero 停留 / hero hold */
        tl.to({}, { duration: 10 })

        /* 10–16 转场①：右→左，屏幕亮出完整计划 / hero → plan, phone crosses right→left */
        panelOut(tl, 'hero', 10)
        tl.to(PZ, { xvw: -19, rotY: 12, rotX: 4, duration: 6, ease: 'power2.inOut' }, 10)
        /* 面光与 rotateY 同窗口反向横扫：光源固定在房间里，机身转动时高光
           划过包边——这是「静态渐变」与「被灯照着的物体」的分界线。
           The face light sweeps in the same window as rotateY: the lamp stays
           fixed in the room while the body turns, so the highlight travels
           across the rim. This is the line between a printed gradient and an
           object under a light. */
        tl.to('.js-facelight', { xPercent: 14, duration: 6, ease: 'power2.inOut' }, 10)
        sheenPulse(tl, 11)
        swapScreen(tl, 0, 1, 11)
        panelIn(tl, '1', 14)

        /* 16–28 幕1 停留：机身缓慢回正 3°，给静止的画面留一口呼吸。
           Scene 1 hold: the body eases back 3° so the still frame keeps breathing. */
        tl.to(PZ, { rotY: 9, duration: 12, ease: 'none' }, 16)
        tl.to('.js-facelight', { xPercent: 11, duration: 12, ease: 'none' }, 16)

        /* 28–34 转场② / plan → order */
        panelOut(tl, '1', 28)
        tl.to(PZ, { rotY: 17, scale: 1.04, duration: 5, ease: 'power2.inOut' }, 29)
        tl.to('.js-facelight', { xPercent: 20, duration: 5, ease: 'power2.inOut' }, 29)
        sheenPulse(tl, 30)
        swapScreen(tl, 1, 2, 29)
        panelIn(tl, '2', 32)

        /* 34–46 幕2：滑块与滚动进度同构——往下滚 = 往右推。
           Scene 2: the knob IS the scroll — scrolling down pushes it right. */
        tl.fromTo(
          '.js-knob',
          { x: 0 },
          {
            x: () => {
              const track = q('.js-track')
              const knob = q('.js-knob')
              return track && knob ? track.clientWidth - knob.offsetWidth - track.clientWidth * 0.024 : 150
            },
            duration: 9,
            ease: 'none',
          },
          35
        )
        /* 紫色填充层与滑块同步推进（同 SlideOrderModal 的 .slide-track-fill）。
           The violet fill advances in step with the knob, as .slide-track-fill. */
        tl.fromTo('.js-fill', { scaleX: 0 }, { scaleX: 1, duration: 9, ease: 'none' }, 35)
        tl.to('.js-filled', { autoAlpha: 1, duration: 2 }, 44)

        /* 46–52 转场③：左→右，拉近看图表 / order → guard, phone crosses back, zooms in */
        panelOut(tl, '2', 46)
        tl.to(PZ, { xvw: 19, rotY: -10, rotX: 3, scale: 1.1, duration: 6, ease: 'power2.inOut' }, 46)
        tl.to('.js-facelight', { xPercent: -12, duration: 6, ease: 'power2.inOut' }, 46)
        sheenPulse(tl, 47)
        swapScreen(tl, 2, 3, 47)
        panelIn(tl, '3', 50)

        /* 52–64 幕3：止损线先跳保本（-10 用户单位，越过入场价），保本徽章亮起，
           再追踪行情推进到 -26。SVG 子元素的 CSS transform 以用户坐标系为单位。
           Scene 3: SL jumps to breakeven (-10 user units, past entry), the badge
           lights, then trails to -26. CSS transforms on SVG children use user units. */
        tl.to('.js-sl', { y: -10, duration: 4, ease: 'power2.inOut' }, 53)
        tl.to('.js-be', { autoAlpha: 1, duration: 2 }, 56.5)
        tl.to('.js-sl', { y: -26, duration: 5, ease: 'none' }, 58)

        /* 64–70 转场④ / guard → record */
        panelOut(tl, '3', 64)
        tl.to(PZ, { rotY: 7, scale: 1.02, duration: 5, ease: 'power2.inOut' }, 64)
        tl.to('.js-facelight', { xPercent: 8, duration: 5, ease: 'power2.inOut' }, 64)
        sheenPulse(tl, 65)
        swapScreen(tl, 3, 4, 65)
        panelIn(tl, '4', 68)

        /* 70–84 幕4：记录逐行入场，赢亏同权重 / record rows stagger in, wins and losses equal */
        tl.to('.js-rec', { autoAlpha: 1, y: 0, duration: 2, stagger: 1.6 }, 71)

        /* 84–100 收尾：手机归正居中、微缩，让位给下方内容。
           Ending: the phone squares up, centres and shrinks, yielding to the
           content below. */
        panelOut(tl, '4', 85)
        tl.to(PZ, { xvw: 0, rotY: 0, rotX: 0, scale: 0.92, duration: 11, ease: 'power2.inOut' }, 86)
        tl.to('.js-facelight', { xPercent: 0, duration: 11, ease: 'power2.inOut' }, 86)

        /* ── 鼠标跟随倾斜 / pointer tilt ──
           quickTo 直接写合成器属性，不触碰 React。挂在内层 .js-tilt 上，
           与时间线驱动的外层 .js-pose 互不抢值。
           quickTo writes compositor props directly, never touching React. It
           lives on the inner .js-tilt so it can't fight the timeline-driven
           outer .js-pose for the same values. */
        const rx = gsap.quickTo(TZ, 'rx', { duration: 0.6, ease: 'power3.out' })
        const ry = gsap.quickTo(TZ, 'ry', { duration: 0.6, ease: 'power3.out' })
        /* 玻璃反光跟随光标微转：机身倾斜时屏幕玻璃上的反光角度跟着变——
           挂在 .js-sheen 的 rotation 上（合成器属性），与时间线驱动的 opacity
           不同轴，互不抢值。/ The glass reflection turns slightly with the
           cursor: tied to .js-sheen's rotation (compositor prop), a different
           axis from the timeline-driven opacity, so the two never fight. */
        const rs = gsap.quickTo('.js-sheen', 'rotation', { duration: 0.8, ease: 'power3.out' })
        const onMove = (e: MouseEvent) => {
          const r = stage.getBoundingClientRect()
          rx((0.5 - (e.clientY - r.top) / r.height) * 6)
          ry(((e.clientX - r.left) / r.width - 0.5) * 8)
          rs(((e.clientX - r.left) / r.width - 0.5) * -5)
        }
        const onLeave = () => {
          rx(0)
          ry(0)
          rs(0)
        }
        stage.addEventListener('mousemove', onMove)
        stage.addEventListener('mouseleave', onLeave)
        return () => {
          stage.removeEventListener('mousemove', onMove)
          stage.removeEventListener('mouseleave', onLeave)
        }
      }, el)

      cleanup = () => {
        window.removeEventListener('resize', onResize)
        gsap.ticker.remove(applyPose)
        ctx.revert()
        // 先卸 GL（它会把屏幕节点放回 React 记得的位置），再摘类名。
        // Dispose GL first (it restores the screen node to where React remembers
        // it), then drop the class.
        gl?.dispose()
        el.classList.remove('gl-on')
      }
    })()

    return () => {
      disposed = true
      cleanup?.()
    }
  }, [mode])

  /* 文字面板配置：幕1/2 在右（手机在左），幕3/4 在左（手机在右）——两次换边，
     不是每幕交替。/ Panel sides: scenes 1-2 right (phone left), 3-4 left (phone
     right). Two side switches total, not per-scene alternation. */
  const panels: { id: string; side: 'l' | 'r'; pain: string; title: string; desc: string }[] = [
    { id: '1', side: 'r', pain: 'sh1Pain', title: 'sh1Title', desc: 'sh1Desc' },
    { id: '2', side: 'r', pain: 'sh2Pain', title: 'sh2Title', desc: 'sh2Desc' },
    { id: '3', side: 'l', pain: 'sh3Pain', title: 'sh3Title', desc: 'sh3Desc' },
    { id: '4', side: 'l', pain: 'sh4Pain', title: 'sh4Title', desc: 'sh4Desc' },
  ]

  return (
    <section
      ref={root}
      id="showcase"
      className={`story-section story-root ${mode === 'scrub' ? 'is-scrub' : ''}`}
    >
      <div className="story-stage">
        {/* ── 手机 / the phone ── */}
        <div className="story-phone">
          <div className="dev-scene">
            <div className="js-pose dev-pose">
              <div className="js-tilt dev-tilt">
                <div className="dev-body">
                  <div className="dev-ground" aria-hidden />
                  {/* 9 层堆叠机身：~25px 厚度。此前 14px 换算过来只有一张信用卡
                      厚，「太薄」是显假的第一原因。/ Nine stacked slabs, ~25px
                      deep. The previous 14px scaled to a credit card, and "too
                      thin" is the first thing that reads as fake. */}
                  {Array.from({ length: 9 }, (_, i) => (
                    <div key={i} className="dev-slab" aria-hidden />
                  ))}
                  <div className="dev-face" aria-hidden />
                  {/* 动态面光：随姿态横扫的柔光带（时间线驱动）。
                      The travelling face light, driven by the timeline. */}
                  <div className="dev-facelight" aria-hidden>
                    <i className="js-facelight" />
                  </div>
                  <div className="dev-screen">
                    <ScreenSignals t={t as T} on={active === 0} />
                    <ScreenPlan t={t as T} on={active === 1} />
                    <ScreenOrder t={t as T} on={active === 2} />
                    <ScreenGuard t={t as T} on={active === 3} />
                    <ScreenRecord t={t as T} on={active === 4} />
                    {/* App 骨架常驻：品牌条与 Tab 栏不随幕淡出，正如真实 App 的
                        导航不随页面内容消失。/ The chrome persists: brand strip
                        and tab bar never fade with a scene, exactly as real app
                        navigation never disappears with page content. */}
                    <PhoneChrome t={t as T} activeTab={TAB_BY_SCENE[active]} />
                    <div className="dev-sheen js-sheen" aria-hidden />
                  </div>
                  {/* 侧键 / side keys */}
                  <div className="dev-key power" aria-hidden />
                  <div className="dev-key vol-a" aria-hidden />
                  <div className="dev-key vol-b" aria-hidden />
                  <div className="dev-island" aria-hidden />
                </div>
              </div>
            </div>
          </div>
          {/* 示例声明：合规信息，放在手机外的正下方，不叠在屏幕上。
              Sample-data disclaimer: compliance text below the phone, never
              overlaid on the screen. */}
          <p className="mt-4 text-center text-[11px] text-neutral-500">{t('landing.shCaption')}</p>
        </div>

        {/* ── Hero 面板（含 CTA，唯一可点面板）/ hero panel, the only interactive one ── */}
        <div className={`story-panel panel-l pe ${active === 0 ? 'on' : ''}`} data-panel="hero">
          <div className="panel-inner">
            <h1 className="font-display-xl text-[clamp(2.1rem,5vw,3.6rem)]">
              <span className="block text-white">{t('landing.heroTitle1')}</span>
              <span className="mt-1 block text-prism-400">{t('landing.heroTitle2')}</span>
            </h1>
            <p className="mt-5 max-w-[44ch] text-[14px] leading-relaxed text-neutral-400 sm:text-[15px]">
              {t('landing.heroSubtitle')}
            </p>
            <div className="mt-7 flex flex-wrap items-center gap-x-6 gap-y-3">
              <button
                onClick={() => navigate('/login?mode=register')}
                className="btn btn-primary h-11 px-6 text-[14px] sm:h-12 sm:px-7 sm:text-[15px]"
              >
                {t('landing.ctaPrimary')}
              </button>
              <a
                href="#pricing"
                className="text-[13.5px] text-neutral-400 underline decoration-white/20 underline-offset-[6px] transition-colors hover:text-white hover:decoration-white/60"
              >
                {t('landing.ctaSecondary')}
              </a>
            </div>
          </div>
        </div>

        {/* ── 四幕文字面板 / the four scene panels ── */}
        {panels.map((p, i) => (
          <div
            key={p.id}
            className={`story-panel panel-${p.side} ${active === i + 1 ? 'on' : ''}`}
            data-panel={p.id}
          >
            <div className="panel-inner">
              <p className="text-[13px] leading-relaxed text-neutral-500">{t(`landing.${p.pain}`)}</p>
              <h2 className="mt-3 font-display-xl text-[clamp(1.4rem,2.6vw,2.1rem)] text-white">
                {t(`landing.${p.title}`)}
              </h2>
              <p className="mt-3 max-w-[46ch] text-[13.5px] leading-relaxed text-neutral-400 sm:text-[14px]">
                {t(`landing.${p.desc}`)}
              </p>
            </div>
          </div>
        ))}

        {/* 幕计数：右缘一列 5 个刻度，当前幕为紫。这不是装饰圆点——它表达的是
            真实的播放进度状态。/ Scene counter: five ticks on the right edge,
            the current one violet. Not decorative dots: it reports real
            playhead state. */}
        <div className="absolute right-4 top-1/2 z-20 hidden -translate-y-1/2 flex-col gap-2.5 lg:flex" aria-hidden>
          {Array.from({ length: SCENES }, (_, i) => (
            <span
              key={i}
              className={`js-tick h-5 w-[3px] rounded-full transition-colors duration-300 ${
                active === i ? 'bg-prism-400' : 'bg-white/15'
              }`}
            />
          ))}
        </div>
      </div>

      {/* IO 哨兵（steps 模式用；scrub 模式下无害闲置）
          IO sentinels for steps mode; harmlessly idle under scrub. */}
      {Array.from({ length: SCENES }, (_, i) => (
        <div key={i} className="story-step" data-step={i} style={{ top: `${i * 20}%` }} aria-hidden />
      ))}
    </section>
  )
}
