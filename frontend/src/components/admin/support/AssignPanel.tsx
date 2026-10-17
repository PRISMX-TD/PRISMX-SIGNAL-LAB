// 跟进分配（设计 §5.2 / §7.2）：选人（复用群发邮件的选人表：搜索 / 套餐 / 活跃度筛选、跨页保留勾选）
// + 分配表单，分配前先预检，把「要求勿扰 / 已有进行中跟进 / 工作人员」（会被跳过）与「退订推广邮件」
// （默认跳过，可勾选仍分配）说清楚。现有跟进的查看与收回 / 改派 / 延期在「跟进进度」（ProgressPanel）。
// Follow-up assignment (design §5.2 / §7.2): pick users (the email picker, reused: search / plan /
// activity filters, selection survives paging) plus the assign form, with a pre-flight that spells
// out who will be skipped (do-not-contact / active follow-up / staff) and who is skipped by default
// (email opt-outs, includable). Existing follow-ups — viewing, revoke / reassign / extend — live in
// the progress section (ProgressPanel).
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { adminSupportApi } from '../../../api/client'
import {
  FOLLOW_UP_GOALS,
  FOLLOW_UP_PRIORITIES,
  type AssignBlocker,
  type FollowUpGoal,
  type FollowUpPriority,
  type SupportMember,
} from '../../../api/supportTypes'
import ConfirmModal from '../../ConfirmModal'
import Select from '../../Select'
import EmailRecipientPicker, { type Picked } from '../EmailRecipientPicker'
import { errText } from '../../support/supportUi'

