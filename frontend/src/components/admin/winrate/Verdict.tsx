// 判定图形：↑ 明显高于一半 / ↓ 明显低于一半 / = 差不多 / ? 看不出。
//
// 写着判定的芯片曾经也住在这里，已按产品要求从整页删除——判定现在只由胜率数字
// 的颜色承担。图形留下来是因为有两处颜色不够用：钟点格（格子里只有一个百分比，
// 两种灰分不开）和「可以留意」的品种芯片（要区分"确实更高"与"只是看着高"）。
// 它同时也是色弱读者唯一能分辨好坏的编码。
//
// The verdict glyph: ↑ clearly above half, ↓ clearly below, = about even,
// ? undecided. The worded chip used to live here too and was removed page-wide
// at the product owner's request — the verdict is now carried by the colour of
// the percentage. The glyph stays because two places need more than colour: the
// hour cells (a bare percentage, where the two greys are indistinguishable)
// and the "worth a look" symbol chips. It is also the only encoding a
// colour-blind reader can use.
import type { VerdictKind } from './shared'

export function VerdictGlyph({ kind }: { kind: VerdictKind }) {
  const common = {
    width: 10, height: 10, viewBox: '0 0 10 10', fill: 'none',
    stroke: 'currentColor', strokeWidth: 1.8,
    strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const,
    'aria-hidden': true, className: 'shrink-0',
  }
  switch (kind) {
    case 'strong':
      return <svg {...common}><path d="M5 8.5V1.5M1.8 4.7 5 1.5l3.2 3.2" /></svg>
    case 'weak':
      return <svg {...common}><path d="M5 1.5v7M1.8 5.3 5 8.5l3.2-3.2" /></svg>
    case 'even':
      return <svg {...common}><path d="M1.5 3.5h7M1.5 6.5h7" /></svg>
    case 'unsure':
      return <svg {...common}><path d="M3.1 3.6a1.9 1.9 0 1 1 2.7 1.7c-.6.3-.8.7-.8 1.2M5 8.6h.01" /></svg>
    default:
      return <svg {...common}><circle cx="5" cy="5" r="1.6" fill="currentColor" stroke="none" /></svg>
  }
}
