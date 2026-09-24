// 节日小装饰的组件 / components for the small festival decorations
//
// 每个组件都只是一个绝对定位的叠加层，挂在宿主元素里：宿主的颜色、尺寸、可点
// 区域一概不变，节日一过（或用户关掉装饰）整层消失，宿主回到原样。
// Each component is an absolutely positioned overlay inside its host. The
// host's colour, size and hit area never change; when the festival ends (or
// the user switches decorations off) the layer disappears and the host is as
// it was.
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { useFestivalOptional } from './FestivalProvider'
import type { FestivalKey } from './calendar'
import { avatarHat, buttonTopper, cardTopper, corner, garland, ground, mini, shards } from './decor'
import { icon } from './art'
import { loadGsap } from './motion'
import { ParticleField, type Effect } from './particles'
import { collectInfo, hitsAny, relBox } from './layout'
import './festival.css'

type Gsap = typeof import('gsap')['gsap']

function q(el: Element, sel: string): Element[] {
  return Array.prototype.slice.call(el.querySelectorAll(sel))
}

// 入场：GSAP 播完后加 .fa-live，CSS 待机循环接手。减少动效时直接给定格画面。
// Entrance: once GSAP finishes, .fa-live hands over to the CSS idle loops.
// Reduced motion gets the final frame straight away.
function useEntrance(
  ref: React.RefObject<HTMLElement>,
  key: FestivalKey | null,
  reduced: boolean,
  replay: number,
  build: (gsap: Gsap, el: HTMLElement) => ReturnType<Gsap['timeline']> | null,
  gate = true
) {
  useEffect(() => {
    const el = ref.current
    if (!el || !key || !gate) return
    el.classList.remove('fa-live')
    if (reduced) return
    let alive = true
    let tl: ReturnType<Gsap['timeline']> | null = null
    el.style.visibility = 'hidden'
    loadGsap()
      .then((gsap) => {
        if (!alive) return
        el.style.visibility = ''
        tl = build(gsap, el)
        if (tl) tl.eventCallback('onComplete', () => el.classList.add('fa-live'))
        else el.classList.add('fa-live')
      })
      .catch(() => {
        el.style.visibility = ''
        el.classList.add('fa-live')
      })
    return () => {
      alive = false
      if (tl) tl.kill()
      el.style.visibility = ''
    }
  }, [key, reduced, replay, gate])
}

// 避让：装饰里任何一件碰到周围的文字（包括宿主按钮自己的文字），就把那一件隐藏。
// 挂载后、字体加载后、窗口尺寸变化时各检查一次。
// Avoidance: any decoration piece touching nearby text (including its host
// button's own label) is hidden. Checked after mount, after fonts settle and on
// every resize.
// once：只在生效的那一刻同步量一次（外加窗口缩放）。要在入场动画开始前调用——这时每一件
// 都还在静止位置上；之后再量，量到的是飞行途中的位置，会先显示、落定后才藏，看得见跳一下。
// once: measure synchronously at the moment it becomes active (plus on resize).
// It must run before the entrance starts, while every piece is still at rest;
// measuring later catches pieces mid-flight, showing them first and hiding them
// only after they land, which reads as a visible pop.
function useAvoidInfo(ref: React.RefObject<HTMLElement>, pieceSelector: string | null, root: (el: HTMLElement) => Element | null, active: boolean, once = false) {
  useEffect(() => {
    const el = ref.current
    if (!el || !active) return
    const origin = { left: 0, top: 0, width: 0, height: 0 } as DOMRect
    const check = () => {
      const r = root(el)
      if (!r) return
      const host = el.parentElement
      const info = collectInfo([r], origin, { ignoreControl: host && host.matches('button, a') ? host : null })
      const pieces = pieceSelector ? (Array.prototype.slice.call(el.querySelectorAll(pieceSelector)) as HTMLElement[]) : [el]
      // 逐个图形测，而不是测整张图的外框：一簇星光的外框大半是空白，按外框测会把
      // 离文字还很远的星光也藏掉。
      // Test each drawn shape rather than the drawing's outer box: a cluster of
      // sparkles is mostly empty space, and testing the box would hide sparkles
      // that are nowhere near the text.
      pieces.forEach((p) => {
        p.style.visibility = ''
        const shapes = Array.prototype.slice.call(p.querySelectorAll('path, ellipse, circle, rect, polygon, line, text')) as Element[]
        // 细绳的外框宽度接近 0，relBox 会丢掉它，这里至少按 1px 算。
        // A thin string's box is nearly zero wide and relBox would drop it; count it as at least 1px.
        const boxes = shapes
          .filter((s) => !s.closest('defs'))
          .map((s) => {
            const r = s.getBoundingClientRect()
            return r.width + r.height < 0.5 ? null : { x: r.left, y: r.top, w: Math.max(1, r.width), h: Math.max(1, r.height) }
          })
        const list = boxes.length ? boxes : [relBox(p, origin)]
        if (list.some((b) => b && hitsAny(b, info, 4))) p.style.visibility = 'hidden'
      })
    }
    if (once) check()
    const timers = once ? [] : [60, 700, 2000].map((ms) => window.setTimeout(check, ms))
    window.addEventListener('resize', check)
    return () => {
      timers.forEach((t) => window.clearTimeout(t))
      window.removeEventListener('resize', check)
    }
  }, [active])
}

