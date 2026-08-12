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
import { CASE_BOTH, CASE_LOSS, CASE_VOID, CASE_WIN, SL_Y, TP_Y, VOID_END_Y, type Pt } from './verdictData'

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
  // 判决碑的画线动画靠一块沿 x 推进的局部裁剪面 / the stone's draw-on animation
  // rides a local clipping plane sweeping along x
  renderer.localClippingEnabled = true
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

  /* ══ 地面网格 ══
     整层唯一的几何。观众判断「我在一个空间里」的全部依据就是它的透视收敛。
     The layer's only geometry. Its perspective convergence is the entire basis
     for reading the page as a place. */
  let gridMat: TH.LineBasicMaterial
  {
    const pts: number[] = []
    const X = 3000
    const ZA = 1800
    const ZB = -5200
    for (let x = -X; x <= X; x += 150) pts.push(x, FLOOR_Y, ZA, x, FLOOR_Y, ZB)
    for (let z = ZA; z >= ZB; z -= 150) pts.push(-X, FLOOR_Y, z, X, FLOOR_Y, z)
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
    gridMat = new THREE.LineBasicMaterial({ color: C_GRID, transparent: true, opacity: 0.6 })
    scene.add(new THREE.LineSegments(g, gridMat))
  }

  /* ══ 判决碑 / the verdict stone ══
     判决墙的「平面感」在这里解决：同一份判例数据（verdictData.ts）不再画成
     贴在页面上的图，而是立成一块站在网格大地上的实体碑——价格路径挤出成有
     厚度的浮雕，三条价位线是穿过碑身的实体板。相机以固定的 3/4 博物馆视角
     面对它，四拍之间只挪半步：不是回到失败的飞行，而是给已经验证过的构图
     加上厚度、透视和地面。
     几何全部由 SVG 坐标线性映射而来（x−790；y 按 440:360 缩放翻转），因此
     SVG 后备与这块碑画的是同一份行情，构图核对只需做一次。
     材质仍然全部 MeshBasic：实色颜料 + 雾给深度，零光照零辉光。
     The wall's flatness is solved here: the same case data, no longer a picture
     on the page but a stele standing on the grid floor - the price path
     extruded into a relief with real thickness, the three levels as physical
     slabs through the stone. The camera faces it from a fixed museum
     three-quarter view, drifting half a step across the beats: not a return to
     the failed flight, but thickness, perspective and ground under an
     already-verified composition. All geometry maps linearly from the SVG
     coordinates, so fallback and stone draw the same market and the
     composition needs verifying once. Materials stay MeshBasic: solid pigment
     with fog for depth, no lights, no glow. */
  const MON_Z = -1500
  const EN_W = -40
  const svg2w = ([x, y]: Pt): [number, number] => [x - 790, 140 - (y - 200) * (360 / 440)]
  const clipPlane = new THREE.Plane(new THREE.Vector3(-1, 0, 0), 1e6)
  const monument = new THREE.Group()
  monument.position.z = MON_Z
  scene.add(monument)

  /* 三条价位线：横贯碑身的实体薄板，判决瞬间对应的板闪成满不透明度。
     The three levels: thin slabs across the stone, flashing solid at the
     verdict. */
  const mkSlab = (y: number, color: number, o: number) => {
    const m = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0 })
    const b = new THREE.Mesh(new THREE.BoxGeometry(1160, 2.5, 130), m)
    b.position.set(30, y, -18)
    b.renderOrder = 1
    monument.add(b)
    return { m, o }
  }
  const tpSlab = mkSlab(140, 0x8b6cff, 0.55)
  const enSlab = mkSlab(EN_W, 0x52525b, 0.35)
  const slSlab = mkSlab(-220, 0x71717a, 0.45)
  /* 判决闪板：常驻价位线只有 2.5 单位厚，把它推到满不透明度在屏幕上仍是一条
     亚像素细线（实测判决点紫色占比纹丝不动）。SVG 版的判决带有 12px 的实体
     宽度，3D 版必须给同等的质量——一块 16 单位厚的实色板，只在判决瞬间出现。
     The verdict plates: the resident level slabs are 2.5 units thin, and pushing
     one to full opacity still reads as a sub-pixel line (measured: the violet
     share did not move at the verdict). The SVG band had 12px of real mass, so
     the 3D verdict gets the same - a 16-unit plate that exists only at the
     verdict itself. */
  const mkFlash = (y: number, color: number) => {
    const m = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0 })
    const b = new THREE.Mesh(new THREE.BoxGeometry(1160, 16, 132), m)
    b.position.set(30, y, -18)
    b.renderOrder = 1
    monument.add(b)
    return m
  }
  const tpFlash = mkFlash(140, 0x8b6cff)
  const slFlash = mkFlash(-220, 0xc4c4cc)
  const startMat = new THREE.MeshBasicMaterial({ color: 0x8b6cff, transparent: true, opacity: 0 })
  {
    const c = new THREE.Mesh(new THREE.BoxGeometry(14, 14, 14), startMat)
    c.position.set(-450, EN_W, 12)
    c.renderOrder = 4
    monument.add(c)
  }

  interface CaseCtl {
    kind: 'win' | 'loss' | 'both' | 'void'
    mats: { m: TH.MeshBasicMaterial; o: number }[]
    stamps: { m: TH.MeshBasicMaterial; o: number }[]
    wx0: number
    wx1: number
  }
  const cases: CaseCtl[] = []
  const addCase = (pts: Pt[], kind: CaseCtl['kind']) => {
    const g = new THREE.Group()
    monument.add(g)
    const w = pts.map(svg2w)
    const mats: CaseCtl['mats'] = []
    const stamps: CaseCtl['stamps'] = []
    const clipped = (color: number, o: number) => {
      const m = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0, clippingPlanes: [clipPlane] })
      mats.push({ m, o })
      return m
    }
    const stampAt = (x: number, y: number, size: number, color: number, o = 1) => {
      const m = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0 })
      stamps.push({ m, o })
      const c = new THREE.Mesh(new THREE.BoxGeometry(size, size, size), m)
      c.position.set(x, y, 14)
      c.renderOrder = 4
      g.add(c)
    }
    /* 碑身：路径与入场线围成的面，挤出 36 深——行情的浮雕。
       The body: the area between path and entry, extruded 36 deep. */
    const body = new THREE.Shape()
    body.moveTo(w[0][0], EN_W)
    w.forEach(([x, y]) => body.lineTo(x, y))
    body.lineTo(w[w.length - 1][0], EN_W)
    body.closePath()
    const rb = new THREE.Mesh(new THREE.ExtrudeGeometry(body, { depth: 36, bevelEnabled: false }), clipped(0x232329, 0.94))
    rb.position.z = -18
    rb.renderOrder = 2
    g.add(rb)
    /* 顶脊：沿路径的白色条带，略深于碑身——价格线本体。
       The ridge: a white band along the path, slightly deeper than the body -
       the price line itself. */
    const ridge = new THREE.Shape()
    ridge.moveTo(w[0][0], w[0][1] + 5)
    w.forEach(([x, y]) => ridge.lineTo(x, y + 5))
    ;[...w].reverse().forEach(([x, y]) => ridge.lineTo(x, y - 5))
    ridge.closePath()
    const rg = new THREE.Mesh(new THREE.ExtrudeGeometry(ridge, { depth: 44, bevelEnabled: false }), clipped(0xededf0, 1))
    rg.position.z = -22
    rg.renderOrder = 3
    g.add(rg)

    if (kind === 'win') stampAt(510, 140, 52, 0x8b6cff)
    if (kind === 'loss') stampAt(510, -220, 52, 0xc4c4cc)
    if (kind === 'both') {
      stampAt(svg2w([1198, SL_Y])[0], -220, 20, 0xededf0)
      stampAt(svg2w([1232, TP_Y])[0], 140, 20, 0xededf0)
      stampAt(510, svg2w([0, 430])[1], 52, 0xc4c4cc)
    }
    if (kind === 'void') {
      const yv = svg2w([0, VOID_END_Y])[1]
      // 虚线幽灵：七段短棒 / the dashed ghost: seven short bars
      for (let i = 0; i < 7; i++) {
        const m = new THREE.MeshBasicMaterial({ color: 0x71717a, transparent: true, opacity: 0 })
        stamps.push({ m, o: 0.55 })
        const d = new THREE.Mesh(new THREE.BoxGeometry(26, 3, 3), m)
        d.position.set(30 + i * 72, yv, 0)
        d.renderOrder = 4
        g.add(d)
      }
      stampAt(-10, yv, 26, 0x71717a, 0.7)
    }
    cases.push({ kind, mats, stamps, wx0: w[0][0], wx1: w[w.length - 1][0] })
  }
  addCase(CASE_WIN, 'win')
  addCase(CASE_LOSS, 'loss')
  addCase(CASE_BOTH, 'both')
  addCase(CASE_VOID, 'void')

  /* 拍点与 MarketStory 的 GSAP 时间线严格同拍（10/28/46/64%），画线窗与判决点
     也一致：两层共享滚动几何，按同一组分数自然对齐，无需任何通信。
     Beat marks match MarketStory's timeline exactly (10/28/46/64%), as do the
     draw window and the verdict point: both layers share the scroll geometry,
     so the same fractions align them with no channel in between. */
  const BEAT_AT = [0.1, 0.28, 0.46, 0.64]
  let wide = false
  const updateMonument = (r: number) => {
    const l = r - 1
    const lK = smooth(clamp01((l + 0.02) / 0.08)) * (1 - smooth(clamp01((l - 1.02) / 0.1)))
    monument.visible = wide && lK > 0.001
    let fTP = 0
    let fSL = 0
    cases.forEach((c, i) => {
      const a = BEAT_AT[i]
      const inK = smooth(clamp01((l - a) / 0.02))
      const outK = i === 3 ? 1 : 1 - smooth(clamp01((l - (a + 0.155)) / 0.025))
      const cK = inK * outK * lK
      c.mats.forEach(({ m, o }) => (m.opacity = o * cK))
      const drawP = clamp01((l - (a + 0.01)) / 0.08)
      const vK = smooth(clamp01((l - (a + 0.092)) / 0.02)) * outK * lK
      const ghostK = smooth(clamp01((drawP - 0.88) / 0.12)) * cK
      c.stamps.forEach(({ m, o }) => (m.opacity = o * (c.kind === 'void' ? ghostK : vK)))
      if (cK > 0.5) clipPlane.constant = c.wx0 - 20 + drawP * (c.wx1 + 70 - (c.wx0 - 20))
      if (c.kind === 'win' || c.kind === 'both') fTP = Math.max(fTP, vK)
      if (c.kind === 'loss' || c.kind === 'both') fSL = Math.max(fSL, vK)
    })
    tpSlab.m.opacity = (tpSlab.o + (1 - tpSlab.o) * fTP) * lK
    slSlab.m.opacity = (slSlab.o + (1 - slSlab.o) * fSL) * lK
    tpFlash.opacity = fTP * 0.95
    slFlash.opacity = fSL * 0.95
    enSlab.m.opacity = enSlab.o * lK
    startMat.opacity = 0.95 * lK
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
    /* 判定幕：面对判决碑的 3/4 博物馆机位，四拍之间只挪半步——从偏左 18°
       缓慢转向近正面并推近一段，始终高于碑心、俯视少许。
       The verdict act: a museum three-quarter view of the stone, drifting half
       a step across the beats - from 18 degrees left toward near-frontal with
       a gentle push-in, always slightly above the stone's centre. */
    { r: 1.06, p: [-430, 170, -380], l: [40, -30, -1500], fov: 36 },
    { r: 1.5, p: [-250, 130, -500], l: [40, -40, -1500], fov: 36 },
    { r: 1.96, p: [-80, 85, -580], l: [30, -40, -1500], fov: 36 },
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

    /* 判定幕期间网格退到 0.18：墙是唯一主体，大地降为余光里的存在。出墙后
       回到 0.6，随后起雾——定价、FAQ、页脚是整页阅读量最大的一段，身后不该
       有满强度的网格。
       Under the verdict wall the grid drops to 0.18: the wall is the only
       subject and the floor becomes peripheral. It returns to 0.6 on the way
       out, then haze rises for the reading-heavy tail of the page. */
    /* 碑站在大地上，网格只降到 0.3 而不是熄灭：地面是它的台座。
       The stone stands on the floor, so the grid only drops to 0.3 rather than
       going out - the ground is its pedestal. */
    const wallK = smooth(clamp01((r - 1.0) / 0.14)) * (1 - smooth(clamp01((r - 2.02) / 0.22)))
    gridMat.opacity = 0.6 * (1 - 0.5 * wallK)
    updateMonument(r)
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
    /* 碑宽 1160，竖屏的水平视场装不下（fov 34 × 竖屏宽高比 ≈ 16° 半角）。
       窄屏保留 SVG 墙（meet 模式按设计装得下），碑只在桌面出场。
       The stone is 1160 wide; a portrait horizontal field of view cannot hold
       it. Narrow viewports keep the SVG wall (whose meet mode fits by design);
       the stone appears on desktop only. */
    wide = w >= 1024
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
      /* 构图校验：把碑的包围盒投影回屏幕百分比。飞行镜头的教训是像素统计验
         不出「读成什么」；投影包围盒至少用数字钉死「碑在画面里的位置与大小」。
         Composition check: project the stone's bounding box to viewport
         percentages. Pixel statistics never caught what the corridor read as;
         a projected box pins where and how large the stone sits in frame. */
      frameBox(r: number) {
        ;(devApi as { set(x: number): void }).set(r)
        const v = new THREE.Vector3()
        let x0 = 1e9
        let x1 = -1e9
        let y0 = 1e9
        let y1 = -1e9
        for (const x of [-450, 510])
          for (const y of [-220, 160])
            for (const z of [MON_Z - 40, MON_Z + 40]) {
              v.set(x, y, z).project(camera)
              x0 = Math.min(x0, v.x)
              x1 = Math.max(x1, v.x)
              y0 = Math.min(y0, v.y)
              y1 = Math.max(y1, v.y)
            }
        const pct = (n: number) => Math.round((n * 0.5 + 0.5) * 1000) / 10
        return { l: pct(x0), r: pct(x1), b: 100 - pct(y0), t: 100 - pct(y1), visible: monument.visible }
      },
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
