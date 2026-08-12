// 棱镜碎片 / prism shards
//
// ════════════════════════════════════════════════════════════════════════════
// 上一版的雾被指出「像一片片玻璃」，截图里能直接看到带直边的多边形——贴片本身
// 露了形。这一版不再跟它较劲，而是顺着它做：既然读成玻璃，那就做成真的玻璃碎片。
//
// 更重要的是，这一步解开了前一版的死结。我在 BackdropAir 的文件头写过一句
// 「雾是修饰不是内容，它只在有几何体的地方生效」，然后转手把雾放进了一片空黑
// 里——它背后什么都没有，于是只能读成发光体。碎片给了烟雾**可以遮挡、也可以
// 被遮挡的东西**：烟从碎片前面飘过是遮挡，从后面飘过是被遮挡，两者互相成全。
// 前一版量到的那条「有存在感就没结构」的边界，根子也在这里——独立噪声互相
// 平均是数学，但只要场景里有硬边的实体，观众的深度判断就不再依赖噪声自身的
// 对比度了。
//
// 玻璃碎片之所以读成玻璃，几乎全靠**边**：面几乎是黑的、略透，而棱边捕捉环境光
// 形成一道细亮线。所以这里每片都是「极暗的面 + 发丝亮边」，而不是把面调亮。
// 这也正好是本站「颜料，不是光」的做法：亮的是被照到的棱，不是自己在发光的面。
//
// The previous fog was called out as looking like sheets of glass, and the
// screenshot shows straight-edged polygons - the sprite planes themselves showing
// through. Rather than fight that, this leans into it: if it reads as glass, make
// it real glass shards.
//
// More importantly this unties the previous knot. BackdropAir's own header says
// fog is a modifier that only acts where geometry already is, and then it put the
// fog in empty blackness, where it could only read as an emitter. Shards give the
// smoke something to occlude AND be occluded by. The measured "presence versus
// structure" frontier had the same root: independent noise averaging out is
// arithmetic, but once the scene holds hard-edged solids the viewer's depth
// judgement no longer rests on the noise's own contrast.
//
// A glass shard reads as glass almost entirely through its EDGES: the faces are
// nearly black and slightly transparent while the arrises catch the environment as
// a thin bright line. So every shard here is a very dark face plus a hairline lit
// edge rather than a brightened face - which is also exactly the site's
// pigment-not-light stance, since what is bright is the lit arris, not a face that
// emits.
// ════════════════════════════════════════════════════════════════════════════

import type * as TH from 'three'

export interface ShardsHandle {
  setVisible(v: boolean): void
  /** 整体压暗，判定幕让位给终端 / global dim so the verdict terminal owns its act */
  setDim(k: number): void
  update(t: number): void
  dispose(): void
}

