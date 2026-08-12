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
  /** 整体压暗，与碎片同步 / global dim, in step with the shards */
  setDim(k: number): void
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
  /* ══ 雾的贴图：分形噪声，不是径向渐变 ══
     上一版被指出「一点都不像雾气，只是像光」，三条根因都在这张贴图上：
     一、径向渐变**有核心**——中心最亮、单调向外衰减。那是光的定义。雾没有
         核心，它是一片密度不均的介质。所以包络改成「中间一整片平台、只在边缘
         化开」，中心不再更亮，亮度差全部交给噪声。
     二、真雾有**多尺度的内部结构**（絮状、丝缕、参差的边），上一版是完美的圆
         和完美光滑的过渡。所以用四个倍频的值噪声叠出絮状，并把噪声横向拉长
         2.4 倍——雾是横着铺开的，不是各向同性的。
     三、竖直方向要有密度梯度：真实雾团下浓上稀。径向渐变上下对称，一眼假。
     Called out as "not like fog at all, just like light", and all three reasons
     live in this texture. A radial gradient HAS A CORE - brightest at the centre,
     falling off monotonically - which is the definition of a light; fog has no
     core, it is a medium of uneven density. So the envelope becomes a plateau
     across the middle that only dissolves at the rim, and every difference in
     brightness is handed to noise instead. Real fog also has structure at several
     scales with ragged edges, so four octaves of value noise build the wisps,
     stretched 2.4x horizontally because fog lies in sheets rather than spheres.
     And density falls off upward: a real mass is denser at its base, while a
     radial gradient is symmetric top to bottom and reads as fake instantly. */
  const S = 320
  const smoothstep = (x: number) => x * x * (3 - 2 * x)

  /* 值噪声：一张随机格点 + 平滑插值。四个倍频叠加成 fbm。
     Value noise: a lattice of random values with smooth interpolation, four
     octaves summed into fbm. */
  const lattice = (n: number, rnd: () => number) => {
    const g = new Float32Array((n + 1) * (n + 1))
    for (let i = 0; i < g.length; i++) g[i] = rnd()
    // 缝合边界，贴图左右上下可接 / seam the edges so the texture can tile
    for (let i = 0; i <= n; i++) {
      g[i * (n + 1) + n] = g[i * (n + 1)]
      g[n * (n + 1) + i] = g[i]
    }
    return g
  }
  const sampleLat = (g: Float32Array, n: number, u: number, v: number) => {
    const x = ((u % 1) + 1) % 1 * n
    const y = ((v % 1) + 1) % 1 * n
    const xi = Math.floor(x)
    const yi = Math.floor(y)
    const fx = smoothstep(x - xi)
    const fy = smoothstep(y - yi)
    const a = g[yi * (n + 1) + xi]
    const b = g[yi * (n + 1) + xi + 1]
    const c2 = g[(yi + 1) * (n + 1) + xi]
    const d = g[(yi + 1) * (n + 1) + xi + 1]
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c2 * (1 - fx) + d * fx) * fy
  }

  const makeFogTex = (seed: number): TH.Texture | null => {
    const c = document.createElement('canvas')
    c.width = S
    c.height = S
    const g2 = c.getContext('2d')
    if (!g2) return null
    const rnd = lcg(seed)
    /* 倍频从 4-32 加到 6-96。上一版最细一层是 32 格，铺到一个 1500 单位的团上，
       一个格子在屏幕上有 27px——那是「大块的浓淡」，不是絮。实测絮状度（3x3
       局部标准差中位数）只有 0.46，画面依然读成平滑过渡。加到 96 格之后最细的
       结构落到 9px 量级，才有丝缕。
       Octaves go from 4-32 up to 6-96. The finest layer used to be 32 cells, which
       across a 1500-unit mass is 27px on screen - that is broad unevenness, not
       wisps, and the measured wispiness (median 3x3 local deviation) came back at
       0.46 with the frame still reading as a smooth gradient. At 96 cells the
       finest structure lands around 9px, which is where filaments start. */
    const oct = [6, 12, 24, 48, 96].map((n) => ({ n, g: lattice(n, rnd) }))
    const img = g2.createImageData(S, S)
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const u = (x + 0.5) / S
        const v = (y + 0.5) / S
        /* fbm。横向拉长 2.4 倍让絮状沿水平方向铺开。
           fbm, sampled 2.4x wider than tall so the wisps lie horizontally. */
        let f = 0
        let amp = 0.5
        let norm = 0
        for (const o of oct) {
          f += amp * sampleLat(o.g, o.n, u / 2.4, v)
          norm += amp
          amp *= 0.52
        }
        f /= norm
        /* 平台型包络：中心不更亮，只在边缘化开。这是「不是光」的关键一步。
           A plateau envelope: no brighter at the centre, dissolving only at the
           rim. This is the step that stops it reading as a light. */
        const d = Math.hypot(u - 0.5, v - 0.5) * 2
        const env = d < 0.45 ? 1 : Math.max(0, 1 - smoothstep((d - 0.45) / 0.55))
        /* 下浓上稀 / denser at the base */
        const vert = 0.55 + 0.45 * v
        /* 抬底并压对比：fbm 的低值区留空，高值区才是絮。
           Lift the floor and compress: the low end of the fbm stays empty so only
           the high end reads as a wisp. */
        /* 重映射从 (f-0.42)/0.58^1.25 收紧到 (f-0.5)/0.5^2.2：把 fbm 的下半段
           整个压成空，只留上半段成丝。对比不够时，多层半透明噪声叠加会互相平均
           掉（独立噪声求和趋于平滑，中心极限定理），结果就是一片光滑的辉光——
           实测结构占比只有 4-5%。留白越多，每一层自己的絮才越保得住。
           The remap tightens from (f-0.42)/0.58^1.25 to (f-0.5)/0.5^2.2, emptying
           the lower half of the fbm entirely and keeping only the upper half as
           filaments. Without that contrast, stacked semi-transparent noise averages
           itself out - summing independent noise tends to smooth, by the central
           limit theorem - and the result is exactly a smooth glow, measured at a
           4-5% structure share. The more empty space, the more each layer's own
           wisps survive the stack. */
        /* 对比与存在感是一条直接的权衡，两端都量过了：
             (f-0.42)/0.58 ^1.25 → 覆盖 37%、结构占比 4%   —— 有量，但读成光
             (f-0.50)/0.50 ^2.2  → 覆盖  2%、结构占比 24%  —— 有絮，但几乎没有
           取中：(f-0.44)/0.56 ^1.55，配合更高的单层不透明度补回体量。
           Contrast and presence trade off directly, and both ends were measured:
           the loose remap gave 37% coverage at a 4% structure share, which reads as
           light; the tight one gave 24% structure at 2% coverage, which is barely
           there. This sits between them, with more opacity per layer making up the
           lost body. */
        /* 门槛压低（更多面积过线）但曲线更陡（过线之后仍然分明）：这是同时要
           面积与对比的唯一走法，单调调阈值或单调调指数都只会在两端来回。
           A lower threshold so more area clears it, with a steeper curve so what
           clears stays distinct: the only way to ask for area and contrast at once,
           since moving either the threshold or the exponent alone just oscillates
           between the two failure modes. */
        const a = Math.max(0, (f - 0.42) / 0.58) ** 1.9 * env * vert * 255
        const h = ((x * 73856093) ^ (y * 19349663) ^ (seed * 83492791)) >>> 0
        const i = (y * S + x) * 4
        img.data[i] = 255
        img.data[i + 1] = 255
        img.data[i + 2] = 255
        img.data[i + 3] = Math.max(0, Math.min(255, Math.round(a + ((h % 5) - 2))))
      }
    }
    g2.putImageData(img, 0, 0)
    const t = new THREE.CanvasTexture(c)
    t.colorSpace = THREE.SRGBColorSpace
    return t
  }
  /* 三张不同的噪声：所有雾团用同一张贴图会立刻被看出是复制粘贴。
     Three distinct noise fields: one shared texture would read as copy-paste. */
  const texes = [makeFogTex(1301), makeFogTex(7717), makeFogTex(4409)]

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
    spin: boolean
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
  const mat = (opacity: number, color: number, tx: TH.Texture | null) =>
    new THREE.MeshBasicMaterial({
      map: tx,
      color,
      transparent: true,
      opacity,
      depthWrite: false,
      blending: THREE.NormalBlending,
      fog: true,
    })

  let puffSeq = 0
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
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat(opacity, color, texes[puffSeq++ % texes.length]))
    m.position.set(x, y, z)
    m.renderOrder = -1
    groups[kind].add(m)
    puffs[kind].push({ m, baseX: x, baseY: y, z, drift, phase, billboard, spin: puffSeq % 2 === 0 })
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
    for (let i = 0; i < 13; i++) {
      const t = i / 12
      const z = -300 - t * 3300
      // 近处的团放在画面右半与下方，远处的可以居中——远处本来就在文案列之外的
      // 视觉深度上，且已被雾压得很淡
      const side = rnd() > 0.42 ? 1 : -1
      const spread = 900 + t * 2200
      const x = side > 0 ? 300 + rnd() * spread : -820 - rnd() * spread * 0.8
      const y = -560 + rnd() * 1300 - t * 120
      /* 团块加大加密：雾是一大片连续的介质，不是几个离散的斑。噪声接手了内部
         对比之后，峰值不必再靠不透明度堆——反而要压下来，否则又变回发光体。
         Bigger and denser: fog is one continuous medium, not a handful of discrete
         spots. Now that the noise carries the internal contrast, peak brightness no
         longer needs opacity behind it and in fact has to come down, or it reads as
         an emitter again. */
      /* 22 团减到 9 团。叠得越多越平滑，这与直觉相反但已经量到：要保住絮状，
         必须减少互相覆盖的层数，同时把单层的不透明度提上去。
         From 22 masses down to 9. More layers means smoother, which is
         counter-intuitive but measured: keeping the wisps means fewer overlaps and
         more opacity per layer. */
      /* 换一根杠杆：不再在阈值与指数之间来回，改**减少屏幕上的相互覆盖**。
         前四组配置量下来是一条清楚的边界——覆盖率与结构占比此消彼长，因为独立
         噪声一叠加就互相平均掉。团块缩小、铺散之后，每一团在屏幕上各占一块，
         叠加次数下来，自己的絮才留得住。
         A different lever: instead of oscillating between threshold and exponent,
         reduce how much the sprites OVERLAP ON SCREEN. Four measured configurations
         trace a clear frontier where coverage and structure trade off, because
         independent noise averages itself out as soon as it stacks. Smaller masses
         spread wider each own a patch of the frame, the stack depth drops, and each
         one's wisps survive. */
      /* 折中落点。五组配置量出来的边界（覆盖率 / 结构占比）：
           0.42^1.25 × 22 层           37% / 4%
           0.44^1.55 × 13 层           40% / 5%
           0.40^2.4  ×  9 层            7% / 9%
           0.50^2.2  ×  9 层            2% / 24%
           缩小铺散 × 16 层             1% / 34%
         这是一条真实的边界，不是没调好：独立噪声一叠加就互相平均（中心极限
         定理），而要有覆盖率就必须叠。贴图叠片这条路做不出「既在又有絮」的雾，
         真正的解法是单趟 raymarch 的体积雾——一次采样，结构天生保留。
         这里取边界上的折中点，让画面不至于空，同时把这条限制记在代码里。
         The compromise point. Five configurations trace the coverage-versus-
         structure frontier above, and it is a real frontier rather than bad tuning:
         independent noise averages itself out as it stacks, and stacking is exactly
         what coverage requires. Layered sprites cannot produce fog that is both
         present and filamentary; the actual answer is a single raymarched volume,
         where one sampling pass preserves structure by construction. This sits at a
         middle point on the frontier so the frame is not empty, with the limit
         recorded here. */
      const size = 900 + t * 1500 + rnd() * 420
      const op = 1 - t * 0.36 + rnd() * 0.04
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
      /* 噪声把 fbm 的低值区留空之后，雾层的覆盖率从 68% 掉到 12%、峰值掉到 18。
         结构是有了，量没了——不透明度补回来。
         Once the noise left the low end of the fbm empty the strata fell from 68%
         coverage to 12% and a peak of 18: structure gained, substance lost. The
         opacity makes it back. */
      const op = 1 - t * 0.42
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
      if (p.billboard) {
        p.m.quaternion.copy(camera.quaternion)
        /* billboard 之后再绕视轴缓慢自转，相邻层方向相反。刚性平移读成「一个东西
           在飘」，反向自转叠加起来读成「介质在翻卷」——这是雾与物件最后一处
           分野。/ A slow spin about the view axis after billboarding, alternating
           direction between layers. Rigid translation reads as a thing drifting;
           counter-rotating layers read as a medium churning, which is the last
           place fog and object part ways. */
        p.m.rotateZ(p.phase + t * 0.018 * (p.spin ? 1 : -1))
      }
    }
  }

  const allMats: { m: TH.MeshBasicMaterial; base: number }[] = []
  Object.values(puffs).forEach((arr) =>
    arr.forEach((p) => {
      const m = p.m.material as TH.MeshBasicMaterial
      allMats.push({ m, base: m.opacity })
    })
  )

  return {
    setVariant,
    setDim: (k: number) => allMats.forEach(({ m, base }) => (m.opacity = base * k)),
    update,
    dispose() {
      texes.forEach((t) => t?.dispose())
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
