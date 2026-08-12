// 全页持久 3D 空间 / the persistent page-level 3D space
//
// ════════════════════════════════════════════════════════════════════════════
// 为什么要有这一层
//
// 上一版整页只有一个 3D 物件（那台手机），它悬在纯黑里，背后是一张静态网格图。
// 物件本身很立体，但它**不在任何地方**——没有地面、没有远近、没有空间。而
// 「震撼」来自空间，不来自物件：观众要先相信自己身处某处，一个物体才谈得上
// 大小和重量。同样的原因，页面在叙事区结束后会从 3D 悬崖式跌回平面文档，
// 全页只有一个高峰而且在前段。
//
// 所以这一层是**一个从头贯穿到页脚的世界**：一个渲染器、一个场景、一台相机，
// 固定在视口最底层（z-0），由整页滚动位置驱动相机沿一条路径穿行。各分区不再是
// 并排的矩形，而是这条相机路径上的站点：
//
//   route 0 → 1   叙事区：相机高悬在网格地面之上缓慢前推，走廊还在雾里
//   route 1 → 2   判定区：相机俯冲进入「走廊」并沿它飞行（本文件的主戏）
//   route 2 → 3   定价 / FAQ / 收尾：相机拔升脱离走廊，落在一片安静的开阔地
//
// A persistent world spanning the whole page: one renderer, one scene, one camera
// pinned to the bottom layer of the viewport, with page scroll driving the camera
// along a single path. The previous version had a 3D *object* (the phone) floating
// in a void with a static grid image behind it - very dimensional in itself, but
// located nowhere, and the page fell off a 3D cliff back into a flat document once
// the story ended. Space, not objects, is where the impact comes from.
//
// ────────────────────────────────────────────────────────────────────────────
// 走廊：把判定规则做成几何，而不是插画
//
// 这是一个交易产品，叙事区之后最自然的 3D 主体是**行情本身**。四条判定规则
// （见 i18n 的 wrRule1-4）在这里不是四行文案配四张图标，而是四段真实几何：
//
//   时间 → -z（飞向纵深）   价格 → y   蜡烛沿 z 排列
//   天花板 = 止盈   地板 = 止损   中间那条发丝线 = 入场价
//
// 于是「先碰止盈算赢 / 先碰止损算输」不需要解释：你在一条走廊里飞行，价格走到
// 顶就撞天花板，走到底就撞地板。四段走廊 = 四个信号，每段的天花板与地板高度
// 不同（新信号 = 新的止盈止损），所以走廊在飞行中会阶梯式升降——这正是系统
// 真实的样子：一个接一个的信号，用同一套规则判。第三段那根同时刺穿上下的长影
// 就是「同一根 K 线两头都碰」；第四段中间那道缺口就是「数据中断，不计入」。
// 几何本身就是论证。
//
// The corridor turns the judgment rules into geometry rather than illustration.
// Time runs into -z, price is y: the ceiling is take-profit, the floor is
// stop-loss, the hairline between them is entry. "Touch the ceiling first and it
// is a win, the floor first and it is a loss" then needs no explanation - you are
// flying down the corridor watching it happen. Four corridor segments are four
// signals, each with its own ceiling and floor height, so the corridor steps up
// and down as you fly, which is exactly what the real system looks like: one
// signal after another judged by one rulebook. The third segment's single candle
// whose wick pierces both planes IS rule 3; the fourth segment's gap IS rule 4.
//
// ────────────────────────────────────────────────────────────────────────────
// 为什么整场没有一盏灯
//
// 全部材质是 MeshBasicMaterial / LineBasicMaterial：实色填充 + 发丝描边，零光照、
// 零高光、零辉光。这不是省事，这是把「颜料，不是光」的设计令牌原样搬进 3D——
// 纵深完全由透视、遮挡、雾和网格承担，正是一张技术制图该有的样子。顺带它也让
// 这一层便宜到可以在真机上常驻：合并几何后整场不到 10 个 draw call。
// 手机那一层（PhoneGL）是另一回事：金属的可信度只能来自实算的环境反射，那里
// 该有光；这里不该有。两层画布合成在一起，一近一远，各用各的语言。
//
// Not one light in the entire scene: every material is MeshBasic / LineBasic, flat
// fills and hairline edges. That is the pigment-not-glow token system carried
// verbatim into 3D - depth comes from perspective, occlusion, fog and the grid,
// which is how a technical drawing works. It also keeps this layer cheap enough to
// run on real phones: under ten draw calls after merging. The phone layer is the
// opposite case and rightly keeps its lighting; metal is only believable when its
// reflections are computed.
// ════════════════════════════════════════════════════════════════════════════

