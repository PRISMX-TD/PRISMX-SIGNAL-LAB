// 奖品的小圆章：有图用图，没图用该格颜色 + 种类图标（与转盘上同一套），奖品一览、揭晓卡、我的奖品共用，
// 让用户一眼对上「转盘上哪一格」。
// A prize's round badge: its image if any, otherwise the slot colour plus the kind glyph used on the wheel.
// Shared by the prize list, the reveal card and My prizes so a user can match it to its slot at a glance.
import type { LuckyPrizeKind } from '../../api/luckyTypes'
import { KIND_GLYPH, STROKE_GLYPH, labelInk } from './wheelArt'

export default function PrizeArt({ kind, color, imageUrl, size = 36, muted = false }: {
  kind: LuckyPrizeKind; color: string; imageUrl?: string | null; size?: number; muted?: boolean
}) {
  const fill = muted ? '#2A2A33' : color
  const ink = muted ? '#9C9CA6' : labelInk(fill)
  if (imageUrl && !muted) {
    return (
      <span className="lk-art" style={{ width: size, height: size, background: fill }}>
        <img src={imageUrl} alt="" loading="lazy" />
      </span>
    )
  }
  const glyph = KIND_GLYPH[kind] ?? KIND_GLYPH.none
  return (
    <span className="lk-art" style={{ width: size, height: size, background: fill }} aria-hidden>
      <svg viewBox="-12 -12 24 24" width="58%" height="58%">
        <path d={glyph} {...(STROKE_GLYPH[kind]
          ? { fill: 'none', stroke: ink, strokeWidth: 1.6, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }
          : { fill: ink })} />
      </svg>
    </span>
  )
}
