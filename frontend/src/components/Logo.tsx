// 棱镜 Logo / Prism logo mark
// 黑底圆角方块 + 荧光紫三角形描边（中间镂空）+ 微光
// Black rounded square + neon-violet triangle outline (hollow center) + glow
export default function Logo({ size = 32 }: { size?: number }) {
  const gid = 'prismTri'
  const fid = 'prismGlow'
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" aria-hidden>
      <defs>
        <linearGradient id={gid} x1="8" y1="6" x2="40" y2="42" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#c8a8ff" />
          <stop offset="0.5" stopColor="#a855f7" />
          <stop offset="1" stopColor="#7c3aed" />
        </linearGradient>
        <filter id={fid} x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur stdDeviation="1.6" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      {/* 纯黑圆角底 / pure black rounded base */}
      <rect x="1" y="1" width="46" height="46" rx="12" fill="#000000" stroke="rgba(167,121,255,0.25)" strokeWidth="1" />
      {/* 荧光紫三角形描边，中间镂空 / neon-violet triangle outline, hollow center */}
      <path
        d="M24 9 L40 37 L8 37 Z"
        fill="none"
        stroke={`url(#${gid})`}
        strokeWidth="2.6"
        strokeLinejoin="round"
        filter={`url(#${fid})`}
      />
    </svg>
  )
}
