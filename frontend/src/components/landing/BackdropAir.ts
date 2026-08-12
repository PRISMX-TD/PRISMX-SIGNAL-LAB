// 背景大气 / the backdrop as atmosphere
//
// ════════════════════════════════════════════════════════════════════════════
// 第十轮。前九轮按缺的那一样东西可以归成四类：
//   光的分布  网格 / 扫光 / 地平线 / 光幕     —— 没有东西，只有亮度落在哪
//   平面图形  棱镜线稿 / 标尺 / 数字 / K 线   —— 有东西，但描边平涂，没有体积
//   静止实体  玻璃棱镜 / 金属板 / 阶梯台地    —— 有体积，但不往前走
//   流动实体  立柱 / 板 / 方框                —— 会往前走，但物件本身没有意义
//
// 这一轮换的是层级：不再往空间里**放东西**，而是让**空间本身**成为内容，
// 手段选定为大气透视。
//
// 关键的一点必须写在最前面，否则实现方向会错：**雾是修饰，不是内容**。
// scene.fog 只在有几何体的地方生效，空场景里加多少雾都是纯黑。而且大气透视
// 本质上是一个**比较**线索——它靠"同一种东西在不同距离上一层比一层淡"来传达
// 距离。什么都没有的时候，它什么也传达不了。
//
// 所以这里让空气本身有浓淡：一批极柔的雾体分布在纵深里，近的大而清、远的小而
// 淡，彼此遮挡。相机前推时近雾比远雾移动得快——视差与遮挡这两条硬线索都到位，
// 而它们全部由"空气"承担，没有一个可被叫出名字的物件。上一轮被认可的"行进感"
// 也因此保留：动的是空气，不是漂浮的东西。
//
// Round ten. The previous nine group by what each was missing: distributions of
// light that place nothing; flat graphics with no volume; static solids that do
// not travel; and travelling solids whose objects meant nothing. This round
// changes level: rather than placing things in the space, the space itself
// becomes the content, via atmospheric perspective.
//
// One point has to lead, or the implementation goes wrong: FOG IS A MODIFIER,
// NOT CONTENT. scene.fog only acts where geometry already is, so any amount of it
// in an empty scene is still black. And atmospheric perspective is fundamentally
// a COMPARISON cue - it conveys distance by showing the same kind of thing
// getting fainter with range. With nothing there, it conveys nothing.
//
// So the air itself is given density variation: very soft masses distributed
// through depth, near ones large and defined, far ones small and faint, occluding
// one another. As the camera pushes forward the near air moves faster than the
// far - parallax and occlusion, the two hard depth cues, both carried by the
// atmosphere rather than by any nameable object. The forward motion approved last
// round survives: what moves is the air, not floating things.
// ════════════════════════════════════════════════════════════════════════════

import type * as TH from 'three'

export type AirVariant = 'none' | 'masses' | 'strata'

