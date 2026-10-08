// 完整性标记的小标签。已知取值走 admin.competitionPromo.flagKind.*，后端以后加了新的
// 种类也不至于显示一行裸 key——defaultValue 落回原始值。
// Integrity flag chips. Known kinds are translated; an unknown future kind falls back to
// its raw value instead of a bare i18n key.
import { useTranslation } from 'react-i18next'

export default function FlagKinds({ kinds }: { kinds: string[] }) {
  const { t } = useTranslation()
  return (
    <span className="inline-flex flex-wrap gap-1">
      {kinds.map((k) => (
        <span key={k} className="tag bg-amber-400/15 text-[10px] text-amber-300">
          {t(`admin.competitionPromo.flagKind.${k}`, { defaultValue: k })}
        </span>
      ))}
    </span>
  )
}
