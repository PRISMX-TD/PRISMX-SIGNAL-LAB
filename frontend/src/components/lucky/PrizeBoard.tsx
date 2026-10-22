// 侧栏的两块：「奖品一览」（不显示概率 / 份数，份数用完的格照常列出）与「我的奖品」入口卡。
// 每个奖品前面的小圆章与转盘上那一格同色同图标，一眼对得上。中奖记录与领奖在 /lucky/prizes 子页，
// 这里只放一张入口卡：有待领取时显示金色计数。
// The two side panels: the prize list (no odds or stock; sold-out slots are listed as usual) and the
// My prizes entry card. Each prize's badge matches its slot's colour and glyph on the wheel. Wins and
// claiming live on the /lucky/prizes sub-page; this card only links there, with a gold count when
// something is waiting to be claimed.
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import type { LuckyDraw, LuckyPrizePublic } from '../../api/luckyTypes'
import { wonDraws } from '../../utils/luckyView'
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

export function PrizesEntry({ draws }: { draws: LuckyDraw[] }) {
  const { t } = useTranslation()
  const won = wonDraws(draws)
  const pending = won.filter((d) => d.fulfillmentStatus === 'pending').length
  return (
    <Link to="/lucky/prizes" className="card lk-panel lk-entry">
      <div className="lk-entry-main">
        <h2 className="lk-panel-title">{t('lucky.myPrizes')}</h2>
        <p className="lk-entry-sub">{won.length ? t('lucky.prizesTotal', { n: won.length }) : t('lucky.noPrizes')}</p>
      </div>
      {pending > 0 && <span className="lk-entry-badge">{t('lucky.status.pending')} {pending}</span>}
      <svg className="lk-entry-chev" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor"
        strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M6 3.5 10.5 8 6 12.5" />
      </svg>
    </Link>
  )
}
