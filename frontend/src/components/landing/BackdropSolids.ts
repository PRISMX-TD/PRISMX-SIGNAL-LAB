// 背景实体 / dimensional backdrop solids
//
// ════════════════════════════════════════════════════════════════════════════
// 这块背景改了八轮，前七轮可以归成两类，两类都错：
//   光的分布  线阵网格 / 摄影棚扫光 / 远方地平线 / 舞台光幕
//             —— 差别只是亮度落在画面哪儿，本质是同一个动作，没有「东西」
//   平面图形  棱镜线稿 / 价格标尺 / 巨型数字 / K 线剪影
//             —— 有东西了，但全是描边和平涂，没有体积
//
// 反馈是「做一些有立体感的」。而整页唯一一直被认可的视觉是那台手机——它被
// 认可的原因很具体：**有材质、有厚度、会随姿态反光**。所以背景实体沿用同一套
// 材质语言（MeshPhysicalMaterial + PMREM 预积分的暗棚环境贴图），而不是再画一
// 张图：体积感来自实算的环境反射，不是画上去的高光。
//
// 三个方向：
//   prism    实体玻璃棱镜。母品牌就叫 PRISMX，本站签名图形又是「一条线裂成
//            三条」，所以一块真的会折射的棱镜是品牌的字面形态，而不是随便挑
//            的几何体。用 transmission 做真折射。
//   slabs    悬浮板阵。几块拉丝金属板悬在不同深度，与手机同族材质。最克制，
//            纯粹给画面立厚度与前后层次。
//   terraces 阶梯台地。三级实体台阶对应止盈/入场/止损三个价位——把价格阶梯
//            做成可以站上去的地形。
//
// Eight rounds on this backdrop. The first seven fall into two groups and both
// were wrong: distributions of light (grid, sweep, horizon, stage wash) that
// differ only in where brightness lands and place nothing at all; and flat
// graphics (prism outline, price rule, giant numerals, candle silhouette) that
// do place something but only as strokes and fills, with no volume.
//
// The note was "make it dimensional". The one visual on this page that has
// consistently been accepted is the phone, and the reason is specific: it has
// material, thickness, and reflections that move with its pose. So these solids
// share that language - MeshPhysicalMaterial lit by a PMREM-prefiltered dark
// studio - rather than being another drawing. The volume comes from computed
// environment reflection, not from painted highlights.
// ════════════════════════════════════════════════════════════════════════════

import type * as TH from 'three'

export type SolidVariant = 'none' | 'prism' | 'slabs' | 'terraces'

export interface SolidsHandle {
  setVariant(v: SolidVariant): void
  /** 每帧调用：极慢自转 + 随路线沉降 / per frame: very slow spin plus route drift */
  update(t: number, route: number): void
  dispose(): void
}

