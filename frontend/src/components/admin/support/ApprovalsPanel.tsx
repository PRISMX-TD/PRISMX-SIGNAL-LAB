// 待审批（设计 §7.3）：客服提交的补偿天数（超上限）、申请跟进、手动开户标记；外加自动识别出的
// 「自报实盘」转化（pending_review）。批准即执行，驳回可附说明，申请人会收到站内提醒。
// Approvals (design §7.3): over-cap comp days, follow-up requests and manual open-account claims
// from agents, plus auto-detected self-reported real accounts (pending_review conversions).
// Approving executes; rejecting can carry a note; the requester gets an in-app reminder.
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { adminSupportApi } from '../../../api/client'
import { fmtTime } from '../../../api/utils'
import type { SupportConversion, SupportRequest } from '../../../api/supportTypes'
import { SkeletonLine } from '../../Skeleton'
import { DeskModal, errText } from '../../support/supportUi'

const str = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v) : '')

export default function ApprovalsPanel({ onToast }: { onToast: (kind: 'ok' | 'err', text: string) => void }) {
  const { t } = useTranslation()
  const [requests, setRequests] = useState<SupportRequest[] | null>(null)
  const [convs, setConvs] = useState<SupportConversion[]>([])
  const [review, setReview] = useState<{ kind: 'req' | 'conv'; id: string; approve: boolean } | null>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const [r, c] = await Promise.all([adminSupportApi.requests('pending'), adminSupportApi.conversions({ status: 'pending_review' })])
      setRequests(r.items)
      setConvs(c.items)
    } catch (err) {
      onToast('err', errText(err, t('admin.loadError')))
      setRequests([])
    }
  }, [onToast, t])
  useEffect(() => { void load() }, [load])

  const submit = async () => {
    if (!review) return
    setBusy(true)
    try {
      if (review.kind === 'req') {
        if (review.approve) await adminSupportApi.approve(review.id, note.trim())
        else await adminSupportApi.reject(review.id, note.trim())
      } else {
        await adminSupportApi.reviewConversion(review.id, review.approve, note.trim())
      }
      onToast('ok', review.approve ? t('admin.support.approvals.approved') : t('admin.support.approvals.rejected'))
      setReview(null)
      await load()
    } catch (err) {
      onToast('err', errText(err, t('admin.saveError')))
    } finally {
      setBusy(false)
    }
  }

  const describe = (r: SupportRequest) => {
    const p = r.payload
    if (r.kind === 'comp_days') return t('admin.support.approvals.compDays', { n: str(p.days), reason: str(p.reason) })
    if (r.kind === 'follow_up') return t('admin.support.approvals.followUp', { goal: t(`supportDesk.goal.${str(p.goal) || 'revisit'}`) }) + (str(p.note) ? ` · ${str(p.note)}` : '')
    return t('admin.support.approvals.conversion', { server: str(p.server), login: str(p.login) }) + (str(p.note) ? ` · ${str(p.note)}` : '')
  }

  const buttons = (kind: 'req' | 'conv', id: string) => (
    <div className="flex shrink-0 gap-2">
      <button type="button" className="btn-primary px-3 py-1.5 text-xs" onClick={() => { setNote(''); setReview({ kind, id, approve: true }) }}>
        {t('admin.support.approvals.approve')}
      </button>
      <button type="button" className="btn-ghost px-3 py-1.5 text-xs" onClick={() => { setNote(''); setReview({ kind, id, approve: false }) }}>
        {t('admin.support.approvals.reject')}
      </button>
    </div>
  )

  if (!requests) return <div className="glass space-y-3 p-5"><SkeletonLine /><SkeletonLine width="70%" /></div>

  return (
    <div className="space-y-5">
      <section className="space-y-2">
        <h3 className="text-sm font-semibold text-neutral-200">{t('admin.support.approvals.requests', { n: requests.length })}</h3>
        {requests.length === 0 ? (
          <div className="glass p-6 text-center text-sm text-neutral-500">{t('admin.support.approvals.none')}</div>
        ) : (
          requests.map((r) => (
            <div key={r.id} className="glass flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="tag bg-prism-600/20 text-prism-200">{t(`supportDesk.requests.kind.${r.kind}`)}</span>
                  <span className="text-neutral-300">{r.targetName || r.targetUserId}</span>
                  <span className="text-neutral-500">{t('admin.support.approvals.by', { name: r.requesterName || '—' })}</span>
                  <span className="num text-neutral-500">{fmtTime(r.createdAt)}</span>
                </div>
                <p className="mt-1.5 break-words text-sm text-neutral-200">{describe(r)}</p>
              </div>
              {buttons('req', r.id)}
            </div>
          ))
        )}
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-semibold text-neutral-200">{t('admin.support.approvals.conversions', { n: convs.length })}</h3>
        {convs.length === 0 ? (
          <div className="glass p-6 text-center text-sm text-neutral-500">{t('admin.support.approvals.none')}</div>
        ) : (
          convs.map((c) => (
            <div key={c.id} className="glass flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
              <div className="min-w-0 flex-1 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="tag bg-amber-400/15 text-amber-300">{t(`supportDesk.conversions.kind.${c.kind}`)}</span>
                  <span className="text-neutral-300">{c.userName || c.userId}</span>
                  {c.creditedName && <span className="text-neutral-500">{t('admin.support.approvals.credited', { name: c.creditedName })}</span>}
                  <span className="num text-neutral-500">{fmtTime(c.createdAt)}</span>
                </div>
                {c.detail && (
                  <p className="mt-1.5 break-all font-mono text-neutral-400">
                    {[str(c.detail.login), str(c.detail.server)].filter(Boolean).join(' · ')}
                  </p>
                )}
              </div>
              {buttons('conv', c.id)}
            </div>
          ))
        )}
      </section>

      {review && (
        <DeskModal
          title={review.approve ? t('admin.support.approvals.approve') : t('admin.support.approvals.reject')}
          busy={busy}
          danger={!review.approve}
          onClose={() => setReview(null)}
          onConfirm={() => void submit()}
        >
          <p className="text-neutral-300">{review.approve ? t('admin.support.approvals.approveBody') : t('admin.support.approvals.rejectBody')}</p>
          <textarea className="input min-h-[64px] w-full" maxLength={1000} placeholder={t('admin.support.approvals.notePlaceholder')}
            value={note} onChange={(e) => setNote(e.target.value)} />
        </DeskModal>
      )}
    </div>
  )
}
