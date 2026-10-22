// 实物奖品的领取操作（「我的奖品」和揭晓卡共用）：领取方式是工单就开 / 查看工单，是表单就填领奖信息。
// 已结束（已发放 / 已取消）只显示管理员备注；PRO、谢谢参与、再来一次、已抽完未中奖都没有领取操作。
// Claim actions for a custom prize (shared by My prizes and the reveal card): open / view a support
// ticket, or fill in the claim form. Closed claims (delivered / cancelled) only show the admin note; PRO,
// thanks, spin-again and sold-out misses have nothing to claim.
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { luckyApi } from '../../api/client'
import type { LuckyDraw } from '../../api/luckyTypes'
import { localizeApiError } from '../../api/utils'

export default function ClaimActions({ draw, onChange, navigate }: {
  draw: LuckyDraw; onChange: (d: LuckyDraw) => void; navigate: (to: string) => void
}) {
  const { t } = useTranslation()
  const [text, setText] = useState(draw.claimInfo ?? '')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const open = draw.fulfillmentStatus === 'pending' || draw.fulfillmentStatus === 'submitted'
  const errText = (e: unknown) => (e instanceof Error ? localizeApiError(e.message) : t('common.error'))
  if (draw.prize.kind !== 'custom' || draw.soldOut) return null
  if (!open) {
    return draw.adminNote ? <p className="lk-note">{draw.adminNote}</p> : null
  }
  if (draw.prize.claimMode === 'ticket') {
    return (
      <div className="space-y-1.5">
        <button type="button" className="btn-secondary px-4 py-1.5 text-xs" disabled={busy} onClick={async () => {
          // 已有工单就直接去看，不再重复开 / an existing ticket is just opened, never re-created
          if (draw.supportTicketId) { navigate(`/support?ticket=${encodeURIComponent(draw.supportTicketId)}`); return }
          setBusy(true)
          setErr('')
          try {
            const r = await luckyApi.claimTicket(draw.id)
            onChange(r.draw)
            navigate(`/support?ticket=${encodeURIComponent(r.ticketId)}`)
          } catch (e) { setErr(errText(e)) } finally { setBusy(false) }
        }}>
          {draw.supportTicketId ? t('lucky.viewTicket') : t('lucky.claimByTicket')}
        </button>
        {err && <p className="text-xs text-down">{err}</p>}
      </div>
    )
  }
  return (
    <div className="space-y-2">
      {draw.prize.claimHint && <p className="lk-note">{draw.prize.claimHint}</p>}
      <textarea className="input w-full py-2 text-sm" style={{ borderRadius: 14 }} rows={3} maxLength={1000} value={text}
        aria-label={t('lucky.submitClaim')} onChange={(e) => setText(e.target.value)} />
      <button type="button" className="btn-primary px-4 py-1.5 text-xs disabled:opacity-40"
        disabled={busy || !text.trim()} onClick={async () => {
          setBusy(true)
          setErr('')
          try { onChange(await luckyApi.claimInfo(draw.id, text)) } catch (e) { setErr(errText(e)) } finally { setBusy(false) }
        }}>
        {draw.fulfillmentStatus === 'submitted' ? t('lucky.updateClaim') : t('lucky.submitClaim')}
      </button>
      {err && <p className="text-xs text-down">{err}</p>}
    </div>
  )
}