// ════════════════════════════════════════════════════════════════════════════
// 挂件：按钮 / 头像 / 角标 / 定价卡 / toppers
// ════════════════════════════════════════════════════════════════════════════

export type TopperKind = 'button' | 'avatar' | 'mini' | 'card'

function FestivalTopperImpl({ kind, hang = true }: { kind: TopperKind; hang?: boolean }) {
  const f = useFestivalOptional()
  const key = f ? f.festival : null
  const ref = useRef<HTMLSpanElement>(null)
  const pieces = useMemo(() => {
    if (!key) return []
    if (kind === 'button') return buttonTopper(key, hang)
    if (kind === 'card') return cardTopper(key)
    if (kind === 'avatar') return [{ cls: 'fd-hat-wrap', html: avatarHat(key) }]
    return [{ cls: 'fd-mini-piece', html: mini(key) }]
  }, [key, kind, hang])

  // 量出宿主真实的圆角半径写进 --fd-r：药丸按钮两端是弯的，挂件和积雪只能落在
  // 中间那段直边上，才能「刚好」贴住边缘，不悬空、不嵌进去。
  // Measure the host's real corner radius into --fd-r: a pill button curves at
  // both ends, so hanging pieces and snow must land on the straight part of the
  // edge to sit exactly on it, neither floating nor sunk in.
  useEffect(() => {
    const el = ref.current
    const host = el && el.parentElement
    if (!el || !host || (kind !== 'button' && kind !== 'card')) return
    const measure = () => {
      const cs = getComputedStyle(host)
      const r = Math.min(parseFloat(cs.borderTopRightRadius) || 0, host.offsetHeight / 2)
      el.style.setProperty('--fd-r', r.toFixed(1) + 'px')
      // 绝对定位从内边距边开始算，按钮有 1px 描边时所有挂件都会往里偏 1px；
      // 把容器外扩到描边外沿，挂件的坐标就以按钮真正的外轮廓为准。
      // Absolute positioning starts at the padding edge, so a 1px border would
      // push every piece 1px inward; growing the container out to the border
      // edge makes piece coordinates refer to the button's real outline.
      el.style.top = -(parseFloat(cs.borderTopWidth) || 0) + 'px'
      el.style.right = -(parseFloat(cs.borderRightWidth) || 0) + 'px'
      el.style.bottom = -(parseFloat(cs.borderBottomWidth) || 0) + 'px'
      el.style.left = -(parseFloat(cs.borderLeftWidth) || 0) + 'px'
    }
    measure()
    // 已经挂着大挂件的宿主不再叠按钮小饰（charm.css 看这个属性）。
    // A host that carries a large topper skips the generic button charm (charm.css reads this attribute).
    host.setAttribute('data-fd-topper', '')
    window.addEventListener('resize', measure)
    return () => {
      window.removeEventListener('resize', measure)
      host.removeAttribute('data-fd-topper')
    }
  }, [key, kind])

  useEntrance(ref, key, f ? f.reducedMotion : true, f ? f.replay : 0, (gsap, el) => {
    // 「落」到宿主上：从上方一点落下，弹一下停住。帽子和兔耳是戴上去的，积雪是
    // 堆上去的，所以方向都是自上而下。
    // Pieces settle onto the host from slightly above with a small bounce —
    // hats are put on, snow piles up — so everything arrives top-down.
    const tl = gsap.timeline({ delay: 0.25 })
    tl.from(el.children, {
      y: kind === 'avatar' ? -14 : -8,
      opacity: 0,
      scale: kind === 'card' ? 1 : 0.6,
      transformOrigin: '50% 100%',
      duration: 0.7,
      ease: 'back.out(2.2)',
      stagger: 0.08,
    })
    return tl
  })

  // 按钮和定价卡上的挂件要让开文字；头像、铃铛、Tab 上的挂件本来就在图标外侧。
  // Toppers on buttons and the pricing card must clear the text; the ones on the
  // avatar, bell and tab already sit outside their icons.
  // 检查范围取按钮所在的整块（文案面板、分区、页脚、顶栏），这样按钮下方的「向下滑」
  // 提示这类邻居也会被让开。
  // The check covers the whole block around the button (copy panel, section,
  // footer, header), so neighbours such as the scroll hint below are avoided too.
  useAvoidInfo(
    ref,
    '.fd-piece',
    (el) => (kind === 'card' ? el.parentElement : el.closest('.panel-inner, section, footer, header, main') || (el.parentElement && el.parentElement.parentElement)),
    !!key && (kind === 'button' || kind === 'card')
  )

  if (!key || !pieces.length) return null
  return (
    <span ref={ref} className={'fd-topper fd-' + kind} aria-hidden>
      {pieces.map((p, i) => (
        <span key={i} className={'fd-piece ' + p.cls} dangerouslySetInnerHTML={{ __html: p.html }} />
      ))}
    </span>
  )
}
export const FestivalTopper = memo(FestivalTopperImpl)

