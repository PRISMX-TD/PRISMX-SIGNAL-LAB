// 全页持久 3D 空间 / the persistent page-level 3D space
//
// ════════════════════════════════════════════════════════════════════════════
// 这一层现在只做一件事：一张贯穿全页的网格大地。
//
// 第一版在这里放了一条「判定走廊」，相机以第一人称飞进去。三轮迭代（尺度、
// 亮度、减线）之后用户给出的截图仍然是「几个灰盒子从奇怪的角度掠过」。教训
// 有两条，都记在这里防止重犯：
//
// 一、第一人称飞行镜头的自由度太多（位置 ×3、注视 ×3、fov、每段一组），而我
//    在无头环境里只能靠像素统计盲调。统计能保证「画面里有多少东西」，保证
//    不了「这些东西读成什么」。截图证明它读成了杂物。
// 二、「穿过价格通道」要求观众边滚动边解码隐喻——天花板是止盈、地板是止损、
//    我在里面飞。解码失败就只剩混乱。落地页没有让观众解码第二次的资格。
//
// 所以判定幕的内容整体搬去了 MarketStory 的「判决墙」：一面全出血的 DOM/SVG
// 行情图，正面观看，滚动驱动时间而不是相机。那里的构图是坐标数学，可以逐项
// 验证。本层退回它最擅长的角色：让整页站在一个空间里——地面网格、雾、极慢的
// 相机滑移和指针视差。判定幕期间网格降到低亮度给墙让位，此外从头到尾在场。
//
// This layer now does exactly one thing: a grid floor spanning the whole page.
// The first version put a first-person "verdict corridor" here; after three
// rounds of blind tuning the user's screenshot still read as grey boxes at odd
// angles. Two lessons, recorded to prevent a fourth round: a flythrough has too
// many degrees of freedom to tune blind (pixel statistics can verify how much is
// on screen, never what it reads as), and "flying through the price channel"
// demands the viewer decode a metaphor mid-scroll. The verdict content moved to
// MarketStory's verdict wall - a full-bleed DOM/SVG chart viewed head-on, where
// scroll drives time instead of a camera and the composition is coordinate math
// that can be verified item by item. This layer returns to what it is good at:
// making the page stand somewhere. The grid dims under the wall and is present
// everywhere else.
//
// 材质仍然全部是 LineBasic：实色发丝线，零光照、零辉光——「颜料，不是光」。
// Materials stay LineBasic throughout: solid hairlines, no lights, no glow.
// ════════════════════════════════════════════════════════════════════════════

import type * as TH from 'three'
import type { ThreeLite } from './three-lite'
import { createBackdropAir, type AirHandle } from './BackdropAir'
import { createBackdropShards, type ShardsHandle } from './BackdropShards'

/* 背景模式：碎片与烟雾各自可开可关，四种组合。
   烟雾单独存在时读成发光体（它背后什么都没有），碎片给了它可遮挡的东西——
   这就是「碎片 + 烟雾」是主推组合的原因。
   Backdrop modes: shards and smoke each toggle independently. Smoke alone reads as
   an emitter because nothing sits behind it; the shards give it something to
   occlude, which is why shards-plus-smoke is the intended combination. */
export type BackdropMode = 'none' | 'shards' | 'shardsSmoke' | 'smoke'

export interface SpaceHandle {
  resize(): void
  dispose(): void
  /** 实时切换背景处理 / switch the backdrop treatment live */
  /** 切换背景实体 / switch the dimensional backdrop solid */
  setSolid(v: BackdropMode): void
  /** 实例序号 / instance number */
  instId: number
  /** DEV 专用探针，由挂载层决定要不要装到 window 上 / DEV-only probe; the mount
      layer decides whether to publish it on window */
  debug?: unknown
}

let instanceSeq = 0
const IE_BG = 0x09090b // --ink-950，同时也是雾色 / also the fog colour

