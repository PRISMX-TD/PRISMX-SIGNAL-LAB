// 全局氛围背景：网格 + 浮动霓虹光球 / ambient background: grid + floating neon orbs
export default function AuroraBackground() {
  return (
    <div className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
      {/* 棱镜网格 / prism grid */}
      <div className="absolute inset-0 bg-prism-grid bg-[size:46px_46px] opacity-15" />
      {/* 浮动霓虹光球 / floating neon orbs */}
      <div className="absolute -left-40 top-0 h-[28rem] w-[28rem] rounded-full bg-prism-600/10 blur-[120px] animate-float-slow" />
      <div className="absolute right-[-10rem] top-1/4 h-[26rem] w-[26rem] rounded-full bg-prism-500/06 blur-[120px] animate-float" />
      <div className="absolute bottom-[-8rem] left-1/3 h-[24rem] w-[24rem] rounded-full bg-prism-700/06 blur-[120px] animate-float-slow" />
      {/* 顶部柔光 / top vignette */}
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-prism-500/40 to-transparent" />
    </div>
  )
}