// ════════════════════════════════════════════════════════════════════════════
// 分区角落 / section corners
// ════════════════════════════════════════════════════════════════════════════
// 滚到眼前才入场：灯笼被放下来、彩球顺着丝带落下、蛛网一根根织出来、桂花枝
// 荡进来、彩带从上往下展开。
// Enters when scrolled into view: lanterns are lowered, baubles drop on their
// ribbons, the web is woven thread by thread, the osmanthus sprig swings in,
// streamers unfurl downward.

export function FestivalCorner({ side = 'r' }: { side?: 'l' | 'r' }) {
  const f = useFestivalOptional()
  const key = f ? f.festival : null
  const ref = useRef<HTMLDivElement>(null)
  const [seen, setSeen] = useState(false)
  const html = useMemo(() => (key ? corner(key) : ''), [key])

  useEffect(() => {
    const el = ref.current
    if (!el || seen) return
    if (typeof IntersectionObserver === 'undefined') return setSeen(true)
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && setSeen(true), { threshold: 0.35 })
    io.observe(el)
    return () => io.disconnect()
  }, [seen, key])

  // 角饰挂在卡片里，卡片里有勋章按钮这类控件：逐组检查（蝙蝠、蜘蛛、每颗彩球、每盏
  // 灯笼各算一组），碰到的那一组单独隐藏，其余照常。
  // The corner lives inside a card with controls such as the medal button: each
  // group (the bat, the spider, every bauble, every lantern) is checked on its
  // own, and only a group that touches one is hidden.
  // 等卡片真正滚进视野（勋章的入场动画放大完）再量。/ measured once the card is actually in view, after the medal's reveal
  // 彩纸、彩带是直接挂在 svg 下的图形，不在组里，也要逐个查。/ confetti and streamers sit directly under the svg, not in groups, and are checked one by one too
  // 这个钩子写在 useEntrance 之前：同一次提交里它的 effect 先跑，量的是入场动画开始前的静止位置。
  // Declared before useEntrance: in the same commit its effect runs first and measures the resting positions before the entrance begins.
  useAvoidInfo(ref, 'svg > g, svg > rect, svg > path, svg > circle, svg > ellipse, svg > line', (el) => el.parentElement, !!key && seen, true)

  useEntrance(
    ref,
    key,
    f ? f.reducedMotion : true,
    f ? f.replay : 0,
    (gsap, el) => {
      const tl = gsap.timeline()
      switch (key) {
        case 'spring':
          tl.from(q(el, '.fd-c-a, .fd-c-b'), { y: -150, duration: 1.2, ease: 'power3.out', stagger: 0.22 })
            .fromTo(q(el, '.fd-c-a, .fd-c-b'), { rotation: 16 }, { rotation: 0, transformOrigin: '50% 0%', duration: 2.8, ease: 'elastic.out(1, 0.16)', stagger: 0.22 }, 0.4)
            .from(q(el, '.fd-c-c'), { x: 30, opacity: 0, duration: 1.4, ease: 'power3.out' }, 0.3)
          break
        case 'christmas':
          tl.from(q(el, '.fd-c-swag'), { y: -30, opacity: 0, duration: 0.8, ease: 'power3.out' })
            .from(q(el, '.fd-drop'), { y: -120, duration: 1.1, ease: 'bounce.out', stagger: 0.18, clearProps: 'transform,transformOrigin' }, 0.25)
          break
        case 'halloween': {
          const web = q(el, '.fd-web') as SVGGeometryElement[]
          web.forEach((w) => {
            const len = w.getTotalLength()
            gsap.set(w, { strokeDasharray: len, strokeDashoffset: len })
          })
          tl.to(web, { strokeDashoffset: 0, duration: 0.7, ease: 'power2.out', stagger: 0.07 })
            .from(q(el, '.fd-c-spider'), { y: -150, duration: 1.8, ease: 'elastic.out(1, 0.32)' }, 0.5)
            .from(q(el, '.fd-c-bat'), { x: -60, y: 30, opacity: 0, duration: 1, ease: 'power3.out' }, 0.8)
          break
        }
        case 'midautumn':
          tl.from(q(el, '.fd-c-sprig'), { rotation: -18, opacity: 0, transformOrigin: '100% 0%', duration: 2, ease: 'elastic.out(1, 0.55)' })
            .from(q(el, '.fd-c-moon'), { y: 30, opacity: 0, duration: 1.8, ease: 'power3.out' }, 0.3)
            .from(q(el, '.fd-c-cloud'), { x: -30, opacity: 0, duration: 1.4, ease: 'power3.out' }, 0.6)
          break
        case 'newyear':
          // 入场结束后清掉 GSAP 留下的矩阵和支点，待机的 CSS 摆动才能用自己的支点。
          // Clear GSAP's leftover matrix and pivot after the entrance so the idle CSS sway uses its own.
          tl.from(q(el, '.fd-streamer'), { scaleY: 0, transformOrigin: '50% 0%', duration: 1.2, ease: 'power3.out', stagger: 0.12, clearProps: 'transform,transformOrigin' })
            .from(q(el, '.fd-conf'), { scale: 0, opacity: 0, transformOrigin: '50% 50%', duration: 0.5, ease: 'back.out(3)', stagger: 0.03 }, 0.3)
            .from(q(el, '.fd-twinkle'), { scale: 0, transformOrigin: '50% 50%', duration: 0.6, ease: 'back.out(3)', stagger: 0.1 }, 0.5)
          break
      }
      return tl
    },
    seen
  )

  // 角落装饰在窄屏上可能碰到分区标题：碰到就不显示。
  // On narrow screens the corner may meet the section heading; if so it is not shown.
  useAvoidInfo(ref, null, (el) => el.parentElement, !!key)

  if (!key) return null
  return (
    <div
      ref={ref}
      className={'fd-corner fd-corner-' + side + (seen ? '' : ' is-waiting')}
      aria-hidden
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

// ════════════════════════════════════════════════════════════════════════════
// 页脚上沿的地面饰带 / ground strip along the top of a footer
// ════════════════════════════════════════════════════════════════════════════

// sit：挂式饰带（灯笼串、彩旗）改为挂在分隔线之上，不垂进下面的文字里。
// sit: hanging strips (lantern string, bunting) hang above the rule instead of
// dropping into the text below it.
export function FestivalGround({ sit = false }: { sit?: boolean }) {
  const f = useFestivalOptional()
  const key = f ? f.festival : null
  const g = useMemo(() => (key ? ground(key) : null), [key])
  const ref = useRef<HTMLDivElement>(null)
  useEntrance(ref, key, f ? f.reducedMotion : true, f ? f.replay : 0, (gsap, el) =>
    gsap.timeline().from(el.children, { y: 10, opacity: 0, duration: 1, ease: 'power3.out', stagger: 0.15 })
  )
  // 饰带和上方最后一块内容之间的留白不够时，整条不显示。/ hidden when the gap above the rule is too tight
  useAvoidInfo(ref, '.fd-ground-strip, .fd-ground-end', (el) => {
    const footer = el.closest('footer') || el.parentElement
    return footer ? footer.parentElement : null
  }, !!key)
  if (!key || !g) return null
  return (
    <div ref={ref} className={'fd-ground fd-ground-' + key + (sit ? ' fd-ground-sit' : '')} aria-hidden>
      <span className="fd-ground-strip" dangerouslySetInnerHTML={{ __html: g.strip }} />
      {g.end && <span className="fd-ground-end" dangerouslySetInnerHTML={{ __html: g.end }} />}
    </div>
  )
}

// ════════════════════════════════════════════════════════════════════════════
// App 顶栏下沿的挂饰 / garland under the app header
// ════════════════════════════════════════════════════════════════════════════

export function FestivalGarland() {
  const f = useFestivalOptional()
  const key = f ? f.festival : null
  const g = useMemo(() => (key ? garland(key) : null), [key])
  const ref = useRef<HTMLDivElement>(null)
  useEntrance(ref, key, f ? f.reducedMotion : true, f ? f.replay : 0, (gsap, el) =>
    gsap.timeline({ delay: 0.4 }).from(el.children, { y: -16, opacity: 0, duration: 0.9, ease: 'back.out(1.8)', stagger: 0.12 })
  )
  if (!key || !g) return null
  return (
    <div ref={ref} className={'fd-garland fd-garland-' + key} aria-hidden>
      {g.strip && <span className="fd-garland-strip" dangerouslySetInnerHTML={{ __html: g.strip }} />}
      {g.left && <span className="fd-garland-l" dangerouslySetInnerHTML={{ __html: g.left }} />}
      {g.right && <span className="fd-garland-r" dangerouslySetInnerHTML={{ __html: g.right }} />}
    </div>
  )
}

// ════════════════════════════════════════════════════════════════════════════
// App 背景里的节日粒子 / ambient festival particles behind the app
// ════════════════════════════════════════════════════════════════════════════
// 画在所有内容之后：卡片是实色面，粒子只在卡片之间的空隙里露出来，永远不会
// 盖在数字上。数量只有落地页的三到六成。
// Drawn behind everything: cards are opaque, so particles only show in the
// gaps between them and never sit over a number. Counts are 30–60% of the
// landing page's.

const AMBIENT: Record<FestivalKey, { effects: Effect[]; density: number }> = {
  christmas: { effects: ['snow'], density: 0.35 },
  spring: { effects: ['golddust', 'plumPetals'], density: 0.5 },
  midautumn: { effects: ['petals'], density: 0.6 },
  halloween: { effects: ['embers', 'fog'], density: 0.45 },
  newyear: { effects: ['glitter'], density: 0.55 },
}

export function FestivalAmbient() {
  const f = useFestivalOptional()
  const key = f ? f.festival : null
  const reduced = f ? f.reducedMotion : true
  const canvas = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    if (!key || reduced || !canvas.current) return
    const phone = (() => {
      try {
        return window.matchMedia('(max-width: 1023px)').matches
      } catch {
        return false
      }
    })()
    const cfg = AMBIENT[key]
    const pf = new ParticleField(canvas.current, { effects: cfg.effects, density: cfg.density, lite: phone, region: { x0: 0, x1: 1 } })
    const onVis = () => (document.hidden ? pf.stop() : pf.start())
    document.addEventListener('visibilitychange', onVis)
    onVis()
    return () => {
      document.removeEventListener('visibilitychange', onVis)
      pf.destroy()
    }
  }, [key, reduced, f && f.replay])

  if (!key || reduced) return null
  return <canvas ref={canvas} className="fd-ambient" aria-hidden />
}

