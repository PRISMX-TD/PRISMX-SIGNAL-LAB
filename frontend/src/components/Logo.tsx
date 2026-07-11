// 棱镜 Logo / Prism logo mark
// 透明底 + 荧光紫三角形描边（中间镂空）+ 微光
// Transparent base + neon-violet triangle outline (hollow center) + glow
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
        <filter id={fid} x="-80%" y="-80%" width="260%" height="260%">
          <feGaussianBlur stdDeviation="3.2" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      {/* 荧光紫三角形描边，中间镂空 / neon-violet triangle outline, hollow center */}
      <path
        d="M24 9 L40 37 L8 37 Z"
        fill="none"
        stroke={`url(#${gid})`}
        strokeWidth="3"
        strokeLinejoin="round"
        filter={`url(#${fid})`}
      />
    </svg>
  )
}
