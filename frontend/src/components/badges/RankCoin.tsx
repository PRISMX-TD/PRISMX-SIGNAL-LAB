// frontend/src/components/badges/RankCoin.tsx
//
// 名次徽标 V2：一枚真正的"铸币浮雕"，不再是环 + 扁平数字。构造照抄 medal.ts
// 里 V5 勋章的圆形家族（SHAPES.growth，kind:'round', R:29）——环缘渐变、60
// 道边缘齿纹、倒角环、径向底板、数字本身按浮雕手法画三遍（暗色阴影错位
// 1,1 → 亮面渐变 → 细高光描边），全部直接调用/照搬 medal.ts 已导出的
// P()/f()/sprig()/MAT，不重新发明这套几何。材质按名次走勋章墙同一套稀有度
// 语言：1 金（legendary）/ 2 银（rare）/ 3 铜（limited，本身就带暖色深底，
// 不用另配）/ 4+ 石墨（common）。冠军额外加两处装饰——环缘外的 12 道星芒
// （压在底板下层，只露出尖端）与数字两侧的桂枝半枝（借 sprig()，叶片直接用
// 金材质自己的 L/D 两阶，不套家族珐琅色——名次不是勋章家族，没有珐琅语义）。
//
// Rank coin V2: a real struck-medal relief, not a ring around a flat digit.
// Construction is lifted verbatim from medal.ts's round badge family
// (SHAPES.growth, kind:'round', R:29) — rim gradient, 60 rim ticks, a bevel
// ring, the radial field, and the numeral itself drawn as a three-pass
// relief (dark offset-copy shadow → light gradient face → thin highlight
// stroke) — all built from medal.ts's already-exported P()/f()/sprig()/MAT
// rather than re-deriving the geometry. Material follows rank using the
// same rarity language as the badge wall: 1 gold (legendary) / 2 silver
// (rare) / 3 bronze (limited — already carries a warm dark field, no extra
// tint needed) / 4+ graphite (common). The champion gets two extra flourishes
// — 12 short rays behind the rim (mostly hidden under the disc, tips only)
// and a laurel half-sprig on each side of the numeral (via sprig(), leaves
// toned with the gold material's own L/D — no family enamel, since a
// leaderboard rank isn't a badge family).
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { MAT, P, f, sprig } from './medal'

interface Props {
  rank: number
  size?: number
  className?: string
}

// 圆形家族的半径链——直接照抄 medal.ts SHAPES.growth（R:29）与其 round 分支
// 推出的 field/inlay 半径（fr = R-3.6，inlay = fr-3），保持同一套铸币比例。
// The round family's radius chain, copied straight from medal.ts's
// SHAPES.growth (R:29) and the round branch's field/inlay derivation
// (fr = R-3.6, inlay = fr-3) — same minting proportions.
const R = 29
const FIELD_R = R - 3.6 // 25.4
const INLAY_R = FIELD_R - 3 // 22.4

function materialFor(rank: number) {
  if (rank === 1) return MAT.legendary
  if (rank === 2) return MAT.rare
  if (rank === 3) return MAT.limited
  return MAT.common
}

function ticksMarkup(): string {
  let t = ''
  for (let i = 0; i < 60; i++) {
    t += `<line x1="32" y1="${f(32 - R + 0.4)}" x2="32" y2="${f(32 - R + 3)}" transform="rotate(${i * 6} 32 32)"/>`
  }
  return t
}

// 冠军星芒：12 道短锥形，尖端在环缘之外（r 31.5），根部藏在底板之下
// （r 27）——渲染顺序在圆盘之前，圆盘会盖住根部只露尖。
// Champion rays: 12 short tapered spikes, tips outside the rim (r 31.5),
// bases hidden under the disc (r 27) — rendered before the disc so the disc
// covers the bases and only the tips show.
function raysMarkup(k: string, m: typeof MAT.legendary): string {
  let rays = ''
  for (let i = 0; i < 12; i++) {
    const [x1, y1] = P(31.5, i * 30)
    const [x2, y2] = P(27, i * 30 - 3.5)
    const [x3, y3] = P(27, i * 30 + 3.5)
    rays += `<path d="M${f(x2)} ${f(y2)}L${f(x1)} ${f(y1)}L${f(x3)} ${f(y3)}Z"/>`
  }
  return `<g fill="url(#${k}r)" stroke="${m.rim[2]}" stroke-width=".35">${rays}</g>`
}