// ════════════════════════════════════════════════════════════════════════════
// 通知面板空状态的小图 / the small icon in the notification panel's empty state
// ════════════════════════════════════════════════════════════════════════════

export function FestivalEmptyMini() {
  const f = useFestivalOptional()
  const key = f ? f.festival : null
  const html = useMemo(() => (key ? icon(key) : ''), [key])
  if (!key) return null
  return <span className="fd-empty-mini" aria-hidden dangerouslySetInnerHTML={{ __html: html }} />
}

// ════════════════════════════════════════════════════════════════════════════
// 新信号进场的小迸发 / the little burst when a new signal arrives
// ════════════════════════════════════════════════════════════════════════════
// 这是**反馈**：告诉用户「刚到了一条」。碎片从卡片右上角迸出，受重力落下、淡出，
// 1.6 秒后整组移除。卡片本身和它的数字一个像素不动。
// This is feedback — "one just arrived". Shards burst from the card's top-right
// corner, fall under gravity and fade; the set is removed after 1.6 s. The card
// and its numbers are untouched.

export function FestivalBurst() {
  const f = useFestivalOptional()
  const key = f ? f.festival : null
  const reduced = f ? f.reducedMotion : true
  const ref = useRef<HTMLSpanElement>(null)
  const [done, setDone] = useState(false)
  const html = useMemo(() => {
    if (!key) return ''
    const set = shards(key)
    let s = ''
    for (let i = 0; i < 16; i++) s += '<span class="fd-shard">' + set[i % set.length] + '</span>'
    return s
  }, [key])

  useEffect(() => {
    const el = ref.current
    if (!el || !key || reduced) return
    let alive = true
    let tl: ReturnType<Gsap['timeline']> | null = null
    loadGsap().then((gsap) => {
      if (!alive) return
      tl = gsap.timeline({ onComplete: () => setDone(true) })
      const kids = Array.prototype.slice.call(el.children) as HTMLElement[]
      kids.forEach((k, i) => {
        // 只往上方扇形迸出（从卡片上沿起跳），落回的距离也很短：碎片待在卡片上方
        // 的空隙里，不会经过牌面上的任何数字。
        // Fan upward only, from the card's top edge, with a short fall: the shards
        // stay in the gap above the card and never pass over a number on it.
        const a = ((-165 + Math.random() * 150) * Math.PI) / 180
        const d = 28 + Math.random() * 52
        const dx = Math.cos(a) * d
        const dy = Math.sin(a) * d
        const s = 0.6 + Math.random() * 0.6
        tl!.fromTo(k, { x: 0, y: 0, scale: 0, rotation: 0, opacity: 1 }, { x: dx, y: dy, scale: s, rotation: -180 + Math.random() * 360, duration: 0.55, ease: 'power3.out' }, i * 0.012)
          .to(k, { y: dy + 16 + Math.random() * 18, x: dx * 1.15, opacity: 0, duration: 0.8, ease: 'power1.in' }, 0.45 + i * 0.012)
      })
    })
    return () => {
      alive = false
      if (tl) tl.kill()
    }
  }, [key, reduced])

  if (!key || reduced || done) return null
  return <span ref={ref} className="fd-burst" aria-hidden dangerouslySetInnerHTML={{ __html: html }} />
}
