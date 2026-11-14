// 环境背景 / ambient background
//
// 此前这里是三颗 120px 模糊的漂浮霓虹光球（紫 → 靛 → 青），配 float/float-slow
// 无限动画。移除的理由有三条，审美只占其中一条：
//
//  1. 视觉：漂浮彩色光球是 LLM 生成页面最容易辨认的背景签名，而且紫/靛/青三色
//     光球会给每一块前景卡片染上一层随位置变化的色偏——同一张卡在页面上下滚动
//     时颜色是会变的，这让所有卡片的对比度都不可控。
//  2. 性能：120px 模糊 + 无限位移是移动端最贵的一类持续合成。即使提升到独立
//     图层，每帧仍要重新合成三张接近半屏大小的纹理，中端安卓上直接吃掉滚动帧率。
//  3. 依据：光球存在的唯一理由，是让半透明玻璃卡「有东西可透」。卡片材质已经
//     改成实色面（见 index.css 的 .glass），透光的需求本身没有了。
//
// 取而代之的是**完全静态**、零模糊、零动画的结构层：一张极低对比的网格，加一条
// 顶端的光谱线（品牌签名图形）。它不重绘、不合成、不染色，只负责让纯黑画布不
// 显得是一块空白。
//
// This used to render three 120px-blurred floating neon orbs (violet → indigo →
// cyan) on infinite float animations. Three reasons for removing them, only one
// of which is aesthetic:
//
//  1. Visual: drifting coloured orbs are the most recognisable background
//     signature of LLM-generated pages, and three differently-hued orbs tint
//     every foreground card by a position-dependent amount — the same card
//     literally changed colour as it scrolled, which made card contrast
//     impossible to control.
//  2. Performance: a 120px blur under infinite translation is the most expensive
//     class of continuous compositing on mobile. Even promoted to its own layer,
//     three near-half-screen textures had to be recomposited every frame, which
//     ate the scroll framerate on mid-range Android.
//  3. Justification: the orbs existed so the translucent glass cards would have
//     something to see through. The card material is now an opaque plane (see
//     .glass in index.css), so the need they served no longer exists.
//
// What replaces them is a fully static, zero-blur, zero-animation structural
// layer: a very low-contrast grid plus one spectral rule at the top edge (the
// brand's signature graphic). It never repaints, never recomposites and never
// tints anything — it just keeps a pure-black canvas from reading as blank.
export default function AuroraBackground() {
  return (
    <div className="pointer-events-none fixed inset-0 -z-10 overflow-hidden" aria-hidden="true">
      {/* 2026-11-15 起去掉了 46px 结构网格（连同顶端渐隐）：卡片、图表都有自己的网格，
          三层叠在一起像方格纸。层次只靠卡片灰阶和细线。
          Since 2026-11-15 the 46px structural grid (and its top fade) is gone: cards
          and charts carry their own grids, and three layers of them read as graph
          paper. Depth comes from card greys and hairlines only. */}
      {/* 品牌签名：光谱线。一条 1px 发丝线裂成三条微偏移色带——棱镜色散的平面化
          表达。整个 App 只在这一处出现。
          Brand signature: the spectral rule, a 1px hairline splitting into three
          micro-offset bands — dispersion rendered as flat print. It appears
          exactly once in the whole app. */}
      <div className="rule-spectral absolute inset-x-0 top-0">
        <i />
      </div>
    </div>
  )
}
