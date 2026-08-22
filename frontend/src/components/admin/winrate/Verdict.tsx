// 判定芯片：把 verdictOf 的结论渲染成一句人话 + 一个小图形。
// 图形（↑ / ↓ / = / ?）与颜色是双重编码——色弱读者靠形状也能分出好坏。
// The verdict chip: renders verdictOf's conclusion as a phrase plus a small
// glyph. Glyph and colour double-encode the verdict so colour-blind readers can
// still tell them apart by shape.
import { useTranslation } from 'react-i18next'
import { VERDICT_BG, VERDICT_COLOR, type RateLike, type VerdictKind } from './shared'

/** 判定图形，单独导出给星期格用——那里放不下整枚芯片，但形状编码不能丢。
 *  The verdict glyph on its own, for the weekday cells: no room for a whole
 *  chip there, but the shape encoding must not be dropped. */
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

export function VerdictChip({ kind, bucket, size = 'md' }: {
  kind: VerdictKind
  // thin / waiting / broken 三态要报笔数，各取各的：已判定 / 等结果 / 中断。
  // thin / waiting / broken report a count each — resolved / pending / stale.
  bucket?: Pick<RateLike, 'resolved' | 'pending' | 'stale'>
  size?: 'sm' | 'md'
}) {
  const { t } = useTranslation()
  const count = kind === 'waiting' ? bucket?.pending ?? 0 : kind === 'broken' ? bucket?.stale ?? 0 : bucket?.resolved ?? 0
  const text = kind === 'thin' || kind === 'waiting' || kind === 'broken'
    ? t(`admin.winrate.verdict.${kind}`, { count })
    : t(`admin.winrate.verdict.${kind}`)
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full font-medium ${
        size === 'sm' ? 'px-2 py-0.5 text-2xs' : 'px-2.5 py-1 text-xs'
      }`}
      style={{ color: VERDICT_COLOR[kind], background: VERDICT_BG[kind] }}
    >
      <VerdictGlyph kind={kind} />
      {text}
    </span>
  )
}
