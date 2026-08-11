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
//   · 机身 = three.js MeshPhysicalMaterial + PMREM 预积分的摄影棚环境贴图。
//     高光不是画出来的，是按金属度/粗糙度/清漆层算出来的，机身一转就自然流动。
//   · 屏幕 = 仍然是 React 渲染的真实 DOM，由 CSS3DRenderer 用**同一台相机**投影
//     到机身正面。CSS3DRenderer 就是为了与 WebGL 共用相机而存在的，手工用 CSS
//     perspective 去对齐两套投影必然错位。
//   · 屏幕开孔 = 一块只写深度、不写颜色的遮罩面（colorWrite: false）。它在机身
//     正面前方 0.01 个单位，机身正面因深度测试失败而不绘制，画布该处保持透明，
//     底下那层 CSS3D 屏幕就透出来了。这是 three 官方示例里 CSS3D 与 WebGL 混合
//     的标准做法。
//
// Why hybrid rather than putting the whole phone into WebGL: baking the screen
// into a texture ruins three things at once (text goes soft, since a texture can
// never match native glyph rasterisation; the countdown becomes a dead image;
// and switching language would require re-baking). The body is the opposite case
// - metal reads as real only when its environment reflections shift with the
// pose, which CSS gradients can never do and WebGL gives away for free.
//
// So: the body is a MeshPhysicalMaterial lit by a PMREM-prefiltered studio
// environment (highlights are computed from metalness/roughness/clearcoat, not
// painted, so they flow the moment it turns); the screen stays real React DOM,
// projected onto the body's face by CSS3DRenderer using the SAME camera (that is
// precisely what CSS3DRenderer exists for - hand-aligning a CSS perspective to a
// WebGL projection always drifts); and the screen aperture is a depth-only mask
// (colorWrite: false) sitting 0.01 units in front of the face, so the face fails
// the depth test there, the canvas stays transparent, and the CSS3D screen shows
// through. This is the standard WebGL/CSS3D mixing technique from three's own
// examples.
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
  const [{ CSS3DRenderer, CSS3DObject }, { RoomEnvironment }] = await Promise.all([
    import('three/examples/jsm/renderers/CSS3DRenderer.js'),
    import('three/examples/jsm/environments/RoomEnvironment.js'),
  ])

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
  renderer.toneMappingExposure = 1.05
  renderer.domElement.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:2'
  container.appendChild(renderer.domElement)

  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(CAM_FOV, 1, 1, 4000)
  camera.position.set(0, 0, CAM_Z)

  /* ── 环境光照：程序化摄影棚 ──
     RoomEnvironment 是一个由发光面片搭出的虚拟房间，经 PMREM 预积分成粗糙度
     分级的环境贴图。金属的可信度几乎全部来自这里：它给出的是「四面八方各不
     相同的入射光」，而不是一两盏点光源，所以边缘会出现真实的长条形高光。
     RoomEnvironment is a virtual room built from emissive panels, prefiltered by
     PMREM into a roughness-mipped environment map. Nearly all of the metal's
     credibility comes from this: it supplies light arriving differently from
     every direction rather than one or two point lights, which is what produces
     the elongated speculars along the edges. */
  const pmrem = new THREE.PMREMGenerator(renderer)
  const envRT = pmrem.fromScene(new RoomEnvironment(), 0.04)
  scene.environment = envRT.texture

  // 一盏定向光只负责那道锐利的镜面条 / one directional light purely for the crisp streak
  const key = new THREE.DirectionalLight(0xffffff, 1.6)
  key.position.set(-120, 180, 260)
  scene.add(key)
  const rim = new THREE.DirectionalLight(0x9d8bff, 0.55)
  rim.position.set(220, -80, -140)
  scene.add(rim)

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
    color: 0x35353d,
    metalness: 1,
    roughness: 0.34,
    // 清漆层：阳极氧化铝表面那层极薄的透明膜，让高光多一次更锐的反射。
    // Clearcoat: the very thin transparent film over anodised aluminium, adding
    // a second, sharper specular bounce.
    clearcoat: 0.55,
    clearcoatRoughness: 0.22,
    envMapIntensity: 1.35,
  })
  phone.add(new THREE.Mesh(bodyGeo, bodyMat))

  /* 正面玻璃盖板：覆盖金属边以内的整块面，高粗糙度极低 = 镜面黑玻璃。
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
    roughness: 0.075,
    clearcoat: 1,
    clearcoatRoughness: 0.04,
    envMapIntensity: 1.15,
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
    color: 0x2a2a31,
    metalness: 1,
    roughness: 0.38,
    clearcoat: 0.4,
    envMapIntensity: 1.2,
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
     两者都在玻璃盖板之上、遮罩之上，所以永远压在屏幕内容前面——真机上它们
     确实是「盖在」显示区之上的。
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
      envMapIntensity: 1.6,
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
    phone.position.x = p.xPx / pxPerUnit
    // 与 CSS 版 translate(-50%,-52%) 的那 2% 上移保持一致
    // Matches the 2% upward nudge in the CSS version's translate(-50%,-52%)
    phone.position.y = BODY_H * 0.02
    phone.rotation.y = p.rotYdeg * DEG
    phone.rotation.x = p.rotXdeg * DEG
    phone.scale.setScalar(p.scale)
  }
  setPose({ xPx: 0, rotYdeg: 0, rotXdeg: 0, scale: 1 })

  let raf = 0
  const loop = () => {
    raf = requestAnimationFrame(loop)
    renderer.render(scene, camera)
    css3d.render(scene, camera)
  }
  loop()

  return {
    setPose,
    resize,
    dispose() {
      cancelAnimationFrame(raf)
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
      scene.traverse((o) => {
        const m = o as { geometry?: { dispose(): void }; material?: { dispose(): void } }
        m.geometry?.dispose()
        m.material?.dispose()
      })
    },
  }
}
