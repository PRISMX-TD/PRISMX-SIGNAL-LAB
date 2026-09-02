// frontend/src/components/badges/BadgeIcon.tsx
// 17 枚勋章矢量图形。禁止 emoji（产品要求）。稀有度=底座材质，id=中央图形。
// 初版为几何 glyph，后续设计稿只替换 GLYPHS 路径，接口不变。
const RARITY_COLORS: Record<string, [string, string]> = {
  common: ['#8a8f98', '#5b5e66'], rare: ['#4f7cff', '#274a99'],
  epic: ['#a24bf3', '#5c2b8a'], legendary: ['#e8b54d', '#8a6a2a'],
  limited: ['#e8b54d', '#8a6a2a'],
}

// 每枚一个独立中央图形（viewBox 0 0 24 24，stroke 风格与站内 TabIcon 一致）
const GLYPHS: Record<string, JSX.Element> = {
  profile_complete: <path d="M12 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm-5 8c0-2.8 2.2-5 5-5s5 2.2 5 5" />,
  first_close: <path d="M5 12h14M13 6l6 6-6 6" />,
  first_real_trade: <path d="M4 17l5-5 3 3 7-8M16 7h4v4" />,
  comp_finisher: <path d="M6 4h12v4a6 6 0 0 1-12 0V4ZM9 20h6M12 14v6" />,
  evergreen_3m: <path d="M12 4l3 5h-2l3 5h-2l3 5H7l3-5H8l3-5H9l3-5Z" />,
  discipline_90_7: <path d="M12 3l7 4v5c0 4-3 7-7 9-4-2-7-5-7-9V7l7-4ZM9 12l2 2 4-4" />,
  hundred_wins: <path d="M7 4v7a5 5 0 0 0 10 0V4M4 6h3M17 6h3M12 16v4M8 20h8" />,
  midas_touch: <path d="M12 3l2.4 5 5.6.7-4 3.9.9 5.4-4.9-2.6L7.1 18l.9-5.4-4-3.9L9.6 8 12 3Z" />,
  profit_factor_2: <path d="M4 16l5-6 4 3 7-9M4 20h16" />,
  evergreen_6m: <path d="M12 3l3.5 6h-2.3l3.3 6h-2.2l3.2 6H6.5l3.2-6H7.5l3.3-6H8.5L12 3Z" />,
  discipline_90_30: <path d="M12 3l7 4v5c0 4-3 7-7 9-4-2-7-5-7-9V7l7-4ZM12 8v5l3 2" />,
  no_bad_sl_50: <path d="M6 20V10l6-6 6 6v10M9 20v-6h6v6" />,
  comp_podium: <path d="M3 20v-6h6v6M9 20V8h6v12M15 20v-9h6v9" />,
  evergreen_12m: <path d="M12 2l4 7h-2.6l3.6 7h-2.4l3.4 6H6l3.4-6H7l3.6-7H8l4-7Z" />,
  comp_winner: <path d="M12 3l2 4 4.5.6-3.3 3.2.8 4.5L12 13l-4 2.3.8-4.5L5.5 7.6 10 7l2-4ZM12 16v5" />,
  comp_back_to_back: <path d="M8 4l1.5 3 3.5.5-2.5 2.4.6 3.5L8 11.7 4.9 13.4l.6-3.5L3 7.5 6.5 7 8 4Zm8 6l1.5 3 3.5.5-2.5 2.4.6 3.5-3.1-1.7-3.1 1.7.6-3.5L11 13.5l3.5-.5L16 10Z" />,
  founder_2026: <path d="M12 3v3M12 18v3M3 12h3M18 12h3M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z" />,
}

export default function BadgeIcon({ id, rarity, earned, size = 56 }: {
  id: string; rarity: string; earned: boolean; size?: number
}) {
  const [hi, lo] = RARITY_COLORS[rarity] ?? RARITY_COLORS.common
  const gid = `bg-${id}`
  return (
    <svg width={size} height={size} viewBox="0 0 48 48"
         style={earned ? undefined : { filter: 'grayscale(1) opacity(0.45)' }}>
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor={hi} /><stop offset="100%" stopColor={lo} />
        </linearGradient>
      </defs>
      {rarity === 'limited' && (
        <circle cx="24" cy="24" r="22.5" fill="none" stroke={hi}
                strokeWidth="1.4" strokeDasharray="2.5 3" />
      )}
      <circle cx="24" cy="24" r="19" fill="var(--surface, #1b1b21)"
              stroke={`url(#${gid})`} strokeWidth="2.6" />
      <g transform="translate(12 12)" fill="none" stroke={`url(#${gid})`}
         strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        {GLYPHS[id] ?? <circle cx="12" cy="12" r="7" />}
      </g>
    </svg>
  )
}
