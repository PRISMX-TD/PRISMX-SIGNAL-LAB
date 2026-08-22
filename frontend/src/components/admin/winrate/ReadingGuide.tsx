// 「怎么读」：一行图例，把四种判定芯片各解释一句。放在首屏大数字下面、策略
// 列表上面——读者第一次遇到芯片之前就看过它的意思。
// The reading guide: one row that explains each verdict chip in a phrase,
// placed between the hero and the strategy list so the reader meets the
// explanation before the chips.
import { useTranslation } from 'react-i18next'
import type { VerdictKind } from './shared'
import { VerdictChip } from './Verdict'

const KINDS: VerdictKind[] = ['strong', 'weak', 'even', 'unsure']

export default function ReadingGuide() {
  const { t } = useTranslation()
  return (
    <div className="px-1 text-xs text-neutral-400">
      <p className="mb-2 text-neutral-300">{t('admin.winrate.guide.lead')}</p>
      <ul className="flex flex-wrap items-center gap-x-6 gap-y-2">
        {KINDS.map((k) => (
          <li key={k} className="flex items-center gap-2">
            <VerdictChip kind={k} size="sm" />
            <span>{t(`admin.winrate.guide.${k}`)}</span>
          </li>
        ))}
        <li className="text-neutral-500">{t('admin.winrate.guide.thin')}</li>
      </ul>
    </div>
  )
}
