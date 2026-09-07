// frontend/src/components/badges/LimitedClosesLine.tsx
// 绝版勋章的截止行：成就页勋章库瓦片、详情弹层各画一份，此前各自内联调用
// fmtDate（含时分）——绝版窗口只到日，用户没必要读到一个精确到分钟又标了
// UTC+8 的时刻。抽成共享组件，两处改用只到日的 fmtDay，读数与文案只有一处。
//
// The limited-badge closing line: drawn once on the achievements vault tile
// and once in the detail modal, previously each inlining fmtDate (which
// carries hour:minute) — the closing window only needs the day, not a
// UTC+8-stamped minute. Shared here so both call sites use the day-only
// fmtDay and the copy lives in one place.
import { useTranslation } from 'react-i18next'
import { fmtDay } from '../../api/utils'

interface Props {
  closesAt: string | null | undefined
  as?: 'small' | 'p'
  className?: string
}

export default function LimitedClosesLine({ closesAt, as = 'small', className }: Props) {
  const { t } = useTranslation()
  if (!closesAt) return null
  const Tag = as
  const stillOpen = new Date(closesAt).getTime() > Date.now()
  return (
    <Tag className={className}>
      {t('gamification.limited.closes', { date: fmtDay(closesAt) })}
      {' · '}
      {stillOpen ? t('gamification.limited.open') : t('gamification.limited.closed')}
    </Tag>
  )
}
