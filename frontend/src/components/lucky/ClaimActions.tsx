// 实物奖品的领取操作（「我的奖品」和揭晓卡共用）：领取方式是工单就开 / 查看工单，是表单就填领奖信息。
// 已结束（已发放 / 已取消）只显示管理员备注；PRO、谢谢参与、再来一次、已抽完未中奖都没有领取操作。
// 请求逻辑在 useClaim 里，表单是 ClaimForm，「我的奖品」用它们拼自己的按钮样式。
// Claim actions for a custom prize (shared by My prizes and the reveal card): open / view a support
// ticket, or fill in the claim form. Closed claims (delivered / cancelled) only show the admin note; PRO,
// thanks, spin-again and sold-out misses have nothing to claim. The requests live in useClaim and the
// form is ClaimForm, so My prizes can build its own buttons on top of them.
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { luckyApi } from '../../api/client'
import type { LuckyDraw } from '../../api/luckyTypes'
import { localizeApiError } from '../../api/utils'

export type Claim = {
  busy: boolean
  err: string
  /** 已有工单就直接去看，没有才开 / opens the existing ticket, or creates one */
  openTicket: () => Promise<void>
  /** 成功返回 true / resolves true on success */
  submitInfo: (text: string) => Promise<boolean>
}

export function useClaim(draw: LuckyDraw, onChange: (d: LuckyDraw) => void, navigate: (to: string) => void): Claim {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const errText = (e: unknown) => (e instanceof Error ? localizeApiError(e.message) : t('common.error'))
  return {
    busy,
    err,
    openTicket: async () => {
      if (draw.supportTicketId) { navigate(`/support?ticket=${encodeURIComponent(draw.supportTicketId)}`); return }
      setBusy(true)
      setErr('')
      try {
        const r = await luckyApi.claimTicket(draw.id)
        onChange(r.draw)
        navigate(`/support?ticket=${encodeURIComponent(r.ticketId)}`)
      } catch (e) { setErr(errText(e)) } finally { setBusy(false) }
    },
    submitInfo: async (text: string) => {
      setBusy(true)
      setErr('')
      try {
        onChange(await luckyApi.claimInfo(draw.id, text))
        return true
      } catch (e) {
        setErr(errText(e))
        return false
      } finally { setBusy(false) }
    },
  }
}

/** 领奖信息表单：说明、输入框、提交（可选「取消」）。
 *  The claim-info form: hint, text box, submit (and an optional cancel). */
export function ClaimForm({ draw, claim, submitClassName = 'btn-primary px-4 py-1.5 text-xs disabled:opacity-40', onCancel }: {
  draw: LuckyDraw; claim: Claim; submitClassName?: string; onCancel?: () => void
}) {
  const { t } = useTranslation()
  const [text, setText] = useState(draw.claimInfo ?? '')
  return (
    <div className="space-y-2">
      {draw.prize.claimHint && <p className="lk-note">{draw.prize.claimHint}</p>}
      <textarea className="input w-full py-2 text-sm" style={{ borderRadius: 14 }} rows={3} maxLength={1000} value={text}
        aria-label={t('lucky.submitClaim')} onChange={(e) => setText(e.target.value)} />
      {/* 有「取消」时两个按钮靠右，揭晓卡里照旧靠左 / with a cancel both sit right; the reveal card keeps left */}
      <div className={`flex items-center space-x-2 ${onCancel ? 'justify-end' : ''}`}>
        {onCancel && (
          <button type="button" className="btn-secondary px-4 py-1.5 text-xs" disabled={claim.busy} onClick={onCancel}>
            {t('common.cancel')}
          </button>
        )}
        <button type="button" className={submitClassName} disabled={claim.busy || !text.trim()}
          onClick={async () => { if (await claim.submitInfo(text)) onCancel?.() }}>
          {draw.fulfillmentStatus === 'submitted' ? t('lucky.updateClaim') : t('lucky.submitClaim')}
        </button>
      </div>
      {claim.err && <p className="text-xs text-down">{claim.err}</p>}
    </div>
  )
}

export default function ClaimActions({ draw, onChange, navigate }: {
  draw: LuckyDraw; onChange: (d: LuckyDraw) => void; navigate: (to: string) => void
}) {
  const { t } = useTranslation()
  const claim = useClaim(draw, onChange, navigate)
  const open = draw.fulfillmentStatus === 'pending' || draw.fulfillmentStatus === 'submitted'
  if (draw.prize.kind !== 'custom' || draw.soldOut) return null
  if (!open) {
    return draw.adminNote ? <p className="lk-note">{draw.adminNote}</p> : null
  }
  if (draw.prize.claimMode === 'ticket') {
    return (
      <div className="space-y-1.5">
        <button type="button" className="btn-secondary px-4 py-1.5 text-xs" disabled={claim.busy} onClick={claim.openTicket}>
          {draw.supportTicketId ? t('lucky.viewTicket') : t('lucky.claimByTicket')}
        </button>
        {claim.err && <p className="text-xs text-down">{claim.err}</p>}
      </div>
    )
  }
  return <ClaimForm draw={draw} claim={claim} />
}
