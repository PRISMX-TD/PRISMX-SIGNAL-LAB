// 「我的抽奖券」票夹：每一批券画成一张印在深紫卡纸上的入场券——左边镭射箔条，主券上是来历和发放日期，
// 打孔撕线右边的存根上是张数、装饰条码和竖排序号；「再来一次」退回的券换成金色卡纸。批次多时先显示 3 张，
// 其余收起。张数是这一批**发了几张**（含已用），右上角的「可用券 N」才是还能抽的次数。
// 品牌小字、条码和序号都是装饰（aria-hidden），序号由发放日月 + 第几批算出，不对应任何真实编号。
// "My tickets" wallet: each batch is an admission ticket printed on deep-violet stock: a holographic foil
// stripe on the left, origin and issue date on the main part, and past the perforation a stub with the
// count, a decorative barcode and a vertical serial; spin-again refunds use gold stock. With many batches,
// three show and the rest fold away. A stub's count is how many that batch *gave* (used included); "N left"
// at the top right is what can still be spun. The kicker, barcode and serial are decoration (aria-hidden);
// the serial is derived from the issue day/month and batch position and matches no real record.
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { LuckyTicketBatchPublic } from '../../api/luckyTypes'
import { fmtDayShort, parseTime } from '../../api/utils'

const SHOWN = 3

const pad2 = (n: number) => String(n).padStart(2, '0')

/** 装饰序号「№ 2210·01」：发放日 + 月（北京时间，与旁边的发放日期一致）+ 第几批。
 *  Decorative serial: issue day + month (Beijing time, matching the date line beside it) + batch position. */
export function ticketSerial(issuedAt: string, index: number): string {
  const d = parseTime(issuedAt)
  const dm = !d || Number.isNaN(d.getTime())
    ? '0000'
    : d.toLocaleDateString('en-GB', { timeZone: 'Asia/Shanghai', day: '2-digit', month: '2-digit' }).replace(/\D/g, '')
  return `№ ${dm}·${pad2(index + 1)}`
}

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
          {list.map((b, i) => {
            // reason 为 null = 「再来一次」退回的券 / null reason = a retry refund
            const retry = b.reason == null
            const label = b.reason ?? t('lucky.retryTicket')
            return (
              <li key={`${b.reason ?? 'retry'}-${b.issuedAt}-${i}`} className={`lk-ticket ${retry ? 'is-retry' : ''}`}
                style={{ ['--i' as string]: i }}>
                <i className="lk-ticket-foil" aria-hidden />
                <div className="lk-ticket-main">
                  <span className="lk-ticket-kicker" aria-hidden>PRISMX<em />LUCKY DRAW</span>
                  <span className="lk-ticket-reason" title={label}>
                    {retry && (
                      <svg className="lk-ticket-ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7"
                        strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <path d="M13 8.2a5 5 0 1 1-1.5-3.8" />
                        <path d="M12.2 1.9v3h-3" />
                      </svg>
                    )}
                    {label}
                  </span>
                  <span className="lk-ticket-date">{t('lucky.issuedOn', { time: fmtDayShort(b.issuedAt) })}</span>
                </div>
                <div className="lk-ticket-stub">
                  <span className="lk-ticket-n"><i>×</i>{b.count}</span>
                  <i className="lk-ticket-code" aria-hidden />
                  <span className="lk-ticket-serial" aria-hidden>{ticketSerial(b.issuedAt, i)}</span>
                </div>
              </li>
            )
          })}
        </ul>
      )}
      {batches.length > SHOWN && (
        <button type="button" className="lk-more" aria-expanded={all} onClick={() => setAll((v) => !v)}>
          {all ? t('lucky.fewer') : t('lucky.more', { n: batches.length - SHOWN })}
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6"
            strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d={all ? 'M3 7.5 6 4.5 9 7.5' : 'M3 4.5 6 7.5 9 4.5'} />
          </svg>
        </button>
      )}
    </section>
  )
}
