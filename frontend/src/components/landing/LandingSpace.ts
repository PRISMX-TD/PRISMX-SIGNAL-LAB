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

export interface SpaceHandle {
  resize(): void
  dispose(): void
}

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

  /* ══ 地面：摄影棚的一道扫光 ══
     原来这里是一张 150 单位间距的线阵网格。网格给了透视收敛（很好的纵深线索），
     但它同时是一个**图案**——满屏的格子在近乎空白的区域里变成了唯一的视觉内容，
     读起来是「背景贴了张图」，不是「这里是一个空间」。
     换成一块扫光：一张巨大的地面，上面只有一团被拉长的柔光，随距离衰减。纵深
     不再靠格线数数，而是靠**掠角下这团光的透视压缩**——一个圆形光斑在低视角
     地面上必然呈现为强烈的椭圆，这就是纵深；再加上雾把远端化开。零图案、
     零线条、零重复。这是产品摄影里那块「无缝背景纸 + 一盏顶光」的做法。
     光是打在地面上的，不是地面在发光：与「颜料，不是光」的禁令一致——禁的是
     元素自发光与辉光，不是「一个被照亮的表面」。
     The floor used to be a 150-unit line lattice. A grid does give perspective
     convergence (a good depth cue) but it is also a PATTERN, and across a nearly
     empty region that pattern becomes the only content there - it reads as a
     tiled background image rather than as a place. It is replaced by a sweep: one
     enormous ground plane carrying a single stretched pool of light that falls off
     with distance. Depth no longer comes from counting gridlines but from the
     perspective compression of that pool at a grazing angle - a circular pool on a
     low-angle floor necessarily reads as a strong ellipse, and that ellipse IS the
     depth - with fog dissolving the far edge. No pattern, no lines, no repetition.
     This is the seamless-backdrop-and-one-overhead-light of product photography.
     The light falls ON the floor rather than being emitted BY it, which is exactly
     what the pigment-not-glow rule permits: it bans self-illuminated elements and
     bloom, never a lit surface. */
  let floorMat: TH.MeshBasicMaterial
  let floorMesh: TH.Mesh | null = null
  {
    /* 程序化贴图。低透明度的平滑渐变在 8 位显示器上必然出现色带，所以逐像素
       掺入 ±2/255 的确定性噪点抖动——用固定的哈希而不是 Math.random，画面才
       可复现、才谈得上逐帧核对。
       A procedural texture. A smooth low-alpha gradient bands visibly on 8-bit
       displays, so each pixel gets about two levels of deterministic dither -
       from a fixed hash rather than Math.random, so the frame stays reproducible
       and therefore verifiable. */
    const S = 256
    const c = document.createElement('canvas')
    c.width = S
    c.height = S
    const g2 = c.getContext('2d')
    let tex: TH.Texture | null = null
    if (g2) {
      const img = g2.createImageData(S, S)
      const cxp = S / 2
      const cyp = S * 0.52
      for (let y = 0; y < S; y++) {
        for (let x = 0; x < S; x++) {
          const d = Math.hypot((x - cxp) / (S * 0.5), (y - cyp) / (S * 0.5))
          // 平滑衰减，边缘归零，中心峰值 0.19
          const f = Math.max(0, 1 - d)
          // 峰值 0.55：第一版取 0.19，实测整帧峰值亮度只有 15/255（原网格是
          // 152），等于没画。/ Peak 0.55: the first pass used 0.19 and measured a
          // frame peak of 15 out of 255 against the old grid's 152 - invisible.
          const a = f * f * (3 - 2 * f) * 0.55
          const h = ((x * 73856093) ^ (y * 19349663)) >>> 0
          const dither = ((h % 5) - 2) / 255
          const i = (y * S + x) * 4
          img.data[i] = 255
          img.data[i + 1] = 255
          img.data[i + 2] = 255
          img.data[i + 3] = Math.max(0, Math.min(255, Math.round((a + dither) * 255)))
        }
      }
      g2.putImageData(img, 0, 0)
      tex = new THREE.CanvasTexture(c)
      tex.colorSpace = THREE.SRGBColorSpace
    }
    floorMat = new THREE.MeshBasicMaterial({
      map: tex,
      color: C_GRID,
      transparent: true,
      opacity: 1,
      depthWrite: false,
    })
    /* 地面尺寸沿 z 拉长：贴图是圆的，平面是长方形，于是光斑被拉成沿视线方向
       延伸的长椭圆，正是一道「扫过去的光」而不是一个「圆点」。
       The plane is elongated along z, so the circular texture stretches into a
       long ellipse running away from the viewer - a sweep of light rather than a
       spot. */
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(9000, 13000), floorMat)
    floor.rotation.x = -Math.PI / 2
    floor.position.set(0, FLOOR_Y, -900)
    scene.add(floor)
    floorMesh = floor
  }

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
    /* 光斑跟着相机走。定死在 z=-900 时，相机推到判定幕之后就把它甩在身后了——
       实测 route 1.5 之后地面覆盖率归零，页面下半段身后又变回一片纯黑。让这团
       光始终落在观众前方，读法就对了：这是一盏跟着你走的顶光，而不是地上钉着
       一块亮斑。相机移动极慢，跟随与否肉眼无法分辨，但「地面永远在」是刚性的。
       The pool follows the camera. Pinned at z=-900 it was left behind once the
       camera pushed past the verdict act - measured, floor coverage hit zero after
       route 1.5 and the whole lower half of the page went back to flat black.
       Keeping the pool ahead of the viewer reads correctly: an overhead light
       travelling with you rather than a bright patch nailed to the ground. The
       camera moves slowly enough that following is imperceptible, while "the floor
       is always there" is not negotiable. */
    if (floorMesh) floorMesh.position.z = _p.z - 700
    const wallK = smooth(clamp01((r - 1.0) / 0.14)) * (1 - smooth(clamp01((r - 2.02) / 0.22)))
    floorMat.opacity = 1 - 0.7 * wallK
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
    ;(window as unknown as Record<string, unknown>).__space = devApi
  }

  return {
    resize,
    dispose() {
      if (raf) cancelAnimationFrame(raf)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('resize', resize)
      if (onPointer) window.removeEventListener('pointermove', onPointer)
      renderer.domElement.remove()
      renderer.dispose()
      scene.traverse((o) => {
        const m = o as { geometry?: { dispose(): void }; material?: { dispose(): void } }
        m.geometry?.dispose()
        m.material?.dispose()
      })
      /* DEV 钩子留而不摘：StrictMode 的双挂载让装/摘顺序不确定，摘除逻辑曾把
         后挂载实例刚装好的钩子清掉。开发专用工具，悬空引用无害。
         The DEV hook stays: StrictMode double-mounting made removal wipe the
         second instance's hook. Dev-only, a dangling reference is harmless. */
    },
  }
}