import type * as TH from 'three'

export interface SpaceHandle {
  resize(): void
  dispose(): void
}

/* ── 配色：全部取自设计令牌，不新增颜色 / palette, all from existing tokens ── */
const IE_BG = 0x09090b // --ink-950，同时也是雾色 / also the fog colour
const C_GRID = 0xffffff
const C_BODY = 0x3f3f46
const C_EDGE = 0x5e5e69
const C_ENTRY = 0x8b8b95
const C_TP = 0x5a22ee // prism-600
const C_SL = 0x71717a
const C_WIN = 0x6e42ff // prism-500
const C_LOSS = 0xc4c4cc

/* ── 走廊尺寸 / corridor metrics ──
   世界单位没有物理含义，只需内部自洽：一根蜡烛间距 34，一段 13 根 = 408，
   段长 520 留出 112 的空档，四段从 z=-900 铺到 z=-2980。
   World units are arbitrary but internally consistent: candles every 34, thirteen
   per segment, 520 per segment leaving a 112 gap, four segments spanning -900 to
   -2980. */
const SEG_LEN = 520
/* 走廊起点从 -900 推到 -1500。实测在 -900 时，第一幕（相机还在 z≈+1100）就能
   透过雾看见走廊的紫色轨——那是在跟手机抢注意力。推远之后同样的雾密度下它降到
   若有若无，第一幕末尾才开始浮现，正好成为「下面还有东西」的预告。
   The corridor start moves from -900 to -1500. Measured at -900, the violet rails
   were already visible through the fog during act I with the camera still at
   z=+1100, competing with the phone. Pushed back, the same fog reduces them to a
   hint that only surfaces near the end of act I, which is exactly the foreshadow
   the transition wants. */
const Z0 = -1500
const CAND_DZ = 34
const CAND_PER_SEG = 13
/* 蜡烛从 9 加宽到 16、影线 1.6 加到 3：飞行中它们大多在 400-900 单位外，9 单位
   宽在 256px 的取样里连一个像素都占不满。/ Candles widened from 9 to 16 and wicks
   from 1.6 to 3: in flight they mostly sit 400-900 units out, where 9 units did not
   fill a single pixel. */
const CAND_W = 16
const WICK_W = 3
const FLOOR_Y = -260

/* 每段的止盈/止损高度与基准价。基准价逐段变化，走廊因此在飞行中阶梯升降。
   Take-profit / stop-loss heights and the base price per segment. The base steps
   between segments, which is what makes the corridor rise and fall as you fly. */
const SEGMENTS = [
  { base: 0, tp: 34, sl: -30, verdict: 'win' as const },
  { base: -40, tp: 30, sl: -34, verdict: 'loss' as const },
  { base: 34, tp: 32, sl: -32, verdict: 'both' as const },
  { base: -8, tp: 30, sl: -30, verdict: 'void' as const },
]

/* 第四段「数据中断」的缺口：跳过这几根蜡烛。
   The outage gap in segment 4: these candle slots are skipped. */
const VOID_GAP = [5, 6, 7, 8]

