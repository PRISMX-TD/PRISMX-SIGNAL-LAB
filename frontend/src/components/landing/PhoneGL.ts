// WebGL 手机机身 + CSS3D 真实 DOM 屏幕 / WebGL phone body + CSS3D real-DOM screen
//
// ════════════════════════════════════════════════════════════════════════════
// 为什么是「混合渲染」而不是「整台手机扔进 WebGL」
//
// 把屏幕烤成纹理会同时毁掉三件事：文字变糊（纹理分辨率永远追不上原生字形
// 光栅化）、倒计时变成死图、中英切换要重新烤图。而机身恰恰相反——金属的可信
// 度来自「环境反射随姿态实时变化」，那是 CSS 渐变永远做不到、而 WebGL 免费
// 就有的东西。
//
// 所以分工是：
//   · 机身 = three.js MeshPhysicalMaterial + PMREM 预积分的环境贴图。高光不是
//     画出来的，是按金属度/粗糙度/清漆层算出来的，机身一转就自然流动。
//   · 屏幕 = 仍然是 React 渲染的真实 DOM，由 CSS3DRenderer 用**同一台相机**投影
//     到机身正面。CSS3DRenderer 就是为了与 WebGL 共用相机而存在的，手工用 CSS
//     perspective 去对齐两套投影必然错位。
//   · 屏幕开孔 = 一块只写深度、不写颜色的遮罩面（colorWrite: false）。它在机身
//     正面前方，机身正面因深度测试失败而不绘制，画布该处保持透明，底下那层
//     CSS3D 屏幕就透出来了。这是 three 官方示例里 CSS3D 与 WebGL 混合的标准做法。
//
// Why hybrid rather than putting the whole phone into WebGL: baking the screen
// into a texture ruins three things at once (text goes soft, since a texture can
// never match native glyph rasterisation; the countdown becomes a dead image;
// and switching language would require re-baking). The body is the opposite case
// - metal reads as real only when its environment reflections shift with the
// pose, which CSS gradients can never do and WebGL gives away for free.
//
// So: the body is a MeshPhysicalMaterial lit by a PMREM-prefiltered environment
// (highlights are computed from metalness/roughness/clearcoat, not painted, so
// they flow the moment it turns); the screen stays real React DOM, projected onto
// the body's face by CSS3DRenderer using the SAME camera (that is precisely what
// CSS3DRenderer exists for - hand-aligning a CSS perspective to a WebGL
// projection always drifts); and the screen aperture is a depth-only mask
// (colorWrite: false) in front of the face, so the face fails the depth test
// there, the canvas stays transparent, and the CSS3D screen shows through. This
// is the standard WebGL/CSS3D mixing technique from three's own examples.
// ════════════════════════════════════════════════════════════════════════════

export interface PhonePose {
  /** 水平偏移，CSS 像素（由 vw 换算）/ horizontal offset in CSS px, converted from vw */
  xPx: number
  rotYdeg: number
  rotXdeg: number
  scale: number
}

export interface PhoneGLHandle {
  setPose(p: PhonePose): void
  resize(): void
  dispose(): void
}

/* ── 世界单位 = 毫米 / world units are millimetres ──
   按真机尺寸建模而不是拍脑袋定比例：厚度与圆角半径的比值是「看起来像手机」
   最敏感的一组数，用真实毫米数就不必反复试。
   Modelled at real hardware dimensions rather than invented proportions: the
   ratio between thickness and corner radius is the most sensitivity-critical
   pair for reading as a phone, and real millimetres remove the guesswork. */
const BODY_W = 71.6
const BODY_H = 149.6
const BODY_D = 8.25
const BODY_R = 11.5 // 圆角半径 / corner radius

const GLASS_INSET = 1.6 // 金属边框宽度 / metal rim width
const SCREEN_INSET = 4.3 // 金属边 + 黑色 bezel / metal rim + black bezel