// 数字两侧的桂枝半枝：借 medal.ts 的 sprig()/leaf()，但用自己的 tone()——
// 叶片填色用金材质的 L（亮金），中脉用 D（暗金），不走家族珐琅色（{G} 只用
// 于枝干，落在同一枚 H→L→D 渐变上，与数字浮雕共用一个 <defs> 条目）。
// Laurel half-sprigs flanking the numeral: borrows medal.ts's sprig()/leaf()
// but tones them locally — leaf fill is the gold material's L (light gold),
// midrib is D (dark gold), no family enamel. {G} (the stem) lands on the
// same H→L→D gradient the numeral's face uses.
function sprigsMarkup(k: string, m: typeof MAT.legendary): string {
  const tone = (s: string) => s.replace(/\{G\}/g, `url(#${k}g)`).replace(/\{E\}/g, m.L).replace(/\{D\}/g, m.D)
  const left = sprig([[27, 45], [19, 39], [17, 27], [23, 20]], 3, -1, 6.2, 2.2, 1.4)
  const right = sprig([[37, 45], [45, 39], [47, 27], [41, 20]], 3, 1, 6.2, 2.2, 1.4)
  return `<g>${tone(left)}${tone(right)}</g>`
}

export default function RankCoin({ rank, size = 40, className }: Props) {
  const { t } = useTranslation()
  const reactId = useId()
  // useId() 可能带冒号，拼进 SVG id 前去掉非 id-safe 字符（同 medal.ts 的
  // renderMedalInner 做法）。
  // useId() may carry colons — strip non-id-safe characters before splicing
  // into an SVG id (same approach as medal.ts's renderMedalInner).
  const k = 'rc' + reactId.replace(/[^a-zA-Z0-9_-]/g, '')
  const m = materialFor(rank)
  const [c0, c1, c2] = m.rim
  const champion = rank === 1

  let fontSize = rank <= 9 ? 30 : rank <= 99 ? 24 : 19
  if (champion) fontSize = 26 // 让桂枝有地方展开 / shrink so the sprigs have room

  const inlayColor = champion ? m.inlay ?? c0 : c2
  const inlayW = champion ? 0.9 : 0.8
  const inlayOp = champion ? 0.8 : 0.6

  const textAttrs = `x="32" y="33" text-anchor="middle" dominant-baseline="central" font-family="Archivo, 'Noto Sans SC', sans-serif" font-weight="800" font-size="${fontSize}" style="font-variation-settings:'wdth' 110"`
  // 浮雕三遍：暗色阴影错位 (1,1) → 亮面渐变 → 细高光描边错位 (-.4,-.4)。
  // Three-pass relief: dark offset (1,1) shadow copy → light gradient face →
  // thin highlight stroke offset (-.4,-.4).
  const numeral = `
    <text ${textAttrs} fill="${m.D}" transform="translate(1 1)" opacity=".6">${rank}</text>
    <text ${textAttrs} fill="url(#${k}g)">${rank}</text>
    <text ${textAttrs} fill="none" stroke="${m.H}" stroke-width=".5" transform="translate(-.4 -.4)" opacity=".5">${rank}</text>`

  const inner = `<defs>
      <linearGradient id="${k}r" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c0}"/><stop offset=".55" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient>
      <linearGradient id="${k}b" x1="1" y1="1" x2="0" y2="0"><stop offset="0" stop-color="${c0}"/><stop offset="1" stop-color="${c2}"/></linearGradient>
      <radialGradient id="${k}f" cx=".42" cy=".36" r=".78"><stop offset="0" stop-color="${m.field[0]}"/><stop offset="1" stop-color="${m.field[1]}"/></radialGradient>
      <linearGradient id="${k}g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${m.H}"/><stop offset=".45" stop-color="${m.L}"/><stop offset="1" stop-color="${m.D}"/></linearGradient>
    </defs>
    ${champion ? raysMarkup(k, m) : ''}
    <circle cx="32" cy="32" r="${R}" fill="url(#${k}r)"/>
    <circle cx="32" cy="32" r="${R}" fill="none" stroke="${c2}" stroke-width=".55" opacity=".8"/>
    <g stroke="${m.tick}" stroke-width="1" opacity=".9">${ticksMarkup()}</g>
    <circle cx="32" cy="32" r="${R - 2.1}" fill="none" stroke="url(#${k}b)" stroke-width="1.9"/>
    <circle cx="32" cy="32" r="${R - 3.15}" fill="none" stroke="${m.H}" stroke-width=".45" opacity=".55"/>
    <circle cx="32" cy="32" r="28.7" fill="none" stroke="#fff" stroke-width=".6" opacity=".25"/>
    <circle cx="32" cy="32" r="${FIELD_R}" fill="url(#${k}f)"/>
    <circle cx="32" cy="32" r="${INLAY_R}" fill="none" stroke="${inlayColor}" stroke-width="${inlayW}" opacity="${inlayOp}"/>
    ${rank === 2 ? `<circle cx="32" cy="32" r="20.6" fill="none" stroke="${MAT.rare.L}" stroke-width=".7" opacity=".6"/>` : ''}
    ${champion ? sprigsMarkup(k, m) : ''}
    ${numeral}
    <path d="M13.5 20.5A22 22 0 0 1 24 10.4" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round" opacity=".32"/>`

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role="img"
      aria-label={t('leaderboard.rankLabel', { n: rank })}
      className={className}
      dangerouslySetInnerHTML={{ __html: inner }}
    />
  )
}