/* 圆角矩形，供板与台阶挤出用 / a rounded rect for extruding slabs and steps */
function roundedRect(THREE: typeof import('three'), w: number, h: number, r: number) {
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

export function createBackdropSolids(
  THREE: typeof import('three'),
  renderer: TH.WebGLRenderer,
  scene: TH.Scene,
  opts: { lowPower: boolean }
): SolidsHandle {
  /* ══ 暗棚环境 ══
     体积感的全部来源。金属没有漫反射分量，看到的完全是「镜面方向上有什么」，
     所以环境里必须真的有形状明确的灯板——环境越暗、灯板形状越清楚，金属边缘
     那几道长高光才立得住。
     注意 fromScene 的第四个参数 far 必须显式给：默认远裁剪面只有 100，而灯板在
     300-600 之外，用默认值会被整体裁掉，环境贴图里只剩背景色，金属渲染成纯黑。
     这个坑在手机机身那一版上踩过一次，实测平均亮度 0.7、99.8% 的像素落在 0-31。
     The entire source of volume. Metal has no diffuse term, so it shows exactly
     whatever lies along its mirror direction: the environment must contain real,
     clearly shaped panels. Note that fromScene's fourth argument, far, has to be
     passed - it defaults to 100 while these panels sit 300-600 out, so the default
     clips every one of them and leaves only the background colour, rendering the
     metal pure black. Hit once already on the phone body, where it measured an
     average luminance of 0.7 with 99.8% of pixels in the 0-31 band. */
  const envScene = new THREE.Scene()
  envScene.background = new THREE.Color(0x06060a)
  const panel = (w: number, h: number, rgb: [number, number, number], px: number, py: number, pz: number, ry: number) => {
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(rgb[0], rgb[1], rgb[2]), side: THREE.DoubleSide })
    )
    m.position.set(px, py, pz)
    m.rotation.y = ry
    envScene.add(m)
  }
  panel(420, 320, [2.6, 2.7, 3.1], -300, 240, 140, Math.PI / 3.4) // 主光 / key
  panel(70, 620, [2.4, 2.4, 2.8], 340, 60, 80, -Math.PI / 2.6) // 边缘灯带 / edge strip
  panel(520, 200, [1.0, 0.62, 2.4], 40, -300, 160, 0) // 品牌紫补光 / violet bounce
  panel(900, 520, [1.0, 1.02, 1.25], 0, 280, 520, 0) // 相机后柔光 / fill behind camera

  const pmrem = new THREE.PMREMGenerator(renderer)
  const envRT = pmrem.fromScene(envScene, 0.04, 0.1, 2000)
  envScene.traverse((o) => {
    const m = o as { geometry?: { dispose(): void }; material?: { dispose(): void } }
    m.geometry?.dispose()
    m.material?.dispose()
  })
  const env = envRT.texture

  const groups: Record<Exclude<SolidVariant, 'none'>, TH.Group> = {
    prism: new THREE.Group(),
    slabs: new THREE.Group(),
    terraces: new THREE.Group(),
  }
  Object.values(groups).forEach((g) => {
    g.visible = false
    scene.add(g)
  })

  /* ══ 灯 ══
     纯环境反射对**平板**不成立：一块镜面平板正对相机时，它反射的只是机位背后
     那块补光，实测整块板均值只有 1（峰值 45 全在边缘那一两个像素上）。手机之所以
     成立是因为它通体是曲面和倒角，法线扫过整个环境；平板没有这个条件。
     所以补三盏真实的灯，让实体靠**明暗梯度**立起来，而不是靠一条边缘高光。
     Pure environment reflection does not work for FLAT plates: a mirror plate
     facing the camera reflects only the fill behind the lens, and the slabs
     measured a mean of 1 with their peak of 45 confined to an edge pixel or two.
     The phone works because it is curves and chamfers throughout, sweeping its
     normals across the whole environment; a flat plate never does. Three real
     lights let the solids stand up on a shading gradient instead of one hot edge. */
  scene.add(new THREE.AmbientLight(0x272730, 1.4))
  const key = new THREE.DirectionalLight(0xffffff, 1.7)
  key.position.set(-320, 420, 640)
  scene.add(key)
  const rim = new THREE.DirectionalLight(0x8b6cff, 0.62)
  rim.position.set(420, -240, 220)
  scene.add(rim)

  const metal = (color: number, rough: number) =>
    new THREE.MeshPhysicalMaterial({
      color,
      /* 金属度从 1 降到 0.25：全金属没有漫反射分量，平板就只剩镜面那一条。
         留下七成漫反射，明暗梯度才有载体——顺带这也更贴合本站「颜料，不是光」
         的材质取向：被照亮的实色表面，不是一面镜子。
         Metalness drops from 1 to 0.25: fully metallic means no diffuse term and a
         flat plate keeps only its specular sliver. Leaving 70 percent diffuse gives
         the shading gradient something to live on, and it also sits closer to the
         site's pigment-not-light material stance: a lit solid surface rather than
         a mirror. */
      metalness: 0.25,
      roughness: rough,
      clearcoat: 0.4,
      clearcoatRoughness: 0.3,
      envMap: env,
      /* 1.25 → 2.4。实测悬浮板与台地的整帧峰值只有 8 和 21（棱镜是 109），
         几乎纯黑：金属没有漫反射分量，看到的全部是环境反射，而这套暗棚的灯板
         本来就压得很低，1.25 的强度乘上 0x33333c 的基色只剩个位数。
         1.25 to 2.4. The slabs and terraces measured frame peaks of 8 and 21
         against the prism's 109 - effectively black. Metal has no diffuse term so
         everything visible is environment reflection, and this dark studio's
         panels are already low; 1.25 times a 0x33333c base left single digits. */
      envMapIntensity: 2.4,
    })

  /* ══ 棱镜 ══
     真折射需要 transmission，它每帧要额外渲染一张背景缓冲。桌面付得起；低功耗
     设备退回「极低粗糙度 + 半透明」的近似，形状与反光仍在，只是不折射。
     Real refraction needs transmission, which costs an extra backbuffer pass per
     frame. Desktop can afford it; low-power devices fall back to a very smooth
     semi-transparent approximation that keeps the form and the speculars without
     bending anything. */
  {
    const tri = new THREE.Shape()
    tri.moveTo(0, 150)
    tri.lineTo(-130, -75)
    tri.lineTo(130, -75)
    tri.closePath()
    const geo = new THREE.ExtrudeGeometry(tri, {
      depth: 170,
      bevelEnabled: true,
      bevelThickness: 4,
      bevelSize: 4,
      bevelSegments: 2,
    })
    geo.center()
    const mat = new THREE.MeshPhysicalMaterial({
      color: 0xf2eeff,
      metalness: 0,
      roughness: 0.03,
      envMap: env,
      envMapIntensity: 1.5,
      transmission: opts.lowPower ? 0 : 0.94,
      thickness: 120,
      ior: 1.62,
      transparent: opts.lowPower,
      opacity: opts.lowPower ? 0.28 : 1,
      clearcoat: 1,
      clearcoatRoughness: 0.04,
    })
    const mesh = new THREE.Mesh(geo, mat)
    mesh.scale.setScalar(1.35)
    groups.prism.add(mesh)
    groups.prism.userData.spin = mesh
  }

  /* ══ 悬浮板阵 ══
     几块拉丝金属板悬在不同深度。最克制的一个：不表达任何内容，只给画面厚度与
     前后层次——观众读到的是「这里有空间」，不是「这里有个图案」。
     Brushed metal slabs hanging at different depths. The most restrained option:
     it states nothing, it only gives the frame thickness and front-to-back order,
     so what reads is "there is space here", not "there is a pattern here". */
  {
    /* 位置整体右移下沉，让开 hero 文案列（实测占视口 x 7-33.3% / y 50-78.6%）。
       上一版包围盒投影是 x 7.3-89.6%，正压在文案上。
       Shifted right and down to clear the hero copy column, measured at 7 to 33.3
       percent of the viewport horizontally and 50 to 78.6 vertically. The previous
       placement projected to 7.3-89.6 percent, sitting right on the type. */
    const defs: [number, number, number, number, number, number][] = [
      // w, h, x, y, z, rotY
      /* 又挪一次，这次按投影反推而不是估：上一版包围盒是 x 49-136% / y 72-135%，
         右下角整块溢出画面，看到的几乎只有侧棱——梯度占比因此只有 4%。
         在 1800 距离上画面宽约 1760 世界单位、高约 1100，所以「左移 11%、上移
         24%」换算成 x-194 / y+264。
         Moved again, this time derived from the projection rather than estimated:
         the previous bounding box spanned 49-136% horizontally and 72-135%
         vertically, so most of it hung off the lower right and only the edges were
         visible, which is why the mid-tone share came back at 4%. At a distance of
         1800 the frame is about 1760 world units wide and 1100 tall, making an
         11% left and 24% upward shift equal to x-194 and y+264. */
      [420, 250, -44, -36, -260, 0.34],
      [300, 180, 236, -236, -520, -0.22],
      [520, 320, 626, -146, -900, 0.16],
    ]
    defs.forEach(([w, h, x, y, z, ry], i) => {
      const geo = new THREE.ExtrudeGeometry(roundedRect(THREE, w, h, 18), {
        depth: 26,
        bevelEnabled: true,
        bevelThickness: 2.5,
        bevelSize: 2.5,
        bevelSegments: 2,
      })
      geo.center()
      const m = new THREE.Mesh(geo, metal(i === 2 ? 0x4a3f66 : 0x5c5c6a, 0.4 + i * 0.05))
      m.position.set(x, y, z)
      m.rotation.set(0.06, ry, i === 1 ? 0.08 : -0.04)
      groups.slabs.add(m)
    })
  }

  /* ══ 阶梯台地 ══
     三级实体台阶，高度对应止盈/入场/止损。价格阶梯做成可以站上去的地形——
     内容与形式同一件事，而不是拿几何体当装饰。
     Three solid terraces at the take-profit, entry and stop-loss heights: the
     price ladder as terrain you could stand on, so the content and the form are
     the same thing rather than geometry used as ornament. */
  {
    const steps: [number, number, number][] = [
      // y, z, 紫色强调 / violet accent
      [-200, -220, 0],
      [-350, -560, 1],
      [-500, -900, 0],
    ]
    steps.forEach(([y, z, accent], i) => {
      const geo = new THREE.ExtrudeGeometry(roundedRect(THREE, 900 + i * 240, 120, 10), {
        depth: 420,
        bevelEnabled: true,
        bevelThickness: 3,
        bevelSize: 3,
        bevelSegments: 2,
      })
      geo.center()
      const m = new THREE.Mesh(geo, metal(accent ? 0x4c4074 : 0x55555f, 0.42))
      m.position.set(560 - i * 60, y, z)
      /* -90° 时台阶完全水平，相机几乎平视 → 看到的是刀刃，实测整帧峰值只有 21。
         收到 -66° 让台面朝向相机，顶面才有面积去接环境光。
         At -90 degrees the terraces are dead flat and a near-level camera sees only
         their edges, which measured a frame peak of 21. At -66 the tops face the
         camera and finally have area to catch the environment. */
      m.rotation.set(-1.15, 0, 0.02)
      groups.terraces.add(m)
    })
  }

  let current: SolidVariant = 'none'
  const setVariant = (v: SolidVariant) => {
    current = v
    ;(Object.keys(groups) as Exclude<SolidVariant, 'none'>[]).forEach((k) => {
      groups[k].visible = k === v
    })
  }

  const update = (t: number, route: number) => {
    if (current === 'none') return
    /* 极慢自转：棱镜必须一直动，否则折射是死的——玻璃的可信度来自「转动时
       里面的像跟着变」。转速慢到说不出「它在转」，只觉得画面是活的。
       A very slow spin: the prism has to keep moving or its refraction is dead,
       since glass is believable precisely because the image inside it shifts as
       it turns. Slow enough that nobody would say it is spinning, only that the
       frame is alive. */
    const spin = groups.prism.userData.spin as TH.Mesh | undefined
    if (spin) {
      spin.rotation.y = t * 0.085
      spin.rotation.x = Math.sin(t * 0.05) * 0.22
      spin.rotation.z = -0.12
    }
    /* 随路线沉降：往下滚时实体整体缓慢下沉并后退，与相机推进叠出视差。
       As the route advances the solids sink and recede, adding parallax on top of
       the camera's own push. */
    const k = Math.max(0, Math.min(1, route))
    Object.values(groups).forEach((g) => {
      g.position.y = -k * 190
      g.position.z = -k * 260
    })
  }

  return {
    setVariant,
    update,
    dispose() {
      envRT.dispose()
      pmrem.dispose()
      Object.values(groups).forEach((g) => {
        g.traverse((o) => {
          const m = o as { geometry?: { dispose(): void }; material?: { dispose(): void } }
          m.geometry?.dispose()
          m.material?.dispose()
        })
        scene.remove(g)
      })
    },
  }
}
