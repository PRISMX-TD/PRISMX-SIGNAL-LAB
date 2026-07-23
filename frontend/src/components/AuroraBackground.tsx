// 全局氛围背景：网格 + 浮动霓虹光球 / ambient background: grid + floating neon orbs
export default function AuroraBackground() {
  return (
    <div className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
      {/* 棱镜网格 / prism grid */}
      <div className="absolute inset-0 bg-prism-grid bg-[size:46px_46px] opacity-10" />
      {/* 浮动极光光球：紫→靛→青三色谱系，玻璃卡有内容可透才成立
          floating aurora orbs in a violet→indigo→cyan spectrum — the glass
          cards only earn their blur when there is color behind them.
          transform-gpu + will-change 把每个光球提升到独立合成层，让 120px 模糊
          只在图层创建时算一次、动画期间由 GPU 复用，避免每帧重算模糊拖慢滚动；
          手机端低电量/减少动态偏好下会由全局 CSS 暂停这些动画。
          transform-gpu + will-change promote each orb to its own compositor
          layer, so the 120px blur is rasterized once and reused by the GPU
          during the animation instead of being recomputed every frame (which
          would jank scrolling). Global CSS pauses these under reduced-motion. */}
      <div className="transform-gpu will-change-transform absolute -left-40 top-0 h-[28rem] w-[28rem] rounded-full bg-[#7c3aed]/[0.16] blur-[120px] animate-float-slow" />
      <div className="transform-gpu will-change-transform absolute right-[-10rem] top-1/4 h-[26rem] w-[26rem] rounded-full bg-[#3b5bdb]/[0.13] blur-[120px] animate-float" />
      <div className="transform-gpu will-change-transform absolute bottom-[-8rem] left-1/3 h-[24rem] w-[24rem] rounded-full bg-[#14a4bb]/[0.11] blur-[120px] animate-float-slow" />
      {/* 顶部柔光 / top vignette */}
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-prism-500/40 to-transparent" />
    </div>
  )
}