export interface AirHandle {
  setVariant(v: AirVariant): void
  /** 每帧调用 / per frame */
  update(t: number, camZ: number): void
  dispose(): void
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

/* ══ 正文禁区 ══
   hero 文案列实测占视口 x 5.5-35% / y 48-80%。雾体是柔边的，不像实体那样有明确
   轮廓，但它抬高的是**背景亮度**，压在正文后面同样吃对比度。所以照样避开：
   横向完全让开这一列，纵向不限（雾在文案上下方铺开反而更像空气）。
   The hero copy column measures 5.5-35% by 48-80% of the viewport. Haze has soft
   edges rather than a hard silhouette, but what it raises is the BACKGROUND
   LUMINANCE, which eats contrast behind type just the same. So it clears the
   column horizontally; vertically it is unconstrained, since air spreading above
   and below the copy reads more like air, not less.
   柔边意味着没有可判定的轮廓，所以这里不做几何判定，改由像素探针直接量文案区
   的峰值亮度——雾体的位置是手放的，验证靠实测。
   Soft edges mean there is no silhouette to test geometrically, so placement is
   by hand and verification is by measuring the peak luminance inside the copy box
   directly. */
export function createBackdropAir(
  THREE: typeof import('three'),
  scene: TH.Scene,
  camera: TH.PerspectiveCamera
): AirHandle {
  /* 雾体贴图：一团中心浓、边缘化开的柔斑，逐像素掺确定性抖动去色带。
     低透明度的平滑渐变在 8 位显示器上必然出现色带，而雾恰恰全是低透明度渐变。
     The haze texture: a soft mass, dense at the centre and dissolving at the rim,
     with deterministic per-pixel dither against banding - smooth low-alpha
     gradients band visibly on 8-bit displays and haze is nothing but those. */
  const S = 128
  const c = document.createElement('canvas')
  c.width = S
  c.height = S
  const g2 = c.getContext('2d')
  let tex: TH.Texture | null = null
  if (g2) {
    const img = g2.createImageData(S, S)
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const d = Math.hypot((x + 0.5) / S - 0.5, (y + 0.5) / S - 0.5) * 2
        const f = Math.max(0, 1 - d)
        /* 三次方衰减而不是线性：雾团必须没有可辨认的边。线性衰减在边缘留下一道
           可见的圆弧，观众立刻读成"一个圆形贴图"，而不是空气。
           A cubic falloff rather than linear: a haze mass must have no discernible
           edge. Linear leaves a visible arc at the rim that reads immediately as
           "a circular sprite" rather than as air. */
        const a = f * f * f * 255
        const h = ((x * 73856093) ^ (y * 19349663)) >>> 0
        const i = (y * S + x) * 4
        img.data[i] = 255
        img.data[i + 1] = 255
        img.data[i + 2] = 255
        img.data[i + 3] = Math.max(0, Math.min(255, Math.round(a + ((h % 5) - 2))))
      }
    }
    g2.putImageData(img, 0, 0)
    tex = new THREE.CanvasTexture(c)
    tex.colorSpace = THREE.SRGBColorSpace
  }

  const groups: Record<Exclude<AirVariant, 'none'>, TH.Group> = {
    masses: new THREE.Group(),
    strata: new THREE.Group(),
  }
  Object.values(groups).forEach((g) => {
    g.visible = false
    scene.add(g)
  })

  interface Puff {
    m: TH.Mesh
    baseX: number
    baseY: number
    z: number
    drift: number
    phase: number
    billboard: boolean
  }
  const puffs: Record<Exclude<AirVariant, 'none'>, Puff[]> = { masses: [], strata: [] }

  /* 雾色比页面底色略亮一点点。正常混合，不用 additive——叠加混合会让重叠处越叠
     越亮，那就是辉光，与本站「颜料，不是光」的禁令直接冲突；正常混合的重叠只是
     更不透明，读起来才是更浓的空气。
     The haze colour sits a shade above the page background. Normal blending, never
     additive: additive makes overlaps brighter and brighter, which is glow and
     collides head-on with the site's pigment-not-light rule, whereas overlapping
     under normal blending simply reads as denser air. */
  /* 雾色与不透明度是算出来的，不是试出来的。合成结果 = 底色 + o × (雾色亮度 −
     底色)。第一版取 0x1b1b26（亮度 27）× 0.19，代入就是 9 + 0.19×18 ≈ 12，实测
     峰值 5——比页面底色 9 高不了几级，等于没画。
     要让近处的雾团落在 30-50 的亮度上（与之前被认可过存在感的地面扫光同级），
     雾色必须提到 0x4e4e66（亮度 80）、不透明度提到 0.40：9 + 0.40×71 ≈ 37，
     两团重叠约 53，再被雾按距离压下去——这样近浓远淡的层次才拉得开。
     The haze colour and opacity are derived, not guessed. The composite is
     background plus o times the difference in luminance. The first pass used
     0x1b1b26 at luminance 27 with o=0.19, which works out to about 12 and measured
     a peak of 5 - a handful of levels above the page's own 9, so effectively
     unpainted. For near masses to land at 30-50, on par with the floor sweep that
     did read as present, the colour has to rise to 0x4e4e66 at luminance 80 with
     o=0.40: about 37 for one mass and 53 where two overlap, then pushed back down
     with range by the fog. That spread is what makes near-dense and far-faint read. */
  const mat = (opacity: number, color: number) =>
    new THREE.MeshBasicMaterial({
      map: tex,
      color,
      transparent: true,
      opacity,
      depthWrite: false,
      blending: THREE.NormalBlending,
      fog: true,
    })

  const add = (
    kind: Exclude<AirVariant, 'none'>,
    w: number,
    h: number,
    x: number,
    y: number,
    z: number,
    opacity: number,
    color: number,
    billboard: boolean,
    drift: number,
    phase: number
  ) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat(opacity, color))
    m.position.set(x, y, z)
    m.renderOrder = -1
    groups[kind].add(m)
    puffs[kind].push({ m, baseX: x, baseY: y, z, drift, phase, billboard })
  }

  /* ══ masses：浓淡不匀的雾体 ══
     十四团柔斑铺在 -300 到 -3600 的纵深里，近的大而略清、远的小而淡。相机前推
     时近团比远团扫过画面快得多，视差就是纵深。横向一律避开文案列。
     Fourteen soft masses spread from -300 to -3600, the near ones larger and a
     shade more defined, the far ones smaller and fainter. As the camera advances
     the near masses sweep across frame far faster than the far ones, and that
     parallax IS the depth. All of them clear the copy column horizontally. */
  {
    const rnd = lcg(77213)
    for (let i = 0; i < 14; i++) {
      const t = i / 13
      const z = -300 - t * 3300
      // 近处的团放在画面右半与下方，远处的可以居中——远处本来就在文案列之外的
      // 视觉深度上，且已被雾压得很淡
      const side = rnd() > 0.42 ? 1 : -1
      const spread = 620 + t * 1500
      const x = side > 0 ? 340 + rnd() * spread : -900 - rnd() * spread * 0.6
      const y = -420 + rnd() * 900 - t * 160
      const size = 900 + t * 1900 + rnd() * 500
      /* 探针改用 sRGB 读回之后重新标定：0.40 不透明度 × 0x4e4e66 实测近处峰值
         只有 28。提到 0.62 × 0x60607c，近处落在 55-70，与雾层拉开层次。
         Recalibrated once the probe read back in sRGB: 0.40 opacity against
         0x4e4e66 measured a near peak of only 28. At 0.62 against 0x60607c the
         near masses land at 55-70 and separate properly from the far ones. */
      const op = 0.62 - t * 0.3 + rnd() * 0.06
      const violet = rnd() > 0.72
      add('masses', size, size * (0.62 + rnd() * 0.3), x, y, z, op, violet ? 0x584a8c : 0x60607c, true, 14 + rnd() * 22, rnd() * 6.28)
    }
  }

  /* ══ strata：分层的雾 ══
     风景画传达纵深的老办法：同一种东西一层比一层高、一层比一层淡。七道横贯的
     雾带铺在纵深里，越远越高越淡——不需要任何物件，层次本身就是距离。
     The landscape painter's method: the same thing, each layer higher and fainter
     than the last. Seven bands across the depth, rising and fading with range - no
     object required, the stratification itself is the distance. */
  {
    const rnd = lcg(51907)
    for (let i = 0; i < 7; i++) {
      const t = i / 6
      const z = -400 - t * 3200
      const y = -560 + t * 620
      const w = 3200 + t * 4200
      const h = 420 + t * 520
      const op = 0.6 - t * 0.3
      add('strata', w, h, 260 + rnd() * 300, y, z, op, i === 3 ? 0x584a8c : 0x60607c, false, 9 + rnd() * 12, rnd() * 6.28)
    }
  }

  let current: AirVariant = 'none'
  const setVariant = (v: AirVariant) => {
    current = v
    ;(Object.keys(groups) as Exclude<AirVariant, 'none'>[]).forEach((k) => {
      groups[k].visible = k === v
    })
  }

  const update = (t: number, camZ: number) => {
    if (current === 'none') return
    for (const p of puffs[current]) {
      /* 极慢横向漂移。空气不该静止，但也绝不该被看出在"动"——一旦能数出速度，
         它就变回了漂浮的物件，那正是这一轮要去掉的东西。
         A very slow lateral drift. Air should never be still, and equally never be
         seen to MOVE: the moment its speed can be counted it becomes a floating
         object again, which is exactly what this round removes. */
      p.m.position.x = p.baseX + Math.sin(t * 0.045 + p.phase) * p.drift
      p.m.position.y = p.baseY + Math.cos(t * 0.031 + p.phase) * p.drift * 0.5
      /* 循环：相机一路前推，雾必须回收，否则滚到页面下半段身后就空了。
         按相机位置取模而不是按时间，任何滚动速度下密度都一致。
         Recycling: the camera advances the whole way, so the haze must wrap or the
         lower half of the page ends up behind nothing. Keyed to camera position
         rather than to time, so density holds at any scroll speed. */
      const SPAN = 3800
      let z = p.z
      const rel = z - camZ
      if (rel > 400) z -= SPAN * Math.ceil((rel - 400) / SPAN)
      else if (rel < -3800) z += SPAN * Math.ceil((-3800 - rel) / SPAN)
      p.m.position.z = z
      if (p.billboard) p.m.quaternion.copy(camera.quaternion)
    }
  }

  return {
    setVariant,
    update,
    dispose() {
      tex?.dispose()
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