export async function createLandingSpace(opts: {
  container: HTMLElement
  /** 叙事区（第一幕）/ the story section, act I */
  storyEl: HTMLElement
  /** 判定区（第二幕）/ the verdict section, act II */
  marketEl: HTMLElement
  /**
   * WebGL 上下文丢失时的回调：调用方应当 dispose 本 handle 并摘掉 .space-on，
   * 让 SSR 就有的静态基线层重新露出来。触发时渲染循环已经停住。
   * Called when the WebGL context is lost. The caller should dispose this handle
   * and drop .space-on so the static baseline layer (present since SSR) shows
   * again. The render loop is already stopped by then.
   */
  onContextLost?: () => void
}): Promise<SpaceHandle | null> {
  const { container, storyEl, marketEl, onContextLost } = opts

  try {
    const probe = document.createElement('canvas')
    if (!probe.getContext('webgl2') && !probe.getContext('webgl')) return null
  } catch {
    return null
  }

  // 只取用到的类（见 three-lite.ts），整包的其余部分由 tree-shaking 摇掉。
  // Only the classes in use (see three-lite.ts); the rest of three is tree-shaken.
  const THREE: ThreeLite = (await import('./three-lite')).THREE
  const INST = ++instanceSeq

  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'low-power' })
  renderer.setClearAlpha(0)
  renderer.outputColorSpace = THREE.SRGBColorSpace
  // 四条长写法而不是 inset 简写：inset 是 Chrome 87+，在本项目 Chrome 70 的下限之外，
  // 旧内核上整条作废，画布会掉回静态流位置。
  // Longhands instead of the `inset` shorthand: `inset` is Chrome 87+, outside the
  // Chrome 70 floor, and when dropped the canvas falls back into static flow.
  renderer.domElement.style.cssText =
    'position:absolute;top:0;right:0;bottom:0;left:0;width:100%;height:100%;pointer-events:none'
  container.appendChild(renderer.domElement)

  const scene = new THREE.Scene()
  /* 指数雾，雾色 = 页面底色。清屏 alpha 为 0，远处网格淡出的目标色与页面背景
     严格一致：大地的尽头是「化开」，不是「被裁掉」。
     Exponential fog in the page's own colour over a zero-alpha clear: the floor
     ends by dissolving into the backdrop, never by being clipped. */
  scene.fog = new THREE.FogExp2(IE_BG, 0.00034)

  const camera = new THREE.PerspectiveCamera(34, 1, 8, 6500)



  /* 实体层：体积感全部来自这里的实算环境反射，与手机同族材质。
     低功耗设备关掉玻璃的 transmission（每帧额外一张背景缓冲），形状与反光保留。
     The solids layer, whose volume comes entirely from computed environment
     reflection in the same material family as the phone. Low-power devices drop
     the glass transmission pass while keeping the form and its speculars. */
  /* 大气层。全部是 MeshBasicMaterial 的柔斑，不吃光照，所以这一版把上一版为了
     照亮金属实体而加的三盏灯一起去掉了——场景里已经没有需要被照的东西。
     The atmosphere layer. Everything in it is a MeshBasic soft mass that ignores
     lighting, so the three lights the previous version added to illuminate metal
     solids go with them: nothing in the scene needs lighting any more. */
  const air: AirHandle = createBackdropAir(THREE, scene, camera)
  const shards: ShardsHandle = createBackdropShards(THREE, renderer, scene)

  /* ══ 相机路径 ══
     不再有俯冲和飞行：从头到尾是一次缓慢的低空前推。变化要慢到观众说不出
     「刚才动了」，只觉得世界一直是活的。所有关键帧都略微俯视——上一版的教训：
     地平线的位置靠相机高度调，不靠仰角调，仰角会把近处地面整个移出画面。
     No more dives or flight: one slow low glide from start to finish, changing
     too gradually to be named and just fast enough to keep the world alive.
     Every keyframe pitches gently - the earlier lesson being that horizon
     placement belongs to camera height, not pitch, which throws the near floor
     out of frame. */
  interface Key {
    r: number
    p: [number, number, number]
    l: [number, number, number]
    fov: number
  }
  const KEYS: Key[] = [
    { r: 0.0, p: [0, 60, 1250], l: [-30, 88, 350], fov: 34 },
    { r: 0.86, p: [0, 70, 60], l: [-40, 96, -840], fov: 35 },
    { r: 1.06, p: [0, 85, -260], l: [-20, 70, -1160], fov: 36 },
    { r: 1.96, p: [8, 120, -1750], l: [18, 55, -2650], fov: 36 },
    { r: 2.2, p: [0, 95, -2150], l: [0, 20, -3050], fov: 36 },
    { r: 3.0, p: [0, 80, -2900], l: [0, -30, -3780], fov: 35 },
  ]
  const smooth = (x: number) => x * x * (3 - 2 * x)
  const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x)
  const _p = new THREE.Vector3()
  const _l = new THREE.Vector3()
  const applyRoute = (r: number, ox = 0, oy = 0) => {
    let i = 0
    while (i < KEYS.length - 2 && r > KEYS[i + 1].r) i++
    const a = KEYS[i]
    const b = KEYS[i + 1]
    const k = smooth(clamp01((r - a.r) / (b.r - a.r)))
    _p.set(
      a.p[0] + (b.p[0] - a.p[0]) * k,
      a.p[1] + (b.p[1] - a.p[1]) * k,
      a.p[2] + (b.p[2] - a.p[2]) * k
    )
    _l.set(
      a.l[0] + (b.l[0] - a.l[0]) * k,
      a.l[1] + (b.l[1] - a.l[1]) * k,
      a.l[2] + (b.l[2] - a.l[2]) * k
    )
    _p.x += ox
    _p.y += oy
    camera.position.copy(_p)
    camera.lookAt(_l)

    /* 【2026-09-19 订正】这里原来写着「判定幕期间地面退到三成：判定终端是唯一主体，
       大地降为余光里的存在；出终端后回升，随后起雾」——前半句**从来没有实现过**。
       实际发生的只有后半句：下面那个 haze 从 route 2.02 起把雾密度推上去，给页面
       尾段（定价 / FAQ / 页脚，整页阅读量最大的一段）加一层灰。判定幕期间碎片与
       烟雾**不会**让位：BackdropAir / BackdropShards 上确实各有一个 setDim 实现并
       导出，但全仓库零调用点，今天已连同这条注释一并清掉（见那两个文件）。
       要不要真的做「判定幕让位」是视觉决策，留给负责人；这里先让注释与代码一致——
       一条描述着不存在行为的注释，比没有注释更贵。
       Corrected 2026-09-19. This used to claim the floor drops to 30% under the
       verdict terminal so the terminal is the only subject. That never existed. What
       actually happens is only the second half: the haze below raises fog density
       from route 2.02 onward, greying the page's reading-heavy tail (pricing, FAQ,
       footer). Shards and smoke do NOT yield during the verdict act — both backdrops
       did export a setDim for it, with zero call sites anywhere, and those were
       removed today along with this claim (see those two files). Whether to actually
       build the yielding behaviour is a visual decision left to its owner; for now
       the comment matches the code, because a comment describing behaviour that does
       not exist costs more than no comment at all. */
    /* 背景跟着相机走。定死在世界坐标里时，相机推过判定幕就把它甩在身后了——
       实测 route 1.5 之后地面覆盖率归零，页面下半段身后又变回一片纯黑。
       The backdrop follows the camera. Pinned in world space it got left behind
       once the camera pushed past the verdict act - measured, coverage hit zero
       after route 1.5 and the page's lower half went back to flat black. */
    const haze = smooth(clamp01((r - 2.02) / 0.6))
    if (scene.fog) (scene.fog as TH.FogExp2).density = 0.00034 + haze * 0.00046

    const fov = a.fov + (b.fov - a.fov) * k
    if (Math.abs(camera.fov - fov) > 0.01) {
      camera.fov = fov
      camera.updateProjectionMatrix()
    }
  }

  let vh = 0
  const resize = () => {
    const w = container.clientWidth
    const h = container.clientHeight
    if (!w || !h) return
    vh = h
    camera.aspect = w / h
    camera.updateProjectionMatrix()
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5))
    renderer.setSize(w, h)
  }

  /* ══ 路线：每帧从滚动位置算，不挂 scroll 监听 ══
     三段锚点是真实的分区边界，任何分区高度改动都自动跟随。

     锚点**只在布局真的变了的时候量一次**，帧内只读 window.scrollY。
     此前 computeRoute 是每帧调的，而它里面有两次 getBoundingClientRect() 加一次
     document.documentElement.scrollHeight——三项都强制同步布局（forced reflow）。
     这一层在落地页**全生命周期**运行（只按 document.hidden 起停，没有
     IntersectionObserver），于是低端安卓的主线程每帧白挨一次 reflow，与 GSAP scrub
     和 CSS3D 变换叠在一起就是滚动掉帧。滚动本身不会改变这三个文档偏移，改变它们的
     只有布局，所以按布局事件缓存才是对的口径。
     ResizeObserver 盯 body：视口 resize 之外，字体落地、图片定高、i18n 换语言导致的
     高度变化也都要重新量，光挂 window.resize 会漏。ResizeObserver 是 Chrome 64+，
     在本项目 Chrome 70 的下限之内。

     Anchors are measured only when layout actually changes; the per-frame path
     reads window.scrollY and nothing else. computeRoute used to run every frame
     with two getBoundingClientRect() calls plus documentElement.scrollHeight in
     it — three forced synchronous layouts. This layer runs for the landing page's
     entire lifetime (started and stopped by document.hidden alone, with no
     IntersectionObserver), so low-end Android paid a reflow every frame on top of
     GSAP scrub and the CSS3D transforms, which is where the dropped frames came
     from. Scrolling never changes these document offsets; only layout does.
     The ResizeObserver watches body because font swap, late image sizing and an
     i18n language change all move these offsets without firing window.resize.
     ResizeObserver is Chrome 64+, inside this project's Chrome 70 floor. */
  let sTop = 0
  let mTop = 0
  let mEnd = 0
  let docEnd = 1
  const measureRoute = () => {
    const y = window.scrollY
    sTop = storyEl.getBoundingClientRect().top + y
    mTop = marketEl.getBoundingClientRect().top + y
    mEnd = marketEl.getBoundingClientRect().bottom + y - vh
    docEnd = Math.max(mEnd + 1, document.documentElement.scrollHeight - vh)
  }
  const computeRoute = () => {
    const y = window.scrollY
    if (y <= mTop) return clamp01((y - sTop) / Math.max(1, mTop - sTop))
    if (y <= mEnd) return 1 + clamp01((y - mTop) / Math.max(1, mEnd - mTop))
    return 2 + clamp01((y - mEnd) / Math.max(1, docEnd - mEnd))
  }

  // vh 由 resize() 填，锚点依赖它，所以先量视口再量锚点。
  // resize() fills vh and the anchors depend on it, so viewport first.
  resize()
  measureRoute()
  let cur = computeRoute()
  /* 指针视差只在有精确指针的设备上接线：触屏的 pointermove 在滚动中持续触发，
     那不是「看向别处」。/ Pointer parallax only where a fine pointer exists. */
  const ptr = { x: 0, y: 0 }
  const ptrT = { x: 0, y: 0 }
  let onPointer: ((e: PointerEvent) => void) | null = null
  if (window.matchMedia('(pointer: fine)').matches) {
    onPointer = (e: PointerEvent) => {
      ptrT.x = e.clientX / window.innerWidth - 0.5
      ptrT.y = 0.5 - e.clientY / window.innerHeight
    }
    window.addEventListener('pointermove', onPointer, { passive: true })
  }
  applyRoute(cur)

  const draw = () => renderer.render(scene, camera)
  draw()

  let raf = 0
  const frame = () => {
    raf = requestAnimationFrame(frame)
    const target = computeRoute()
    // 阻尼跟随：与叙事区 scrub:0.6 的手感一致。/ Damped follow, matching scrub 0.6.
    const d = target - cur
    cur = Math.abs(d) > 0.00015 ? cur + d * 0.16 : target
    ptr.x += (ptrT.x - ptr.x) * 0.05
    ptr.y += (ptrT.y - ptr.y) * 0.05
    const t = performance.now() / 1000
    /* 极慢正弦漂移 + 指针视差：滚动停下时画面仍然是一个地方，不是一张图。
       位移写在相机位置上、注视点不动，近处网格比远处移动得多——真视差。
       A very slow sine drift plus pointer parallax: when scrolling stops the
       frame stays a place, not a picture. Offsets land on the camera position
       with the look target held, so near grid moves more than far. */
    applyRoute(cur, Math.sin(t * 0.19) * 11 + ptr.x * 30, Math.cos(t * 0.133) * 6 + ptr.y * 18)
    /* 大气不需要 dt 与滚动油门：它没有自己的流速，纵深由相机前推带出来，横向
       只有一层慢到数不出速度的漂移。上一版那套「按帧间隔积分 + 滚动加速」是为
       流动的物件写的，物件去掉之后一并去掉。
       The atmosphere needs neither dt nor a scroll throttle: it has no flow speed
       of its own, its depth comes from the camera's advance, and laterally there is
       only a drift too slow to time. The previous per-frame integration and scroll
       boost existed for travelling objects and go with them. */
    air.update(t, _p.z)
    shards.update(t)
    draw()
  }
  let lost = false
  const pump = () => {
    if (!document.hidden && !lost && !raf) raf = requestAnimationFrame(frame)
    else if ((document.hidden || lost) && raf) {
      cancelAnimationFrame(raf)
      raf = 0
    }
  }

  /* ── 上下文丢失：停表并露出静态基线层 ──
     这是页面上的第二个 WebGL 上下文（另一个是 PhoneGL 的机身），scrub 模式下两个
     同时活着，低端安卓 WebView 在内存压力/切后台/驱动重置时丢上下文是常态。
     此前全仓库对 webglcontextlost 零处理：一丢，rAF 仍以 60fps 调 renderer.render，
     每帧抛 GL 错误，画布永久透明，而 .space-on 还挂在 <html> 上把 SSR 就有的静态
     网格压着淡出——于是整页背景变成一片空白，**比不启用 WebGL 还糟**。
     preventDefault() 必须调，否则浏览器根本不会尝试恢复。
     Second WebGL context on the page (the phone body is the other); scrub mode
     keeps both alive. Losing it is routine on low-end Android WebViews. There was
     no handling anywhere in the repo: the rAF kept calling render at 60fps into a
     dead context while .space-on stayed on <html>, holding the SSR static grid
     faded out — so the whole page background went blank, strictly worse than never
     starting WebGL at all. preventDefault() is required or the browser will not
     even attempt a restore. */
  const onLost = (e: Event) => {
    e.preventDefault()
    lost = true
    pump()
    onContextLost?.()
  }
  renderer.domElement.addEventListener('webglcontextlost', onLost)
  const onVisibility = () => pump()
  document.addEventListener('visibilitychange', onVisibility)
  const onResize = () => {
    resize()
    measureRoute()
  }
  window.addEventListener('resize', onResize)
  /* 布局变化（字体落地、图片定高、换语言）同样要重量锚点，而它们不触发 resize。
     Layout changes that never fire resize still move the anchors. */
  const ro = new ResizeObserver(() => measureRoute())
  ro.observe(document.body)
  pump()

  let devApi: unknown = null
  if (import.meta.env.DEV) {
    // 逐帧核对用：滚动位置在无头环境里不可写，直接注入 route 才能比对画面。
    // For verification: scroll is not writable headless, so route is injectable.
    devApi = {
      set(r: number) {
        if (raf) {
          cancelAnimationFrame(raf)
          raf = 0
        }
        cur = r
        applyRoute(r)
        draw()
      },
      resume: () => pump(),
      get: () => cur,
      /* 手动步进：无头面板的 rAF 是冻结的，「东西有没有在往前流」在这里无法靠
         等待两帧去验证——必须能显式推进模拟再取画面。
         Manual stepping: rAF is frozen in the headless pane, so whether the field
         is actually flowing cannot be checked by waiting two frames. The
         simulation has to be advanceable explicitly before sampling. */
      step(seconds: number) {
        air.update(seconds, _p.z)
        shards.update(seconds)
        draw()
      },
      /* 把当前可见实体的包围盒投到屏幕百分比。3D 里「东西落在画面哪儿」是我
         在无头环境下唯一能核对的方式——平面 SVG 那一版靠 getBBox，这里靠投影。
         Projects the visible solids' bounding box to viewport percentages. Where
         things land in a 3D frame is the one thing that can be checked headlessly,
         by projection here as getBBox did for the flat SVG pass. */
      solidBox(r: number) {
        ;(devApi as { set(x: number): void }).set(r)
        const box = new THREE.Box3()
        let any = false
        scene.traverse((o) => {
          const m = o as TH.Mesh
          if (!m.isMesh || !m.visible) return
          let par: TH.Object3D | null = m.parent
          let shown = true
          while (par) {
            if (!par.visible) shown = false
            par = par.parent
          }
          if (!shown || !m.geometry?.boundingBox) {
            m.geometry?.computeBoundingBox?.()
          }
          if (!shown || !m.geometry?.boundingBox) return
          if (m.geometry.boundingBox.max.x - m.geometry.boundingBox.min.x > 5000) return
          const b = m.geometry.boundingBox.clone().applyMatrix4(m.matrixWorld)
          box.union(b)
          any = true
        })
        if (!any) return { empty: true }
        const v = new THREE.Vector3()
        let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9
        for (const bx of [box.min.x, box.max.x])
          for (const by of [box.min.y, box.max.y])
            for (const bz of [box.min.z, box.max.z]) {
              v.set(bx, by, bz).project(camera)
              x0 = Math.min(x0, v.x); x1 = Math.max(x1, v.x)
              y0 = Math.min(y0, v.y); y1 = Math.max(y1, v.y)
            }
        const pc = (n: number) => Math.round((n * 0.5 + 0.5) * 1000) / 10
        return { l: pc(x0), r: pc(x1), t: 100 - pc(y1), b: 100 - pc(y0) }
      },
      /* 探针也要能切背景，而且必须切的是**同一个实例**：React StrictMode 会
         挂载两次，window.__space 与 React 持有的句柄可能来自不同实例，那样量
         到的就是一个已经卸载的场景。instId 让两边可以对账。
         The probe needs to switch backdrops on the SAME instance: StrictMode
         mounts twice, so window.__space and the React-held handle can belong to
         different instances and the probe would be reading a torn-down scene.
         instId lets the two be reconciled. */
      /* 离屏抓帧：渲染到 RenderTarget 再读回。默认帧缓冲呈现后即清空，直接
         drawImage 读到的是透明。/ Offscreen capture via render target read-back;
         the default framebuffer is cleared once presented. */
      shot(r: number, outW = 512) {
        ;(devApi as { set(x: number): void }).set(r)
        const h = Math.round((outW * container.clientHeight) / container.clientWidth)
        const rt = new THREE.WebGLRenderTarget(outW, h)
        /* 渲染目标必须显式标成 sRGB，否则读回来的是**线性**值。
           这是一个贯穿整个会话的测量错误：画布有 outputColorSpace 做 sRGB 编码，
           而渲染目标默认没有，于是 readRenderTargetPixels 拿到的是线性空间的数。
           暗部的差距是数量级的——线性 5/255 编码成 sRGB 约等于 39/255，我据此
           判过好几次「几乎不可见」，其实屏幕上是看得见的。
           The render target has to be tagged sRGB or the read-back is LINEAR. This
           was a measurement error running through the whole session: the canvas
           carries outputColorSpace and applies sRGB encoding while a render target
           by default does not, so readRenderTargetPixels returned linear numbers.
           In the shadows the gap is an order of magnitude - linear 5 of 255 encodes
           to about 39 of 255 - and several "effectively invisible" verdicts were
           called on those numbers when the screen was showing something. */
        rt.texture.colorSpace = THREE.SRGBColorSpace
        renderer.setRenderTarget(rt)
        renderer.render(scene, camera)
        const buf = new Uint8Array(outW * h * 4)
        renderer.readRenderTargetPixels(rt, 0, 0, outW, h, buf)
        renderer.setRenderTarget(null)
        rt.dispose()
        const c = document.createElement('canvas')
        c.width = outW
        c.height = h
        const g = c.getContext('2d')
        if (!g) return ''
        g.fillStyle = '#09090b'
        g.fillRect(0, 0, outW, h)
        const img = g.createImageData(outW, h)
        for (let y = 0; y < h; y++) {
          const src = (h - 1 - y) * outW * 4
          img.data.set(buf.subarray(src, src + outW * 4), y * outW * 4)
        }
        const tmp = document.createElement('canvas')
        tmp.width = outW
        tmp.height = h
        tmp.getContext('2d')?.putImageData(img, 0, 0)
        g.drawImage(tmp, 0, 0)
        return c.toDataURL('image/png')
      },
    }
  }

  return {
    resize,
    setSolid: (v: BackdropMode) => {
      air.setVariant(v === 'shardsSmoke' || v === 'smoke' ? 'masses' : 'none')
      shards.setVisible(v === 'shards' || v === 'shardsSmoke')
    },
    instId: INST,
    debug: devApi,
    dispose() {
      if (raf) cancelAnimationFrame(raf)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('resize', onResize)
      ro.disconnect()
      renderer.domElement.removeEventListener('webglcontextlost', onLost)
      if (onPointer) window.removeEventListener('pointermove', onPointer)
      air.dispose()
      shards.dispose()
      renderer.domElement.remove()
      renderer.dispose()
      /* 归还上下文：dispose() 只释放 three 的 GPU 资源，不还上下文本身，而浏览器
         对同时存活的上下文有硬上限。/ Hand the context back: dispose() frees
         three's resources but not the context, and browsers cap live contexts. */
      try {
        renderer.forceContextLoss()
      } catch {
        /* noop */
      }
      scene.traverse((o) => {
        const m = o as { geometry?: { dispose(): void }; material?: { dispose(): void } }
        m.geometry?.dispose()
        m.material?.dispose()
      })
      /* DEV 探针的装卸已经整个搬到挂载层：由它在「采纳了哪个实例」的那一刻
         装、卸载时摘。这里自己往 window 上装是错的——StrictMode 会创建两个
         实例，后创建的那个可能恰恰是被丢弃的，于是 window.__space 指向一个
         已卸载的场景。实测出现过 probe=2 / react=1，四个背景变体因此读数
         完全相同（探针切的是弃用实例，用户点的是在用实例）。
         Publishing the DEV probe moved entirely to the mount layer, which
         installs it at the moment it adopts an instance. Self-installing here
         was wrong: StrictMode creates two instances and the later one may be
         the discarded one, leaving window.__space pointing at a torn-down
         scene. Measured probe=2 against react=1, which made all four backdrop
         variants read identically - the probe was switching the dead instance
         while the picker drove the live one. */
    },
  }
}
