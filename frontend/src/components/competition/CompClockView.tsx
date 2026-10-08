// 详情页的大钟：天 / 小时 / 分三格；到点或已结束时改成一格文字（即将 / 结束时间）。
// The detail page's big clock: day / hour / minute cells; one text cell at zero or once over.
import type { TFunction } from 'i18next'
import { fmtDate } from '../../api/utils'
import { clockOf, type CompTiming } from './compClock'

export default function CompClock({ c, nowMs, t }: { c: CompTiming; nowMs: number; t: TFunction }) {
  const clock = clockOf(c, nowMs, t)
  return (
    <div className="cmp-clock">
      {clock?.parts ? (
        (['d', 'h', 'm'] as const).map((u) => {
          const part = clock.parts!.find((x) => x.unit === u)
          return (
            <div key={u}>
              <b className="num">{String(part?.value ?? 0).padStart(2, '0')}</b>
              <span>{t(`competition.cd.units.${u}`)}</span>
            </div>
          )
        })
      ) : (
        <div className="is-wide">
          <b className="num is-text">{clock ? t('competition.cd.soon') : c.endsAt ? fmtDate(c.endsAt) : '—'}</b>
          <span>{clock ? clock.label : t('competition.ends')}</span>
        </div>
      )}
    </div>
  )
}
