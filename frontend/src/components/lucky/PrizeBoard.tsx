// 侧栏的两块：「奖品一览」（不显示概率 / 份数，份数用完的格照常列出）与跨期的「我的奖品」。
// 每个奖品前面的小圆章与转盘上那一格同色同图标，一眼对得上。
// The two side panels: the prize list (no odds or stock; sold-out slots are listed as usual) and the
// cross-round "My prizes". Each prize's badge matches its slot's colour and glyph on the wheel.
import { useTranslation } from 'react-i18next'
import type { LuckyDraw, LuckyFulfillment, LuckyPrizePublic } from '../../api/luckyTypes'
import { fmtDayShort } from '../../api/utils'
import { wonDraws } from '../../utils/luckyView'
import ClaimActions from './ClaimActions'
import PrizeArt from './PrizeArt'
import { slotColor } from './wheelArt'

export function PrizeList({ prizes }: { prizes: LuckyPrizePublic[] }) {
  const { t } = useTranslation()
  return (
    <section className="card lk-panel">
      <div className="lk-panel-head">
        <h2 className="lk-panel-title">{t('lucky.prizes')}</h2>
        <span className="lk-panel-aux">{t('lucky.slots', { n: prizes.length })}</span>
      </div>
      <ul className="lk-prizes">
        {prizes.map((p, i) => (
          <li key={p.id} className="lk-prize">
            <PrizeArt kind={p.kind} color={slotColor(p.color, i)} imageUrl={p.imageUrl} size={40} />
            <div className="min-w-0 flex-1">
              <div className="lk-prize-name">{p.name}</div>
              {p.description && <div className="lk-prize-desc">{p.description}</div>}
            </div>
            {(p.kind === 'pro_days' || p.kind === 'custom') && (
              <span className={`lk-tag ${p.kind === 'pro_days' ? 'is-pro' : ''}`}>{t(`lucky.kindTag.${p.kind}`)}</span>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}

const STATUS_TONE: Record<LuckyFulfillment, string> = {
  auto_done: 'is-done',
  delivered: 'is-done',
  pending: 'is-wait',
  submitted: 'is-busy',
  cancelled: 'is-off',
}

export function MyPrizes({ draws, onChange, navigate }: {
  draws: LuckyDraw[]; onChange: (xs: LuckyDraw[]) => void; navigate: (to: string) => void
}) {
  const { t } = useTranslation()
  const won = wonDraws(draws)
  return (
    <section className="card lk-panel">
      <div className="lk-panel-head">
        <h2 className="lk-panel-title">{t('lucky.myPrizes')}</h2>
        {won.length > 0 && <span className="lk-panel-aux">{won.length}</span>}
      </div>
      {won.length === 0 ? <p className="lk-empty">{t('lucky.noPrizes')}</p> : (
        <ul className="lk-won">
          {won.map((d) => (
            <li key={d.id} className="lk-won-row">
              <div className="flex items-start gap-3">
                <PrizeArt kind={d.prize.kind} color={slotColor(d.prize.color, d.slotIndex ?? 0)} imageUrl={d.prize.imageUrl} size={32} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-2">
                    <span className="lk-prize-name">{d.prize.name}</span>
                    <span className={`lk-status ${STATUS_TONE[d.fulfillmentStatus]}`}>{t(`lucky.status.${d.fulfillmentStatus}`)}</span>
                  </div>
                  <div className="lk-prize-desc">{fmtDayShort(d.createdAt)}{d.roundName ? ` · ${d.roundName}` : ''}</div>
                </div>
              </div>
              <div className="lk-won-claim">
                <ClaimActions draw={d} navigate={navigate}
                  onChange={(nd) => onChange(draws.map((x) => (x.id === nd.id ? nd : x)))} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
