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
import { createBackdropSolids, type SolidVariant, type SolidsHandle } from './BackdropSolids'

export type Backdrop = 'none' | 'sweep' | 'horizon' | 'veil'

export interface SpaceHandle {
  resize(): void
  dispose(): void
  /** 实时切换背景处理 / switch the backdrop treatment live */
  setBackdrop(b: Backdrop): void
  /** 切换背景实体 / switch the dimensional backdrop solid */
  setSolid(v: SolidVariant): void
  /** 实例序号 / instance number */
  instId: number
  /** DEV 专用探针，由挂载层决定要不要装到 window 上 / DEV-only probe; the mount
      layer decides whether to publish it on window */
  debug?: unknown
}

let instanceSeq = 0
const IE_BG = 0x09090b // --ink-950，同时也是雾色 / also the fog colour
const C_GRID = 0xffffff
const FLOOR_Y = -260

export async function createLandingSpace(opts: {
  container: HTMLElement
  /** 叙事区（第一幕）/ the story section, act I */
  storyEl: HTMLElement
  /** 判定区（第二幕）/ the verdict section, act II */
  marketEl: HTMLElement
}): Promise<SpaceHandle | null> {
  const { container, storyEl, marketEl } = opts

  try {
    const probe = document.createElement('canvas')
    if (!probe.getContext('webgl2') && !probe.getContext('webgl')) return null
  } catch {
    return null
  }

  const THREE = await import('three')
  const INST = ++instanceSeq

  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'low-power' })
  renderer.setClearAlpha(0)
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.domElement.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none'
  container.appendChild(renderer.domElement)

  const scene = new THREE.Scene()
  /* 指数雾，雾色 = 页面底色。清屏 alpha 为 0，远处网格淡出的目标色与页面背景
     严格一致：大地的尽头是「化开」，不是「被裁掉」。
     Exponential fog in the page's own colour over a zero-alpha clear: the floor
     ends by dissolving into the backdrop, never by being clipped. */
  scene.fog = new THREE.FogExp2(IE_BG, 0.00034)

  const camera = new THREE.PerspectiveCamera(34, 1, 8, 6500)

  /* ══ 背景：四种处理，可实时切换 ══
     hero 下方那片区域连续被否了两版（线阵网格 → 摄影棚扫光）。问题不在参数：
     我看不见页面，探针能量到「有没有、多亮、在哪」，量不到「好不好看」，
     于是只能串行盲猜，一轮一个。所以这里改成把四种**性质不同**的处理同时
     建出来，由页面上的切换器实时翻看——把串行盲猜换成并行比较。
     Four backdrop treatments built at once and switched live. The region under
     the hero was rejected twice (line grid, then studio sweep) and the problem
     was never a parameter: probes can verify presence, brightness and position
     but never whether it looks good, which forced serial guessing at one idea
     per round. Building all four and letting the picker compare them turns that
     into a parallel choice.

       none    什么都没有。纯页面底色，手机只靠自己的接触阴影立住。最克制。
       sweep   地面扫光：一团被拉长的柔光落在地上，随距离衰减（上一版）。
       horizon 远方地平线：没有地面，只有一条横贯画面的大气光带。
       veil    舞台光幕：光从上方洒下的垂直渐变，越往下越暗。

     四者共用同一套程序化贴图管线，全部是实色 + 平滑衰减，零图案零线条。
     All four share one procedural texture pipeline: solid fills with smooth
     falloff, no pattern and no lines anywhere. */
  /* 程序化贴图。低透明度的平滑渐变在 8 位显示器上必然出现色带，所以逐像素掺入
     ±2/255 的确定性抖动——用固定哈希而不是 Math.random，画面才可复现、才谈得上
     逐帧核对。/ A procedural texture. Smooth low-alpha gradients band visibly on
     8-bit displays, so each pixel gets about two levels of deterministic dither
     from a fixed hash rather than Math.random, keeping frames reproducible and
     therefore verifiable. */
  const makeTex = (alphaAt: (u: number, v: number) => number): TH.Texture | null => {
    const S = 256
    const c = document.createElement('canvas')
    c.width = S
    c.height = S
    const g2 = c.getContext('2d')
    if (!g2) return null
    const img = g2.createImageData(S, S)
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const h = ((x * 73856093) ^ (y * 19349663)) >>> 0
        const a = alphaAt((x + 0.5) / S, (y + 0.5) / S) + ((h % 5) - 2) / 255
        const i = (y * S + x) * 4
        img.data[i] = 255
        img.data[i + 1] = 255
        img.data[i + 2] = 255
        img.data[i + 3] = Math.max(0, Math.min(255, Math.round(a * 255)))
      }
    }
    g2.putImageData(img, 0, 0)
    const t = new THREE.CanvasTexture(c)
    t.colorSpace = THREE.SRGBColorSpace
    return t
  }
  const smoothstep = (f: number) => f * f * (3 - 2 * f)

  const mkPlane = (w: number, h: number, tex: TH.Texture | null) => {
    const m = new THREE.MeshBasicMaterial({
      map: tex,
      color: C_GRID,
      transparent: true,
      opacity: 1,
      depthWrite: false,
    })
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), m)
    mesh.visible = false
    scene.add(mesh)
    return { mesh, m }
  }

  /* sweep：地面上一团圆形光斑。平面沿 z 拉长，圆贴图被拉成长椭圆，掠角下的
     透视压缩就是纵深线索。/ A circular pool on an elongated ground plane, so
     perspective compression at a grazing angle carries the depth. */
  const sweep = mkPlane(
    9000,
    13000,
    makeTex((u, v) => {
      const d = Math.hypot((u - 0.5) / 0.5, (v - 0.52) / 0.5)
      return smoothstep(Math.max(0, 1 - d)) * 0.55
    })
  )
  sweep.mesh.rotation.x = -Math.PI / 2

  /* horizon：一面竖直的光幕挂在远处，中段一条高斯光带 = 地平线附近的大气。
     没有地面、没有表面，只有「远处有东西」。
     A vertical veil far ahead carrying one Gaussian band: the atmosphere near a
     horizon. No ground, no surface, just "there is something out there". */
  const horizon = mkPlane(
    9000,
    3600,
    makeTex((u, v) => {
      const band = Math.exp(-(((v - 0.52) / 0.11) ** 2))
      const sides = smoothstep(Math.max(0, 1 - Math.abs(u - 0.5) / 0.5))
      return band * sides * 0.62
    })
  )

  /* veil：同一面光幕，改成自上而下的舞台光——上亮下暗，像顶光洒在背景幕上。
     The same veil relit from above: a stage wash, bright at the top and falling
     away downward. */
  const stage = mkPlane(
    9000,
    3600,
    makeTex((u, v) => {
      /* 两次都调偏了，记下来：第一版峰值 0.5 且亮部起点在 v=0.18，实测整帧
         峰值只有 17/255——亮区整个落在画面上缘之外；第二版把亮区一路铺到顶，
         结果覆盖率 100%、峰值 109，整帧被洗白，文字无处安放。
         正解是一条**有上下衰减的高斯光带**而不是一个半边全亮的斜坡：峰值落在
         v=0.433（换算到世界坐标约 y=400，即画面上三分之一），上下各自衰减。
         Mis-tuned twice, recorded here: the first pass peaked at 0.5 starting at
         v=0.18 and measured a frame peak of 17 because the lit region sat above
         the top of frame; the second ran the lit region all the way to the top
         and measured 100% coverage at peak 109, washing out the whole frame with
         nowhere to put type. The answer is a Gaussian band that falls off in
         BOTH directions rather than a half-bright ramp, peaking at v=0.433
         (about y=400 in world terms, the upper third of frame). */
      const band = Math.exp(-(((v - 0.433) / 0.2) ** 2))
      const sides = smoothstep(Math.max(0, 1 - Math.abs(u - 0.5) / 0.5))
      return band * sides * 0.5
    })
  )

  const setBackdrop = (b: Backdrop) => {
    sweep.mesh.visible = b === 'sweep'
    horizon.mesh.visible = b === 'horizon'
    stage.mesh.visible = b === 'veil'
  }
  setBackdrop('sweep')


  /* 实体层：体积感全部来自这里的实算环境反射，与手机同族材质。
     低功耗设备关掉玻璃的 transmission（每帧额外一张背景缓冲），形状与反光保留。
     The solids layer, whose volume comes entirely from computed environment
     reflection in the same material family as the phone. Low-power devices drop
     the glass transmission pass while keeping the form and its speculars. */
  const solids: SolidsHandle = createBackdropSolids(THREE, renderer, scene, {
    lowPower: window.matchMedia('(pointer: coarse)').matches || window.innerWidth < 1024,
  })

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

    /* 判定幕期间地面退到三成：判定终端是唯一主体，大地降为余光里的存在。
       出终端后回升，随后起雾——定价、FAQ、页脚是整页阅读量最大的一段。
       Under the verdict terminal the floor drops to 30%: the terminal is the only
       subject and the ground becomes peripheral. It comes back on the way out,
       then haze rises for the reading-heavy tail of the page. */
    /* 背景跟着相机走。定死在世界坐标里时，相机推过判定幕就把它甩在身后了——
       实测 route 1.5 之后地面覆盖率归零，页面下半段身后又变回一片纯黑。
       The backdrop follows the camera. Pinned in world space it got left behind
       once the camera pushed past the verdict act - measured, coverage hit zero
       after route 1.5 and the page's lower half went back to flat black. */
    sweep.mesh.position.set(_p.x, FLOOR_Y, _p.z - 700)
    horizon.mesh.position.set(_p.x, FLOOR_Y + 300, _p.z - 2600)
    stage.mesh.position.set(_p.x, FLOOR_Y + 420, _p.z - 2400)
    /* 判定幕期间背景退到三成：判定终端是唯一主体，环境降为余光里的存在。
       Under the verdict terminal the backdrop drops to 30%: the terminal is the
       only subject and the surroundings become peripheral. */
    const wallK = smooth(clamp01((r - 1.0) / 0.14)) * (1 - smooth(clamp01((r - 2.02) / 0.22)))
    const bk = 1 - 0.7 * wallK
    sweep.m.opacity = bk
    horizon.m.opacity = bk
    stage.m.opacity = bk
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
     Route is computed from the sections' own rects once per frame, so any
     height change is followed automatically. */
  const computeRoute = () => {
    const y = window.scrollY
    const sr = storyEl.getBoundingClientRect()
    const mr = marketEl.getBoundingClientRect()
    const sTop = sr.top + y
    const mTop = mr.top + y
    const mEnd = mr.bottom + y - vh
    const docEnd = Math.max(mEnd + 1, document.documentElement.scrollHeight - vh)
    if (y <= mTop) return clamp01((y - sTop) / Math.max(1, mTop - sTop))
    if (y <= mEnd) return 1 + clamp01((y - mTop) / Math.max(1, mEnd - mTop))
    return 2 + clamp01((y - mEnd) / Math.max(1, docEnd - mEnd))
  }

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
  resize()

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
    solids.update(t, cur)
    draw()
  }
  const pump = () => {
    if (!document.hidden && !raf) raf = requestAnimationFrame(frame)
    else if (document.hidden && raf) {
      cancelAnimationFrame(raf)
      raf = 0
    }
  }
  const onVisibility = () => pump()
  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('resize', resize)
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
      setBackdrop,
      /* 离屏抓帧：渲染到 RenderTarget 再读回。默认帧缓冲呈现后即清空，直接
         drawImage 读到的是透明。/ Offscreen capture via render target read-back;
         the default framebuffer is cleared once presented. */
      shot(r: number, outW = 512) {
        ;(devApi as { set(x: number): void }).set(r)
        const h = Math.round((outW * container.clientHeight) / container.clientWidth)
        const rt = new THREE.WebGLRenderTarget(outW, h)
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
    setBackdrop,
    setSolid: (v: SolidVariant) => solids.setVariant(v),
    instId: INST,
    debug: devApi,
    dispose() {
      if (raf) cancelAnimationFrame(raf)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('resize', resize)
      if (onPointer) window.removeEventListener('pointermove', onPointer)
      solids.dispose()
      renderer.domElement.remove()
      renderer.dispose()
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
