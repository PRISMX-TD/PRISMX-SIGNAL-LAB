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
/* 第二轮提权。上一轮把平均亮度从 14-22 提到 19-42，但实测「亮于 60 的像素」
   仍然只占整帧的 0.1-3.5% —— 也就是 96.5% 以上的画面都在 24% 亮度以下。暗色
   页面不等于把一切压进最暗的四分之一：整场唯一有存在感的还是那台被实光照着
   的手机，围绕它的空间仍然是水印。
   Second pass on weight. The previous round lifted the mean from 14-22 to 19-42,
   but measurement showed pixels brighter than 60 still made up only 0.1-3.5% of a
   frame - over 96.5% of the image sat below 24% brightness. A dark page does not
   mean pressing everything into the bottom quarter: the only thing with presence
   was still the phone under real light, and the space around it stayed a
   watermark. */
const C_BODY = 0x5c5c6b
const C_EDGE = 0xb4b4c2
const C_ENTRY = 0xa8a8b4
/* 通道轨改用 prism-400 而不是 prism-600。#5A22EE 满不透明度的亮度也只有 66，
   作为整幕的签名元素太弱；#8B6CFF 是同一套令牌里的下一级，亮度 124。
   The channel rails move from prism-600 to prism-400. #5A22EE tops out at a
   luminance of 66 even at full opacity, too weak for this act's signature element;
   #8B6CFF is the next step in the same token scale at 124. */
const C_TP = 0x8b6cff // prism-400
const C_SL = 0xa1a1aa
const C_WIN = 0x6e42ff // prism-500
const C_LOSS = 0xc4c4cc

/* ── 走廊尺寸 / corridor metrics ──
   世界单位没有物理含义，只需内部自洽：一根蜡烛间距 34，一段 13 根 = 408，
   段长 520 留出 112 的空档，四段从 z=-900 铺到 z=-2980。
   World units are arbitrary but internally consistent: candles every 34, thirteen
   per segment, 520 per segment leaving a 112 gap, four segments spanning -900 to
   -2980. */
const SEG_LEN = 880
/* 走廊起点从 -900 推到 -1500。实测在 -900 时，第一幕（相机还在 z≈+1100）就能
   透过雾看见走廊的紫色轨——那是在跟手机抢注意力。推远之后同样的雾密度下它降到
   若有若无，第一幕末尾才开始浮现，正好成为「下面还有东西」的预告。
   The corridor start moves from -900 to -1500. Measured at -900, the violet rails
   were already visible through the fog during act I with the camera still at
   z=+1100, competing with the phone. Pushed back, the same fog reduces them to a
   hint that only surfaces near the end of act I, which is exactly the foreshadow
   the transition wants. */
const Z0 = -1500
const CAND_DZ = 66
const CAND_PER_SEG = 11
/* 蜡烛从 9 加宽到 16、影线 1.6 加到 3：飞行中它们大多在 400-900 单位外，9 单位
   宽在 256px 的取样里连一个像素都占不满。/ Candles widened from 9 to 16 and wicks
   from 1.6 to 3: in flight they mostly sit 400-900 units out, where 9 units did not
   fill a single pixel. */
/* 蜡烛 16 → 46 宽。16 单位宽的柱子放在 640 宽的通道里是一根线，实测在 256px
   的取样里几乎不占像素——「行情本身」这个主角比配角还小。加粗到 46 之后它们
   才是从身边掠过的建筑，而不是远处的一条虚线。
   Candles from 16 to 46 wide. A 16-unit column inside a 640-wide channel is a
   thread and barely occupied a pixel in the 256px sampling - the protagonist was
   smaller than the set. At 46 they are architecture passing by. */
const CAND_W = 46
const WICK_W = 9
const FLOOR_Y = -260
/* 走廊整体抬到地面之上 420。上一版通道与地面网格只差 100 出头，两张网格叠在
   一起读成一片糊；抬开之后飞行时能从脚下的地板栅格里看见远低于自己的大地，
   画面才有「层」。第一幕与第四幕的相机高度因此完全不用动。
   The corridor is lifted 420 above the ground. It previously sat barely 100 above
   the floor grid and the two smeared into one another; separated, you can see the
   ground far below through the channel's own floor while flying, which is what
   gives the frame layers. Acts I and IV keep their camera heights unchanged. */
const CORRIDOR_Y = 420

