// frontend/src/components/badges/RankCoin.tsx
//
// 名次徽标：一枚小铸币，刻着名次数字。材质按名次——金/银/铜对应 1/2/3 名，
// 其余（4+、未上榜的"我的名次"卡）用石墨。直接借用 medal.ts 里 MAT 表的
// rim 三色渐变（legendary=足金、rare=银、limited=青铜火漆、common=石墨），
// 与勋章墙用的是同一套材质语言，不另起一份配色。
// 几何/纹理照抄设计稿（leaderboard-design.html）的 coin() 函数：60 道边缘
// 齿纹 + 双层圆环倒角 + 居中数字，纯装饰、不含用户输入，dangerouslySetInnerHTML
// 是安全的（同 medal.ts 顶部说明的理由）。
//
// Rank coin: a small struck coin engraved with the rank number. Material by
// rank — gold/silver/bronze for 1st/2nd/3rd, graphite for everything else
// (4+, and the unranked "my rank" card). Borrows the rim gradient triples
// straight from medal.ts's MAT table (legendary/rare/limited/common) so it
// speaks the same material language as the badge wall, rather than a
// separate palette.
// Geometry/texture ported verbatim from the design board's coin() function:
// 60 rim ticks + a two-ring bevel + a centered numeral — purely decorative,
// no user input, so dangerouslySetInnerHTML is safe (same rationale as the
// top of medal.ts).
import { useId } from 'react'
import { MAT } from './medal'

interface Props {
  rank: number
  size?: number
  className?: string
}

const RIM_BY_RANK: Record<number, readonly [string, string, string]> = {
  1: MAT.legendary.rim,
  2: MAT.rare.rim,
  3: MAT.limited.rim,
}
const GRAPHITE = MAT.common.rim

function ticksMarkup(): string {
  let t = ''
  for (let i = 0; i < 40; i++) {
    t += `<line x1="32" y1="4" x2="32" y2="6.5" transform="rotate(${i * 9} 32 32)"/>`
  }
  return t
}

export default function RankCoin({ rank, size = 40, className }: Props) {
  const reactId = useId()
  const k = 'rc' + reactId.replace(/[^a-zA-Z0-9_-]/g, '')
  const [c0, c1, c2] = RIM_BY_RANK[rank] ?? GRAPHITE
  const fontSize = rank > 9 ? 24 : 30

  const inner = `<defs>
      <linearGradient id="${k}r" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c0}"/><stop offset=".55" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient>
      <linearGradient id="${k}b" x1="1" y1="1" x2="0" y2="0"><stop offset="0" stop-color="${c0}"/><stop offset="1" stop-color="${c2}"/></linearGradient>
      <radialGradient id="${k}f" cx=".42" cy=".36" r=".8"><stop offset="0" stop-color="#1F1B14"/><stop offset="1" stop-color="#0F0D0A"/></radialGradient>
    </defs>
    <circle cx="32" cy="32" r="29" fill="url(#${k}r)"/>
    <g stroke="${c2}" stroke-width="1" opacity=".8">${ticksMarkup()}</g>
    <circle cx="32" cy="32" r="26.6" fill="none" stroke="url(#${k}b)" stroke-width="1.8"/>
    <circle cx="32" cy="32" r="24.8" fill="url(#${k}f)"/>
    <text x="32" y="32" text-anchor="middle" dominant-baseline="central" font-family="Archivo, Noto Sans SC, sans-serif" font-weight="800" font-size="${fontSize}" fill="${c0}" style="font-variation-settings:'wdth' 110">${rank}</text>
    <path d="M13.5 20.5A22 22 0 0 1 24 10.4" fill="none" stroke="#fff" stroke-width="1.5" stroke-linecap="round" opacity=".32"/>`

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role="img"
      aria-label={`#${rank}`}
      className={className}
      dangerouslySetInnerHTML={{ __html: inner }}
    />
  )
}
