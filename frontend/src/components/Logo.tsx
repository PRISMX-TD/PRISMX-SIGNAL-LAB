// 棱镜 Logo / Prism logo mark
export default function Logo({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" aria-hidden>
      <defs>
        <linearGradient id="prismG" x1="0" y1="0" x2="48" y2="48">
          <stop offset="0" stopColor="#c4a8ff" />
          <stop offset="0.5" stopColor="#8b46ff" />
          <stop offset="1" stopColor="#6320d6" />
        </linearGradient>
      </defs>
      <path d="M24 4 L42 38 L6 38 Z" stroke="url(#prismG)" strokeWidth="2.5" fill="rgba(139,70,255,0.08)" strokeLinejoin="round" />
      <path d="M24 4 L24 38" stroke="url(#prismG)" strokeWidth="1.5" opacity="0.6" />
      <path d="M30 21 L46 14" stroke="#c4a8ff" strokeWidth="1.5" opacity="0.9" />
      <path d="M30 24 L46 24" stroke="#a779ff" strokeWidth="1.5" opacity="0.8" />
      <path d="M30 27 L46 34" stroke="#7a2fff" strokeWidth="1.5" opacity="0.7" />
    </svg>
  )
}