/* 每段的止盈/止损高度与基准价。基准价逐段变化，走廊因此在飞行中阶梯升降。
   Take-profit / stop-loss heights and the base price per segment. The base steps
   between segments, which is what makes the corridor rise and fall as you fly. */
/* 止盈/止损高度整体放大约三倍。原来通道 64 高、640 宽，是 10:1 的扁缝：在里面
   飞，天花板和地板都远在画面上下缘之外，没有任何围合感。现在 200 高对 640 宽，
   约 3:1，才是一条隧道。
   The channel heights are scaled roughly threefold. At 64 tall against 640 wide it
   was a 10:1 slot: flying inside it, ceiling and floor sat off the top and bottom
   of frame and enclosed nothing. At 200 against 640, about 3:1, it is a tunnel. */
const SEGMENTS = [
  { base: 0, tp: 105, sl: -95, verdict: 'win' as const },
  { base: -95, tp: 95, sl: -105, verdict: 'loss' as const },
  { base: 80, tp: 100, sl: -100, verdict: 'both' as const },
  { base: -25, tp: 95, sl: -95, verdict: 'void' as const },
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
  const amp = 32
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
  /* 0.00052 → 0.00042，并同步提高各线的不透明度。实测整个空间的平均亮度只有
     14-22 / 255、峰值 47-140 —— 结构做对了，却按水印的强度在渲染。「颜料，不是
     光」禁的是自发光与辉光，不是把一切压到 6% 灰；实色线该有实色线的分量。
     Density from 0.00052 to 0.00042, with every line opacity raised alongside.
     Measured, the whole space averaged 14-22 out of 255 with peaks of 47-140: the
     structure was right but rendered at watermark strength. Pigment-not-glow bans
     emission and bloom, not rendering everything at 6% grey - a solid line is
     entitled to solid weight. */
  scene.fog = new THREE.FogExp2(IE_BG, 0.00034)

  const camera = new THREE.PerspectiveCamera(34, 1, 8, 6500)

  /* ══ 地面网格 ══
     一张平面 + 一组发丝线。它不是装饰：整个第一幕里，观众判断「我在一个空间
     里」的全部依据就是这张地面的透视收敛。
     A plane plus a set of hairlines. Not decoration: throughout act I this grid's
     perspective convergence is the entire basis for reading the scene as a place. */
  /* 全场材质登记表。第一幕只该有地面与手机，判定幕只该有走廊——同屏出现两套
     大型网格就是截图里那片眼花的直接来源。所以两者按 route 互相让位：不是靠
     距离和雾去「碰巧看不见」（那正是第一张截图里走廊变成一个悬空线框盒子的
     原因），而是明确地开关。
     A material registry. Act I should hold only the ground and the phone, and the
     verdict act only the corridor: two large grids sharing a frame is the direct
     source of the clutter in the screenshot. So they yield to each other by route -
     explicitly, rather than relying on distance and fog to happen to hide one, which
     is exactly how the corridor became a wireframe box floating beside the phone in
     the first screenshot. */
  const gridMats: TH.LineBasicMaterial[] = []
  const corridorMats: { m: TH.Material; o: number }[] = []
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
    const X = 3000
    const ZA = 1800
    const ZB = -7400
    for (let x = -X; x <= X; x += 150) pts.push(x, FLOOR_Y, ZA, x, FLOOR_Y, ZB)
    for (let z = ZA; z >= ZB; z -= 150) pts.push(-X, FLOOR_Y, z, X, FLOOR_Y, z)
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
    const gm = new THREE.LineBasicMaterial({ color: C_GRID, transparent: true, opacity: 0.6 })
    gridMats.push(gm)
    gridGroup.add(new THREE.LineSegments(g, gm))
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
  const ribPts: number[] = []
  const voidRibPts: number[] = []

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
  /* ══ 减线 ══
     上一版每个平面有 7 条纵轨、每 66 单位一根横档，再加每 132 一道肋架，两个
     平面叠起来是五套互相冲突的线阵——截图里读到的是「眼花」，不是「震撼」。
     震撼来自一个巨大而简单的形，加上周围的空；复杂只会稀释它。
     现在每个平面只剩**两条纵轨**（像夜路的两条边线，两条平行线在透视里就已经
     是一个平面），横档拉稀到 220，肋架整个退化成「每段一道门」。整条走廊的
     线数降到约四分之一，蜡烛因此从背景噪声里浮出来成为唯一的纹理。
     The previous version gave each plane seven longitudinal rails plus a rung every
     66 units, with a rib every 132 on top - two planes' worth stacking into five
     competing line fields. The screenshot reads as clutter, not awe. Awe comes from
     one enormous simple form surrounded by emptiness; complexity only dilutes it.
     Each plane now keeps just TWO rails - like the edge lines of a night road, two
     parallel lines already being a plane once perspective has them - rungs thin out
     to every 220, and the ribs collapse into one gate per segment. Line count drops
     to roughly a quarter, which lets the candles surface as the only texture. */
  const railHalf = 320
  const RAIL_X = [-320, 320]
  const pushPlane = (into: number[], y: number, zA: number, zB: number) => {
    for (const x of RAIL_X) into.push(x, y, zA, x, y, zB)
    for (let z = zA - 110; z >= zB; z -= 220) into.push(-railHalf, y, z, railHalf, y, z)
  }
  /* 肋架：每 RIB_DZ 一道贯通上下的矩形框，把「上下两片网格」变成「一条隧道」。
     它同时承担速度感——飞行中真正从身边掠过、能被数出来的就是这些框。
     A rib every RIB_DZ: a rectangle bridging ceiling and floor that turns two flat
     grids into a tunnel, and carries the sense of speed, since these are the things
     that actually sweep past and can be counted. */
  /* 门：每段开头一道完整矩形。四段 = 四道门，穿过一道就是一个新信号开始——
     数量少到可以被数出来，所以它是事件；每 132 一道的时候它只是纹理。
     A gate: one complete rectangle at each segment's start. Four segments, four
     gates, and passing one means a new signal begins - few enough to be counted, so
     each is an event. At one every 132 units they were merely texture. */
  const pushGate = (into: number[], tpY: number, slY: number, z: number) => {
    into.push(-railHalf, slY, z, -railHalf, tpY, z)
    into.push(railHalf, slY, z, railHalf, tpY, z)
    into.push(-railHalf, tpY, z, railHalf, tpY, z)
    into.push(-railHalf, slY, z, railHalf, slY, z)
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
      pushGate(voidRibPts, tpY, slY, zA + 14)
    } else {
      pushPlane(tpPts, tpY, zA + 14, zB)
      pushPlane(slPts, slY, zA + 14, zB)
      pushGate(ribPts, tpY, slY, zA + 14)
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
      const h = Math.max(7, top - bot)
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

      const wh = Math.max(3, seg.base + c.h - (seg.base + c.l))
      const w = new THREE.BoxGeometry(WICK_W, wh, WICK_W)
      w.translate(0, seg.base + (c.h + c.l) / 2, z)
      ;(isLast && seg.verdict !== 'void' ? bucket : wickGeos).push(w)
    })
  })

  /* 尾声：第四段之后再延出一段只有轨与肋、没有蜡烛的通道。
     四条规则的顺序由文案定死（赢 / 输 / 双触 / 数据中断），所以这一幕天然结束
     在「不计入统计」那段——它按设计就是最暗的：没有紫色、蜡烛缺一块。实测
     覆盖率 36 → 34.7 → 27.2 → 9.5，最后一拍是整幕最空的一帧，等于在最弱的地方
     收尾。延出这段尾声之后，出口画面重新被收敛的结构填满，同时它说的是实话：
     通道还在往前走，信号一个接一个。
     An epilogue: a further stretch of channel past segment four with rails and ribs
     but no candles. The order of the four rules is fixed by the copy (win, loss,
     both touched, data outage), so the act necessarily ends on "excluded from
     stats" - which is by design the dimmest one, with no violet and a hole in the
     candles. Measured, coverage ran 36 to 34.7 to 27.2 to 9.5: the closing beat was
     the emptiest frame of the act, ending on its weakest moment. With the epilogue
     the exit frame fills with converging structure again, and it states something
     true: the channel keeps going, one signal after the next. */
  {
    const last = SEGMENTS[SEGMENTS.length - 1]
    const zA = Z0 - SEGMENTS.length * SEG_LEN + 60
    const zB = zA - 1500
    pushPlane(tpPts, last.base + last.tp, zA, zB)
    pushPlane(slPts, last.base + last.sl, zA, zB)
    entryPts.push(0, last.base, zA, 0, last.base, zB)
  }

  const flat = (color: number, opacity = 1) => {
    const m = new THREE.MeshBasicMaterial({ color, transparent: true, opacity })
    corridorMats.push({ m, o: opacity })
    return m
  }
  const line = (color: number, opacity: number) => {
    const m = new THREE.LineBasicMaterial({ color, transparent: true, opacity })
    corridorMats.push({ m, o: opacity })
    return m
  }

  const addMerged = (geos: TH.BufferGeometry[], mat: TH.Material, edge?: number) => {
    if (!geos.length) return
    const merged = mergeGeometries(geos, false)
    geos.forEach((g) => g.dispose())
    if (!merged) return
    corridor.add(new THREE.Mesh(merged, mat))
    if (edge != null) {
      corridor.add(
        new THREE.LineSegments(new THREE.EdgesGeometry(merged, 30), line(edge, 1))
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
  addLines(tpPts, line(C_TP, 1))
  addLines(slPts, line(C_SL, 0.92))
  addLines(ribPts, line(C_ENTRY, 0.72))
  /* 中断段的轨从 0.3 提到 0.52。减线之后实测这一拍覆盖率从 27.2% 塌到 6.8%，
     成了一个洞——而这条规则说的是「不计入统计」，不是「不存在」。通道照旧
     划出，只是比别的段暗、且中间缺一段蜡烛。
     The outage segment's rails go from 0.3 to 0.52. After the line cut this beat
     measured a collapse from 27.2% coverage to 6.8%, turning into a hole - but the
     rule says excluded from the statistics, not absent. The channel is still drawn,
     merely dimmer than its neighbours and missing a run of candles. */
  addLines(voidPts, line(C_SL, 0.52))
  addLines(voidRibPts, line(C_SL, 0.42))
  addLines(entryPts, line(C_ENTRY, 0.85))
  addLines(railPts, line(C_ENTRY, 0.7))
  corridor.position.y = CORRIDOR_Y

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
    /* 抵达走廊入口的**正上方**，然后垂直俯冲进去。第一幕结尾相机在地面之上
       320，入口在 420+，两者相差近 400 —— 这一段是整页唯一的一次高度落差，
       「掉进去」的那一下就是这一幕的开场。
       Arriving directly above the corridor mouth and then diving in. Act I ends with
       the camera 320 above the ground while the mouth sits above 420, a drop of
       nearly 400 - the one height change on the whole page, and that fall is this
       act's opening. */
    { r: 1.0, p: [0, 700, -700], l: [-60, 470, -1560], fov: 38 },
    /* 走廊偏航方向。桌面端文字面板固定在左侧（left: 7vw，宽 26rem），实测原来
       那组「相机在 +x、看向 -x」的取向把走廊整个压在面板身后：面板区域覆盖率
       40.9%，画面其余部分只有 16%，左右像素比 2:1。镜像之后走廊让到右侧，
       左边留给文字——这不是构图偏好，是可读性。
       Corridor yaw. The desktop text panel is pinned left (7vw, 26rem wide) and the
       original "camera at +x looking toward -x" orientation put the whole corridor
       behind it: 40.9% coverage inside the panel box against 16% for the rest of
       the frame, a 2:1 left/right pixel split. Mirrored, the corridor moves right
       and the left is left for type. Not a compositional preference, legibility. */
    /* 偏航从 9.1° 收到 5°，fov 从 52 收到 46。
       正对着看的隧道最有纪念碑感，偏得越多越像「从旁边路过一个结构」；而宽
       视场只是把更多东西塞进同一帧，与「要震撼不要复杂」正好相反。左侧文字
       靠那道近乎实色的遮罩护住就够了，不必再靠把主体推开来让位。
       Yaw drops from 9.1 to 5 degrees and the FOV from 52 to 46. A tunnel viewed
       head-on is the monumental one; the more it is yawed the more it reads as
       passing alongside a structure. And a wide lens only crams more into the same
       frame, which is the opposite of wanting awe rather than complexity. The
       near-opaque scrim is enough to protect the type on the left without also
       shoving the subject aside. */
    { r: 1.12, p: [-30, 452, -1400], l: [30, 424, -2010], fov: 48 },
    /* 四段各对应一条规则，相机高度跟着该段的基准价升降（段基准 0 / -95 / +80
       / -25，加上 CORRIDOR_Y 的 420）。走廊在飞行中阶梯升降，正是「一个接一个
       的信号，各有各的止盈止损」。
       One segment per rule, the camera tracking each segment's base price (0, -95,
       +80, -25, plus the 420 lift). The corridor stepping up and down as you fly IS
       "one signal after another, each with its own levels". */
    { r: 1.34, p: [-30, 424, -1880], l: [30, 404, -2480], fov: 46 },
    { r: 1.56, p: [-30, 330, -2700], l: [30, 318, -3300], fov: 46 },
    { r: 1.78, p: [-30, 502, -3560], l: [30, 500, -4160], fov: 46 },
    /* 第四拍的机位往回挪 160。中断段的蜡烛缺口落在 -4470 到 -4668，原来相机
       正好停在缺口里往缺口看，实测这一拍覆盖率只有 6.8%（前一拍 27.7%）——
       整幕的最后一眼是一片空。挪到缺口之前，读法就对了：身边是这个信号的前
       几根 K 线，正前方是那段空白，再往前尾声通道继续收敛。
       The fourth beat's camera moves back 160. The outage segment's candle gap spans
       -4470 to -4668 and the camera had been parked inside it looking into it, which
       measured 6.8% coverage against the previous beat's 27.7% - the act's last look
       was at nothing. Moved ahead of the gap it reads correctly: this signal's first
       candles alongside, the blank stretch straight ahead, and the epilogue channel
       converging past it. */
    { r: 1.95, p: [-30, 396, -4280], l: [30, 388, -4900], fov: 46 },
    // 拔升脱离，落进一片安静的开阔地 / pulling up and out into open ground
    /* 出走廊不是平移出去，是**拔升**：相机从通道里升到 950，尾声那段轨从画面
       下缘滑过。同一段滚动里 fov 从 50 收到 42，两者叠起来读成「爬升脱离」，
       而不是「场景淡出」。
       Leaving the corridor is a CLIMB, not a slide: the camera rises from inside the
       channel to 950 while the epilogue rails sweep past the bottom of frame. The
       FOV narrows from 50 to 42 over the same stretch, and the two together read as
       pulling up and away rather than as the scene fading out. */
    { r: 2.06, p: [-20, 950, -5060], l: [30, 430, -5760], fov: 46 },
    { r: 2.24, p: [0, 420, -5560], l: [20, 120, -6320], fov: 40 },
    { r: 3.0, p: [0, 80, -5960], l: [0, -26, -6820], fov: 36 },
  ]
  const smooth = (x: number) => x * x * (3 - 2 * x)
  const _p = new THREE.Vector3()
  const _l = new THREE.Vector3()
  /* 相机在关键帧之外还带一份**持续微动**：一组极慢的正弦漂移，加上桌面端的
     指针视差。这两者都不改变剧情，只解决一件事——滚动停下时，一个完全静止的
     3D 场景读起来就是一张图，而不是一个地方。位移写在相机位置上、注视点不动，
     所以近处的肋架比远处的走廊移动得多，是真视差而不是整体平移。
     Beyond the keyframes the camera carries a continuous micro-motion: a very slow
     sine drift plus pointer parallax on desktop. Neither changes the story; they
     solve one thing - a completely frozen 3D scene reads as a picture rather than a
     place the moment scrolling stops. The offset is applied to the camera position
     with the look target held, so near ribs move more than the far corridor: real
     parallax, not a pan. */
  const applyRoute = (r: number, ox = 0, oy = 0) => {
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
    _p.x += ox
    _p.y += oy
    camera.position.copy(_p)
    camera.lookAt(_l)
    /* 第三、四幕加雾。提权之后实测 route 2.6-3.0 的近处地面线亮到 133-167，
       而那正是定价、FAQ、页脚——整页阅读量最大的一段，身后不该有这个强度的
       网格。用雾密度收（0.00034 → 0.0009）而不是调透明度，因为雾只压远处、
       近处该亮仍然亮，读起来是「起雾了」而不是「有人把灯关小」。
       这同时正好是第四幕本来的意图：主动退出 3D，把最后一屏交还给可读性。
       Haze rises through acts III and IV. After the weight increase, the near floor
       lines measured 133-167 at routes 2.6 to 3.0 - which is pricing, the FAQ and
       the footer, the most reading-heavy stretch of the page, and no grid belongs
       behind it at that strength. Done with fog density (0.00034 to 0.0009) rather
       than opacity, because fog only suppresses distance while near things stay as
       bright as they should be: it reads as haze rolling in, not as someone turning
       the lights down. It is also exactly what act IV was always meant to do -
       deliberately step out of the 3D and hand the last screens back to legibility. */
    /* 一次只有一个主体。走廊在 0.92 之前完全不存在（第一幕只有地面与手机），
       地面在进走廊后压到几乎为零（判定幕只有走廊悬在黑里），出走廊后两者对调
       回来。这比调雾、调距离都干脆——截图里那两个毛病本质上是同一个：同屏
       出现了两个主体。
       One subject at a time. The corridor does not exist at all before 0.92, so act
       I holds only the ground and the phone; the ground drops to near zero once
       inside, so the verdict act holds only the corridor hanging in black; and the
       two swap back on the way out. Cleaner than tuning fog or distance - both
       faults in the screenshots were the same fault, two subjects in one frame. */
    /* 两条淡入淡出**错开**，中间留一拍近乎全黑：地面先退（0.86-0.98），走廊后
       进（1.00-1.16）。同时交叉会在 route 1.0 附近出现两者各一半的一帧——实测
       那一帧覆盖率 16.8%、均值只有 20，既不是地面也不是走廊，正是要避免的
       「两个主体」。先切黑再亮起，是这一幕最省力也最有效的一次强调。
       The two fades are OFFSET with a near-black beat between them: the ground
       leaves over 0.86-0.98 and the corridor arrives over 1.00-1.16. Cross-fading
       them produced a frame around route 1.0 that was half of each - measured at
       16.8% coverage and a mean of 20, neither ground nor corridor, exactly the two
       subjects problem. Cutting to black before the reveal is the cheapest and
       strongest emphasis this act has. */
    const inCorridor = smooth(Math.max(0, Math.min(1, (r - 1.0) / 0.16)))
    const outCorridor = smooth(Math.max(0, Math.min(1, (r - 2.04) / 0.24)))
    const corridorK = inCorridor * (1 - outCorridor)
    const groundK = 1 - smooth(Math.max(0, Math.min(1, (r - 0.86) / 0.12))) * (1 - outCorridor * 0.94)
    for (const cm of corridorMats) (cm.m as TH.Material & { opacity: number }).opacity = cm.o * corridorK
    for (const gm of gridMats) gm.opacity = 0.6 * groundK

    const haze = smooth(Math.max(0, Math.min(1, (r - 1.98) / 0.62)))
    if (scene.fog) (scene.fog as TH.FogExp2).density = 0.00034 + haze * 0.00056
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
  /* 指针视差只在有精确指针的设备上接线：触屏上 pointermove 会在滚动中持续触发，
     那不是「看向别处」，接上去只会让画面跟着手指抖。
     Pointer parallax is only wired up where a fine pointer exists: on touch,
     pointermove fires continuously during scrolling, which is not "looking around"
     and would just make the frame jitter under the finger. */
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
    // 阻尼跟随：与叙事区 scrub:0.6 的手感一致，滚动停下后自然收敛。
    // Damped follow matching the story's scrub:0.6 feel, converging once scrolling
    // stops.
    const d = target - cur
    cur = Math.abs(d) > 0.00015 ? cur + d * 0.16 : target
    ptr.x += (ptrT.x - ptr.x) * 0.05
    ptr.y += (ptrT.y - ptr.y) * 0.05
    const t = performance.now() / 1000
    /* 每帧都画，不再做「没变就跳过」。整场合并后不到 10 个 draw call、几千个
       顶点，持续出帧的代价远小于「页面看起来是一张截图」的代价。标签页切到
       后台仍然停表。
       Drawing every frame now, with no skip-if-unchanged. The whole scene is under
       ten draw calls and a few thousand vertices, and the cost of sustaining that is
       far below the cost of the page looking like a screenshot. The clock still
       stops when the tab goes to the background. */
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
      if (onPointer) window.removeEventListener('pointermove', onPointer)
      renderer.domElement.remove()
      renderer.dispose()
      scene.traverse((o) => {
        const m = o as { geometry?: { dispose(): void }; material?: { dispose(): void } }
        m.geometry?.dispose()
        m.material?.dispose()
      })
      /* DEV 钩子不再在 dispose 里摘除。StrictMode 的「挂载→卸载→再挂载」让
         两个实例的装/摘顺序不确定，之前那版按身份比对仍然会偶发地被先挂载的
         那次清掉（实测 window.__space 时有时无）。这是只在开发构建里存在的
         核对工具，留一个悬空引用无害，比一个时灵时不灵的探针有用得多。
         The DEV hook is no longer removed on dispose. StrictMode's mount, unmount,
         mount leaves the install and removal order between the two instances
         undetermined, and even the identity-checked version was intermittently
         wiped by the first instance (measured: window.__space present only some
         reloads). This is a verification tool that exists in dev builds only; a
         dangling reference is harmless and far more useful than a probe that works
         half the time. */    },
  }
}
