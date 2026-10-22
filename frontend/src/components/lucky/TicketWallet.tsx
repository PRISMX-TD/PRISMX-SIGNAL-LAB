// 「我的抽奖券」票夹：每一批券画成一张带撕口的票根（左边是来历和发放日期，右边存根是张数），
// 「再来一次」退回的券用金色存根区分。批次多时先显示 3 张，其余收起。
// 张数是这一批**发了几张**（含已用），右上角的「剩 N 张」才是还能抽的次数。
// "My tickets" wallet: each batch is a ticket stub with a perforation (origin and date on the left, the
// count on the stub); refunded spin-again tickets get a gold stub. With many batches, three show and
// the rest fold away. A stub's count is how many that batch *gave* (used included); "N left" at the top
// right is what can still be spun.
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { LuckyTicketBatchPublic } from '../../api/luckyTypes'
import { fmtDayShort } from '../../api/utils'

const SHOWN = 3

export default function TicketWallet({ unused, batches }: { unused: number; batches: LuckyTicketBatchPublic[] }) {
  const { t } = useTranslation()
  const [all, setAll] = useState(false)
  const list = all ? batches : batches.slice(0, SHOWN)
  return (
    <section className="card lk-panel">
      <div className="lk-panel-head">
        <h2 className="lk-panel-title">{t('lucky.myTickets')}</h2>
        <span className="lk-left">{t('lucky.available')} <b>{unused}</b></span>
      </div>
      {batches.length === 0 ? (
        <p className="lk-empty">{t('lucky.noTicketsHint')}</p>
      ) : (
        <ul className="lk-tickets">
          {list.map((b, i) => (
            <li key={`${b.reason ?? 'retry'}-${b.issuedAt}-${i}`} className={`lk-ticket ${b.reason == null ? 'is-retry' : ''}`}>
              <div className="lk-ticket-main">
                {/* reason 为 null = 「再来一次」退回的券 / null reason = a retry refund */}
                <span className="lk-ticket-reason">{b.reason ?? t('lucky.retryTicket')}</span>
                <span className="lk-ticket-date">{t('lucky.issuedOn', { time: fmtDayShort(b.issuedAt) })}</span>
              </div>
              <div className="lk-ticket-stub">
                <span className="lk-ticket-n">×{b.count}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
      {batches.length > SHOWN && (
        <button type="button" className="lk-more" aria-expanded={all} onClick={() => setAll((v) => !v)}>
          {all ? t('lucky.fewer') : t('lucky.more', { n: batches.length - SHOWN })}
        </button>
      )}
    </section>
  )
}