/* 确定性伪随机。行情路径必须每次加载都一样——这讲的是**一个**信号的一生，
   不是每次刷新换一份行情；何况可复现的场景才谈得上逐帧核对。
   Deterministic PRNG. The path must be identical on every load: this narrates one
   signal's life, not a fresh market each refresh, and a reproducible scene is the
   only kind that can be verified frame by frame. */
function lcg(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

interface Candle {
  o: number
  h: number
  l: number
  c: number
}

/* 生成一段行情：随机游走 + 后段向判定价位的拉力，最后一根强制触及。
   One segment of price action: a random walk with a pull toward the verdict level
   over the back half, and a final candle forced to touch. */
function buildSeries(seed: number, n: number, tp: number, sl: number, verdict: string): Candle[] {
  const rnd = lcg(seed)
  const amp = 11
  const target = verdict === 'win' ? tp : verdict === 'loss' ? sl : 0
  const out: Candle[] = []
  let close = 0
  for (let i = 0; i < n; i++) {
    const k = n > 1 ? i / (n - 1) : 0
    const pull = verdict === 'void' ? 0 : Math.max(0, (k - 0.4) / 0.6) ** 1.7
    const open = close
    close = close + (rnd() - 0.5) * amp * 1.6 - close * 0.06 + (target - close) * pull * 0.3
    // 夹在通道内，只有最后一根被允许越界 / clamped inside the channel; only the
    // final candle is allowed out
    close = Math.max(sl * 0.82, Math.min(tp * 0.82, close))
    const hi = Math.max(open, close) + rnd() * amp * 0.55
    const lo = Math.min(open, close) - rnd() * amp * 0.55
    out.push({ o: open, h: hi, l: lo, c: close })
  }
  const last = out[n - 1]
  if (verdict === 'win') {
    last.c = tp - 3
    last.h = tp + 3
  } else if (verdict === 'loss') {
    last.c = sl + 3
    last.l = sl - 3
  } else if (verdict === 'both') {
    // 规则三：同一根 K 线两头都碰。这根影子刺穿天花板与地板，是整条走廊里
    // 唯一一个「几何本身就是规则」的时刻。
    // Rule 3: one candle touching both. Its wick pierces ceiling and floor - the
    // single moment where the geometry alone states the rule.
    last.o = 4
    last.c = -6
    last.h = tp + 4
    last.l = sl - 4
  }
  return out
}

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
  const { mergeGeometries } = await import('three/examples/jsm/utils/BufferGeometryUtils.js')

  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'low-power' })
  renderer.setClearAlpha(0)
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.domElement.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none'
  container.appendChild(renderer.domElement)

  const scene = new THREE.Scene()
  /* 指数雾，雾色 = 页面底色。清屏 alpha 为 0，所以远处几何淡出的目标色与页面
     背景严格一致，走廊尽头是「化开」而不是「被裁掉」——这是整场唯一的纵深
     线索里最贵的一条，也是最便宜的实现。
     Exponential fog whose colour is the page's own background. The clear alpha is
     zero, so distant geometry dissolves into exactly the backdrop behind the
     canvas: the corridor ends by fading out, never by being clipped. */
  /* 雾密度 0.00108 → 0.00052。实测第一幕整帧峰值亮度只有 5/255 —— 几乎纯黑：
     0.00108 把 1000 单位外的一切压到 31% 可见度，再乘以地面线 0.07 的不透明度
     就只剩 2/255。空间层的全部意义是让观众相信「我在一个地方」，一张看不见的
     地面等于没做。放开雾之后走廊末端仍然化开，但近处的结构结实了。
     Fog density from 0.00108 to 0.00052. Measured, act I peaked at a luminance of
     5 out of 255 - effectively black: the old density cut everything beyond 1000
     units to 31% visibility, and multiplying that by the grid's 0.07 opacity left
     2/255. The entire point of this layer is to make the viewer believe they are
     somewhere, and an invisible floor does none of that. Opened up, the far end of
     the corridor still dissolves while the near structure holds. */
  scene.fog = new THREE.FogExp2(IE_BG, 0.00052)

  const camera = new THREE.PerspectiveCamera(34, 1, 5, 4200)

  /* ══ 地面网格 ══
     一张平面 + 一组发丝线。它不是装饰：整个第一幕里，观众判断「我在一个空间
     里」的全部依据就是这张地面的透视收敛。
     A plane plus a set of hairlines. Not decoration: throughout act I this grid's
     perspective convergence is the entire basis for reading the scene as a place. */
  const gridGroup = new THREE.Group()
  {
    const pts: number[] = []
    /* 范围要盖住整条相机路径（第四幕相机会走到 z=-4600），否则出走廊之后地面
       就没了——实测 route 2.2 与 3.0 的画面覆盖率是 0，定价与页脚身后是一片
       纯黑，比改造前的静态网格还差。
       The extent has to cover the whole camera path (act IV reaches z=-4600) or the
       floor simply ends after the corridor - measured, routes 2.2 and 3.0 rendered
       0% coverage, leaving pricing and the footer against pure black, worse than
       the static grid this replaced. */
    const X = 2800
    const ZA = 1800
    const ZB = -6400
    for (let x = -X; x <= X; x += 150) pts.push(x, FLOOR_Y, ZA, x, FLOOR_Y, ZB)
    for (let z = ZA; z >= ZB; z -= 150) pts.push(-X, FLOOR_Y, z, X, FLOOR_Y, z)
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
    gridGroup.add(
      new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: C_GRID, transparent: true, opacity: 0.3 }))
    )
  }
  scene.add(gridGroup)

  /* ══ 走廊 ══ */
  const corridor = new THREE.Group()
  scene.add(corridor)

  const bodyGeos: TH.BufferGeometry[] = []
  const wickGeos: TH.BufferGeometry[] = []
  const winGeos: TH.BufferGeometry[] = []
  const lossGeos: TH.BufferGeometry[] = []
  const railPts: number[] = []
  const tpPts: number[] = []
  const slPts: number[] = []
  const entryPts: number[] = []
  const voidPts: number[] = []

  /* 走廊的「栏杆与横档」：两条纵向轨 + 每 68 单位一根横档。用线框而不是半透明
     实面，是因为实面在雾里会糊成一片灰，而线框在任何距离上都保持「这是一个
     被划定的通道」的读数——同时它就是本站 .rule-spectral 的发丝线语言。
     Rails and rungs rather than translucent slabs: a slab smears into grey haze in
     fog, while a wireframe keeps reading as a bounded channel at any distance, and
     it is the same hairline language as the site's .rule-spectral. */
  /* 通道半宽 42 → 320。实测 42 单位宽的通道在 500 距离上只占半个视场的 12%，
     读起来是「远处一条带子」，不是「我在里面」。加宽到 320 之后天花板与地板
     铺过画面两侧，围合感才成立——这是「走廊」这个比喻能不能站住的唯一变量。
     蜡烛仍然只有 16 宽，于是画面是「在两片巨大的网格之间飞，中间穿着一条细线」，
     正是这一幕想要的图像。
     Channel half-width from 42 to 320. Measured, 42 units at a distance of 500
     covered 12% of the half field of view and read as a distant ribbon rather than
     as being inside anything. At 320 the ceiling and floor run past both edges of
     the frame and the enclosure works - this is the single variable that decides
     whether the corridor metaphor holds. The candles stay 16 wide, so the image is
     flying between two vast grids with one thin thread down the middle. */
  const railHalf = 320
  const RAIL_X = [-320, -170, -80, 0, 80, 170, 320]
  const pushPlane = (into: number[], y: number, zA: number, zB: number) => {
    for (const x of RAIL_X) into.push(x, y, zA, x, y, zB)
    for (let z = zA; z >= zB; z -= 60) into.push(-railHalf, y, z, railHalf, y, z)
  }

  SEGMENTS.forEach((seg, si) => {
    const zA = Z0 - si * SEG_LEN
    const series = buildSeries(9871 + si * 733, CAND_PER_SEG, seg.tp, seg.sl, seg.verdict)
    const tpY = seg.base + seg.tp
    const slY = seg.base + seg.sl
    const zB = zA - (CAND_PER_SEG - 1) * CAND_DZ - CAND_DZ

    if (seg.verdict === 'void') {
      /* 数据中断段：通道照旧划出，但用另一组更暗的线，且蜡烛缺一块。
         The outage segment: the channel is still drawn, in a dimmer set of lines,
         with a hole where the candles should be. */
      pushPlane(voidPts, tpY, zA + 14, zB)
      pushPlane(voidPts, slY, zA + 14, zB)
    } else {
      pushPlane(tpPts, tpY, zA + 14, zB)
      pushPlane(slPts, slY, zA + 14, zB)
    }
    entryPts.push(0, seg.base, zA + 14, 0, seg.base, zB)
    // 段首一道竖档：新信号从这里开始 / a vertical marker where each signal starts
    railPts.push(-railHalf, slY, zA + 14, -railHalf, tpY, zA + 14)
    railPts.push(railHalf, slY, zA + 14, railHalf, tpY, zA + 14)

    series.forEach((c, i) => {
      if (seg.verdict === 'void' && VOID_GAP.includes(i)) return
      const z = zA - i * CAND_DZ
      const top = seg.base + Math.max(c.o, c.c)
      const bot = seg.base + Math.min(c.o, c.c)
      const h = Math.max(2.2, top - bot)
      const isLast = i === series.length - 1
      const bucket =
        isLast && seg.verdict === 'win'
          ? winGeos
          : isLast && (seg.verdict === 'loss' || seg.verdict === 'both')
            ? lossGeos
            : bodyGeos

      const b = new THREE.BoxGeometry(CAND_W, h, CAND_W)
      b.translate(0, (top + bot) / 2, z)
      bucket.push(b)

      const wh = Math.max(1, seg.base + c.h - (seg.base + c.l))
      const w = new THREE.BoxGeometry(WICK_W, wh, WICK_W)
      w.translate(0, seg.base + (c.h + c.l) / 2, z)
      ;(isLast && seg.verdict !== 'void' ? bucket : wickGeos).push(w)
    })
  })

  const flat = (color: number, opacity = 1) =>
    new THREE.MeshBasicMaterial({ color, transparent: opacity < 1, opacity })
  const line = (color: number, opacity: number) =>
    new THREE.LineBasicMaterial({ color, transparent: true, opacity })

  const addMerged = (geos: TH.BufferGeometry[], mat: TH.Material, edge?: number) => {
    if (!geos.length) return
    const merged = mergeGeometries(geos, false)
    geos.forEach((g) => g.dispose())
    if (!merged) return
    corridor.add(new THREE.Mesh(merged, mat))
    if (edge != null) {
      corridor.add(
        new THREE.LineSegments(new THREE.EdgesGeometry(merged, 30), line(edge, 0.5))
      )
    }
  }
  addMerged(bodyGeos, flat(C_BODY), C_EDGE)
  addMerged(wickGeos, flat(C_BODY))
  addMerged(winGeos, flat(C_WIN), C_TP)
  addMerged(lossGeos, flat(C_LOSS), C_LOSS)

  const addLines = (pts: number[], mat: TH.LineBasicMaterial) => {
    if (!pts.length) return
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
    corridor.add(new THREE.LineSegments(g, mat))
  }
  addLines(tpPts, line(C_TP, 0.72))
  addLines(slPts, line(C_SL, 0.4))
  addLines(voidPts, line(C_SL, 0.14))
  addLines(entryPts, line(C_ENTRY, 0.34))
  addLines(railPts, line(C_ENTRY, 0.22))

  /* ══ 相机路径 ══
     关键帧按 route（0-3）排布，段内用 smoothstep 插值。fov 一起动：进走廊时
     从 34° 开到 52°，出走廊收回——变焦是最省力的「速度感」，比单纯提高位移
     速度可信得多。
     Keyframes along route 0-3, smoothstepped between. The FOV animates with them,
     opening from 34 to 52 degrees inside the corridor: a lens change buys far more
     sense of speed than simply moving faster. */
  interface Key {
    r: number
    p: [number, number, number]
    l: [number, number, number]
    fov: number
  }
  /* 全部关键帧的俯仰角都必须**朝下一点**。上一版为了把地平线压低而让相机略微
     仰视，结果是近处地面整个跑到画面之外，只剩远处被雾吃掉的部分——实测第一幕
     与第四幕的覆盖率因此接近 0。地平线的位置该靠相机高度调，不该靠仰角调。
     Every keyframe now pitches slightly DOWN. The previous set tilted the camera up
     to push the horizon lower, which moved the entire near floor out of frame and
     left only the fogged distance - measured, that is why acts I and IV came back
     at close to zero coverage. Horizon placement belongs to camera height, not to
     pitch. */
  const KEYS: Key[] = [
    // 第一幕：地面之上约 320，几乎平视、略微俯。走廊还在 2600 之外的雾里。
    { r: 0.0, p: [0, 60, 1250], l: [-30, 88, 350], fov: 34 },
    { r: 0.86, p: [0, 70, 60], l: [-40, 96, -840], fov: 35 },
    // 抵达走廊入口上方，开始下降 / arriving above the entrance, starting the drop
    { r: 1.0, p: [0, 150, -640], l: [-60, 30, -1500], fov: 38 },
    /* 走廊偏航方向。桌面端文字面板固定在左侧（left: 7vw，宽 26rem），实测原来
       那组「相机在 +x、看向 -x」的取向把走廊整个压在面板身后：面板区域覆盖率
       40.9%，画面其余部分只有 16%，左右像素比 2:1。镜像之后走廊让到右侧，
       左边留给文字——这不是构图偏好，是可读性。
       Corridor yaw. The desktop text panel is pinned left (7vw, 26rem wide) and the
       original "camera at +x looking toward -x" orientation put the whole corridor
       behind it: 40.9% coverage inside the panel box against 16% for the rest of
       the frame, a 2:1 left/right pixel split. Mirrored, the corridor moves right
       and the left is left for type. Not a compositional preference, legibility. */
    { r: 1.12, p: [-38, 34, -1320], l: [34, 8, -1900], fov: 50 },
    // 四段各对应一条规则，相机高度跟着该段的基准价升降
    { r: 1.34, p: [-38, 4, -1700], l: [34, -12, -2270], fov: 52 },
    { r: 1.56, p: [-38, -36, -2210], l: [34, -48, -2780], fov: 52 },
    { r: 1.78, p: [-38, 32, -2730], l: [34, 30, -3300], fov: 52 },
    { r: 1.95, p: [-38, -6, -3250], l: [34, -12, -3820], fov: 50 },
    // 拔升脱离，落进一片安静的开阔地 / pulling up and out into open ground
    { r: 2.1, p: [0, 90, -3680], l: [20, 0, -4520], fov: 42 },
    { r: 3.0, p: [0, 80, -4700], l: [0, -30, -5560], fov: 36 },
  ]
  const smooth = (x: number) => x * x * (3 - 2 * x)
  const _p = new THREE.Vector3()
  const _l = new THREE.Vector3()
  const applyRoute = (r: number) => {
    let i = 0
    while (i < KEYS.length - 2 && r > KEYS[i + 1].r) i++
    const a = KEYS[i]
    const b = KEYS[i + 1]
    const k = smooth(Math.max(0, Math.min(1, (r - a.r) / (b.r - a.r))))
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
    camera.position.copy(_p)
    camera.lookAt(_l)
    const fov = a.fov + (b.fov - a.fov) * k
    if (Math.abs(camera.fov - fov) > 0.01) {
      camera.fov = fov
      camera.updateProjectionMatrix()
    }
  }

  /* ══ 尺寸 ══
     像素比压到 1.5：这一层是背景，全是实色面与 1px 线，2.0 的收益肉眼看不出来，
     但在真机上是实打实的填充率。
     Pixel ratio capped at 1.5: this is a backdrop of flat fills and hairlines where
     2.0 buys nothing visible, and fill rate on a phone is real. */
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
    dirty = true
  }

  /* ══ 路线：每帧从滚动位置算，不挂 scroll 监听 ══
     route 的三段锚点是真实的分区边界，所以任何分区高度改动（含移动端的
     520vh→440vh）都自动跟随，不存在需要同步的常数。
     Route is computed from the sections' own rects once per frame - no scroll
     listener - so any change to section heights (including mobile's 520vh to
     440vh) is followed automatically with no constant to keep in sync. */
  const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x)
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
  let dirty = true
  applyRoute(cur)
  resize()

  const draw = () => renderer.render(scene, camera)
  draw()

  let raf = 0
  const frame = () => {
    raf = requestAnimationFrame(frame)
    const target = computeRoute()
    const d = target - cur
    // 阻尼跟随：与叙事区 scrub:0.6 的手感一致，滚动停下后自然收敛。
    // Damped follow matching the story's scrub:0.6 feel, converging once scrolling
    // stops.
    if (Math.abs(d) > 0.00015) {
      cur += d * 0.16
      dirty = true
    } else if (cur !== target) {
      cur = target
      dirty = true
    }
    if (!dirty) return
    dirty = false
    applyRoute(cur)
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
    // 逐帧核对用：滚动位置在无头环境里不可写，直接注入 route 才能截图比对。
    // For verification: scroll position is not writable in a headless pane, so the
    // route has to be injectable to screenshot specific beats.
    devApi = {
      // 注入 route 前必须先停表：渲染循环每帧都会把 cur 拉回滚动位置对应的值，
      // 不停表则注入的值撑不过一帧。/ The clock has to stop before injecting: the
      // render loop pulls cur back to the scroll-derived value every frame, so an
      // injected value would not survive one.
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
      /* 离屏抓帧：渲染到 RenderTarget 再读回像素。不用 preserveDrawingBuffer 是
         因为它对每一帧都收费，而这里只在核对时用一次；也不用 drawImage(canvas)，
         因为默认帧缓冲在呈现后即被清空，读到的会是一片透明。
         Offscreen capture via a render target and a pixel read-back. Not
         preserveDrawingBuffer, which taxes every frame for something used only
         when verifying; and not drawImage on the canvas, because the default
         framebuffer is cleared once presented and would read back empty. */
      shot(r: number, outW = 512) {
        devApi && (devApi as { set(x: number): void }).set(r)
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
        // readRenderTargetPixels 自下而上，ImageData 自上而下 / bottom-up vs top-down
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
      get: () => cur,
    }
    ;(window as unknown as Record<string, unknown>).__space = devApi
  }

  return {
    resize,
    dispose() {
      if (raf) cancelAnimationFrame(raf)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('resize', resize)
      renderer.domElement.remove()
      renderer.dispose()
      scene.traverse((o) => {
        const m = o as { geometry?: { dispose(): void }; material?: { dispose(): void } }
        m.geometry?.dispose()
        m.material?.dispose()
      })
      // 只在全局钩子仍然是自己装的那个时才摘：React StrictMode 会「挂载→卸载→
      // 再挂载」，无条件 delete 会让先挂载那次的 dispose 清掉后挂载那次刚装好的
      // 钩子（实测 window.__space 因此恒为 undefined）。
      // Only remove the global hook if it is still the one this instance
      // installed: StrictMode mounts, unmounts and mounts again, and an
      // unconditional delete lets the first instance's dispose wipe the hook the
      // second one just installed - measured, that left window.__space permanently
      // undefined.
      const w = window as unknown as Record<string, unknown>
      if (import.meta.env.DEV && devApi && w.__space === devApi) delete w.__space
    },
  }
}
