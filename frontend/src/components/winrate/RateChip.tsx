// 全页唯一的「名字 + 胜率」芯片：顶层的「胜率最高的时间」「可以留意」用它，
// 策略卡上的「胜率最高的时间 / 品种」也用它。
//
// 判定不写字、不画符号，只由底色和字色承担：51% 起绿、40–50% 橙、40% 以下红
// （见 shared.ts 的 verdictOf）。
//
// 全部用 <span>：策略卡把这些芯片放在一个 <button> 里，按钮内只允许短语内容。
//
// The page's one "name + rate" chip, used by the top layer's best-hours and
// worth-a-look lists and by the strategy card's best hours / symbols. The verdict
// carries no word and no glyph — only the tint and text colour (green from 51%,
// amber 40-50%, red below 40%; see verdictOf in shared.ts). Spans throughout:
// the strategy card renders these inside a <button>, which allows phrasing
// content only.
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
  // 判定词并进无障碍名。芯片上判定**只剩颜色**，而颜色对读屏器根本不存在——
  // 不并进来，用读屏器的人只会听到"22:00 67.7%"，拿不到"高于一半"这一维。
  // 视觉上零成本：aria-label 不渲染。
  // The verdict word joins the accessible name. On a chip the verdict is carried
  // by colour alone, and colour does not exist for a screen reader — without this
  // such a reader hears "22:00 67.7%" and never learns which band it is in. Costs
  // nothing visually: aria-label is not rendered.
  const label = `${aria ?? `${name} ${fmtPct(rate)}`} · ${t(`admin.winrate.verdict.${kind}`)}`
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full ${
        size === 'sm' ? 'px-2 py-1 text-xs' : 'px-3 py-1.5 text-sm'
      }`}
      style={{ background: VERDICT_BG[kind], color: VERDICT_COLOR[kind] }}
      aria-label={label}
    >
      <span className="font-semibold tabular-nums text-neutral-100">{name}</span>
      <span className="font-semibold tabular-nums">{fmtPct(rate)}</span>
    </span>
  )
}
