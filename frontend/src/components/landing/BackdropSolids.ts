// 背景实体流 / streaming dimensional backdrop
//
// ════════════════════════════════════════════════════════════════════════════
// 这块背景改了九轮。前八轮可以归成三类，每一类都缺一样东西：
//   光的分布  网格 / 扫光 / 地平线 / 光幕     —— 没有「东西」，只有亮度落在哪
//   平面图形  棱镜线稿 / 标尺 / 数字 / K 线   —— 有东西，但是描边平涂，没有体积
//   静止实体  玻璃棱镜 / 金属板 / 阶梯台地    —— 有体积，但**不往前走**
//
// 第九轮的反馈是「我要的是往前推进的」。回看之下这一维我不但漏了，还亲手写反
// 了——上一版的注释白纸黑字写着「变化要慢到观众说不出『刚才动了』」。那正是
// 问题所在：要的不是察觉不到的呼吸，是**行进**。
//
// 所以这一版把体积和行进合起来：一群实体从深处涌来、掠过相机、循环回到远端。
// 速度足以读出，位置全部避开正文，只在画面外围与下方那条空带里流动——周边
// 视野的持续前移正是「在前进」最强的信号，而且它不跟主体抢注意力。
//
// Nine rounds on this backdrop. The first eight fall into three groups, each
// missing one thing: distributions of light (grid, sweep, horizon, wash) that
// place nothing; flat graphics (prism outline, rule, numerals, candles) that
// place something but with no volume; and static solids (glass prism, slabs,
// terraces) that have volume but DO NOT TRAVEL.
//
// The note was "I want something that moves forward". Reviewing it, I had not
// merely missed that dimension, I had written its opposite: the previous version's
// own comment reads "slow enough that nobody would say it moved". That was the
// problem. What is wanted is not imperceptible breathing, it is travel.
//
// So this version combines volume with travel: a field of solids streams out of
// the depth, sweeps past the camera and recycles to the far end. The speed is
// readable, every position clears the body copy, and the flow is confined to the
// frame's periphery and the empty band below - sustained forward motion in
// peripheral vision is the strongest available signal of travelling, and it does
// not compete with the subject.
// ════════════════════════════════════════════════════════════════════════════

import type * as TH from 'three'

export type SolidVariant = 'none' | 'bars' | 'panels' | 'frames'

export interface SolidsHandle {
  setVariant(v: SolidVariant): void
  /** 每帧调用 / per frame */
  update(dt: number, camZ: number, boost: number): void
  dispose(): void
}

const SPAN = 3600 // 循环深度 / recycle depth
/* 淡入区间拉近。实测原本 3050→2350 时整帧均值只有 10-12：雾密度 0.00034 在
   2350 处已经把亮度压到 0.63、在 3050 处压到 0.35，实体还没亮起来就已经被雾
   吃掉大半。拉近之后它们在明显更近、雾更薄的位置才出现。
   The fade-in band moves closer. At 3050 to 2350 the frame mean measured only
   10-12: a fog density of 0.00034 already cuts to 0.63 at 2350 and 0.35 at 3050,
   so the solids were being eaten by haze before they had finished appearing.
   Closer in, they arrive where the air is thinner. */
const FADE_IN_FAR = 2450
const FADE_IN_NEAR = 1850
const FADE_OUT_FAR = 620
const FADE_OUT_NEAR = 240

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

/* 确定性伪随机：背景不该每次刷新长得不一样，可复现才谈得上逐项核对。
   Deterministic: the backdrop should not differ per reload, and only a
   reproducible field can be verified. */