function lcg(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

export function createBackdropShards(
  THREE: typeof import('three'),
  renderer: TH.WebGLRenderer,
  scene: TH.Scene
): ShardsHandle {
  /* ══ 暗棚环境 ══
     棱边的亮线是环境反射算出来的，不是画上去的，所以必须有环境。
     fromScene 的第四个参数 far 必须显式给：默认远裁剪面只有 100，灯板在 300-600
     之外会被整体裁掉，玻璃于是全黑——这个坑在手机机身那版踩过一次。
     The lit arrises are computed environment reflection rather than painted, so an
     environment is required. fromScene's fourth argument, far, must be passed: it
     defaults to 100 while the panels sit 300-600 out, which would clip them all and
     leave the glass black - a trap already hit once on the phone body. */
  const envScene = new THREE.Scene()
  envScene.background = new THREE.Color(0x05050a)
  const panel = (w: number, h: number, rgb: [number, number, number], px: number, py: number, pz: number, ry: number) => {
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(rgb[0], rgb[1], rgb[2]), side: THREE.DoubleSide })
    )
    m.position.set(px, py, pz)
    m.rotation.y = ry
    envScene.add(m)
  }
  panel(460, 340, [3.2, 3.3, 3.9], -320, 260, 150, Math.PI / 3.4) // 主光 / key
  panel(80, 660, [3.0, 3.0, 3.6], 360, 60, 90, -Math.PI / 2.6) // 边缘灯带 / edge strip
  panel(540, 220, [1.5, 0.9, 3.4], 40, -320, 170, 0) // 品牌紫补光 / violet bounce
  panel(900, 540, [1.1, 1.12, 1.4], 0, 300, 540, 0) // 相机后柔光 / fill behind camera

  const pmrem = new THREE.PMREMGenerator(renderer)
  const envRT = pmrem.fromScene(envScene, 0.04, 0.1, 2000)
  envScene.traverse((o) => {
    const m = o as { geometry?: { dispose(): void }; material?: { dispose(): void } }
    m.geometry?.dispose()
    m.material?.dispose()
  })
  const env = envRT.texture

  const group = new THREE.Group()
  group.visible = false
  scene.add(group)

  /* 面：几乎全黑、略透。亮度一律不给面，只给棱。
     Faces: nearly black and slightly transparent. No brightness is given to a
     face, only to an arris. */
  const faceMat = new THREE.MeshPhysicalMaterial({
    color: 0x0b0b12,
    metalness: 0,
    roughness: 0.06,
    transparent: true,
    opacity: 0.42,
    side: THREE.DoubleSide,
    envMap: env,
    envMapIntensity: 1.9,
    clearcoat: 1,
    clearcoatRoughness: 0.04,
    depthWrite: false,
  })

  interface Shard {
    m: TH.Object3D
    spin: [number, number, number]
    drift: number
    phase: number
    baseX: number
    baseY: number
  }
  const shards: Shard[] = []

  /* ══ 文案列的屏幕空间排除 ══
     实测碎片在 hero 文案后面把亮度顶到 86，#A3A3A3 正文对比度掉到 2.96:1，不过
     AA（要 4.5:1）。硬边实体压正文比雾伤得多，必须真的挤出去。
     不能用固定的世界坐标范围判定：同一个 x 在不同深度投影到的屏幕位置完全不同。
     近处 z=-260 时半幅约 738 世界单位，深处 z=-3000 时约 2078——一个 x=-1200 的
     碎片在近处早已出画，在深处却正落在文案列里。所以按深度反推：
       d = camZ − z，半幅 halfW = d × tan(hfov/2)，
       文案列占屏 5.5%-35% → 世界 x ∈ [−0.89×halfW, −0.30×halfW]
     再加上碎片自身半径当留边，落进去的就推到最近的一侧之外。
     Screen-space exclusion for the copy column. Shards measured a luminance of 86
     behind the hero copy, dropping #A3A3A3 body text to a contrast of 2.96:1
     against the 4.5:1 floor, and hard-edged solids hurt type far more than haze
     does. A fixed world-space range cannot express this: the same x projects to
     completely different screen positions at different depths - the half-width is
     about 738 world units at z=-260 and about 2078 at z=-3000, so a shard at
     x=-1200 is off-frame up close and squarely inside the copy column far away.
     Hence deriving it per depth from the half-width, with the shard's own radius as
     margin, and pushing anything that lands inside out to the nearer side. */
  const CAM_Z0 = 1250 // 第一幕机位，文案可见的那一幕 / act I camera, where the copy lives
  const TAN_H = 0.489 // fov 34 竖直、16:9 换算的水平半角 / horizontal half-angle
  const clearCopy = (x: number, z: number, r: number) => {
    /* 留边要用**实际最远顶点**而不是标称半径：顶点半径是 r0 × (0.5 + rnd×0.75)，
       最远能到 r0 × 1.25。拿 r0 当留边，最外那圈顶点就有 25% 的余量没算进去——
       实测文案区因此仍有 34 的亮度渗入。
       The margin has to use the actual furthest vertex rather than the nominal
       radius: vertex radii are r0 times 0.5 plus up to 0.75, reaching r0 x 1.25.
       Using r0 leaves a quarter of the outermost ring unaccounted for, which
       measured as 34 of luminance still reaching the copy column. */
    r *= 1.3
    const halfW = Math.max(1, (CAM_Z0 - z) * TAN_H)
    const lo = -0.89 * halfW - r
    const hi = -0.3 * halfW + r
    if (x > lo && x < hi) return x - lo < hi - x ? lo : hi
    return x
  }

  /* ══ 按屏幕分带放置 ══
     截图里中间整块是空的，而且是**构造上**就空：原来的放置只有「左 / 右」两支，
     右支从 x=+380 起，在正机位下半幅约 738，那已经是屏幕 75%——落在手机后面。
     屏幕 35%-58% 这条带从来没被分配过。
     改成按屏幕横向分带取样，再按深度换算回世界坐标（x = (2f−1) × halfW）：
       mid   0.38-0.56   文案列右缘到手机左缘之间，就是空的那一块
       right 0.80-1.05   手机之后到画面外
       left  -0.05-0.06  左缘外沿
     中间带的碎片必须小：半幅 738 时一片 r=600 的碎片放在 38% 处会一路盖回文案列，
     被 clearCopy 推出去，等于白放。
     Placed by screen band. The middle of the frame was empty BY CONSTRUCTION: the
     old placement had only a left and a right branch, and the right one started at
     x=+380, which against a half-width of about 738 is already 75% of the screen -
     behind the phone. The 35-58% band was never assigned to anything. Sampling is
     now done in screen fractions and converted back per depth via x = (2f-1) *
     halfW. Shards in the middle band have to be small: at a half-width of 738 a
     600-radius shard placed at 38% reaches back across the copy column and gets
     pushed out by clearCopy, which wastes it. */
  /* 中间带的起点由几何反推，不是猜的：一片半径 r 的碎片不越过文案列右缘
     （−0.30×halfW），中心至少要在 −0.30×halfW + r。近处 halfW≈807、r≈200 时
     换算成屏幕 f ≥ 0.474。上一版把起点放在 0.38，于是整条带的碎片全部被
     clearCopy 推回同一个位置——中间看着有东西，其实全挤在一条线上，而且实测
     仍有 34 的亮度渗进文案列。深处 halfW 变大，同一个约束自动放宽。
     The middle band's left limit is derived rather than guessed: for a shard of
     radius r to clear the copy column's right edge at -0.30 x halfW its centre must
     sit at or beyond -0.30 x halfW + r, which for a near half-width of about 807
     and r about 200 works out to a screen fraction of 0.474. The previous 0.38
     start meant clearCopy pushed the whole band back to one position - the middle
     looked occupied while everything was stacked on a single line, and 34 of
     luminance still bled into the copy column. At depth the half-width grows and
     the same constraint relaxes on its own. */
  /* ══ 手排布局 ══
     随机分带出来的排布被指出「太多、位置很奇怪」，两个原因：
     一、中间带取 0.47-0.62，而手机在屏幕 0.59-0.76——两者重叠，新加的碎片全挤在
         手机左缘那一小块，成了主体旁边的一团噪点。
     二、随机取样本身就会结块：同一带里连着几片落在相近位置、尺寸又相近，读起来
         就是「一堆」而不是「几片」。
     改成写死的布局表。十九片减到十一片，每片的屏幕位置、深度、大小都由这张表
     决定，可以逐行复审，也不会因为换个随机种子就重排。
     禁区两处：文案列（屏幕 5.5-35%）和手机（约 57-78%）。手机只对**近景**碎片
     设禁——深处的碎片又小又淡，而且手机本体是不透明的，本来就会把它们挡住，
     那正是纵深该有的样子。
     Hand-authored layout. The random band placement was called out as too many
     shards in strange positions, for two reasons: the middle band ran 0.47 to 0.62
     while the phone occupies 0.59 to 0.76, so everything added there piled up
     against the phone's left edge as noise beside the subject; and random sampling
     clumps by nature, dropping several similar sizes at similar positions so it
     reads as a heap rather than as a few shards. This table fixes each shard's
     screen position, depth and size, reviewable line by line and stable across
     seeds. Two exclusions: the copy column at 5.5-35% and the phone at roughly
     57-78%, the latter only for NEAR shards - distant ones are small and faint, and
     the phone's opaque body occludes them anyway, which is exactly what depth
     should look like. */
  const LAYOUT: [number, number, number, number][] = [
    // 屏幕 x, 屏幕 y, 深度 t(0近-1远), 尺寸系数
    [0.44, 0.26, 0.1, 0.5], // 中景空档，偏上
    [0.5, 0.66, 0.34, 0.62], // 中景空档，偏下
    [0.4, 0.84, 0.66, 0.8], // 中远，低位
    [0.89, 0.2, 0.08, 0.7], // 右上，近
    [0.98, 0.58, 0.3, 0.9], // 右中
    [0.85, 0.86, 0.55, 0.75], // 右下
    [0.02, 0.32, 0.18, 0.8], // 左缘，上
    [-0.04, 0.74, 0.46, 0.85], // 左缘，下
    [0.66, 0.1, 0.82, 0.55], // 远，手机上方
    [0.74, 0.93, 0.88, 0.65], // 远，手机下方
    [0.28, 0.08, 0.95, 0.6], // 远，左上（深处半幅大，不压文案）
  ]
  const PHONE = { l: 0.57, r: 0.78 }

  const rnd = lcg(31337)
  /* 十九片，铺在 -260 到 -3000 的纵深里。横向偏右与外围：hero 文案列实测占视口
     x 5.5-35%，碎片一律让开——硬边实体压在正文上比雾更伤。
     Nineteen shards through a depth of -260 to -3000, biased right and outward: the
     hero copy column measures 5.5-35% of the viewport and hard-edged solids sitting
     on type hurt more than haze does. */
  for (let i = 0; i < LAYOUT.length; i++) {
    const [fx0, fy0, t, rk] = LAYOUT[i]
    /* 不规则凸多边形：五到七个顶点，半径与角度都抖动。规则多边形一眼假，
       碎片的说服力全在「没有两片一样」。
       An irregular convex polygon of five to seven vertices with both radius and
       angle jittered. A regular polygon reads as fake instantly; a shard is
       convincing precisely because no two are alike. */
    const n = 5 + Math.floor(rnd() * 3)
    /* 分带轮转，中间带占比最高（0,1,2,0,1,0 的循环里 mid 出现两次）
       Round-robin across the bands with the middle weighted highest. */
    const r0 = (110 + rnd() * 90 + t * 200) * rk
    const shape = new THREE.Shape()
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2 + (rnd() - 0.5) * 0.75
      const r = r0 * (0.5 + rnd() * 0.75)
      const x = Math.cos(a) * r
      const y = Math.sin(a) * r * (0.7 + rnd() * 0.6)
      if (k === 0) shape.moveTo(x, y)
      else shape.lineTo(x, y)
    }
    shape.closePath()
    /* 有厚度才有棱。厚度极薄（8-22），但正是这一圈侧面接住环境光，形成那道
       让人读成玻璃的亮边。
       Thickness is what creates arrises. It is very thin at 8 to 22 units, but that
       narrow band of side faces is what catches the environment and forms the lit
       edge that reads as glass. */
    /* 厚度 8-22 收到 3-8，倒角同步收细。原来的厚度让侧面那一圈在屏幕上有明显
       宽度，正面轮廓与背面轮廓分成两条线，读起来是「有厚度的框」而不是「一片
       薄玻璃」。收薄之后两条轮廓叠成一条，才是碎玻璃的样子。
       Thickness drops from 8-22 to 3-8 with the bevel narrowing to match. The old
       depth gave the side band visible width on screen, splitting the front and
       back outlines into two separate lines that read as a thick frame rather than
       a thin shard. Thin enough, the two outlines collapse into one. */
    const geo = new THREE.ExtrudeGeometry(shape, {
      depth: 3 + rnd() * 5,
      bevelEnabled: true,
      bevelThickness: 0.7,
      bevelSize: 0.7,
      bevelSegments: 1,
    })
    geo.center()

    const o = new THREE.Group()
    o.add(new THREE.Mesh(geo, faceMat))
    /* 发丝亮边。EdgesGeometry 的阈值取 18 度：低于它连倒角的过渡边都会被画出来，
       一片碎片会糊成一团线。/ A hairline edge, with EdgesGeometry thresholded at 18
       degrees: below that even the bevel's transition edges get drawn and a shard
       turns into a tangle of lines. */
    /* 边线：不透明度从 0.34-0.64 砍到 0.14-0.30，EdgesGeometry 阈值从 18° 提到
       42°。阈值决定哪些棱会被画出来——18° 会把倒角的过渡边也算进去，于是每条
       轮廓其实是三四条挨着的线，看上去就粗。42° 只留真正的折角。
       Edges: opacity cut from 0.34-0.64 down to 0.14-0.30 and the EdgesGeometry
       threshold raised from 18 to 42 degrees. That threshold decides which arrises
       get drawn, and at 18 the bevel's transition edges qualify too, so every
       outline was really three or four adjacent lines and read as heavy. At 42 only
       genuine creases survive. */
    const edgeMat = new THREE.LineBasicMaterial({
      color: rnd() > 0.68 ? 0xb9a6ff : 0x8b6cff,
      transparent: true,
      opacity: 0.14 + (1 - t) * 0.16,
    })
    o.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo, 42), edgeMat))

    const z = -260 - t * 2740
    const halfW = Math.max(1, (CAM_Z0 - z) * TAN_H)
    /* 近景碎片让开手机：把落在手机列里的推到最近的一侧之外。远景（t>0.6）不推——
       手机会挡住它们，那是纵深，不是噪点。
       Near shards clear the phone, pushed to whichever side is closer. Distant ones
       (t above 0.6) are left alone: the phone occludes them, which reads as depth
       rather than as clutter. */
    let f = fx0
    if (t < 0.6 && f > PHONE.l && f < PHONE.r) f = f - PHONE.l < PHONE.r - f ? PHONE.l : PHONE.r
    const x = (f * 2 - 1) * halfW
    /* 纵向也按屏幕铺：空的那块从画面 20% 一直到 82%，只靠固定的世界坐标范围
       在深处会全部挤到中线附近。/ Vertical placement is also in screen terms: the
       empty region runs from 20% to 82% of the frame, and a fixed world-space range
       would bunch everything near the centre line at depth. */
    const halfH = Math.max(1, (CAM_Z0 - z) * 0.3057)
    const y = 60 + (0.5 - fy0) * 2 * halfH
    o.position.set(clearCopy(x, z, r0), y, z)
    o.rotation.set(rnd() * 3.14, rnd() * 3.14, rnd() * 3.14)
    group.add(o)
    shards.push({
      m: o,
      spin: [(rnd() - 0.5) * 0.026, (rnd() - 0.5) * 0.03, (rnd() - 0.5) * 0.02],
      drift: 12 + rnd() * 26,
      phase: rnd() * 6.28,
      baseX: clearCopy(x, -260 - t * 2740, r0),
      baseY: y,
    })
  }

  const edgeMats: TH.LineBasicMaterial[] = []
  group.traverse((o) => {
    const l = o as TH.LineSegments
    if (l.isLineSegments) edgeMats.push(l.material as TH.LineBasicMaterial)
  })
  const edgeBase = edgeMats.map((m) => m.opacity)
  const faceBase = faceMat.opacity

  return {
    setVisible: (v: boolean) => {
      group.visible = v
    },
    /* 判定幕里终端是唯一主体，碎片退到余光。压的是不透明度而不是隐藏——
       突然消失会被看见，缓慢退场不会。
       In the verdict act the terminal is the only subject and the shards fall back
       to peripheral. Dimming rather than hiding: a sudden disappearance registers,
       a fade does not. */
    setDim: (k: number) => {
      faceMat.opacity = faceBase * k
      edgeMats.forEach((m, i) => (m.opacity = edgeBase[i] * k))
    },
    update: (t: number) => {
      if (!group.visible) return
      for (const s of shards) {
        /* 极慢自转。碎片必须一直转，否则棱上那道亮线是死的——玻璃的可信度来自
           「转动时高光沿着棱滑过去」。转速慢到说不出它在转，只觉得画面是活的。
           A very slow tumble. Shards must keep turning or the line along the arris
           is dead: glass is believable because the highlight slides along the edge
           as it moves. Slow enough that nobody would say it is spinning. */
        s.m.rotation.x += s.spin[0] * 0.016
        s.m.rotation.y += s.spin[1] * 0.016
        s.m.rotation.z += s.spin[2] * 0.016
        s.m.position.x = s.baseX + Math.sin(t * 0.05 + s.phase) * s.drift
        s.m.position.y = s.baseY + Math.cos(t * 0.037 + s.phase) * s.drift * 0.6
      }
    },
    dispose() {
      envRT.dispose()
      pmrem.dispose()
      group.traverse((o) => {
        const m = o as { geometry?: { dispose(): void }; material?: { dispose(): void } }
        m.geometry?.dispose()
        m.material?.dispose()
      })
      scene.remove(group)
    },
  }
}