export default function AssignPanel({
  presetUserIds,
  onPresetCleared,
  onToast,
}: {
  presetUserIds: string[]
  onPresetCleared: () => void
  onToast: (kind: 'ok' | 'err', text: string) => void
}) {
  const { t } = useTranslation()
  const [members, setMembers] = useState<SupportMember[]>([])
  const [picked, setPicked] = useState<Picked>(() => Object.fromEntries(presetUserIds.map((id) => [id, ''])))
  const [assigneeId, setAssigneeId] = useState('')
  const [goal, setGoal] = useState<FollowUpGoal>('open_mt5')
  const [priority, setPriority] = useState<FollowUpPriority>('normal')
  const [note, setNote] = useState('')
  const [includeOptedOut, setIncludeOptedOut] = useState(false)
  const [blockers, setBlockers] = useState<AssignBlocker[] | null>(null)
  const [assigning, setAssigning] = useState(false)
  const [confirm, setConfirm] = useState(false)

  useEffect(() => {
    if (presetUserIds.length) onPresetCleared()
    adminSupportApi
      .members()
      .then((r) => setMembers(r.items.filter((m) => !m.disabled)))
      .catch((err) => onToast('err', errText(err, t('admin.loadError'))))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const ids = Object.keys(picked)
  const idsKey = ids.join(',')

  // 勾选变了就重新预检（防抖）/ re-run the pre-flight when the selection changes (debounced)
  useEffect(() => {
    if (!ids.length) {
      setBlockers(null)
      return
    }
    const timer = window.setTimeout(() => {
      adminSupportApi
        .checkAssign(ids)
        .then((r) => setBlockers(r.items))
        .catch(() => setBlockers(null))
    }, 400)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey])

  const hard = (b: AssignBlocker) => b.missing || b.staff || b.doNotContact || b.activeFollowUp
  const counts = blockers
    ? {
        dnc: blockers.filter((b) => b.doNotContact).length,
        active: blockers.filter((b) => !b.doNotContact && b.activeFollowUp).length,
        staff: blockers.filter((b) => b.staff || b.missing).length,
        opted: blockers.filter((b) => !hard(b) && b.optedOut).length,
        ok: blockers.filter((b) => !hard(b) && (!b.optedOut || includeOptedOut)).length,
      }
    : null

  const assign = async () => {
    setConfirm(false)
    setAssigning(true)
    try {
      const r = await adminSupportApi.assign({
        userIds: ids,
        assigneeId,
        goal,
        priority,
        note: note.trim() || null,
        includeOptedOut,
      })
      onToast('ok', t('admin.support.assign.done', { created: r.created.length, skipped: r.skipped.length }))
      setPicked({})
      setNote('')
    } catch (err) {
      onToast('err', errText(err, t('admin.saveError')))
    } finally {
      setAssigning(false)
    }
  }

  const memberOptions = members.map((m) => ({ value: m.id, label: `${m.nickname || m.email} · ${t(`admin.support.tier.${m.effectiveTier}`)}` }))

  return (
    <div className="space-y-5">
      <section className="glass space-y-3 p-4">
        <h3 className="text-sm font-semibold text-neutral-200">{t('admin.support.assign.pickTitle')}</h3>
        <EmailRecipientPicker kind="notice" picked={picked} onChange={setPicked} onError={(text) => onToast('err', text)} />
      </section>

      <section className="glass space-y-3 p-4">
        <h3 className="text-sm font-semibold text-neutral-200">{t('admin.support.assign.formTitle', { n: ids.length })}</h3>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <label className="block text-xs text-neutral-400">
            <span className="mb-1 block">{t('admin.support.assign.assignee')}</span>
            <Select value={assigneeId} onChange={setAssigneeId} ariaLabel={t('admin.support.assign.assignee')}
              options={[{ value: '', label: t('admin.support.assign.chooseAssignee') }, ...memberOptions]} />
          </label>
          <label className="block text-xs text-neutral-400">
            <span className="mb-1 block">{t('supportDesk.card.goal')}</span>
            <Select value={goal} onChange={(v) => setGoal(v as FollowUpGoal)} ariaLabel={t('supportDesk.card.goal')}
              options={FOLLOW_UP_GOALS.map((g) => ({ value: g, label: t(`supportDesk.goal.${g}`) }))} />
          </label>
          <label className="block text-xs text-neutral-400">
            <span className="mb-1 block">{t('admin.support.assign.priority')}</span>
            <Select value={priority} onChange={(v) => setPriority(v as FollowUpPriority)} ariaLabel={t('admin.support.assign.priority')}
              options={FOLLOW_UP_PRIORITIES.map((p) => ({ value: p, label: t(`supportDesk.priority.${p}`) }))} />
          </label>
        </div>
        <textarea className="input min-h-[64px] w-full rounded-xl py-2 text-sm leading-relaxed" maxLength={2000} placeholder={t('admin.support.assign.notePlaceholder')}
          value={note} onChange={(e) => setNote(e.target.value)} />
        {counts && (
          <div className="flex flex-wrap gap-2 text-xs">
            <span className="tag bg-up/15 text-up">{t('admin.support.assign.willAssign', { n: counts.ok })}</span>
            {counts.dnc > 0 && <span className="tag bg-down/15 text-down">{t('admin.support.assign.skipDnc', { n: counts.dnc })}</span>}
            {counts.active > 0 && <span className="tag bg-amber-400/15 text-amber-300">{t('admin.support.assign.skipActive', { n: counts.active })}</span>}
            {counts.staff > 0 && <span className="tag bg-white/5 text-neutral-400">{t('admin.support.assign.skipStaff', { n: counts.staff })}</span>}
            {counts.opted > 0 && <span className="tag bg-amber-400/15 text-amber-300">{t('admin.support.assign.optedOut', { n: counts.opted })}</span>}
          </div>
        )}
        {counts && counts.opted > 0 && (
          <label className="flex cursor-pointer items-center gap-2 text-xs text-neutral-400">
            <input type="checkbox" checked={includeOptedOut} onChange={(e) => setIncludeOptedOut(e.target.checked)}
              className="h-3.5 w-3.5 rounded border-white/20 bg-white/5 accent-prism-500" />
            {t('admin.support.assign.includeOptedOut')}
          </label>
        )}
        <button type="button" className="btn-primary px-5 py-2 text-sm disabled:opacity-40"
          disabled={!ids.length || !assigneeId || assigning || (counts != null && counts.ok === 0)} onClick={() => setConfirm(true)}>
          {assigning ? t('common.loading') : t('admin.support.assign.submit')}
        </button>
      </section>

      {confirm && (
        <ConfirmModal
          center
          busy={assigning}
          title={t('admin.support.assign.confirmTitle')}
          message={t('admin.support.assign.confirmBody', {
            n: counts?.ok ?? ids.length,
            name: members.find((m) => m.id === assigneeId)?.nickname || members.find((m) => m.id === assigneeId)?.email || '',
            goal: t(`supportDesk.goal.${goal}`),
          })}
          onConfirm={() => void assign()}
          onCancel={() => setConfirm(false)}
        />
      )}
    </div>
  )
}
