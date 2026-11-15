// 事实表：奖品 / 开赛 / 结束 / 报名窗口（仅报名制）。
// Facts: prize, start, end, registration window (signup only).
import type { TFunction } from 'i18next'
import { fmtDate, fmtDay } from '../../api/utils'
import type { CompetitionSummary } from '../../api/types'
import { EMPTY } from '../../utils/format'

export default function CompFacts({ c, t }: {
  c: Pick<CompetitionSummary, 'prizeNote' | 'startsAt' | 'endsAt' | 'enrollment' | 'regOpensAt' | 'regClosesAt'>
  t: TFunction
}) {
  return (
    <dl className="cmp-facts">
      {c.prizeNote && (
        <div>
          <dt>{t('competition.prizeLabel')}</dt>
          <dd className="is-prize">{c.prizeNote}</dd>
        </div>
      )}
      <div>
        <dt>{t('competition.starts')}</dt>
        <dd className="num">{c.startsAt ? fmtDate(c.startsAt) : EMPTY}</dd>
      </div>
      <div>
        <dt>{t('competition.ends')}</dt>
        <dd className="num">{c.endsAt ? fmtDate(c.endsAt) : EMPTY}</dd>
      </div>
      {c.enrollment === 'signup' && (
        <div>
          <dt>{t('competition.regWindow')}</dt>
          <dd className="num">
            {c.regOpensAt ? fmtDay(c.regOpensAt) : EMPTY} – {c.regClosesAt ? fmtDay(c.regClosesAt) : EMPTY}
          </dd>
        </div>
      )}
    </dl>
  )
}