const SCREEN_W = BODY_W - SCREEN_INSET * 2

/* 屏幕 DOM 的像素尺寸。宽高比必须与世界坐标里的屏幕严格一致，否则 CSS3DObject
   的 x/y 缩放不等，文字会被拉扁。这里先定 DOM 宽，再由宽高比反推世界高度。
   The screen DOM's pixel size. Its aspect must match the world-space screen
   exactly, or the CSS3DObject's x and y scales differ and the type gets
   squashed. DOM width is fixed first, then world height derives from it. */
export const SCREEN_DOM_W = 380
export const SCREEN_DOM_H = 822
const SCREEN_H = (SCREEN_W * SCREEN_DOM_H) / SCREEN_DOM_W
const SCREEN_SCALE = SCREEN_W / SCREEN_DOM_W

const CAM_FOV = 26
const CAM_Z = 500

export async function createPhoneGL(opts: {
  /** 全视口舞台，两层渲染器挂在这里 / the full-viewport stage hosting both renderers */
  container: HTMLElement
  /** React 渲染的屏幕节点，将被 CSS3D 接管 / the React-rendered screen node CSS3D takes over */
  screenEl: HTMLElement
}): Promise<PhoneGLHandle | null> {
  const { container, screenEl } = opts

  // 早退：没有 WebGL 就别费劲，调用方会回退到 CSS 手机。
  // Bail early without WebGL; the caller falls back to the CSS phone.
  try {
    const probe = document.createElement('canvas')
    if (!probe.getContext('webgl2') && !probe.getContext('webgl')) return null
  } catch {
    return null
  }

  const THREE = await import('three')
  const { CSS3DRenderer, CSS3DObject } = await import('three/examples/jsm/renderers/CSS3DRenderer.js')

  /* ── 记住屏幕节点的原位，dispose 时放回去 ──
     CSS3DObject 会把这个节点搬进它自己的容器。React 仍然持有该节点的引用并继续
     更新它的子树（这没问题），但卸载时 React 会对**原父节点**调用 removeChild，
     那时节点已经不在原处，会抛 NotFoundError 让整页崩掉。
     所以必须记住原父节点与原后继兄弟，dispose 时精确放回。
     CSS3DObject moves this node into its own container. React keeps its ref and
     goes on updating the subtree (which is fine), but on unmount React calls
     removeChild on the ORIGINAL parent, where the node no longer is - that throws
     NotFoundError and takes the page down. Hence recording the original parent
     and next sibling, and restoring exactly on dispose. */
  const homeParent = screenEl.parentNode
  const homeNext = screenEl.nextSibling

  /* ── 渲染器 ──
     CSS3D 在下、WebGL 在上：WebGL 画布带 alpha，遮罩开孔处保持透明，屏幕从
     下面透出来。两层都不接收指针事件，交互仍归页面本身。
     CSS3D below, WebGL above: the canvas has alpha and stays transparent at the
     mask aperture so the screen shows through from underneath. Neither layer
     takes pointer events; interaction still belongs to the page. */
  const css3d = new CSS3DRenderer()
  css3d.domElement.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:1'
  container.appendChild(css3d.domElement)

  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'high-performance' })
  renderer.setClearAlpha(0)
  renderer.outputColorSpace = THREE.SRGBColorSpace
  // ACES 影调映射：高光不会一冲就死白，金属边缘的亮部保留层次。
  // ACES tone mapping keeps speculars from clipping to flat white, so the lit
  // metal edges retain gradation.
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.1
  renderer.domElement.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:2'
  container.appendChild(renderer.domElement)

  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(CAM_FOV, 1, 1, 4000)
  camera.position.set(0, 0, CAM_Z)

  /* ══ 环境光照：暗调产品摄影棚 ══
     此前用的是 three 自带的 RoomEnvironment，那是一间明亮的通用房间——金属会
     反射出一大片均匀白光，压在本站的近黑页面上会读成「从别处抠来贴上的」。
     真实的产品摄影恰恰相反：**暗环境 + 几条形状明确的灯带**。金属上那些又长又
     锐的高光，就是灯带的形状被曲面拉长后的像；环境越暗，高光的形状越清楚。
     所以这里手搭一间暗棚：一块左上主光板、一条右侧窄灯带（负责边缘那道最锐的
     高光）、一块底部品牌紫补光（把机身与页面的紫色语汇连起来，但强度极低，
     只染边不发光）。整场经 PMREM 预积分成按粗糙度分级的环境贴图。
     Previously this used three's RoomEnvironment, a bright generic room: the
     metal reflected one large even white field, which on this site's near-black
     page reads as cut-and-pasted from somewhere else. Real product photography
     does the opposite - a dark environment with a few sharply shaped light
     panels. The long, crisp speculars on metal ARE the shape of those panels
     stretched across the curvature, and the darker the surround, the more clearly
     that shape reads. So this builds a dark studio by hand: a key panel upper
     left, a narrow strip on the right (which produces the sharpest edge
     highlight), and a low-intensity violet bounce from below that ties the body
     to the page's brand hue without ever glowing. The whole set is prefiltered
     by PMREM into a roughness-mipped environment map. */
  const envScene = new THREE.Scene()
  envScene.background = new THREE.Color(0x07070a)
  const panel = (w: number, h: number, rgb: [number, number, number], px: number, py: number, pz: number, ry: number) => {
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(w, h),
      // 亮度 > 1 是刻意的：PMREM 的渲染目标是半浮点，能承载 HDR 值，
      // 这正是高光能「亮过白」而不糊成一片的原因。
      // Values above 1 are deliberate: PMREM's render target is half-float and
      // carries HDR, which is what lets speculars read brighter than white
      // without smearing into a flat patch.
      new THREE.MeshBasicMaterial({ color: new THREE.Color(rgb[0], rgb[1], rgb[2]), side: THREE.DoubleSide })
    )
    m.position.set(px, py, pz)
    m.rotation.y = ry
    envScene.add(m)
  }
  panel(420, 320, [3.4, 3.5, 3.9], -300, 220, 120, Math.PI / 3.4) // 主光板 / key
  panel(70, 620, [7.2, 7.2, 7.6], 340, 40, 60, -Math.PI / 2.6) // 窄灯带 / edge strip
  /* 底部品牌紫补光。实测下半部边框亮度掉到 0，在本站近黑的页面上机身下缘会
     整个融进背景、轮廓断掉。提亮这块板既补住下缘，又让品牌紫以**金属反射**的
     形式出现在机身上——它是被反射的光，不是元素自己在发光，因此与设计系统
     「颜料，不是光」的禁令不冲突。
     Bottom violet bounce. Measurement showed the lower rim falling to zero
     luminance, which on this site's near-black page dissolves the bottom of the
     body into the background and breaks its silhouette. Raising this panel both
     restores that edge and puts the brand violet on the body as a *metal
     reflection* - light being reflected, not an element emitting - so it does not
     conflict with the design system's pigment-not-glow rule. */
  panel(520, 200, [1.1, 0.7, 2.6], 40, -320, 140, 0)
  panel(300, 300, [0.9, 0.92, 1.05], 120, 260, -260, Math.PI) // 背后柔光 / back fill
  /* 相机后方的大柔光板。这块不是可有可无的补光，而是决定成败的一块：全金属
     与镜面玻璃**没有漫反射分量**，正面看到的完全是「镜面反射方向上有什么」。
     正对镜头的平面，其反射方向恰好指回相机身后——那里如果是空的，正面就渲染
     成死黑。实拍产品时摄影师必放的那块白卡，作用与此完全相同：它让正面玻璃
     出现自上而下的柔和渐变，机身才读成「玻璃」而不是「一个洞」。
     A large soft panel behind the camera. This one is not optional fill, it is
     the difference between working and not: fully metallic and mirror surfaces
     have NO diffuse term, so a front-facing plane shows exactly whatever lies
     along its mirror direction - which points back past the camera. Leave that
     empty and the face renders dead black. This is the same white card a product
     photographer always places behind the lens: it gives the cover glass a soft
     top-to-bottom gradient, which is what makes it read as glass rather than a
     hole cut in the page. */
  panel(1000, 560, [1.25, 1.28, 1.5], 0, 300, 520, 0)

  const pmrem = new THREE.PMREMGenerator(renderer)
  /* 第四个参数 far 必须显式给：PMREMGenerator.fromScene 的默认远裁剪面只有 100，
     而上面这些灯板距原点 300–600，用默认值会被整体裁掉，环境贴图里只剩背景色。
     那时全金属机身（无漫反射分量、外观 100% 来自环境反射）会渲染成纯黑，只剩
     方向光的一个高光点——实测就是这个现象。
     The far argument must be passed explicitly: PMREMGenerator.fromScene defaults
     to a far plane of 100, while the panels above sit 300-600 from the origin, so
     the default clips every one of them and leaves only the background colour in
     the environment. The fully metallic body (no diffuse term, appearance driven
     entirely by environment reflection) then renders pure black apart from a
     single directional-light specular - which is exactly what measuring the
     framebuffer showed. */
  const envRT = pmrem.fromScene(envScene, 0.03, 0.1, 2000)
  scene.environment = envRT.texture
  envScene.traverse((o) => {
    const m = o as { geometry?: { dispose(): void }; material?: { dispose(): void } }
    m.geometry?.dispose()
    m.material?.dispose()
  })

  // 一盏定向光只负责那道锐利的镜面条 / one directional light purely for the crisp streak
  const key = new THREE.DirectionalLight(0xffffff, 1.25)
  key.position.set(-120, 180, 260)
  scene.add(key)

  /* ── 圆角矩形 ── */
  const roundedRect = (w: number, h: number, r: number) => {
    const s = new THREE.Shape()
    const x = -w / 2
    const y = -h / 2
    s.moveTo(x + r, y)
    s.lineTo(x + w - r, y)
    s.quadraticCurveTo(x + w, y, x + w, y + r)
    s.lineTo(x + w, y + h - r)
    s.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
    s.lineTo(x + r, y + h)
    s.quadraticCurveTo(x, y + h, x, y + h - r)
    s.lineTo(x, y + r)
    s.quadraticCurveTo(x, y, x + r, y)
    return s
  }

  /* ══ 接触阴影 ══
     上一版把 CSS 机身整个隐藏，而地影是它的子元素，于是 WebGL 手机变成了完全
     没有影子的悬空物体——这是上一轮引入的回归。影子对「物体真实存在于空间中」
     的贡献极大，比任何材质参数都直接。
     这里用一块贴了程序化径向渐变的面片，不写深度、不参与光照，位置跟随机身
     水平移动，并随旋转反向偏移一点点（灯在左上，机身右转时影子向左让）。
     The previous pass hid the entire CSS body, and the ground shadow was one of
     its children - so the WebGL phone became a completely shadowless floating
     object. That was a regression. A shadow contributes more to "this object
     really occupies space" than any material parameter.
     This is a plane carrying a procedurally drawn radial gradient: no depth
     write, no lighting, tracking the body horizontally and shifting slightly
     against the rotation (the key light is upper left, so a rightward turn
     pushes the shadow left). */
  const shadowTex = (() => {
    const c = document.createElement('canvas')
    c.width = 256
    c.height = 128
    const g = c.getContext('2d')
    if (!g) return null
    const grd = g.createRadialGradient(128, 64, 0, 128, 64, 128)
    grd.addColorStop(0, 'rgba(0,0,0,0.82)')
    grd.addColorStop(0.4, 'rgba(0,0,0,0.34)')
    grd.addColorStop(1, 'rgba(0,0,0,0)')
    g.fillStyle = grd
    g.fillRect(0, 0, 256, 128)
    return new THREE.CanvasTexture(c)
  })()
  const shadow = shadowTex
    ? new THREE.Mesh(
        new THREE.PlaneGeometry(150, 46),
        new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false, opacity: 0.85 })
      )
    : null
  if (shadow) {
    shadow.position.set(0, -BODY_H / 2 - 9, -14)
    shadow.renderOrder = -2
    scene.add(shadow)
  }

  const phone = new THREE.Group()
  scene.add(phone)

  /* 机身：带倒角的挤出体。倒角就是真机侧边那道抛光斜面，也是整台手机上最亮的
     一条高光所在——没有倒角，金属只会读成一块深灰塑料。
     The body: a bevelled extrusion. The bevel is the polished chamfer along a
     real phone's edge and carries the brightest specular on the whole object;
     without it, metal reads as a slab of dark plastic. */
  const bodyGeo = new THREE.ExtrudeGeometry(roundedRect(BODY_W, BODY_H, BODY_R), {
    depth: BODY_D - 1.1,
    bevelEnabled: true,
    bevelThickness: 0.55,
    bevelSize: 0.55,
    bevelOffset: 0,
    bevelSegments: 3,
    curveSegments: 32,
  })
  bodyGeo.center()
  const bodyMat = new THREE.MeshPhysicalMaterial({
    color: 0x3a3a43,
    metalness: 1,
    roughness: 0.3,
    // 清漆层：阳极氧化铝表面那层极薄的透明膜，让高光多一次更锐的反射。
    // Clearcoat: the very thin transparent film over anodised aluminium, adding
    // a second, sharper specular bounce.
    clearcoat: 0.6,
    clearcoatRoughness: 0.18,
    envMapIntensity: 1.5,
  })
  phone.add(new THREE.Mesh(bodyGeo, bodyMat))

  /* 正面玻璃盖板：覆盖金属边以内的整块面，粗糙度极低 = 镜面黑玻璃。
     屏幕熄灭的部分（bezel）就靠它显出「黑得发亮」而不是「黑得发死」。
     Front cover glass over everything inside the metal rim, at very low
     roughness for a mirror-black surface. It is what makes the unlit bezel read
     as glossy black rather than dead black. */
  const glassGeo = new THREE.ShapeGeometry(
    roundedRect(BODY_W - GLASS_INSET * 2, BODY_H - GLASS_INSET * 2, BODY_R - GLASS_INSET * 0.55),
    32
  )
  const glassMat = new THREE.MeshPhysicalMaterial({
    color: 0x050507,
    metalness: 0.1,
    roughness: 0.06,
    clearcoat: 1,
    clearcoatRoughness: 0.03,
    envMapIntensity: 1.3,
  })
  const glass = new THREE.Mesh(glassGeo, glassMat)
  glass.position.z = BODY_D / 2 + 0.02
  phone.add(glass)

  /* 屏幕开孔遮罩：只写深度不写颜色。renderOrder = -1 保证它先于机身绘制，
     机身正面在该区域深度测试失败而被丢弃，画布保持透明。
     The aperture mask: depth-only, no colour. renderOrder -1 draws it before the
     body so the face fails the depth test there and the canvas stays clear. */
  const maskGeo = new THREE.ShapeGeometry(roundedRect(SCREEN_W, SCREEN_H, BODY_R - SCREEN_INSET * 0.62), 32)
  const mask = new THREE.Mesh(maskGeo, new THREE.MeshBasicMaterial({ colorWrite: false }))
  mask.position.z = BODY_D / 2 + 0.06
  mask.renderOrder = -1
  phone.add(mask)

  /* 侧键：右缘电源、左缘双音量。真机上这三块是与机身同材质的独立零件，
     所以用同一个材质、略深的颜色，转动时它们会跟着一起反光。
     Side keys: power right, two volume left. On real hardware these are separate
     parts in the same finish, so they share the material at a slightly darker
     tint and catch the same reflections as the body turns. */
  const keyMat = new THREE.MeshPhysicalMaterial({
    color: 0x2d2d35,
    metalness: 1,
    roughness: 0.34,
    clearcoat: 0.45,
    envMapIntensity: 1.4,
  })
  const addKey = (x: number, y: number, h: number) => {
    const k = new THREE.Mesh(new THREE.BoxGeometry(1.5, h, BODY_D * 0.52), keyMat)
    k.position.set(x, y, 0)
    phone.add(k)
  }
  addKey(BODY_W / 2 + 0.4, 22, 26)
  addKey(-BODY_W / 2 - 0.4, 38, 15)
  addKey(-BODY_W / 2 - 0.4, 19, 15)

  /* 灵动岛 + 镜头：岛是玻璃面上的黑色药丸，镜头是嵌在里面的深蓝紫玻璃。
     两者都在玻璃盖板与遮罩之上，所以永远压在屏幕内容前面——真机上它们确实
     是「盖在」显示区之上的。
     The island and its lens sit above both the cover glass and the mask, so they
     always occlude screen content, exactly as they physically do on hardware. */
  const island = new THREE.Mesh(
    new THREE.ShapeGeometry(roundedRect(24, 7.4, 3.7), 24),
    new THREE.MeshBasicMaterial({ color: 0x000000 })
  )
  island.position.set(0, SCREEN_H / 2 - 7.6, BODY_D / 2 + 0.1)
  island.renderOrder = 3
  phone.add(island)

  const lens = new THREE.Mesh(
    new THREE.CircleGeometry(2.35, 32),
    new THREE.MeshPhysicalMaterial({
      color: 0x121628,
      metalness: 0.35,
      roughness: 0.08,
      clearcoat: 1,
      envMapIntensity: 1.8,
    })
  )
  lens.position.set(7.4, SCREEN_H / 2 - 7.6, BODY_D / 2 + 0.14)
  lens.renderOrder = 4
  phone.add(lens)

  /* ── CSS3D 屏幕 ──
     节点被搬进 CSS3D 容器，缩放到与世界坐标里的屏幕等大。z 略低于遮罩，
     保证它落在开孔背后而不是浮在机身之前。
     The node moves into the CSS3D container, scaled to the world-space screen.
     Its z sits just under the mask so it lands behind the aperture rather than
     floating in front of the body. */
  screenEl.style.width = `${SCREEN_DOM_W}px`
  screenEl.style.height = `${SCREEN_DOM_H}px`
  const screenObj = new CSS3DObject(screenEl)
  screenObj.scale.setScalar(SCREEN_SCALE)
  screenObj.position.z = BODY_D / 2 + 0.04
  phone.add(screenObj)

  /* ── 尺寸与投影 ──
     CSS3DRenderer 把世界单位直接当 CSS 像素用，其透视值随视口高度变化，所以
     手机的视觉大小天然跟着视口缩放（等价于原来 CSS 版的 clamp()）。
     世界单位与屏幕像素的换算比在这里算一次，供 setPose 把 vw 偏移换成世界坐标。
     CSS3DRenderer treats world units as CSS pixels and derives its perspective
     from viewport height, so the phone's apparent size scales with the viewport
     for free (the equivalent of the CSS version's clamp()). The world-to-pixel
     ratio is computed once here so setPose can convert a vw offset into world
     units. */
  let pxPerUnit = 1
  const resize = () => {
    const w = container.clientWidth
    const h = container.clientHeight
    if (!w || !h) return
    camera.aspect = w / h
    camera.updateProjectionMatrix()
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setSize(w, h)
    css3d.setSize(w, h)
    const perspective = (0.5 / Math.tan((CAM_FOV * Math.PI) / 360)) * h
    pxPerUnit = perspective / CAM_Z
  }
  resize()

  const DEG = Math.PI / 180
  const setPose = (p: PhonePose) => {
    const x = p.xPx / pxPerUnit
    phone.position.x = x
    // 与 CSS 版 translate(-50%,-52%) 的那 2% 上移保持一致
    // Matches the 2% upward nudge in the CSS version's translate(-50%,-52%)
    phone.position.y = BODY_H * 0.02
    phone.rotation.y = p.rotYdeg * DEG
    phone.rotation.x = p.rotXdeg * DEG
    phone.scale.setScalar(p.scale)
    if (shadow) {
      // 影子跟随水平位移，并随旋转反向让开一点：灯在左上，机身右转影子向左。
      // The shadow tracks the horizontal move and yields slightly against the
      // rotation: the key light is upper left, so a rightward turn pushes it left.
      shadow.position.x = x - p.rotYdeg * 0.28
      shadow.scale.setScalar(p.scale)
    }
  }
  setPose({ xPx: 0, rotYdeg: 0, rotXdeg: 0, scale: 1 })

  const draw = () => {
    renderer.render(scene, camera)
    css3d.render(scene, camera)
  }
  // 先同步画一帧：叙事区首屏就位时不必等到第一次 rAF 才有画面。
  // One synchronous frame up front so the story has an image the moment it is
  // in place, rather than waiting for the first rAF.
  draw()

  /* ── 渲染循环：只在真的看得见时跑 ──
     叙事区只占页面的一部分，用户滚到定价/FAQ 之后手机早已离开视口，此时继续
     每秒 60 次重绘纯属烧 GPU 和电池。IntersectionObserver 负责「在不在视口」，
     visibilitychange 负责「标签页在不在前台」，两者任一为假就停表。
     The story is only part of the page; once the user reaches pricing or the FAQ
     the phone is long gone from the viewport, and redrawing it 60 times a second
     there is pure GPU and battery burn. IntersectionObserver covers "is it on
     screen", visibilitychange covers "is the tab in front", and either being
     false stops the clock. */
  let raf = 0
  let onScreen = true
  const frame = () => {
    raf = requestAnimationFrame(frame)
    draw()
  }
  const pump = () => {
    const should = onScreen && !document.hidden
    if (should && !raf) raf = requestAnimationFrame(frame)
    else if (!should && raf) {
      cancelAnimationFrame(raf)
      raf = 0
    }
  }
  const io = new IntersectionObserver(
    ([e]) => {
      onScreen = e.isIntersecting
      pump()
    },
    { threshold: 0 }
  )
  io.observe(container)
  const onVisibility = () => pump()
  document.addEventListener('visibilitychange', onVisibility)
  pump()

  return {
    setPose,
    resize,
    dispose() {
      if (raf) cancelAnimationFrame(raf)
      io.disconnect()
      document.removeEventListener('visibilitychange', onVisibility)
      // 先把屏幕节点放回 React 记得的位置，再拆渲染器——顺序反了会让 React
      // 卸载时找不到节点。/ Restore the screen node to where React remembers it
      // BEFORE tearing the renderers down; the reverse order leaves React unable
      // to find the node at unmount.
      if (homeParent) homeParent.insertBefore(screenEl, homeNext)
      screenEl.style.width = ''
      screenEl.style.height = ''
      screenEl.style.transform = ''
      css3d.domElement.remove()
      renderer.domElement.remove()
      renderer.dispose()
      envRT.dispose()
      pmrem.dispose()
      shadowTex?.dispose()
      scene.traverse((o) => {
        const m = o as { geometry?: { dispose(): void }; material?: { dispose(): void } }
        m.geometry?.dispose()
        m.material?.dispose()
      })
    },
  }
}
