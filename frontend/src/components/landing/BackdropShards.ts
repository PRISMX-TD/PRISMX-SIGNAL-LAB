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
    const halfW = Math.max(1, (CAM_Z0 - z) * TAN_H)
    const lo = -0.89 * halfW - r
    const hi = -0.3 * halfW + r
    if (x > lo && x < hi) return x - lo < hi - x ? lo : hi
    return x
  }

  const rnd = lcg(31337)
  /* 十九片，铺在 -260 到 -3000 的纵深里。横向偏右与外围：hero 文案列实测占视口
     x 5.5-35%，碎片一律让开——硬边实体压在正文上比雾更伤。
     Nineteen shards through a depth of -260 to -3000, biased right and outward: the
     hero copy column measures 5.5-35% of the viewport and hard-edged solids sitting
     on type hurt more than haze does. */
  for (let i = 0; i < 19; i++) {
    const t = i / 18
    /* 不规则凸多边形：五到七个顶点，半径与角度都抖动。规则多边形一眼假，
       碎片的说服力全在「没有两片一样」。
       An irregular convex polygon of five to seven vertices with both radius and
       angle jittered. A regular polygon reads as fake instantly; a shard is
       convincing precisely because no two are alike. */
    const n = 5 + Math.floor(rnd() * 3)
    const r0 = 120 + rnd() * 260 + t * 220
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
    const geo = new THREE.ExtrudeGeometry(shape, {
      depth: 8 + rnd() * 14,
      bevelEnabled: true,
      bevelThickness: 1.6,
      bevelSize: 1.6,
      bevelSegments: 1,
    })
    geo.center()

    const o = new THREE.Group()
    o.add(new THREE.Mesh(geo, faceMat))
    /* 发丝亮边。EdgesGeometry 的阈值取 18 度：低于它连倒角的过渡边都会被画出来，
       一片碎片会糊成一团线。/ A hairline edge, with EdgesGeometry thresholded at 18
       degrees: below that even the bevel's transition edges get drawn and a shard
       turns into a tangle of lines. */
    const edgeMat = new THREE.LineBasicMaterial({
      color: rnd() > 0.68 ? 0xb9a6ff : 0x8b6cff,
      transparent: true,
      opacity: 0.34 + (1 - t) * 0.3,
    })
    o.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo, 18), edgeMat))

    const side = rnd() > 0.34 ? 1 : -1
    const spread = 700 + t * 1900
    const x = side > 0 ? 380 + rnd() * spread : -880 - rnd() * spread * 0.7
    const y = -520 + rnd() * 1200 - t * 140
    const z = -260 - t * 2740
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