function lcg(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

export function createBackdropSolids(
  THREE: typeof import('three'),
  renderer: TH.WebGLRenderer,
  scene: TH.Scene,
  camera: TH.PerspectiveCamera,
  opts: { lowPower: boolean }
): SolidsHandle {
  /* ══ 暗棚环境 ══
     体积的来源之一。fromScene 的第四个参数 far 必须显式给：默认远裁剪面只有
     100，而灯板在 300-600 之外，用默认值会被整体裁掉，金属渲染成纯黑。这个坑
     在手机机身那一版踩过，实测平均亮度 0.7、99.8% 的像素落在 0-31 区间。
     One source of the volume. fromScene's fourth argument, far, must be passed:
     it defaults to 100 while these panels sit 300-600 out, so the default clips
     them all and the metal renders black - already hit once on the phone body,
     which measured an average luminance of 0.7 with 99.8% of pixels in 0-31. */
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
  panel(420, 320, [2.6, 2.7, 3.1], -300, 240, 140, Math.PI / 3.4)
  panel(70, 620, [2.4, 2.4, 2.8], 340, 60, 80, -Math.PI / 2.6)
  panel(520, 200, [1.0, 0.62, 2.4], 40, -300, 160, 0)
  panel(900, 520, [1.0, 1.02, 1.25], 0, 280, 520, 0)

  const pmrem = new THREE.PMREMGenerator(renderer)
  const envRT = pmrem.fromScene(envScene, 0.04, 0.1, 2000)
  envScene.traverse((o) => {
    const m = o as { geometry?: { dispose(): void }; material?: { dispose(): void } }
    m.geometry?.dispose()
    m.material?.dispose()
  })
  const env = envRT.texture

  /* 纯环境反射对平板不成立：镜面平板正对相机只反射机位背后那块补光，实测整块
     板均值 1、峰值全在一两个边缘像素上。补三盏真实的灯，让实体靠明暗梯度立起来。
     Pure environment reflection fails for flat plates - a mirror plate facing the
     lens reflects only the fill behind it, measuring a mean of 1 with its peak
     confined to an edge pixel. Three real lights let volume live on a gradient. */
  scene.add(new THREE.AmbientLight(0x272730, 1.4))
  const key = new THREE.DirectionalLight(0xffffff, 1.7)
  key.position.set(-320, 420, 640)
  scene.add(key)
  const rim = new THREE.DirectionalLight(0x8b6cff, 0.62)
  rim.position.set(420, -240, 220)
  scene.add(rim)

  const groups: Record<Exclude<SolidVariant, 'none'>, TH.Group> = {
    bars: new THREE.Group(),
    panels: new THREE.Group(),
    frames: new THREE.Group(),
  }
  Object.values(groups).forEach((g) => {
    g.visible = false
    scene.add(g)
  })

  /* ══ 正文禁区 ══
     hero 文案列实测占视口 x 7-33.3% / y 50-78.6%。流过来的实体一律不得落进去：
     背景元素压在正文上是噪点，不是设计。
     判定只需在**淡入距离**上做一次：实体沿 z 直线前移，屏幕位置只会由中心向外
     发散，所以淡入那一刻是它整个可见期里离画面中心最近的时刻。那一刻在框外，
     此后必然在框外——一次判定覆盖整段行程。
     The hero copy column measures 7-33.3% by 50-78.6% of the viewport and nothing
     may stream into it. The test only has to run once, at the fade-in distance:
     objects travel straight along z so their screen position only ever spreads
     outward from centre, making fade-in the closest to centre they will ever be.
     Clear there means clear for the whole pass - one test covers the journey. */
  const COPY = { l: 0.055, r: 0.35, t: 0.48, b: 0.8 }
  /* 判定必须按实体的**投影半径**留边，不能只判中心点。上一版只判点，结果立柱
     与方框仍分别有 6 和 17 的亮度落进文案列——一根 900 高的立柱中心在框外，
     它的上下端照样伸进去。
     The test must allow for the solid's PROJECTED RADIUS rather than testing its
     centre alone. Testing the point left the columns and frames putting luminance
     of 6 and 17 into the copy column: a 900-tall column can have its centre
     outside the box and its ends still reach in. */
  /* 分轴留边，而且直接在**屏幕空间**撒点。
     上一版用包围球半径同时作横纵留边，结果是灾难：一根 900 高的立柱球半径 470，
     在 1850 的淡入距离上换算成 42% 的屏幕高度，判定于是把所有立柱都推出画面，
     实测覆盖率从 6.2% 塌到 0——它们全在视锥外飞过去了。
     纵向半高不该拿来当横向留边。而且只要横向完全避开文案列，纵向再高也压不到
     正文，所以横向用半宽、纵向用半高，两个条件独立成立即可。
     Per-axis margins, sampled directly in SCREEN space. The previous version used
     one bounding-sphere radius for both axes, which was catastrophic: a 900-tall
     column has a sphere radius of 470, which at the 1850 fade-in distance is 42%
     of the screen height, so the test pushed every column out of frame and
     coverage collapsed from 6.2% to 0 - they were all flying past outside the
     frustum. A vertical half-height has no business as a horizontal margin, and
     clearing the copy column horizontally is sufficient on its own no matter how
     tall the object is. */
  const halfExtent = (dist: number) => {
    const tanV = Math.tan((camera.fov * Math.PI) / 360)
    return { hw: dist * tanV * camera.aspect, hh: dist * tanV }
  }
  const clearsCopy = (sx: number, sy: number, mx: number, my: number) =>
    sx + mx < COPY.l || sx - mx > COPY.r || sy - my > COPY.b

  interface Item {
    mesh: TH.Mesh
    mat: TH.MeshPhysicalMaterial
    baseOp: number
    spin: number
  }
  const items: Item[] = []

  const mkMat = (color: number, rough: number, op: number) =>
    new THREE.MeshPhysicalMaterial({
      color,
      /* 金属度 0.25 而不是 1：全金属没有漫反射分量，平板就只剩镜面那一条细线。
         留七成漫反射，明暗梯度才有载体；也更贴合本站「颜料，不是光」的取向。
         Metalness 0.25 rather than 1: fully metallic leaves a flat plate with
         nothing but a specular sliver. Seventy percent diffuse gives the shading
         gradient something to live on, and sits closer to the site's stance. */
      metalness: 0.25,
      roughness: rough,
      clearcoat: 0.4,
      clearcoatRoughness: 0.3,
      envMap: env,
      envMapIntensity: opts.lowPower ? 1.6 : 2.4,
      transparent: true,
      opacity: op,
      depthWrite: false,
    })

  /* 拒绝采样：随机撒点，落进正文禁区就重摇。上限 40 次防病态输入死循环。
     Rejection sampling with a 40-try cap so a pathological case cannot spin. */
  /* 在淡入平面的屏幕坐标里撒点，再换算回世界坐标——这样每个实体一定在视锥内
     出现，不会像上一版那样在画面外飞过去。允许 15% 的出画余量，让它们可以从
     边缘外侧切进来。
     Sampled in screen coordinates on the fade-in plane and converted back to
     world, which guarantees every solid appears inside the frustum instead of
     sailing past outside it as before. A 15% overscan lets them cut in from just
     beyond the edge. */
  const place = (rnd: () => number, halfW: number, halfH: number) => {
    const { hw, hh } = halfExtent(FADE_IN_NEAR)
    const mx = halfW / (2 * hw)
    const my = halfH / (2 * hh)
    for (let i = 0; i < 40; i++) {
      const sx = -0.15 + rnd() * 1.3
      const sy = -0.15 + rnd() * 1.3
      if (!clearsCopy(sx, sy, mx, my)) continue
      return { x: (sx - 0.5) * 2 * hw, y: (0.5 - sy) * 2 * hh }
    }
    return { x: hw * 0.7, y: -hh * 0.6 }
  }

  const build = (
    kind: Exclude<SolidVariant, 'none'>,
    count: number,
    seed: number,
    geoFor: (rnd: () => number) => TH.BufferGeometry,
    colorFor: (rnd: () => number) => number,
    op: number
  ) => {
    const rnd = lcg(seed)
    for (let i = 0; i < count; i++) {
      const geo = geoFor(rnd)
      geo.computeBoundingBox()
      const bb = geo.boundingBox
      const halfW = bb ? (bb.max.x - bb.min.x) / 2 : 120
      const halfH = bb ? (bb.max.y - bb.min.y) / 2 : 300
      const mat = mkMat(colorFor(rnd), 0.36 + rnd() * 0.16, op)
      const mesh = new THREE.Mesh(geo, mat)
      mesh.userData.halfW = halfW
      mesh.userData.halfH = halfH
      const p = place(rnd, halfW, halfH)
      mesh.position.set(p.x, p.y, -(SPAN * (i + rnd() * 0.6)) / count)
      mesh.rotation.set(rnd() * 0.5 - 0.25, rnd() * 0.9 - 0.45, rnd() * 0.4 - 0.2)
      groups[kind].add(mesh)
      items.push({ mesh, mat, baseOp: op, spin: (rnd() - 0.5) * 0.06 })
    }
  }

  /* bars 立柱：细长竖条掠过两侧，最接近「穿过廊柱」的读法，速度感最强。
     Slender columns sweeping past on both sides - the closest reading to passing
     through a colonnade, and the strongest sense of speed. */
  build(
    'bars',
    18,
    77001,
    (rnd) => {
      const g = new THREE.ExtrudeGeometry(roundedRect(THREE, 52 + rnd() * 34, 420 + rnd() * 520, 12), {
        depth: 52,
        bevelEnabled: true,
        bevelThickness: 4,
        bevelSize: 4,
        bevelSegments: 2,
      })
      g.center()
      return g
    },
    (rnd) => (rnd() > 0.76 ? 0x62509b : 0x74747f),
    0.85
  )

  /* panels 板片：宽而薄的板，像掠过的幕墙，比立柱安静。
     Wide thin panels like a passing curtain wall, quieter than the columns. */
  build(
    'panels',
    14,
    88002,
    (rnd) => {
      const g = new THREE.ExtrudeGeometry(roundedRect(THREE, 340 + rnd() * 420, 180 + rnd() * 160, 18), {
        depth: 26,
        bevelEnabled: true,
        bevelThickness: 3,
        bevelSize: 3,
        bevelSegments: 2,
      })
      g.center()
      return g
    },
    (rnd) => (rnd() > 0.78 ? 0x5d4f85 : 0x76767f),
    0.8
  )

  /* frames 方框：描边实体环，一个个从旁边掠过——最有「一段一段推进」的节奏。
     Solid outline rings sweeping past, the most sectioned, step-by-step rhythm. */
  build(
    'frames',
    12,
    99003,
    (rnd) => {
      const w = 300 + rnd() * 340
      const h = w * (0.62 + rnd() * 0.5)
      const outer = roundedRect(THREE, w, h, 22)
      outer.holes.push(roundedRect(THREE, w - 46, h - 46, 12))
      const g = new THREE.ExtrudeGeometry(outer, {
        depth: 40,
        bevelEnabled: true,
        bevelThickness: 3,
        bevelSize: 3,
        bevelSegments: 2,
      })
      g.center()
      return g
    },
    (rnd) => (rnd() > 0.7 ? 0x6a58a3 : 0x74747f),
    0.88
  )

  let current: SolidVariant = 'none'
  const setVariant = (v: SolidVariant) => {
    current = v
    ;(Object.keys(groups) as Exclude<SolidVariant, 'none'>[]).forEach((k) => {
      groups[k].visible = k === v
    })
  }

  /* 基础速度：世界单位 / 秒。在 2000 距离上画面宽约 1950 单位，200/s 意味着
     大约 18 秒走完整个循环深度——快到读得出在前进，慢到不抢主体。
     Base speed in world units per second. The frame is about 1950 units wide at a
     distance of 2000, so 200/s crosses the full recycle depth in roughly 18
     seconds: fast enough to read as travelling, slow enough not to grab focus. */
  const SPEED = 200
  const rndRe = lcg(123457)

  const update = (dt: number, camZ: number, boost: number) => {
    if (current === 'none') return
    const step = SPEED * (1 + boost) * dt
    const g = groups[current as Exclude<SolidVariant, 'none'>]
    for (const it of items) {
      if (it.mesh.parent !== g) continue
      it.mesh.position.z += step
      it.mesh.rotation.z += it.spin * dt
      /* 掠过相机就回到远端，并重新摇一个位置——固定轨迹会让循环被一眼看出来。
         Recycled past the lens with a fresh position; a fixed track would make the
         loop obvious. */
      if (it.mesh.position.z > camZ + 320) {
        it.mesh.position.z -= SPAN
        const p = place(rndRe, (it.mesh.userData.halfW as number) ?? 120, (it.mesh.userData.halfH as number) ?? 300)
        it.mesh.position.x = p.x
        it.mesh.position.y = p.y
      }
      const d = camZ - it.mesh.position.z
      let a = 1
      if (d > FADE_IN_NEAR) a = (FADE_IN_FAR - d) / (FADE_IN_FAR - FADE_IN_NEAR)
      else if (d < FADE_OUT_FAR) a = (d - FADE_OUT_NEAR) / (FADE_OUT_FAR - FADE_OUT_NEAR)
      a = Math.max(0, Math.min(1, a))
      it.mat.opacity = it.baseOp * a
      it.mesh.visible = a > 0.01
    }
  }

  return {
    setVariant,
    update,
    dispose() {
      envRT.dispose()
      pmrem.dispose()
      Object.values(groups).forEach((gr) => {
        gr.traverse((o) => {
          const m = o as { geometry?: { dispose(): void }; material?: { dispose(): void } }
          m.geometry?.dispose()
          m.material?.dispose()
        })
        scene.remove(gr)
      })
      items.length = 0
    },
  }
}
