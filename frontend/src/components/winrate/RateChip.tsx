// 全页唯一的「名字 + 胜率」芯片：顶层的「胜率最高的时间」「可以留意」用它，
// 策略卡上的「胜率最高的时间 / 品种」也用它。
//
// 判定不写字、不画符号，只由底色和字色承担：51% 起绿、40–50% 橙、40% 以下红
// （见 shared.ts 的 verdictOf）。
//
// 全部用 <span>：策略卡把这些芯片放在一个 <button> 里，按钮内只允许短语内容。
// 样式在 winrate.css 的 .rate-chip（钟点白、胜率着色、md/sm 两档）。
//
// The page's one "name + rate" chip, used by the top layer's best-hours and
// worth-a-look lists and by the strategy card's best hours / symbols. The verdict
// carries no word and no glyph — only the tint and text colour (green from 51%,
// amber 40-50%, red below 40%; see verdictOf in shared.ts). Spans throughout:
// the strategy card renders these inside a <button>, which allows phrasing
// content only. Styled by .rate-chip in winrate.css.
//
// 读屏：判定词放在 sr-only 里（span 上的 aria-label 读屏不认）。可见符号刻意不加，
// 理由见 StrategyDetail.tsx 判定格的注释（产品要求去掉判定图形）。
// Screen readers get the verdict from an sr-only span (aria-label on a span is
// ignored). No visible glyph on purpose — see the verdict-cell note in StrategyDetail.tsx.
import { useTranslation } from 'react-i18next'
import { VERDICT_BG, VERDICT_COLOR, fmtPct, type VerdictKind } from './shared'

export default function RateChip({ kind, name, rate, size = 'md', aria }: {
  kind: VerdictKind
  name: string
  rate: number
  size?: 'sm' | 'md'
  aria?: string
}) {
  const { t } = useTranslation()
  // 判定词进读屏。芯片上判定**只剩颜色**，而颜色对读屏器根本不存在——不补上，用读屏器
  // 的人只会听到"22:00 67.7%"，拿不到"高于一半"这一维。原来写在 span 的 aria-label 上，
  // 但无角色的 span 上 aria-label 读屏不认，所以改成 sr-only 文字；视觉上同样零成本。
  // The verdict reaches screen readers. On a chip it is carried by colour alone, which
  // does not exist for a screen reader. It used to sit in aria-label on the span, which
  // screen readers ignore on a role-less element, so it is now sr-only text instead.
  const verdict = t(`admin.winrate.verdict.${kind}`)
  return (
    <span
      className={`rate-chip${size === 'sm' ? ' sm' : ''}`}
      style={{ background: VERDICT_BG[kind], color: VERDICT_COLOR[kind] }}
    >
      {aria ? (
        <>
          <span className="n num" aria-hidden="true">{name}</span>
          <span className="r num" aria-hidden="true">{fmtPct(rate)}</span>
          <span className="sr-only">{`${aria} · ${verdict}`}</span>
        </>
      ) : (
        <>
          <span className="n num">{name}</span>
          <span className="r num">{fmtPct(rate)}</span>
          <span className="sr-only">{` · ${verdict}`}</span>
        </>
      )}
    </span>
  )
}
