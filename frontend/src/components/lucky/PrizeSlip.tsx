// 「我的奖品」子页的一张回执单：左边票根（中奖时刻 + 哪一期）、中间奖品、右边领奖按钮和状态印章。
// 表单方式的领奖点按钮后在单子下面展开一整行；工单方式直接开 / 看工单。
// One receipt slip on the My prizes page: stub (time won + round), the prize, then the claim button and
// the status stamp. Form-mode claims unfold a full-width row under the slip; ticket mode opens the ticket.
import { useState, type CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import type { LuckyDraw, LuckyFulfillment } from '../../api/luckyTypes'
import { parseTime } from '../../api/utils'
import { ClaimForm, useClaim } from './ClaimActions'
import PrizeArt from './PrizeArt'
import { slotColor } from './wheelArt'

// 印章上的英文码与订单回执的 FILLED / PENDING 同一套写法 / stamp codes in the orders page's style
const CODE: Record<LuckyFulfillment, string> = {
  pending: 'Claim',
  submitted: 'Review',
  delivered: 'Sent',
  auto_done: 'Done',
  cancelled: 'Void',
}

const clockOf = (iso: string) => {
  const d = parseTime(iso)
  return d
    ? d.toLocaleTimeString('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : '--:--:--'
}

export default function PrizeSlip({ draw, index, onChange, navigate }: {
  draw: LuckyDraw; index: number; onChange: (d: LuckyDraw) => void; navigate: (to: string) => void
}) {
  const { t } = useTranslation()
  const claim = useClaim(draw, onChange, navigate)
  const [form, setForm] = useState(false)
  const status = draw.fulfillmentStatus
  const open = draw.prize.kind === 'custom' && (status === 'pending' || status === 'submitted')
  const ticket = draw.prize.claimMode === 'ticket'
  const sub = open
    ? (status === 'submitted' && !ticket ? draw.claimInfo : draw.prize.claimHint)
    : draw.adminNote

  return (
    <article className="lkp-slip" data-status={status} style={{ '--i': index } as CSSProperties}>
      <div className="lkp-stub">
        <div className="lkp-stub-t">{clockOf(draw.createdAt)}</div>
        {draw.roundName && <div className="lkp-stub-a" title={draw.roundName}>{draw.roundName}</div>}
      </div>
      <div className="lkp-body">
        <PrizeArt kind={draw.prize.kind} color={slotColor(draw.prize.color, draw.slotIndex ?? 0)} imageUrl={draw.prize.imageUrl} size={36} />
        <div className="lkp-ident">
          <div className="lkp-name" title={draw.prize.name}>{draw.prize.name}</div>
          {/* 表单展开时说明已在表单里 / the form repeats the hint while open */}
          {sub && !form && <div className="lkp-msg">{sub}</div>}
          {claim.err && !form && <div className="lkp-msg bad">{claim.err}</div>}
        </div>
      </div>
      <div className="lkp-act">
        {open && !form && (
          <button type="button" className={`${status === 'pending' ? 'btn-primary' : 'btn-secondary'} lkp-btn`} disabled={claim.busy}
            onClick={ticket ? claim.openTicket : () => setForm(true)}>
            {ticket
              ? t(draw.supportTicketId ? 'lucky.viewTicket' : 'lucky.claimByTicket')
              : t(status === 'submitted' ? 'lucky.updateClaim' : 'lucky.fillClaim')}
          </button>
        )}
      </div>
      <div className="lkp-stampcell">
        <span className="lkp-stamp">{CODE[status]}<i /><span className="zh">{t(`lucky.status.${status}`)}</span></span>
      </div>
      {form && (
        <div className="lkp-form">
          <ClaimForm draw={draw} claim={claim} onCancel={() => setForm(false)} />
        </div>
      )}
    </article>
  )
}
